// ════════════════════════════════════════════════════════════════════════════
// API 请求地址
// ════════════════════════════════════════════════════════════════════════════
//
// 默认打 NovelAI 官方。用户也可以填一个第三方地址（中转 / 反代 / 自建），
// 请求就改发到那里。
//
// 换的只是「发给谁」，不是「发什么」：第三方必须兼容 NovelAI 的
// /ai/generate-image —— 同样的 JSON 报文、同样的 Bearer 认证头、回一个装着图片的
// ZIP。报文构造和 ZIP 解包那两段完全不知道地址被换过。
//
// 本文件不引 SillyTavern，可在 node 下单测。
// ════════════════════════════════════════════════════════════════════════════

/** NovelAI 的生图路径 */
export const GENERATE_PATH = '/ai/generate-image';

export const DEFAULT_ENDPOINT = `https://image.novelai.net${GENERATE_PATH}`;

/**
 * 把用户填的 API 地址变成真正要请求的 URL。
 *
 * 留空就是官方地址 —— 这是一个有明确含义的选项（面板上也是这么写的），
 * 不是「填坏了悄悄兜底」：填了但不合法时返回 null，由校验层报出来。
 *
 * 没写路径时补上 NovelAI 的生图路径。第三方给的往往就是一个域名，
 * 意思是「把 image.novelai.net 换成它」；域名后面只跟了查询参数的也一样。
 * 带了路径就一个字都不改 —— 第三方的路径可以和 NovelAI 不一样，
 * 我们猜不到，也不该猜。
 *
 * @param {any} raw
 * @returns {string | null} 最终请求地址；填了但不合法时为 null
 */
export function resolveEndpoint(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return DEFAULT_ENDPOINT;

    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }

    // 漏写协议的 `localhost:8080` 能被 URL 解析（协议成了 `localhost:`），
    // 所以光靠「能不能解析」不够，协议必须点名检查
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // 账号密码写在地址里的 URL，fetch 会直接拒绝构造请求。放它过校验的话，
    // 要等真正发请求时才冒出一句看不懂的 TypeError，所以在这里就拦下
    if (url.username || url.password) return null;

    if (url.pathname === '/') {
        url.pathname = GENERATE_PATH;
        url.hash = '';
        return url.href;
    }

    return text;
}

const OFFICIAL_HOST = new URL(DEFAULT_ENDPOINT).hostname;

/**
 * 当前是不是在用第三方地址。
 *
 * 界面上所有关于 Anlas / Opus 免费额度的说法都只对官方成立，
 * 用第三方时计费是对方说了算，这些提示要跟着换掉。
 *
 * 认的是主机而不是整串地址：把官方地址多打一个斜杠、换个大小写，
 * 打到的仍然是 NovelAI。
 *
 * @param {any} raw
 * @returns {boolean}
 */
export function isCustomEndpoint(raw) {
    const resolved = resolveEndpoint(raw);
    return resolved !== null && new URL(resolved).hostname !== OFFICIAL_HOST;
}
