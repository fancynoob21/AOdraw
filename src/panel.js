// ════════════════════════════════════════════════════════════════════════════
// 楼层管理面板
// ════════════════════════════════════════════════════════════════════════════
//
// 列出某个楼层里的所有 slot，集中做「改 prompt / 重绘 / 复位 / 长期保存」。
// 工具条已经能在图上就地完成这些操作，面板的意义在于一次看清整层的状态 ——
// 尤其是在有五六张图、其中几张失败几张排队的时候。
//
// 全局图库（跨楼层浏览、批量清理）不在 MVP 范围，靠 cache.list() 后续接。
// ════════════════════════════════════════════════════════════════════════════

import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import * as cache from './cache.js';
import * as pipeline from './pipeline.js';
import { hydrateAll, resolve } from './renderer.js';
import { normalizePrompt } from './util.js';

const STATUS_LABEL = {
    idle: '未生成',
    queued: '排队中',
    waiting: '排队中',
    generating: '生成中',
    done: '已就绪',
    error: '失败',
};

/**
 * @param {number|string} messageId
 */
export async function openPanel(messageId) {
    const mesText = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!mesText) return;

    const slots = [...mesText.querySelectorAll('.sd-slot')];
    const container = document.createElement('div');
    container.className = 'sd-panel';

    const title = document.createElement('h3');
    title.textContent = `本楼图片 (${slots.length})`;
    container.appendChild(title);

    if (!slots.length) {
        const empty = document.createElement('p');
        empty.className = 'sd-panel-empty';
        empty.textContent = '这一层没有可生成的图片标记。';
        container.appendChild(empty);
    }

    for (const slot of slots) {
        container.appendChild(buildRow(/** @type {HTMLElement} */ (slot)));
    }

    await callGenericPopup(container, POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
}

/**
 * @param {HTMLElement} slot
 * @returns {HTMLElement}
 */
function buildRow(slot) {
    const raw = slot.dataset.raw || '';
    const { oh, h, prompt, overridden } = resolve(raw);
    const state = pipeline.peek(h);

    const row = document.createElement('div');
    row.className = 'sd-panel-row';

    // ── 缩略图 ──
    const thumb = document.createElement('div');
    thumb.className = 'sd-panel-thumb';
    if (state?.status === 'done' && state.url) {
        const img = document.createElement('img');
        img.src = state.url;
        img.alt = prompt;
        thumb.appendChild(img);
    } else {
        thumb.textContent = STATUS_LABEL[state?.status || 'idle'] || '未生成';
    }
    row.appendChild(thumb);

    // ── 信息 ──
    const info = document.createElement('div');
    info.className = 'sd-panel-info';

    const promptEl = document.createElement('div');
    promptEl.className = 'sd-panel-prompt';
    promptEl.textContent = prompt;
    info.appendChild(promptEl);

    const meta = document.createElement('div');
    meta.className = 'sd-panel-meta';
    const bits = [`hash ${h.slice(0, 8)}`, STATUS_LABEL[state?.status || 'idle']];
    if (overridden) bits.push('已修改');
    if (state?.error) bits.push(state.error);
    meta.textContent = bits.join(' · ');
    info.appendChild(meta);

    if (overridden) {
        const original = document.createElement('div');
        original.className = 'sd-panel-original';
        original.textContent = `正文原文: ${raw}`;
        info.appendChild(original);
    }

    row.appendChild(info);

    // ── 操作 ──
    const actions = document.createElement('div');
    actions.className = 'sd-panel-actions';

    const mkBtn = (label, handler) => {
        const b = document.createElement('button');
        b.className = 'menu_button sd-panel-btn';
        b.textContent = label;
        b.addEventListener('click', async () => {
            b.disabled = true;
            try { await handler(); } finally { b.disabled = false; }
        });
        return b;
    };

    actions.appendChild(mkBtn(state?.status === 'done' ? '重绘' : '生成', async () => {
        await pipeline.request(prompt, { force: state?.status === 'done' });
        refreshRow(row, slot);
    }));

    actions.appendChild(mkBtn('改 prompt', async () => {
        const input = await callGenericPopup('修改这张图的 prompt', POPUP_TYPE.INPUT, prompt, {
            rows: 4, okButton: '保存并生成', cancelButton: '取消',
        });
        if (input === null || input === false) return;
        const next = normalizePrompt(String(input));
        if (!next || next === prompt) return;
        await cache.setOverride(oh, next);
        hydrateAll();
        await pipeline.request(next);
        refreshRow(row, slot);
    }));

    if (overridden) {
        actions.appendChild(mkBtn('复位', async () => {
            await cache.clearOverride(oh);
            hydrateAll();
            refreshRow(row, slot);
        }));
    }

    actions.appendChild(mkBtn('长期保存', async () => {
        await cache.pin(h, true);
        refreshRow(row, slot);
    }));

    row.appendChild(actions);
    return row;
}

/** 就地替换一行，避免重开整个面板 */
function refreshRow(row, slot) {
    const next = buildRow(slot);
    row.replaceWith(next);
}
