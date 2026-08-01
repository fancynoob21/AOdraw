// ════════════════════════════════════════════════════════════════════════════
// 无 DOM 依赖的纯工具函数（可在 node 下直接单测）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 64 位 FNV-1a，返回 16 位十六进制字符串。
 *
 * 必须是**同步**的：renderer 在文本节点手术时要立刻算出 hash 写进 `data-h`，
 * 那里没有 await 的余地，所以不能用 crypto.subtle。
 *
 * 用 64 位而非 32 位是因为 tag 串可以很长很相似，32 位的碰撞概率在几千张图的
 * 量级上已经不可忽略（生日问题：32 位在 ~77000 个键时碰撞概率过半）。
 *
 * JS 没有原生 64 位整数运算，这里用两个 32 位半各自跑 FNV-1a，
 * 用不同的 offset basis 让两半独立。
 *
 * @param {string} str
 * @returns {string} 16 个十六进制字符
 */
export function hash64(str) {
    const s = String(str ?? '');
    let h1 = 0x811c9dc5; // FNV offset basis (32-bit)
    let h2 = 0x1000193;  // 换一个起点，让两半不相关

    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        // h *= 16777619，用移位加法避免 Math.imul 之外的精度问题
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 ^= c + i; // 掺入位置，避免字符集相同、顺序不同的串在两半上同时碰撞
        h2 = Math.imul(h2, 0x01000193) >>> 0;
    }

    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 归一化从正文里截出来的 prompt。
 *
 * - `nsfw:` / `sketchy:` 前缀转成一个普通的首位 tag
 * - 逗号分隔后逐项 trim、丢空项、再用 ', ' 重新连接
 *
 * 归一化的意义在于让「同一张图的不同写法」落到同一个 hash 上，
 * 从而命中同一份缓存、共享同一次生成。
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizePrompt(raw) {
    return String(raw ?? '')
        .trim()
        .replace(/^(nsfw|sketchy)\s*:\s*/i, 'nsfw, ')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .join(', ');
}

/**
 * 把若干片段拼成一个 tag 串：丢空、中文逗号归一、去首尾逗号。
 * @param  {...string} parts
 * @returns {string}
 */
export function joinTags(...parts) {
    return parts
        .filter(Boolean)
        .map(p => String(p).replace(/[，、]/g, ',').replace(/^[\s,]+|[\s,]+$/g, ''))
        .filter(p => p.length > 0)
        .join(', ');
}

/** @returns {number} [min, max) 之间的随机整数毫秒 */
export function randomDelay(min, max) {
    const lo = Math.max(0, Number(min) || 0);
    const hi = Math.max(lo, Number(max) || 0);
    return lo + Math.random() * (hi - lo);
}

/** @returns {Promise<void>} */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 用用户配置的 pattern 字符串编译正则。
 *
 * 强制加上 `g`（scanner 依赖 lastIndex 循环）和 `i`。
 * 编译失败或缺少捕获组时返回 null，由调用方回退到默认 pattern。
 *
 * @param {string} source
 * @returns {RegExp | null}
 */
export function compilePattern(source) {
    const src = String(source || '').trim();
    if (!src) return null;
    try {
        const re = new RegExp(src, 'gi');
        // 必须有捕获组 1，否则 scanner 拿不到 prompt
        if (new RegExp(src + '|').exec('').length < 2) return null;
        return re;
    } catch {
        return null;
    }
}
