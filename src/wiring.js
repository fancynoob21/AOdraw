// ════════════════════════════════════════════════════════════════════════════
// SillyTavern 事件接线
// ════════════════════════════════════════════════════════════════════════════

import { event_types, eventSource } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { installActionDelegation, uninstallActionDelegation } from './actions.js';
import { getPattern, getSettings, LOG_PREFIX } from './config.js';
import * as pipeline from './pipeline.js';
import {
    cancelLiveHydrate, hydrateAll, hydrateMessage, resolve, scheduleLiveHydrate,
} from './renderer.js';
import { StreamScanner } from './scanner.js';

/** @type {{ scanner: StreamScanner, startedAt: number, dispatched: number } | null} */
let session = null;

/** 已注册的监听，卸载时用 @type {Array<[string, Function]>} */
const bound = [];

function on(type, handler) {
    eventSource.on(type, handler);
    bound.push([type, handler]);
}

// ════════════════════════════════════════════════════════════════════════════

export function install() {
    // ── 会话开始 ──
    on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun) return;
        // impersonate 的文本进的是输入框不是楼层；quiet 是后台生成，都不该出图
        if (type === 'impersonate' || type === 'quiet') return;
        if (!getSettings().enabled) return;

        session = { scanner: new StreamScanner(getPattern()), startedAt: Date.now(), dispatched: 0 };
    });

    // ── ★ 核心：流式期间截获并派发 ──
    //
    // 这个监听器在 ST 的流式循环里是被 await 的（script.js 的
    // `await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, text)`）。
    // 任何异步等待都会直接卡住正文输出，所以它必须同步返回：
    // 扫描是同步的，生成用 `void` 甩出去不等。
    on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
        if (!session) return;

        const fresh = session.scanner.feed(text);
        for (const token of fresh) {
            session.dispatched++;
            console.debug(
                `${LOG_PREFIX} dispatch @ +${Date.now() - session.startedAt}ms —`,
                token.prompt,
            );
            void pipeline.request(resolvePrompt(token.prompt));
        }

        if (getSettings().livePreview) scheduleLiveHydrate();
    });

    // ── 会话结束 ──
    on(event_types.GENERATION_ENDED, () => {
        // 是否需要兜底，必须在关掉会话之前判断
        const needsFallback = !!session && session.dispatched === 0;

        if (session) {
            console.debug(
                `${LOG_PREFIX} GENERATION_ENDED @ +${Date.now() - session.startedAt}ms，` +
                `本轮派发 ${session.dispatched} 张`,
            );
        }
        endSession();

        // 非流式兜底：关掉流式传输时 STREAM_TOKEN_RECEIVED 根本不触发，
        // 这里对最后一层的全文补扫一次，退化成传统的串行行为但功能不缺。
        //
        // 只在流式一张都没派发时才跑。之前是无条件跑的，结果流式期间失败的图
        // （比如撞上 429）会在这里被重新派发一次 —— 两个 token 打出三次请求。
        // 失败的重试应该由用户点「重试」，不该在每次生成结束时偷偷再来一遍。
        if (needsFallback) scanLastMessage();

        hydrateAll();
    });

    on(event_types.GENERATION_STOPPED, () => {
        endSession();
        hydrateAll();
    });

    // ── 重绘时机 ──
    on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => hydrateMessage(id));
    on(event_types.USER_MESSAGE_RENDERED, (id) => hydrateMessage(id));
    on(event_types.MESSAGE_UPDATED, (id) => hydrateMessage(id));
    on(event_types.MESSAGE_EDITED, (id) => hydrateMessage(id));
    on(event_types.MESSAGE_SWIPED, () => { endSession(); hydrateAll(); });

    on(event_types.CHAT_CHANGED, () => {
        endSession();
        pipeline.clearQueue();
        setTimeout(hydrateAll, 100); // 等 ST 把楼层铺完
    });

    installActionDelegation();
}

export function uninstall() {
    endSession();
    for (const [type, handler] of bound) eventSource.removeListener(type, handler);
    bound.length = 0;
    uninstallActionDelegation();
}

// ════════════════════════════════════════════════════════════════════════════

function endSession() {
    session = null;
    cancelLiveHydrate();
}

/** 查 override，没有就用正文原文 */
function resolvePrompt(rawPrompt) {
    return resolve(rawPrompt).prompt;
}

/**
 * 非流式兜底：对最后一个楼层的原文补扫一遍。
 *
 * 关掉流式传输时 STREAM_TOKEN_RECEIVED 完全不会触发，没有这一步就一张图都出不来。
 *
 * 读 chat 数组而不是 DOM 的 textContent —— 此刻 slot 很可能已经把 `[img: ...]`
 * 那段文本节点替换掉了，从 DOM 上再也读不到原文。
 */
function scanLastMessage() {
    if (!getSettings().enabled) return;
    try {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat) || !chat.length) return;

        const last = chat[chat.length - 1];
        if (!last || last.is_user || !last.mes) return;

        const scanner = new StreamScanner(getPattern());
        for (const token of scanner.feed(last.mes)) {
            void pipeline.request(resolvePrompt(token.prompt));
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'scanLastMessage failed', e);
    }
}
