// ════════════════════════════════════════════════════════════════════════════
// 设置：默认值、读写、pattern 编译
// ════════════════════════════════════════════════════════════════════════════

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { compilePattern } from './util.js';

export const EXT_ID = 'StreamDraw';
export const LOG_PREFIX = '[StreamDraw]';

/** 默认截取格式。必须含捕获组 1 = prompt，且必须要求闭合 `]`。 */
export const DEFAULT_PATTERN = '\\[(?:img|图片)\\s*:\\s*([^\\]]+)\\]';

export const DEFAULT_SETTINGS = {
    enabled: true,
    pattern: DEFAULT_PATTERN,

    // ── NovelAI ──
    apiKey: '',
    positivePrefix: 'best quality, amazing quality, very aesthetic, absurdres,',
    negativePrefix: 'lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
    steps: 28,
    scale: 6,
    width: 1216,
    height: 832,
    seed: -1, // -1 = 每次随机
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
};

/** @returns {typeof DEFAULT_SETTINGS} */
export function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = structuredClone(DEFAULT_SETTINGS);
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
