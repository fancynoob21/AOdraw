// ════════════════════════════════════════════════════════════════════════════
// slot 上的用户操作：生成 / 重绘 / 改 prompt / 复位 / 长期保存
// ════════════════════════════════════════════════════════════════════════════
//
// 全部走 #chat 上的事件委托。slot 元素每秒会被销毁重建几十次，逐个绑定
// onclick 必然漏解绑，也必然在重绘后失效。
// ════════════════════════════════════════════════════════════════════════════

import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import * as cache from './cache.js';
import { LOG_PREFIX } from './config.js';
import { openPanel } from './panel.js';
import * as pipeline from './pipeline.js';
import { hydrateAll } from './renderer.js';
import { normalizePrompt } from './util.js';

let installed = false;

export function installActionDelegation() {
    if (installed) return;
    installed = true;
    document.addEventListener('click', onClick, true);
}

export function uninstallActionDelegation() {
    if (!installed) return;
    installed = false;
    document.removeEventListener('click', onClick, true);
}

/** @param {MouseEvent} e */
function onClick(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target?.closest) return;

    // 楼层级：打开本楼管理面板
    const panelBtn = target.closest('.sd_message_panel');
    if (panelBtn) {
        const messageId = panelBtn.closest('.mes')?.getAttribute('mesid');
        if (messageId != null) {
            e.preventDefault();
            e.stopPropagation();
            void openPanel(messageId);
        }
        return;
    }

    const button = target.closest('.sd-btn, .sd-tool');
    if (!button) return;

    const slot = button.closest('.sd-slot');
    if (!slot) return;

    e.preventDefault();
    e.stopPropagation();

    const ctx = {
        oh: slot.dataset.oh,
        h: slot.dataset.h,
        raw: slot.dataset.raw || '',
        prompt: slot.dataset.prompt || '',
    };

    if (button.classList.contains('sd-act-generate')) void doGenerate(ctx);
    else if (button.classList.contains('sd-act-reroll')) void doReroll(ctx);
    else if (button.classList.contains('sd-act-edit')) void doEdit(ctx);
    else if (button.classList.contains('sd-act-reset')) void doReset(ctx);
    else if (button.classList.contains('sd-act-pin')) void doPin(ctx, button);
}

async function doGenerate({ prompt }) {
    await pipeline.request(prompt);
}

/** 重绘：同 prompt 但绕过缓存，结果覆写同一个 hash */
async function doReroll({ prompt }) {
    await pipeline.request(prompt, { force: true });
}

/**
 * 改 prompt。
 *
 * 改动写进 override 表（键是**正文原始 prompt 的 hash**），正文本身一个字都不动 ——
 * 这样 [img: ...] 照常进 LLM 上下文，而编辑也不会在下一次重绘里丢掉。
 */
async function doEdit({ oh, prompt }) {
    const input = await callGenericPopup('修改这张图的 prompt', POPUP_TYPE.INPUT, prompt, {
        rows: 4,
        okButton: '保存并生成',
        cancelButton: '取消',
    });
    if (input === null || input === false) return;

    const next = normalizePrompt(String(input));
    if (!next || next === prompt) return;

    await cache.setOverride(oh, next);
    hydrateAll();          // slot 的 data-h 需要按新 prompt 重算
    await pipeline.request(next);
}

async function doReset({ oh }) {
    await cache.clearOverride(oh);
    hydrateAll();
}

async function doPin({ h }, button) {
    const ok = await cache.pin(h, true);
    if (ok) {
        button.classList.add('sd-pinned');
        button.title = '已标记为长期保存';
    } else {
        console.warn(LOG_PREFIX, 'pin failed: no cache record for', h);
    }
}
