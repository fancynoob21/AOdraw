// ════════════════════════════════════════════════════════════════════════════
// NovelAI 客户端 —— V5 / V4.5
// ════════════════════════════════════════════════════════════════════════════
//
// 支持的模型见 models.js。它们共用同一套报文形状，所以这里没有按模型分支。
//
// 刻意不支持 V3：V3 的报文结构完全不同（角色词压平进 input、没有 v4_prompt），
// 那才需要一整条独立代码路径，复杂度翻倍而收益为零。
// ════════════════════════════════════════════════════════════════════════════

import { isCustomEndpoint, resolveEndpoint } from './endpoint.js';
import { extractImageFromZip } from './unzip.js';
import { joinTags } from './util.js';
import { resolveModel } from './models.js';
import { formatErrors, REQUEST_FIELDS, validateFields } from './validate.js';

// 本模块刻意不 import config.js —— config 依赖 SillyTavern 的运行时，
// 引进来就没法在 node 下单测报文构造了。设置一律由调用方传入。
//
// 请求地址也是设置的一部分（apiEndpoint），见 endpoint.js：留空打官方，
// 填了就打第三方。

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
    CONFIG: { code: 'config', label: '参数有误', desc: '设置里的参数缺失或非法' },
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
 *
 * @param {number} status
 * @param {string} text
 * @param {{ url: string, custom: boolean }} endpoint
 *        请求发给了谁。发给第三方的话措辞要跟着换 ——
 *        第三方的错不能说成「NovelAI 返回」，额度也不叫 Anlas。
 */
function parseApiError(status, text, endpoint) {
    const { url, custom } = endpoint;
    const detail = extractApiMessage(text);
    const suffix = detail ? `: ${detail}` : '';

    // 第三方地址回 404 / 405，几乎总是地址本身填错了（路径不对）。
    // 归到 CONFIG：队列会整条清掉，免得后面每张图都去撞一次同一个错地址。
    // 把实际请求的地址带上 —— 只填域名时路径是我们补的，得让人看见补成了什么。
    if (custom && (status === 404 || status === 405)) {
        return new NaiError(
            `请求失败 ${status}，请检查 API 地址是否填对（实际请求：${url}）${suffix}`,
            ErrorType.CONFIG,
        );
    }

    switch (status) {
        case 401: return new NaiError('API Key 无效', ErrorType.AUTH);
        case 402: return new NaiError(custom ? '额度不足 (402)' : 'Anlas 不足', ErrorType.QUOTA);
        case 429: return new NaiError('并发繁忙，请稍后重试', ErrorType.BUSY);
        case 400: return new NaiError(`请求被拒绝 (400)${suffix}`, ErrorType.UNKNOWN);
        case 500:
        case 502:
        case 503:
        case 504: return new NaiError(
            `${custom ? '第三方接口' : 'NovelAI'} 返回 ${status}${suffix}`, ErrorType.NETWORK,
        );
        default: return new NaiError(`请求失败 ${status}${suffix}`, ErrorType.UNKNOWN);
    }
}

/**
 * 「请求根本没发出去」在各家浏览器里的说法：
 * Chromium 是 Failed to fetch，Firefox 是 NetworkError ...，Safari 是 Load failed，
 * Node 是 fetch failed。
 */
const NETWORK_FAILURE = /Failed to fetch|NetworkError|Load failed|fetch failed/i;

function wrapFetchError(e, endpoint) {
    if (e instanceof NaiError) return e;
    if (e?.name === 'AbortError') return new NaiError('请求超时', ErrorType.TIMEOUT);
    if (NETWORK_FAILURE.test(String(e?.message || ''))) {
        // 浏览器对「连不上」和「对方没放行跨域」给的是同一句话，分不出来。
        // 官方地址不存在跨域问题，所以只在第三方地址下把这种可能点出来。
        return new NaiError(
            endpoint.custom ? '网络错误：连不上 API 地址，或对方没有允许跨域请求 (CORS)' : '网络错误',
            ErrorType.NETWORK,
        );
    }
    return new NaiError(e?.message || '未知错误', ErrorType.UNKNOWN);
}

/**
 * 取出本次请求要打的地址。
 *
 * 地址填错属于参数非法，和 buildRequestBody 里的校验一个待遇：
 * 报 CONFIG、点名字段、不发请求。
 *
 * @param {object} settings
 * @param {string[]} [alongside] 要和地址一起校验的其他字段。传进来是为了
 *        一次把所有出问题的字段都报出来，而不是修好一个才冒出下一个。
 * @returns {{ url: string, custom: boolean }}
 */
function requireEndpoint(settings, alongside = []) {
    const errors = validateFields(settings, ['apiEndpoint', ...alongside]);
    if (errors.length) {
        throw new NaiError(`参数有误 — ${formatErrors(errors)}`, ErrorType.CONFIG);
    }
    return {
        url: resolveEndpoint(settings?.apiEndpoint),
        custom: isCustomEndpoint(settings?.apiEndpoint),
    };
}

/**
 * 解开响应里的 ZIP。
 *
 * 第三方接口最常见的不兼容就在这一步：状态码是 200，回来的却是 JSON 或一张裸图。
 * 只报「找不到 EOCD」没人看得懂，所以把话说明白。
 *
 * @param {ArrayBuffer} buffer
 * @param {{ url: string, custom: boolean }} endpoint
 * @returns {Promise<Blob>}
 */
async function unzipImage(buffer, endpoint) {
    try {
        return await extractImageFromZip(buffer);
    } catch (e) {
        const hint = endpoint.custom ? '（第三方接口返回的不是 NovelAI 格式的图片 ZIP）' : '';
        throw new NaiError(`${e?.message || 'ZIP 解析失败'}${hint}`, ErrorType.PARSE);
    }
}

/**
 * 构造请求体。
 *
 * V4.5 和 V5 用的是同一套形状（params_version 3 + v4_prompt / v4_negative_prompt），
 * 所以这里没有按模型分支 —— 三个可选模型都用真实 API 验证过。
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
    // 不做静默兜底。参数缺失或非法就报出来 —— 悄悄换成一个用户没选过的值，
    // 会让生成结果和面板显示的参数对不上，且毫无提示。
    const errors = validateFields(params, REQUEST_FIELDS);
    if (errors.length) {
        throw new NaiError(`参数有误 — ${formatErrors(errors)}`, ErrorType.CONFIG);
    }

    const width = Number(params.width);
    const height = Number(params.height);
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
        model: String(params.model),
        parameters: {
            params_version: 3,
            width,
            height,
            scale: Number(params.scale),
            seed,
            sampler: params.sampler,
            noise_schedule: params.scheduler,
            steps: Number(params.steps),
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
        throw new NaiError('请先在设置里填入 API Key', ErrorType.AUTH);
    }

    // 地址和报文字段一起校验：两边都填坏了的话，一次全报出来
    const endpoint = requireEndpoint(settings, REQUEST_FIELDS);
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

        const res = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            throw parseApiError(res.status, await res.text().catch(() => ''), endpoint);
        }

        const blob = await unzipImage(await res.arrayBuffer(), endpoint);

        return {
            blob,
            meta: {
                seed: body.parameters.seed,
                width: body.parameters.width,
                height: body.parameters.height,
                model: body.model,
            },
        };
    } catch (e) {
        // 用户主动取消和超时长得很像（都是 AbortError），靠外部 signal 区分
        if (signal?.aborted) throw new NaiError('已取消', ErrorType.ABORTED);
        throw wrapFetchError(e, endpoint);
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
 * @param {object} [settings] 用当前设置里的 model / sampler / scheduler，
 *                            这样测试覆盖的就是用户真正会用的那套参数。
 *                            apiEndpoint 也从这里取 —— 填了第三方地址的话，
 *                            测的就是那个地址通不通、兼不兼容。
 * @returns {Promise<{ success: true, bytes: number, seed: number }>}
 */
export async function testConnection(apiKey, settings = {}) {
    if (!apiKey) throw new NaiError('请先填写 API Key', ErrorType.AUTH);

    // 地址没有「已知可用的值」可以顶替 —— 换成官方就不是在测用户填的那个了。
    // 所以它和下面的 sampler / scheduler 不同，填坏了就直接报错。
    const endpoint = requireEndpoint(settings);

    // 这是一个诊断请求，要能在面板参数填坏的时候照常验证 Key，
    // 所以 sampler / scheduler 只在用户填了有效值时才沿用，否则用已知可用的值。
    const body = buildRequestBody({
        positive: 'test',
        negative: '',
        params: {
            model: resolveModel(settings.model),
            sampler: String(settings.sampler || '').trim() || 'k_euler_ancestral',
            scheduler: String(settings.scheduler || '').trim() || 'karras',
            width: TEST_SIZE,
            height: TEST_SIZE,
            steps: 1,
            seed: 0,
            scale: 5.5,
            varietyBoost: false,
        },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT);

    try {
        const res = await fetch(endpoint.url, {
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
        if (!res.ok) {
            throw parseApiError(res.status, await res.text().catch(() => ''), endpoint);
        }

        const blob = await unzipImage(await res.arrayBuffer(), endpoint);
        return { success: true, bytes: blob.size, seed: body.parameters.seed };
    } catch (e) {
        throw wrapFetchError(e, endpoint);
    } finally {
        clearTimeout(timer);
    }
}
