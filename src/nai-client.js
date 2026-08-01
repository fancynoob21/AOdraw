// ════════════════════════════════════════════════════════════════════════════
// NovelAI 客户端 —— 只支持 nai-diffusion-4-5-full
// ════════════════════════════════════════════════════════════════════════════
//
// 刻意不做 V3 / Curated 分支：V3 的报文结构完全不同（角色词压平进 input、
// 没有 v4_prompt），双分支会让这个文件的复杂度翻倍而收益为零。
// ════════════════════════════════════════════════════════════════════════════

import { extractImageFromZip } from './unzip.js';
import { joinTags } from './util.js';

// 本模块刻意不 import config.js —— config 依赖 SillyTavern 的运行时，
// 引进来就没法在 node 下单测报文构造了。设置一律由调用方传入。
export const NAI_MODEL = 'nai-diffusion-4-5-full';

const NAI_ENDPOINT = 'https://image.novelai.net/ai/generate-image';
const MAX_SEED = 0xffffffff;
const TEST_TIMEOUT = 15000;

/** V4.5 的 variety boost 以 1216×832 为基准做缩放 */
const VARIETY_BOOST_BASE_PIXELS = 1216 * 832;

export const ErrorType = {
    AUTH: { code: 'auth', label: '认证', desc: 'API Key 无效或过期' },
    QUOTA: { code: 'quota', label: '额度', desc: 'Anlas 点数不足' },
    BUSY: { code: 'busy', label: '繁忙', desc: '当前并发繁忙，请稍后重试' },
    NETWORK: { code: 'network', label: '网络', desc: '连接失败或服务不可用' },
    TIMEOUT: { code: 'timeout', label: '超时', desc: '请求超时' },
    PARSE: { code: 'parse', label: '解析失败', desc: '响应不是预期的图片 ZIP' },
    ABORTED: { code: 'aborted', label: '已取消', desc: '请求被取消' },
    UNKNOWN: { code: 'unknown', label: '错误', desc: '未知错误' },
};

export class NaiError extends Error {
    constructor(message, errorType = ErrorType.UNKNOWN) {
        super(message);
        this.name = 'NaiError';
        this.errorType = errorType;
    }
}

/**
 * 从 NovelAI 的错误响应里抠出人能看懂的那句话。
 * 它一般回 `{"statusCode":500,"message":"..."}`，但也可能是纯文本。
 */
function extractApiMessage(text) {
    if (!text) return '';
    try {
        const json = JSON.parse(text);
        const msg = json?.message || json?.error || '';
        if (msg) return String(msg).slice(0, 300);
    } catch { /* 不是 JSON，按纯文本处理 */ }
    return String(text).slice(0, 300);
}

/**
 * HTTP 状态码 → 有意义的错误类型。
 * 分开是为了让 UI 能对不同失败给出不同的重试策略（额度不足重试也没用）。
 *
 * 5xx 一定要把服务端原话带出来。NovelAI 对**报文形状不合法**的请求也回 500，
 * 光显示「服务不可用」会让人以为是对面挂了，实际上是我们自己发错了。
 */
function parseApiError(status, text) {
    const detail = extractApiMessage(text);
    const suffix = detail ? `: ${detail}` : '';

    switch (status) {
        case 401: return new NaiError('API Key 无效', ErrorType.AUTH);
        case 402: return new NaiError('Anlas 不足', ErrorType.QUOTA);
        case 429: return new NaiError('并发繁忙，请稍后重试', ErrorType.BUSY);
        case 400: return new NaiError(`请求被拒绝 (400)${suffix}`, ErrorType.UNKNOWN);
        case 500:
        case 502:
        case 503:
        case 504: return new NaiError(`NovelAI 返回 ${status}${suffix}`, ErrorType.NETWORK);
        default: return new NaiError(`请求失败 ${status}${suffix}`, ErrorType.UNKNOWN);
    }
}

function wrapFetchError(e) {
    if (e instanceof NaiError) return e;
    if (e?.name === 'AbortError') return new NaiError('请求超时', ErrorType.TIMEOUT);
    if (String(e?.message || '').includes('Failed to fetch')) {
        return new NaiError('网络错误', ErrorType.NETWORK);
    }
    return new NaiError(e?.message || '未知错误', ErrorType.UNKNOWN);
}

/**
 * 构造 NAI 4.5 Full 的请求体。
 *
 * 有三个配置键在报文里换了名字，这是最容易踩的坑：
 *   scheduler    → noise_schedule
 *   decrisper    → dynamic_thresholding
 *   varietyBoost → skip_cfg_above_sigma（是个计算值，不是布尔）
 *
 * @param {object} o
 * @param {string} o.positive      完整正向 prompt（已含 positivePrefix）
 * @param {string} o.negative      完整负向 prompt
 * @param {object} o.params        来自设置的参数
 * @param {Array}  [o.characterPrompts] 预留：多角色。MVP 恒为空数组，
 *                                 后续填 `{ prompt, uc, center: {x, y} }`
 * @returns {object}
 */
export function buildRequestBody({ positive, negative, params, characterPrompts = [] }) {
    const width = Number(params.width) || 1216;
    const height = Number(params.height) || 832;
    const seed = Number(params.seed) >= 0
        ? Number(params.seed)
        : Math.floor(Math.random() * (MAX_SEED + 1));

    const skipCfgAboveSigma = params.varietyBoost
        ? Math.sqrt((width * height) / VARIETY_BOOST_BASE_PIXELS) * 58
        : null;

    // 任一角色被显式定位时才启用坐标模式
    const useCoords = characterPrompts.some(
        cp => cp.center && (cp.center.x !== 0.5 || cp.center.y !== 0.5),
    );

    const charCaptions = characterPrompts.map(cp => ({
        char_caption: cp.prompt || '',
        centers: [cp.center || { x: 0.5, y: 0.5 }],
    }));
    const negativeCharCaptions = characterPrompts.map(cp => ({
        char_caption: cp.uc || '',
        centers: [cp.center || { x: 0.5, y: 0.5 }],
    }));

    return {
        action: 'generate',
        input: String(positive || ''),
        model: NAI_MODEL,
        parameters: {
            params_version: 3,
            width,
            height,
            scale: Number(params.scale) || 6,
            seed,
            sampler: params.sampler || 'k_euler_ancestral',
            noise_schedule: params.scheduler || 'karras',
            steps: Number(params.steps) || 28,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: true,
            autoSmea: false,
            cfg_rescale: 0,
            dynamic_thresholding: false,
            controlnet_strength: 1,
            legacy: false,
            legacy_v3_extend: false,
            legacy_uc: false,
            use_coords: useCoords,
            normalize_reference_strength_multiple: true,
            deliberate_euler_ancestral_bug: false,
            prefer_brownian: true,
            image_format: 'png',
            skip_cfg_above_sigma: skipCfgAboveSigma,
            characterPrompts: characterPrompts.map(cp => ({
                prompt: cp.prompt || '',
                uc: cp.uc || '',
                center: cp.center || { x: 0.5, y: 0.5 },
                enabled: true,
            })),
            v4_prompt: {
                caption: {
                    base_caption: String(positive || ''),
                    char_captions: charCaptions,
                },
                use_coords: useCoords,
                use_order: true,
            },
            v4_negative_prompt: {
                caption: {
                    base_caption: String(negative || ''),
                    char_captions: negativeCharCaptions,
                },
                legacy_uc: false,
            },
            // v4_negative_prompt 之外仍要给这个平铺字段，NAI 两边都读
            negative_prompt: String(negative || ''),
        },
    };
}

/**
 * 生成一张图。
 *
 * @param {object} o
 * @param {string} o.prompt   从正文截出来的 prompt（不含 positivePrefix）
 * @param {object} o.settings 插件设置
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ blob: Blob, meta: object }>}
 */
export async function generate({ prompt, settings, signal }) {
    if (!settings.apiKey) {
        throw new NaiError('请先在设置里填入 NovelAI API Key', ErrorType.AUTH);
    }

    const positive = joinTags(settings.positivePrefix, prompt);
    const negative = settings.negativePrefix || '';
    const body = buildRequestBody({ positive, negative, params: settings });

    const controller = new AbortController();
    const timeout = Number(settings.timeout) > 0 ? Number(settings.timeout) : 60000;
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        if (signal?.aborted) throw new NaiError('已取消', ErrorType.ABORTED);

        const res = await fetch(NAI_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            throw parseApiError(res.status, await res.text().catch(() => ''));
        }

        const buffer = await res.arrayBuffer();
        let blob;
        try {
            blob = await extractImageFromZip(buffer);
        } catch (e) {
            throw new NaiError(e?.message || 'ZIP 解析失败', ErrorType.PARSE);
        }

        return {
            blob,
            meta: {
                seed: body.parameters.seed,
                width: body.parameters.width,
                height: body.parameters.height,
                model: NAI_MODEL,
            },
        };
    } catch (e) {
        // 用户主动取消和超时长得很像（都是 AbortError），靠外部 signal 区分
        if (signal?.aborted) throw new NaiError('已取消', ErrorType.ABORTED);
        throw wrapFetchError(e);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * 探针尺寸。
 *
 * 用 1024×1024 而不是更小的值：NovelAI 只接受特定的尺寸组合，随手挑一个
 * 「更省」的小尺寸反而可能被拒。而 1024×1024 配 1 step 正好落在 Opus 的
 * 无限免费额度内，所以这已经是最省的合法选择了。
 */
const TEST_SIZE = 1024;

/**
 * 连接测试：发一个 512×512 / 1 step 的真实请求。
 *
 * 关键是**必须复用 buildRequestBody**。曾经这里手搓过一个
 * `parameters: { width, height, steps }` 的精简报文 —— 那是 V3 的形状，
 * 而 model 是 V4.5，缺了 params_version / v4_prompt / sampler 这些必填字段，
 * NovelAI 直接回 500，于是一个完全有效的 Key 被报成「服务不可用」。
 * 让探针和真实生成走同一条构造路径，形状就不可能再对不上。
 *
 * 顺带把返回的 ZIP 也解一遍：这样「测试通过」意味着认证、报文形状、
 * ZIP 解包三段全都验证过了，而不只是认证。
 *
 * 1 step / 512×512 在 Opus 订阅下是免费额度内的；其他付费档位会消耗
 * 极少量 Anlas。
 *
 * @param {string} apiKey
 * @param {object} [settings] 用当前设置里的 sampler / scheduler 等，
 *                            这样测试覆盖的就是用户真正会用的那套参数
 * @returns {Promise<{ success: true, bytes: number, seed: number }>}
 */
export async function testConnection(apiKey, settings = {}) {
    if (!apiKey) throw new NaiError('请先填写 API Key', ErrorType.AUTH);

    const body = buildRequestBody({
        positive: 'test',
        negative: '',
        params: {
            ...settings,
            width: TEST_SIZE,
            height: TEST_SIZE,
            steps: 1,
            seed: 0,
            varietyBoost: false,
        },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT);

    try {
        const res = await fetch(NAI_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (res.status === 401) throw new NaiError('API Key 无效', ErrorType.AUTH);
        // 额度不足说明 Key 本身是好的，只是没钱了 —— 对「这个 Key 能不能用」
        // 这个问题来说算通过，UI 那边会单独提示。
        if (res.status === 402) return { success: true, bytes: 0, seed: -1 };
        if (!res.ok) throw parseApiError(res.status, await res.text().catch(() => ''));

        const buffer = await res.arrayBuffer();
        const blob = await extractImageFromZip(buffer);
        return { success: true, bytes: blob.size, seed: body.parameters.seed };
    } catch (e) {
        throw wrapFetchError(e);
    } finally {
        clearTimeout(timer);
    }
}
