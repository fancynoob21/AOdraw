// ════════════════════════════════════════════════════════════════════════════
// 尺寸选项与免费额度判定
// ════════════════════════════════════════════════════════════════════════════
//
// 单独成文件是为了可测：config.js 依赖 SillyTavern 运行时，这些纯逻辑放进去
// 就没法在 node 下单测了。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 可选尺寸。
 *
 * 不给自由填写的宽高框，是因为 NovelAI 只接受特定的尺寸组合，手填很容易撞上
 * 「看着合理但服务端不收」的值。
 *
 * `free` 标的是 Opus 订阅下的无限免费额度 —— 条件是尺寸在这三个之内
 * **且 steps ≤ 28**，两个条件缺一不可。
 */
export const SIZE_OPTIONS = [
    { value: '832x1216', width: 832, height: 1216, label: '832 × 1216（竖）', free: true },
    { value: '1216x832', width: 1216, height: 832, label: '1216 × 832（横）', free: true },
    { value: '1024x1024', width: 1024, height: 1024, label: '1024 × 1024（方）', free: true },
    { value: '1024x1536', width: 1024, height: 1536, label: '1024 × 1536（竖·大）', free: false },
    { value: '1536x1024', width: 1536, height: 1024, label: '1536 × 1024（横·大）', free: false },
];

/** Opus 免费额度的 steps 上限 */
export const FREE_STEPS_LIMIT = 28;

export const DEFAULT_SIZE = '1216x832';

/** @param {{width: any, height: any}} s */
function findOption(s) {
    return SIZE_OPTIONS.find(
        o => o.width === Number(s?.width) && o.height === Number(s?.height),
    );
}

/**
 * 从存下来的 width/height 反查是哪个选项。
 * 匹配不上（旧配置、手改过）就落回默认值。
 * @param {{width: any, height: any}} settings
 * @returns {string}
 */
export function sizeValueOf(settings) {
    return findOption(settings)?.value ?? DEFAULT_SIZE;
}

/**
 * 当前设置是否落在 Opus 的无限免费额度内。
 * 尺寸和 steps 两个条件缺一不可。
 * @param {{width: any, height: any, steps: any}} settings
 * @returns {boolean}
 */
export function isFreeTier(settings) {
    const option = findOption(settings);
    if (!option?.free) return false;
    const steps = Number(settings?.steps);
    return Number.isFinite(steps) && steps <= FREE_STEPS_LIMIT;
}
