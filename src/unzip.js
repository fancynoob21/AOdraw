// ════════════════════════════════════════════════════════════════════════════
// 极简 ZIP 读取器 —— 零依赖
// ════════════════════════════════════════════════════════════════════════════
//
// NovelAI 的 /ai/generate-image 返回的不是 JSON，是一个 application/zip 的二进制
// 流，里面装着单张 png。所以必须解 ZIP。
//
// 常见做法是从 CDN 动态加载 JSZip —— 但那意味着离线环境直接失效，而且为了读一个
// 单文件 ZIP 拉进来 100KB 的库并不划算。
//
// 这里只实现「找到第一个图片条目并取出来」这一条路径：
//   - method 0 (stored)  → 直接切片
//   - method 8 (deflate) → 原生 DecompressionStream('deflate-raw')
// 两者都是浏览器和 Node 18+ 原生支持的。
// ════════════════════════════════════════════════════════════════════════════

const SIG_EOCD = 0x06054b50;   // End of central directory
const SIG_CD = 0x02014b50;     // Central directory file header
const SIG_LOCAL = 0x04034b50;  // Local file header

const EOCD_MIN_SIZE = 22;
const CD_FIXED_SIZE = 46;
const LOCAL_FIXED_SIZE = 30;

const ZIP64_SENTINEL = 0xffffffff;

/**
 * 从尾部回扫定位 EOCD。
 *
 * ZIP 的注释长度是 2 字节，所以 EOCD 最多可能在离末尾 22 + 65535 字节的位置。
 * 从末尾往前找第一个签名即可。
 *
 * @param {DataView} view
 * @returns {number} EOCD 的偏移量
 */
function findEocd(view) {
    const maxBack = Math.min(view.byteLength, EOCD_MIN_SIZE + 0xffff);
    for (let i = view.byteLength - EOCD_MIN_SIZE; i >= view.byteLength - maxBack; i--) {
        if (i < 0) break;
        if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    throw new Error('ZIP 格式错误：找不到 EOCD');
}

/**
 * 从 NovelAI 返回的 ZIP 里取出第一张图。
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Blob>} image/png 或 image/webp
 */
export async function extractImageFromZip(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    const eocd = findEocd(view);
    const entryCount = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);

    if (cdOffset === ZIP64_SENTINEL) {
        throw new Error('ZIP 格式错误：不支持 ZIP64');
    }

    // ── 遍历中央目录，找第一个图片条目 ──
    let cursor = cdOffset;
    let found = null;

    for (let i = 0; i < entryCount; i++) {
        if (cursor + CD_FIXED_SIZE > view.byteLength) break;
        if (view.getUint32(cursor, true) !== SIG_CD) break;

        const method = view.getUint16(cursor + 10, true);
        const compSize = view.getUint32(cursor + 20, true);
        const nameLen = view.getUint16(cursor + 28, true);
        const extraLen = view.getUint16(cursor + 30, true);
        const commentLen = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);

        const name = new TextDecoder().decode(
            bytes.subarray(cursor + CD_FIXED_SIZE, cursor + CD_FIXED_SIZE + nameLen),
        );

        if (/\.(png|webp|jpe?g)$/i.test(name)) {
            if (compSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
                throw new Error('ZIP 格式错误：不支持 ZIP64');
            }
            found = { name, method, compSize, localOffset };
            break;
        }

        cursor += CD_FIXED_SIZE + nameLen + extraLen + commentLen;
    }

    if (!found) throw new Error('ZIP 里没有图片');

    // ── 读 local header 拿到真实的数据起点 ──
    // local header 的 nameLen / extraLen 可以和中央目录里的不一样（extra 字段常见差异），
    // 所以必须以 local header 为准来算偏移。
    const lh = found.localOffset;
    if (view.getUint32(lh, true) !== SIG_LOCAL) {
        throw new Error('ZIP 格式错误：local header 签名不匹配');
    }
    const lhNameLen = view.getUint16(lh + 26, true);
    const lhExtraLen = view.getUint16(lh + 28, true);
    const dataStart = lh + LOCAL_FIXED_SIZE + lhNameLen + lhExtraLen;

    // 注意：走中央目录里的 compSize，而不是 local header 里的。
    // 当 flags bit 3（data descriptor）置位时 local header 里的大小字段是 0。
    const raw = bytes.subarray(dataStart, dataStart + found.compSize);

    const mime = /\.webp$/i.test(found.name)
        ? 'image/webp'
        : /\.jpe?g$/i.test(found.name) ? 'image/jpeg' : 'image/png';

    if (found.method === 0) {
        return new Blob([raw], { type: mime });
    }

    if (found.method === 8) {
        const stream = new Blob([raw]).stream()
            .pipeThrough(new DecompressionStream('deflate-raw'));
        const inflated = await new Response(stream).arrayBuffer();
        return new Blob([inflated], { type: mime });
    }

    throw new Error(`ZIP 格式错误：不支持的压缩方式 ${found.method}`);
}
