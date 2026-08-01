// ════════════════════════════════════════════════════════════════════════════
// 渲染：slot 注入 + 幂等注水 + 工具条
// ════════════════════════════════════════════════════════════════════════════
//
// 这里要对抗的是：SillyTavern 每个流式 tick 都会执行
// `messageTextDom.innerHTML = formattedText`（开了 stream_fade_in 则走 morphdom），
// 默认 streaming_fps = 30，也就是每秒最多 30 次把我们插进去的东西全部抹掉。
//
// 结论是不要试图让 DOM「活下来」，而是让重建足够便宜且完全幂等：
// 状态全在 pipeline 的内存 Map 里，DOM 只是它的一次投影，随时可以重画。
// ════════════════════════════════════════════════════════════════════════════

import { getPattern, getSettings, LOG_PREFIX } from './config.js';
import { hydrateStartIndex } from './history.js';
import * as cache from './cache.js';
import * as pipeline from './pipeline.js';
import { hash64, normalizePrompt } from './util.js';

const SLOT_CLASS = 'aod-slot';
const LIVE_HYDRATE_INTERVAL = 200; // 流式期间最多 5fps，30fps 跑全量 TreeWalker 没必要

let reentrancyGuard = false;

/** 已经挂了广播监听的 hash，避免重复订阅 @type {Set<string>} */
const watched = new Set();

// ════════════════════════════════════════════════════════════════════════════
// prompt 解析：正文原文 → 生效 prompt
// ════════════════════════════════════════════════════════════════════════════

/**
 * 正文里的原始 prompt 可能被用户在 slot 上改过。
 * override 表以「原始 prompt 的 hash」为键，所以正文永远不用动。
 *
 * @param {string} rawPrompt 正文里截出来并归一化后的 prompt
 * @returns {{ oh: string, h: string, prompt: string, overridden: boolean }}
 */
export function resolve(rawPrompt) {
    const oh = hash64(rawPrompt);
    const override = cache.getOverrideSync(oh);
    const prompt = override || rawPrompt;
    return { oh, h: hash64(prompt), prompt, overridden: !!override };
}

// ════════════════════════════════════════════════════════════════════════════
// Step 1 · 注入 slot
// ════════════════════════════════════════════════════════════════════════════

/**
 * 把文本节点里的 `[img: ...]` 换成 slot 元素。
 *
 * 用 TreeWalker 做文本节点手术，而不是整段重写 innerHTML —— 后者会连带摧毁同一
 * 楼层里其他扩展绑定的节点和事件监听。
 *
 * @param {HTMLElement} root 一个 `.mes_text`
 * @returns {boolean} 是否有改动
 */
function injectSlots(root) {
    const re = getPattern();
    if (!re) return false;

    /** @type {Text[]} */
    const targets = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
        const node = /** @type {Text} */ (walker.currentNode);
        if (!node.data || node.data.indexOf('[') === -1) continue;
        // 代码块里的 [img:] 是用户在讨论语法，不该被吃掉
        if (node.parentElement?.closest(`pre, code, .${SLOT_CLASS}`)) continue;

        re.lastIndex = 0;
        if (re.test(node.data)) targets.push(node);
    }

    if (!targets.length) return false;

    for (const node of targets) {
        const frag = document.createDocumentFragment();
        const text = node.data;
        let last = 0;
        let m;

        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }

            const prompt = normalizePrompt(m[1]);
            if (!prompt) continue;

            if (m.index > last) {
                frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            }
            frag.appendChild(createSlot(prompt));
            last = m.index + m[0].length;
        }

        if (last < text.length) {
            frag.appendChild(document.createTextNode(text.slice(last)));
        }
        node.replaceWith(frag);
    }

    return true;
}

/**
 * @param {string} rawPrompt
 * @returns {HTMLElement}
 */
function createSlot(rawPrompt) {
    const { oh, h, prompt, overridden } = resolve(rawPrompt);
    const slot = document.createElement('span');
    slot.className = SLOT_CLASS;
    slot.dataset.oh = oh;
    slot.dataset.h = h;
    slot.dataset.raw = rawPrompt;
    slot.dataset.prompt = prompt;
    if (overridden) slot.dataset.overridden = '1';
    return slot;
}

// ════════════════════════════════════════════════════════════════════════════
// Step 2 · 填充
// ════════════════════════════════════════════════════════════════════════════

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function icon(name) {
    const i = document.createElement('i');
    i.className = `fa-solid ${name}`;
    return i;
}

/**
 * 按状态把一个 slot 画出来。完全根据 pipeline 的状态推导，无副作用、可重复调用。
 * @param {HTMLElement} slot
 */
function paintSlot(slot) {
    const h = slot.dataset.h;
    const state = pipeline.peek(h);
    const signature = stateSignature(state);

    // 状态没变就别重画 —— 重画会打断 <img> 的解码、让图闪一下
    if (slot.dataset.painted === signature) return;
    slot.dataset.painted = signature;

    slot.replaceChildren();

    if (!state || state.status === 'idle') {
        // 缓存里没有，也没人请求过。翻旧楼层时的常态：给个按钮让用户自己决定，
        // 绝不自动生成 —— 滚一遍历史记录就烧光 Anlas 是不可接受的。
        const box = el('span', 'aod-placeholder');
        box.appendChild(icon('fa-image'));
        const btn = el('button', 'aod-btn aod-act-generate', '生成');
        box.appendChild(btn);
        slot.appendChild(box);
        return;
    }

    switch (state.status) {
        case 'queued': {
            const box = el('span', 'aod-loading');
            box.appendChild(icon('fa-clock'));
            box.appendChild(el('span', null, `排队中 #${state.position ?? 1}`));
            slot.appendChild(box);
            break;
        }
        case 'waiting': {
            const box = el('span', 'aod-loading');
            box.appendChild(icon('fa-clock'));
            const secs = Math.ceil((state.delayMs || 0) / 1000);
            box.appendChild(el('span', null, `排队中 #${state.position ?? 1} (${secs}s)`));
            slot.appendChild(box);
            break;
        }
        case 'generating': {
            const box = el('span', 'aod-loading');
            box.appendChild(icon('fa-palette aod-spin'));
            const tail = state.position > 0 ? ` (${state.position} 排队)` : '';
            box.appendChild(el('span', null, `生成中${tail}...`));
            slot.appendChild(box);
            break;
        }
        case 'done': {
            const wrap = el('span', 'aod-img-wrap');
            const img = document.createElement('img');
            img.className = 'aod-img';
            img.src = state.url;
            img.alt = state.prompt || '';
            img.loading = 'lazy';
            wrap.appendChild(img);
            wrap.appendChild(buildToolbar(slot));
            slot.appendChild(wrap);
            break;
        }
        case 'error': {
            const box = el('span', 'aod-error');
            box.appendChild(icon('fa-triangle-exclamation'));
            box.appendChild(el('span', null, state.error || '生成失败'));
            box.appendChild(el('button', 'aod-btn aod-act-generate', '重试'));
            slot.appendChild(box);
            break;
        }
    }
}

/** 状态的可比较指纹，用来判断要不要重画 */
function stateSignature(state) {
    if (!state) return 'none';
    return [
        state.status,
        state.position ?? '',
        state.status === 'waiting' ? Math.ceil((state.delayMs || 0) / 1000) : '',
        state.url ?? '',
        state.error ?? '',
    ].join('|');
}

/** @param {HTMLElement} slot */
function buildToolbar(slot) {
    const bar = el('span', 'aod-toolbar');

    const mk = (cls, iconName, title) => {
        const b = el('button', `aod-tool ${cls}`);
        b.title = title;
        b.appendChild(icon(iconName));
        return b;
    };

    bar.appendChild(mk('aod-act-reroll', 'fa-rotate', '重绘（同 prompt）'));
    bar.appendChild(mk('aod-act-edit', 'fa-pen', '修改 prompt'));
    if (slot.dataset.overridden === '1') {
        bar.appendChild(mk('aod-act-reset', 'fa-rotate-left', '复位为正文原始 prompt'));
    }
    bar.appendChild(mk('aod-act-pin', 'fa-thumbtack', '长期保存（不被缓存清理）'));
    return bar;
}

// ════════════════════════════════════════════════════════════════════════════
// Step 3 · 订阅
// ════════════════════════════════════════════════════════════════════════════

/**
 * 每个 hash 只挂一个全局监听，触发时重画文档里所有用到它的 slot。
 *
 * 不给每个 slot 单独订阅 —— slot 每秒会被销毁重建几十次，逐个订阅必然漏解绑。
 * @param {string} h
 */
function ensureWatch(h) {
    if (watched.has(h)) return;
    watched.add(h);
    pipeline.subscribe(h, () => {
        for (const slot of document.querySelectorAll(`.${SLOT_CLASS}[data-h="${CSS.escape(h)}"]`)) {
            paintSlot(/** @type {HTMLElement} */ (slot));
        }
    });
}

/**
 * 给含有 slot 的楼层加一个打开管理面板的按钮。
 *
 * 面板在「图失败了 / 还在排队」的时候最有用，而那些状态下图上是没有工具条的，
 * 所以入口必须挂在楼层级别而不是图上。
 *
 * `.mes_buttons` 不在 `.mes_text` 里，流式重绘不会碰它，插一次就够。
 * @param {HTMLElement} root 一个 `.mes_text`
 */
function ensurePanelButton(root) {
    const mes = root.closest('.mes');
    if (!mes) return;
    const holder = mes.querySelector('.mes_buttons .extraMesButtons');
    if (!holder || holder.querySelector('.aod_message_panel')) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button aod_message_panel fa-solid fa-images';
    btn.title = 'AOdraw：本楼图片';
    holder.prepend(btn);
}

// ════════════════════════════════════════════════════════════════════════════
// 对外入口
// ════════════════════════════════════════════════════════════════════════════

/**
 * 对一个 `.mes_text` 做幂等注水。可以被无限次重复调用。
 * @param {HTMLElement} root
 */
export function hydrate(root) {
    if (!root || reentrancyGuard) return;
    if (!getSettings().enabled) return;

    reentrancyGuard = true;
    try {
        injectSlots(root);

        const slots = root.querySelectorAll(`.${SLOT_CLASS}`);
        if (slots.length) ensurePanelButton(root);

        for (const node of slots) {
            const slot = /** @type {HTMLElement} */ (node);
            if (!slot.dataset.raw) continue;

            // 重新解析一次 override —— 用户刚在别处改过 prompt 时，已存在的 slot
            // 必须换到新的 hash 上去，否则会一直盯着旧图。
            const { oh, h, prompt, overridden } = resolve(slot.dataset.raw);
            if (slot.dataset.h !== h) {
                slot.dataset.oh = oh;
                slot.dataset.h = h;
                slot.dataset.prompt = prompt;
                if (overridden) slot.dataset.overridden = '1';
                else delete slot.dataset.overridden;
                delete slot.dataset.painted; // 强制重画
            }

            ensureWatch(h);
            paintSlot(slot);

            // 只查缓存，不发起生成。pipeline 内部会记住「查过且没有」，
            // 所以这行在流式期间被反复调用也不会反复读库。
            void pipeline.hydrateFromCache(h, slot.dataset.prompt || '');
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'hydrate failed', e);
    } finally {
        reentrancyGuard = false;
    }
}

/**
 * 批量注水，只覆盖最近的若干层。
 *
 * 注水要对每个楼层做一次 TreeWalker 全文扫描，聊天记录攒到几百层之后全量扫
 * 纯属浪费。深度由设置控制，最新一层永远包含在内。
 *
 * 注意这只约束**批量**注水。针对单个楼层的事件（编辑、swipe）走 hydrateMessage，
 * 那是用户对那一层的明确操作，不受深度限制。
 */
export function hydrateAll() {
    if (!getSettings().enabled) return;

    const messages = document.querySelectorAll('#chat .mes');
    const start = hydrateStartIndex(messages.length, getSettings().historyDepth);

    for (let i = start; i < messages.length; i++) {
        const node = messages[i].querySelector('.mes_text');
        if (node) hydrate(/** @type {HTMLElement} */ (node));
    }
}

/**
 * 对某个楼层注水。
 *
 * 不受历史深度限制 —— 走到这里说明用户刚对这一层做了什么（编辑、swipe），
 * 那就该响应，哪怕它已经翻到很旧的位置。
 */
export function hydrateMessage(messageId) {
    const node = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (node) hydrate(/** @type {HTMLElement} */ (node));
}

/** 对最后一个楼层注水（流式期间就是正在写的那一层） */
export function hydrateLast() {
    const all = document.querySelectorAll('#chat .mes .mes_text');
    const last = all[all.length - 1];
    if (last) hydrate(/** @type {HTMLElement} */ (last));
}

// ── 流式期间的节流注水 ────────────────────────────────────────────────────

let liveTimer = null;
let liveLastRun = 0;

/**
 * 流式期间调用。节流到 5fps —— 正文每秒最多被重绘 30 次，跟着跑全量 TreeWalker
 * 纯属浪费，而人眼也分辨不出这点差别。
 */
export function scheduleLiveHydrate() {
    const now = Date.now();
    const elapsed = now - liveLastRun;

    if (elapsed >= LIVE_HYDRATE_INTERVAL) {
        liveLastRun = now;
        hydrateLast();
        return;
    }
    if (liveTimer) return;

    liveTimer = setTimeout(() => {
        liveTimer = null;
        liveLastRun = Date.now();
        hydrateLast();
    }, LIVE_HYDRATE_INTERVAL - elapsed);
}

export function cancelLiveHydrate() {
    if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
    }
}
