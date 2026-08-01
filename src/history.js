// ════════════════════════════════════════════════════════════════════════════
// 历史楼层渲染深度
// ════════════════════════════════════════════════════════════════════════════
//
// 注水要对每个楼层做一次 TreeWalker 全文扫描。聊天记录攒到几百层之后，每次
// CHAT_CHANGED / GENERATION_ENDED 都全量扫一遍是纯粹的浪费 —— 绝大多数楼层
// 用户根本不会再看。
//
// 深度算的是**过去**楼层，最新楼层永远渲染。否则深度设成 0 会把刚生成出来的
// 那一层也一起关掉，本插件的核心功能直接失效。
//
// 本文件不引 SillyTavern，可在 node 下单测。
// ════════════════════════════════════════════════════════════════════════════

/** 全部楼层的哨兵值 */
export const HISTORY_ALL = -1;

export const DEFAULT_HISTORY_DEPTH = 5;

export const HISTORY_DEPTH_OPTIONS = [
    { value: 0, label: '只渲染最新楼层' },
    { value: 3, label: '过去 3 层' },
    { value: 5, label: '过去 5 层' },
    { value: 10, label: '过去 10 层' },
    { value: 20, label: '过去 20 层' },
    { value: 50, label: '过去 50 层' },
    { value: HISTORY_ALL, label: '全部楼层' },
];

/**
 * 给定楼层总数和深度设置，算出该从第几层开始渲染。
 *
 * @param {number} total 楼层总数
 * @param {any} depth    设置里的 historyDepth；负数表示全部
 * @returns {number} 起始下标（含）。等于 total 时表示一层都不渲染。
 */
export function hydrateStartIndex(total, depth) {
    const count = Number(total);
    if (!Number.isFinite(count) || count <= 0) return 0;

    // 设置坏掉时宁可多渲染也不要少渲染 —— 少渲染的表现是图莫名其妙不出来，
    // 比多花一点 CPU 难查得多。
    //
    // 空值必须单独挡掉：Number('') 和 Number(null) 都是 0，会被当成
    // 「只渲染最新一层」这个合法选择，而不是「设置坏了」。
    const blank = depth === '' || depth === null || depth === undefined;
    const d = blank ? NaN : Number(depth);
    if (!Number.isFinite(d)) return Math.max(0, count - 1 - DEFAULT_HISTORY_DEPTH);

    if (d < 0) return 0; // 全部

    // 最新一层永远算在内，所以是 count - 1 - d
    return Math.max(0, count - 1 - Math.floor(d));
}
