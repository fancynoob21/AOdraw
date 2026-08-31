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
    DEFAULT_PATTERN, FREE_STEPS_LIMIT, getSettings, HISTORY_DEPTH_OPTIONS,
    invalidatePattern, isFreeTier, LOG_PREFIX, MODEL_OPTIONS, saveSettings,
    SIZE_OPTIONS, sizeValueOf,
} from './src/config.js';
import { generate, testConnection } from './src/nai-client.js';
import { formatErrors, validateFields } from './src/validate.js';
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

export const IMG_GUIDELINE = `当剧情出现值得定格的画面时，在该段落后生成：
[img: ...]
遵循以下规则。
RULES FOR [img: ...]

FORMAT: base prompt | character1 | character2
Single character also needs |. No comma touching |.
OK: sunset | girl,    WRONG: sunset, | girl,

TOKEN LIMIT: <410. If over, cut: atmosphere > adjectives > minor actions > minor details. Never cut character ID or count tags.

RULE: Tag what you see. No natural language sentences. No subjective tags (sexy, cute). Use Danbooru compound tags (princess carry, not carry + princess). Max 2 tags per concept.

WEIGHT SYNTAX: numerical only. 1.5::tag :: to strengthen. 0.5::tag :: to weaken. -1::tag :: to remove/invert. No {} no []. Parentheses only in character names: changli (wuthering waves).

=== BASE PROMPT (before first |) ===

Note: NO quality tags needed, e.g best quality, aestheric, etc.
Order: nsfw (if applicable), count tag, scene.

Count tags: 1girl, solo / 2girls / 1boy, 1girl etc. Futa = girl.
Count tags ONLY here, never after |.
No-person scenes: no humans, scene tags. No | needed.

Scene: location + time + light + tone + depth. Short phrases only.
Example: outdoors, park, sunset, warm lighting, blurred background

=== CHARACTER PROMPT (after |) ===

Start each with: girl, / boy, / other, (no number prefix).
OK: girl, changli (wuthering waves)
WRONG: 1girl, changli (wuthering waves)

Multiple characters: left-to-right order in image.

KNOWN CHARACTER (default look): name (series), age, action, expression. DO NOT write hair color, eye color, default outfit, default accessories.
Note: Age tag is optional for KNOWN CHARACTER, depends on if content requires character to be at certain age criteria. Use aged down / aged up and baby/petite/...etc.

KNOWN CHARACTER (changed look): name (series), age, alternate costume, new appearance, new outfit, action, expression. Nude scene: must write nude. To remove default accessory: -1::hat ::

Name format:
OK: yangyang (wuthering waves)
WRONG: yangyang, wuthering waves
WRONG: yangyang_(wuthering_waves)

ORIGINAL/NPC CHARACTER: always full description: gender, age, hairstyle, hair color, eye color, body type, outfit, accessories, action, expression. Never abbreviate.
For underaged charcters, such as babies and children, also add tags that reflect the age, such as big eyes.

Futa: if there is a "penis," tag, add 2::no testicles ::, after it.

=== ACTION TAGS ===
Whenever their is an interation, e.g Holding hand, hug, pointing at another, sex, etc. Use action tags to label source, target, or mutual.
source#action = doer. target#action = receiver. mutual#action = both.
Syntax: source#hug. NOT source: hug, NOT source_hug.

=== EXAMPLES ===
SFW example:
2girls, indoors, factory, night, fog, industrial lights, pipes, light particles, cardboard box, aesthetic, best quality, english text, text | girl, purple eyes, short hair, smile, open mouth, ruffled blouse, red blouse, pleated skirt, blonde hair, green scarf, hands on own hips, blunt bangs, blue skirt, medium skirt, small breasts, bob cut, target#pointing, long sleeves, red nails, fang, cowboy shot. She is being pointed at. | girl, very long hair, purple hair, curly hair, white jeans, white pants, golden shirt, cowboy shot, green eyes, turtleneck sweater, sleeveless turtleneck, side braid, medium breasts, sleeveless, ripped jeans, wavy mouth, blush, purple nails, open mouth, source#pointing at another.
NSFW example 1：
nsfw, 1girl 1boy,summer theme, warm lighting, beach background, rough sex, nude, | girl, futanari, female rover (wuthering waves), hair down, wet skin, ahegao, saliva, arm behind head, medium penis, 2::no testicles::, anvil position, target#sex, barefoot, wet pussy, stomach bulge, cum on breast, cum on face, cum on stomach, cum on pussy, looking at another. | boy, male rover (wuthering waves), source#sex, pov, gigantic penis
NSFW example 2:
nsfw, 1girl 1boy,indoor, sex club, purple led, on velvet couch,rough sex, nude, side view | girl, futanari,female rover (wuthering waves), hair down, wet skin, ahegao, saliva, medium penis,no testicles, cowgirl position, target#sex, barefoot, wet pussy, stomach bulge, cum on breast, cum on pussy, source#hug, she is hugging another's neck. | boy, male rover (wuthering waves), tall, muscular body, nude, smirking, sitting on couch, cum on belly,source#sex, gigantic penis, target#hug, his neck is hugged by the girl
NSFW example 3:
nsfw, 2girls 1boy,indoor, sex hotel, luxurious bedroom, dim light, rough sex, nude, side view, group sex, spitroast, on bed | boy, male rover (wuthering waves), tall, muscular body, nude, smirking, target#fellatio, gigantic penis, source#head grab | girl, jinhsi (wuthering waves), nude, heart ahoge, barefoot, doggystyle, ahegao, source#fellatio, target#head grab, target#sex from behind, cum on face, cum on back, cum on beast, excessive pussy juice | girl, futanari, nude,female rover (wuthering waves), hair down, evil grin,on one knee, large penis, no testicles, source#sex from behind.

=== SELF-CHECK (run after every output) ===

1. No natural language sentences in tags.
2. No conflicting tags (from above + from below, sitting + running).
3. No scene tags after |. Scene goes in base prompt only.
4. No invented accessories not in character design.
5. looking at viewer = looking at camera ONLY. Not for characters looking at each other.
6. No count tags after |.
7. Known characters: no default appearance tags.
8. No {} or [] weight syntax. Use numerical :: only.
9. No comma next to |.
10. Are there any interactive actions, such as hug, kiss, sex? If so, are there any source#, target#, mutual# action tags?
11. Sequence follows left to right, top to bottom.
12. Under 410 tokens.`;

// ════════════════════════════════════════════════════════════════════════════
// 设置 UI
// ════════════════════════════════════════════════════════════════════════════

/** 输入控件 id → 设置键 + 类型 */
const FIELDS = [
    ['aod_enabled', 'enabled', 'bool'],
    ['aod_api_key', 'apiKey', 'str'],
    ['aod_model', 'model', 'str'],
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
    ['aod_history_depth', 'historyDepth', 'int'],
    ['aod_pattern', 'pattern', 'str'],
];

function readControl(input, type) {
    if (type === 'bool') return input.checked;
    if (type === 'int' || type === 'num') {
        // 留空就原样存空串，让校验层去报「不能为空」。
        // 这里绝不能悄悄换成默认值 —— 那样面板显示的和实际用的就对不上了。
        const raw = input.value.trim();
        if (raw === '') return '';
        const num = type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
        return Number.isFinite(num) ? num : raw;
    }
    return input.value;
}

function writeControl(input, type, value) {
    if (type === 'bool') input.checked = !!value;
    else input.value = value ?? '';
}

function bindSettingsUI() {
    const settings = getSettings();

    // 下拉的 option 必须先建好，否则后面 writeControl 设 value 会落空
    populateHistorySelect();
    populateModelSelect();

    for (const [id, key, type] of FIELDS) {
        const input = document.getElementById(id);
        if (!input) {
            console.warn(LOG_PREFIX, 'missing settings control', id);
            continue;
        }

        writeControl(input, type, settings[key]);

        input.addEventListener('change', () => {
            const value = readControl(input, type);
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
            refreshValidation();

            if (key === 'pattern' || key === 'enabled' || key === 'historyDepth') hydrateAll();
            if (key === 'steps') updateSizeHint(); // 免费额度还取决于 steps
        });
    }

    bindSizeSelect();
    bindTestGenerate();
    refreshValidation();

    const guideline = document.getElementById('aod_guideline');
    if (guideline) guideline.value = IMG_GUIDELINE;

    document.getElementById('aod_test_key')?.addEventListener('click', onTestKey);
    document.getElementById('aod_clear_cache')?.addEventListener('click', onClearCache);

    void refreshCacheStats();
}

/** 模型下拉，同样要先填好选项 */
function populateModelSelect() {
    const select = document.getElementById('aod_model');
    if (!select || select.options.length) return;
    for (const option of MODEL_OPTIONS) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = `${option.label} · ${option.value}`;
        select.appendChild(el);
    }
}

/** 历史深度是个下拉，选项要先填好才能被 writeControl 选中 */
function populateHistorySelect() {
    const select = document.getElementById('aod_history_depth');
    if (!select || select.options.length) return;
    for (const option of HISTORY_DEPTH_OPTIONS) {
        const el = document.createElement('option');
        el.value = String(option.value);
        el.textContent = option.label;
        select.appendChild(el);
    }
}

/** 设置键 → 面板控件 id，用于把校验错误标回对应的输入框 */
const KEY_TO_ID = Object.fromEntries(FIELDS.map(([id, key]) => [key, id]));

/**
 * 跑一遍校验，把问题标在对应输入框上并汇总到顶部。
 *
 * 默认值只是面板的**预填充**，不是后台的兜底 —— 用户清空了某个格子，
 * 就该看到报错，而不是让它在背后被换成一个自己没选过的值。
 */
function refreshValidation() {
    const settings = getSettings();
    const errors = validateFields(settings);

    for (const [key, id] of Object.entries(KEY_TO_ID)) {
        const input = document.getElementById(id);
        if (!input) continue;
        input.classList.toggle('aod-invalid', errors.some(e => e.key === key));
    }

    const banner = document.getElementById('aod_validation');
    if (!banner) return;

    if (!errors.length) {
        banner.hidden = true;
        banner.replaceChildren();
        return;
    }

    banner.hidden = false;
    banner.replaceChildren();
    const title = document.createElement('div');
    title.className = 'aod-validation-title';
    title.textContent = '参数有误，生图会被拒绝：';
    banner.appendChild(title);

    const list = document.createElement('ul');
    for (const e of errors) {
        const li = document.createElement('li');
        li.textContent = `${e.label} ${e.message}`;
        list.appendChild(li);
    }
    banner.appendChild(list);
}

/**
 * 「测试生图」：用面板上当前这套参数真的生成一张。
 *
 * 和「测试 Key」是两回事 —— 那个用固定的免费组合，只回答「Key 能不能用」；
 * 这个回答「我现在这套参数能不能出图」，包括尺寸、steps、前缀词全都算进去。
 */
function bindTestGenerate() {
    const button = document.getElementById('aod_test_generate');
    const input = /** @type {HTMLInputElement} */ (document.getElementById('aod_test_prompt'));
    const out = document.getElementById('aod_test_gen_result');
    const preview = document.getElementById('aod_test_gen_preview');
    if (!button || !input || !out || !preview) return;

    button.addEventListener('click', async () => {
        if (button.classList.contains('disabled')) return;

        const settings = getSettings();

        const errors = validateFields(settings);
        if (errors.length) {
            out.textContent = `❌ 参数有误：${formatErrors(errors)}`;
            refreshValidation();
            return;
        }
        if (!settings.apiKey) {
            out.textContent = '❌ 请先填入 API Key';
            return;
        }

        const prompt = input.value.trim() || input.placeholder;
        const free = isFreeTier(settings);

        button.classList.add('disabled');
        preview.hidden = true;
        preview.replaceChildren();
        out.textContent = free ? '生成中（免费额度内）...' : '生成中（会消耗 Anlas）...';

        const startedAt = Date.now();
        try {
            const { blob, meta } = await generate({ prompt, settings });
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

            out.textContent = `✅ ${meta.width}×${meta.height} · seed ${meta.seed} · `
                + `${(blob.size / 1024).toFixed(0)} KB · 用时 ${seconds}s`
                + (free ? ' · 免费' : ' · 已消耗 Anlas');

            const img = document.createElement('img');
            // 预览是一次性的，页面刷新就没了；不进缓存，免得污染正文用的那套 hash
            img.src = URL.createObjectURL(blob);
            img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
            preview.appendChild(img);
            preview.hidden = false;
        } catch (e) {
            out.textContent = `❌ ${e?.message || '生成失败'}`;
        } finally {
            button.classList.remove('disabled');
        }
    });
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
