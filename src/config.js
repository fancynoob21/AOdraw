// ════════════════════════════════════════════════════════════════════════════
// 设置：默认值、读写、pattern 编译
// ════════════════════════════════════════════════════════════════════════════

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { compilePattern } from './util.js';

export const EXT_ID = 'AOdraw';
export const LOG_PREFIX = '[AOdraw]';

/** 默认截取格式。必须含捕获组 1 = prompt，且必须要求闭合 `]`。 */
export const DEFAULT_PATTERN = '\\[(?:img|图片)\\s*:\\s*([^\\]]+)\\]';

// 尺寸相关的纯逻辑放在 sizes.js 里（那边不依赖 SillyTavern，可单测），
// 这里转出去，调用方不必关心它住在哪
export {
    DEFAULT_SIZE, FREE_STEPS_LIMIT, isFreeTier, SIZE_OPTIONS, sizeValueOf,
} from './sizes.js';
export {
    DEFAULT_HISTORY_DEPTH, HISTORY_ALL, HISTORY_DEPTH_OPTIONS, hydrateStartIndex,
} from './history.js';
export { DEFAULT_MODEL, isKnownModel, MODEL_OPTIONS, resolveModel } from './models.js';

export const DEFAULT_SETTINGS = {
    enabled: true,
    pattern: DEFAULT_PATTERN,

    // ── NovelAI ──
    apiKey: '',
    model: 'nai-diffusion-5-full',
    positivePrefix: 'best quality, amazing quality, very aesthetic, absurdres,',
    negativePrefix: 'lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
    steps: 28,        // Opus 免费额度的上限，超过就开始计费
    scale: 5.5,       // NovelAI 界面里叫 Prompt Guidance
    width: 1216,      // 由尺寸下拉写入，不单独暴露输入框
    height: 832,
    seed: -1,         // -1 = 每次随机
    sampler: 'k_euler_ancestral',
    scheduler: 'karras', // → 报文里的 noise_schedule
    varietyBoost: false, // → 报文里的 skip_cfg_above_sigma（计算值）
    timeout: 60000,

    // ── 队列 ──
    cooldownMin: 5000,
    cooldownMax: 10000,

    // ── 缓存 ──
    ttlDays: 7, // 0 = 永不过期

    // ── 渲染 ──
    livePreview: true,
    historyDepth: 5, // 除最新楼层外，还渲染多少个过去楼层；-1 = 全部
};

/** 改名前的设置键。留着只为把 API Key 之类搬过来，之后可以删。 */
const LEGACY_EXT_ID = 'StreamDraw';

/** scale 的旧默认值。等于它说明用户没动过，可以安全地跟着新默认值走。 */
const LEGACY_DEFAULT_SCALE = 6;

/** @returns {typeof DEFAULT_SETTINGS} */
export function getSettings() {
    if (!extension_settings[EXT_ID]) {
        // 从改名前的键搬迁。主要是为了不让用户重填 API Key。
        const legacy = extension_settings[LEGACY_EXT_ID];
        if (legacy && typeof legacy === 'object') {
            extension_settings[EXT_ID] = { ...structuredClone(DEFAULT_SETTINGS), ...legacy };
            // 用户没改过 scale 的话，让它跟上新的默认值 5.5；
            // 改过就尊重用户的选择。
            if (Number(legacy.scale) === LEGACY_DEFAULT_SCALE) {
                extension_settings[EXT_ID].scale = DEFAULT_SETTINGS.scale;
            }
            delete extension_settings[LEGACY_EXT_ID];
        } else {
            extension_settings[EXT_ID] = structuredClone(DEFAULT_SETTINGS);
        }
    }
    // 补齐新增字段（用户从旧版本升上来时）
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXT_ID][key] === undefined) {
            extension_settings[EXT_ID][key] = value;
        }
    }
    return extension_settings[EXT_ID];
}

export function saveSettings() {
    saveSettingsDebounced();
}

// pattern 每次渲染都要用，编译结果按源串缓存，避免重复 new RegExp
let patternCacheKey = null;
let patternCacheValue = null;

/**
 * 取当前生效的截取正则。
 *
 * 返回的是**同一个 RegExp 实例**，它带 `g` 标志因而有可变的 `lastIndex` ——
 * 所有使用者都必须在循环前自行把 `lastIndex` 归零。scanner 和 renderer 都这么做了。
 *
 * @returns {RegExp}
 */
export function getPattern() {
    const source = getSettings().pattern || DEFAULT_PATTERN;
    if (source === patternCacheKey && patternCacheValue) {
        return patternCacheValue;
    }
    const compiled = compilePattern(source) || compilePattern(DEFAULT_PATTERN);
    patternCacheKey = source;
    patternCacheValue = compiled;
    return compiled;
}

/** 用户改了 pattern 之后调用，丢掉编译缓存 */
export function invalidatePattern() {
    patternCacheKey = null;
    patternCacheValue = null;
}
