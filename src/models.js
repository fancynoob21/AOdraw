// ════════════════════════════════════════════════════════════════════════════
// 可选模型
// ════════════════════════════════════════════════════════════════════════════
//
// 这里的每一个 ID 都用真实 API 验证过：合法参数下都能返回可解包的 ZIP，
// 而且**用的是同一套 V4.5 形状的报文**（params_version 3 + v4_prompt +
// v4_negative_prompt）—— 所以支持多个模型不需要任何分支，只是换个字符串。
//
// 这跟 V3 的情况本质不同：V3 的报文结构完全不一样（角色词压平进 input、
// 没有 v4_prompt），那才值得为「只支持一个模型」买单。V5 和 V4.5 不是。
//
// 顺带记一下探测结论：`nai-diffusion-v5-full` 和 `nai-diffusion-5` 都会被
// NovelAI 明确回「model doesn't exist」，别再试这两个写法。
//
// 本文件不引 SillyTavern，可在 node 下单测。
// ════════════════════════════════════════════════════════════════════════════

export const MODEL_OPTIONS = [
    { value: 'nai-diffusion-5-full', label: 'V5 Full' },
    { value: 'nai-diffusion-5-curated', label: 'V5 Curated' },
    { value: 'nai-diffusion-4-5-full', label: 'V4.5 Full' },
];

export const DEFAULT_MODEL = 'nai-diffusion-5-full';

/**
 * 模型 ID 是否是我们验证过的那几个。
 * @param {any} value
 * @returns {boolean}
 */
export function isKnownModel(value) {
    return MODEL_OPTIONS.some(o => o.value === value);
}

/**
 * 取一个能用的模型 ID。
 *
 * 只用于诊断请求（测试连接）—— 那种请求要在面板参数填坏的时候也能验证 Key，
 * 所以这里允许回落。真实生成走的是校验，不会静默兜底。
 *
 * @param {any} value
 * @returns {string}
 */
export function resolveModel(value) {
    const id = String(value || '').trim();
    return id || DEFAULT_MODEL;
}
