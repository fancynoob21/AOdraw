// ════════════════════════════════════════════════════════════════════════════
// StreamDraw —— 流式并行生图
// ════════════════════════════════════════════════════════════════════════════
//
// 传统生图工作流是串行的：等正文写完 → 渲染 → 提取 [img:] → 排队生成。
// 但 `[img: 1girl, smile]` 在流式传到 `]` 的那一刻就已经语义完整了，此时正文
// 往往才写了三分之一。本插件就是抓住那一刻，让生图时间被正文剩余的生成时间吃掉。
// ════════════════════════════════════════════════════════════════════════════

import { renderExtensionTemplateAsync } from '../../../extensions.js';
import * as cache from './src/cache.js';
import {
    DEFAULT_PATTERN, getSettings, invalidatePattern, LOG_PREFIX, saveSettings,
} from './src/config.js';
import { testConnection } from './src/nai-client.js';
import * as pipeline from './src/pipeline.js';
import { hydrateAll } from './src/renderer.js';
import { install as installWiring } from './src/wiring.js';

const EXT_FOLDER = 'third-party/StreamDraw';

export const IMG_GUIDELINE = `## 图片
需要展示画面时，在正文中穿插以下格式：
[img: Subject, Appearance, Background, Atmosphere, Extra descriptors]
- tag 必须为英文，逗号分隔，使用 Danbooru 风格，5-15 个 tag
- 第一个 tag 固定为人物数量标签，如: 1girl, 1boy, 2girls, solo
- 多张图片每行一个 [img: ...]
- 尺度较大的内容加上 nsfw 相关 tag`;

// ════════════════════════════════════════════════════════════════════════════
// 设置 UI
// ════════════════════════════════════════════════════════════════════════════

/** 输入控件 id → 设置键 + 类型 */
const FIELDS = [
    ['sd_enabled', 'enabled', 'bool'],
    ['sd_api_key', 'apiKey', 'str'],
    ['sd_positive', 'positivePrefix', 'str'],
    ['sd_negative', 'negativePrefix', 'str'],
    ['sd_width', 'width', 'int'],
    ['sd_height', 'height', 'int'],
    ['sd_steps', 'steps', 'int'],
    ['sd_scale', 'scale', 'num'],
    ['sd_seed', 'seed', 'int'],
    ['sd_sampler', 'sampler', 'str'],
    ['sd_scheduler', 'scheduler', 'str'],
    ['sd_variety_boost', 'varietyBoost', 'bool'],
    ['sd_cooldown_min', 'cooldownMin', 'int'],
    ['sd_cooldown_max', 'cooldownMax', 'int'],
    ['sd_timeout', 'timeout', 'int'],
    ['sd_ttl_days', 'ttlDays', 'int'],
    ['sd_live_preview', 'livePreview', 'bool'],
    ['sd_pattern', 'pattern', 'str'],
];

function readControl(input, type) {
    if (type === 'bool') return input.checked;
    if (type === 'int') return parseInt(input.value, 10);
    if (type === 'num') return parseFloat(input.value);
    return input.value;
}

function writeControl(input, type, value) {
    if (type === 'bool') input.checked = !!value;
    else input.value = value ?? '';
}

function bindSettingsUI() {
    const settings = getSettings();

    for (const [id, key, type] of FIELDS) {
        const input = document.getElementById(id);
        if (!input) {
            console.warn(LOG_PREFIX, 'missing settings control', id);
            continue;
        }

        writeControl(input, type, settings[key]);

        input.addEventListener('change', () => {
            const value = readControl(input, type);

            // 数字框被清空时 parse 出 NaN，别把设置写坏
            if ((type === 'int' || type === 'num') && !Number.isFinite(value)) {
                writeControl(input, type, settings[key]);
                return;
            }

            settings[key] = value;

            if (key === 'pattern') {
                // 空串或写错的正则，回落到默认值并把输入框改回去，让用户看得见
                invalidatePattern();
                if (!String(value).trim()) {
                    settings.pattern = DEFAULT_PATTERN;
                    writeControl(input, type, DEFAULT_PATTERN);
                    invalidatePattern();
                }
            }

            saveSettings();

            if (key === 'pattern' || key === 'enabled') hydrateAll();
        });
    }

    const guideline = document.getElementById('sd_guideline');
    if (guideline) guideline.value = IMG_GUIDELINE;

    document.getElementById('sd_test_key')?.addEventListener('click', onTestKey);
    document.getElementById('sd_clear_cache')?.addEventListener('click', onClearCache);

    void refreshCacheStats();
}

async function onTestKey() {
    const out = document.getElementById('sd_test_result');
    const button = document.getElementById('sd_test_key');
    if (!out) return;

    out.textContent = '测试中...';
    button?.classList.add('disabled');
    try {
        await testConnection(getSettings().apiKey);
        out.textContent = '✅ Key 有效';
    } catch (e) {
        out.textContent = `❌ ${e?.message || '失败'}`;
    } finally {
        button?.classList.remove('disabled');
    }
}

async function onClearCache() {
    await cache.clearAll();
    pipeline.dispose();
    hydrateAll();
    await refreshCacheStats();
}

async function refreshCacheStats() {
    const out = document.getElementById('sd_cache_stats');
    if (!out) return;
    const { count, bytes } = await cache.stats();
    out.textContent = `缓存 ${count} 张，${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ════════════════════════════════════════════════════════════════════════════
// 启动
// ════════════════════════════════════════════════════════════════════════════

jQuery(async () => {
    try {
        const settings = getSettings();

        const html = await renderExtensionTemplateAsync(EXT_FOLDER, 'settings');
        const mount = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (mount) {
            mount.insertAdjacentHTML('beforeend', html);
            bindSettingsUI();
        } else {
            console.warn(LOG_PREFIX, 'no settings mount point found');
        }

        // override 表要在第一次注水之前进内存 —— renderer 需要同步读它来算生效 hash
        await cache.loadOverrides();
        void cache.sweep(settings.ttlDays);

        installWiring();
        hydrateAll();

        console.log(LOG_PREFIX, 'ready');
    } catch (e) {
        console.error(LOG_PREFIX, 'init failed', e);
    }
});
