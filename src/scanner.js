// ════════════════════════════════════════════════════════════════════════════
// 流式 token 扫描器 —— 本插件的核心
// ════════════════════════════════════════════════════════════════════════════
//
// 传统工作流等正文渲染完再提取 [img:]，于是「写正文」和「画图」完全串行。
// 但 `[img: 1girl, smile]` 在流式传到 `]` 的那一刻就已经语义完整了 ——
// 此时正文可能才写了三分之一。这个扫描器就是用来抓住那一刻的。
//
// 本文件刻意不引任何 DOM / SillyTavern 依赖，可在 node 下直接单测。
// ════════════════════════════════════════════════════════════════════════════

import { normalizePrompt } from './util.js';

/**
 * @typedef {object} ScannedToken
 * @property {number} index  token 在累积文本中的起始下标
 * @property {string} raw    匹配到的原文，如 `[img: 1girl, smile]`
 * @property {string} prompt 归一化后的 prompt，如 `1girl, smile`
 */

export class StreamScanner {
    /**
     * @param {RegExp} pattern 必须带 `g` 标志、必须含捕获组 1 = prompt、
     *                         且必须要求闭合定界符（否则半截 token 会误匹配）
     */
    constructor(pattern) {
        this.re = pattern;
        /** 已派发过的 token，键是 `${index} ${raw}` @type {Set<string>} */
        this.seen = new Set();
    }

    /**
     * 喂入一次 STREAM_TOKEN_RECEIVED 给的**累积全文**（不是增量），
     * 返回这一次新出现的完整 token。
     *
     * 为什么全量重扫也不会重复派发：
     *
     * 1. 正则强制要求闭合 `]`，所以 `[img: 1gir` 这种半截 token 根本不匹配，
     *    天然不会误派发 —— 这是整个设计成立的前提。
     * 2. 流式文本是**累积且前缀不可变**的，已匹配过的 token 每一轮都会在
     *    同一个 index 上以同样的原文重现，于是 `seen` 能精确去重。
     * 3. 整个过程完全同步，`[^\]]+` 是线性的，没有回溯风险。
     *
     * 调用方必须保证本方法是同步返回的：STREAM_TOKEN_RECEIVED 在 ST 的流式
     * 循环里是被 `await` 的，任何异步等待都会直接卡住正文输出。
     *
     * @param {string} fullText
     * @returns {ScannedToken[]}
     */
    feed(fullText) {
        const text = String(fullText ?? '');
        if (!text) return [];

        /** @type {ScannedToken[]} */
        const fresh = [];

        // 共享的 RegExp 实例带可变 lastIndex，每次循环前必须归零
        this.re.lastIndex = 0;

        let m;
        while ((m = this.re.exec(text)) !== null) {
            // 零宽匹配会让 exec 原地打转，防一手死循环
            if (m[0].length === 0) {
                this.re.lastIndex++;
                continue;
            }

            const key = m.index + ' ' + m[0];
            if (this.seen.has(key)) continue;

            const prompt = normalizePrompt(m[1]);
            if (!prompt) continue; // `[img: ]` 之类的空 token 忽略，但不记进 seen

            this.seen.add(key);
            fresh.push({ index: m.index, raw: m[0], prompt });
        }

        return fresh;
    }

    /** 新一轮生成开始 / swipe / 切聊天时调用 */
    reset() {
        this.seen.clear();
    }
}
