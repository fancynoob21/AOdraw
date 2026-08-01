// ════════════════════════════════════════════════════════════════════════════
// AOdraw —— 流式并行生图
// ════════════════════════════════════════════════════════════════════════════
//
// 传统生图工作流是串行的：等正文写完 → 渲染 → 提取 [img:] → 排队生成。
// 但 `[img: 1girl, smile]` 在流式传到 `]` 的那一刻就已经语义完整了，此时正文
// 往往才写了三分之一。本插件就是抓住那一刻，让生图时间被正文剩余的生成时间吃掉。
// ════════════════════════════════════════════════════════════════════════════

import { renderExtensionTemplateAsync } from '../../../extensions.js';
import * as cache from './src/cache.js';
import {
    DEFAULT_PATTERN, FREE_STEPS_LIMIT, getSettings, invalidatePattern, isFreeTier,
    LOG_PREFIX, saveSettings, SIZE_OPTIONS, sizeValueOf,
} from './src/config.js';
import { testConnection } from './src/nai-client.js';
import * as pipeline from './src/pipeline.js';
import { hydrateAll } from './src/renderer.js';
import { install as installWiring } from './src/wiring.js';

/**
 * 从自身 URL 推导扩展目录名，而不是写死。
 *
 * SillyTavern 安装扩展时用的是**仓库名**作为文件夹名，所以这个名字取决于
 * 用户从哪个 repo 装的，写死一定会在别人机器上加载不出设置面板。
 * （相对 import 不受影响 —— 那是相对文件的，与文件夹叫什么无关。）
 */
function detectExtensionFolder() {
    const m = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/(.+)\/index\.js$/);
    return m ? m[1] : 'third-party/AOdraw';
}

const EXT_FOLDER = detectExtensionFolder();

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
    ['aod_enabled', 'enabled', 'bool'],
    ['aod_api_key', 'apiKey', 'str'],
    ['aod_positive', 'positivePrefix', 'str'],
    ['aod_negative', 'negativePrefix', 'str'],
    // width / height 不在这里 —— 它们由 aod_size 下拉一起写入，见 bindSizeSelect()
    ['aod_steps', 'steps', 'int'],
    ['aod_scale', 'scale', 'num'],
    ['aod_seed', 'seed', 'int'],
    ['aod_sampler', 'sampler', 'str'],
    ['aod_scheduler', 'scheduler', 'str'],
    ['aod_variety_boost', 'varietyBoost', 'bool'],
    ['aod_cooldown_min', 'cooldownMin', 'int'],
    ['aod_cooldown_max', 'cooldownMax', 'int'],
    ['aod_timeout', 'timeout', 'int'],
    ['aod_ttl_days', 'ttlDays', 'int'],
    ['aod_live_preview', 'livePreview', 'bool'],
    ['aod_pattern', 'pattern', 'str'],
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
            if (key === 'steps') updateSizeHint(); // 免费额度还取决于 steps
        });
    }

    bindSizeSelect();

    const guideline = document.getElementById('aod_guideline');
    if (guideline) guideline.value = IMG_GUIDELINE;

    document.getElementById('aod_test_key')?.addEventListener('click', onTestKey);
    document.getElementById('aod_clear_cache')?.addEventListener('click', onClearCache);

    void refreshCacheStats();
}

/**
 * 尺寸下拉。
 *
 * 存进设置的仍是 width / height 两个数（报文要的就是它们），下拉只是它们的
 * 一个受约束的入口 —— NovelAI 只接受特定尺寸组合，开放输入框只会让人撞上
 * 「看着合理但服务端不收」的值。
 */
function bindSizeSelect() {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('aod_size'));
    if (!select) return;

    const settings = getSettings();

    for (const option of SIZE_OPTIONS) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.free ? `${option.label} · 免费` : option.label;
        select.appendChild(el);
    }

    // 反查当前 width/height 属于哪个选项；旧配置或手改过的值会落回默认
    select.value = sizeValueOf(settings);
    const resolved = SIZE_OPTIONS.find(o => o.value === select.value);
    if (resolved && (settings.width !== resolved.width || settings.height !== resolved.height)) {
        settings.width = resolved.width;
        settings.height = resolved.height;
        saveSettings();
    }

    select.addEventListener('change', () => {
        const picked = SIZE_OPTIONS.find(o => o.value === select.value);
        if (!picked) return;
        settings.width = picked.width;
        settings.height = picked.height;
        saveSettings();
        updateSizeHint();
    });

    updateSizeHint();
}

/** 免费额度同时取决于尺寸和 steps，所以两边改动都要刷新这行提示 */
function updateSizeHint() {
    const hint = document.getElementById('aod_size_hint');
    if (!hint) return;

    const settings = getSettings();
    if (isFreeTier(settings)) {
        hint.textContent = `✅ Opus 订阅下这个组合是无限免费的（steps ≤ ${FREE_STEPS_LIMIT}）。`;
        return;
    }

    const option = SIZE_OPTIONS.find(o => o.value === sizeValueOf(settings));
    hint.textContent = option?.free
        ? `⚠️ 这个尺寸本身免费，但 steps = ${settings.steps} 超过了 ${FREE_STEPS_LIMIT}，会消耗 Anlas。`
        : '⚠️ 这个尺寸超出 Opus 免费额度，每张都会消耗 Anlas。';
}

async function onTestKey() {
    const out = document.getElementById('aod_test_result');
    const button = document.getElementById('aod_test_key');
    if (!out) return;

    out.textContent = '测试中（会真的生成一张 512×512 / 1 step 的图）...';
    button?.classList.add('disabled');
    try {
        const settings = getSettings();
        const r = await testConnection(settings.apiKey, settings);
        out.textContent = r.bytes > 0
            // 走通到这里意味着认证、报文形状、ZIP 解包三段全部验证过了
            ? `✅ Key 有效，已成功生成并解包一张图（${(r.bytes / 1024).toFixed(0)} KB）`
            : '⚠️ Key 有效，但 Anlas 不足';
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
    const out = document.getElementById('aod_cache_stats');
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
