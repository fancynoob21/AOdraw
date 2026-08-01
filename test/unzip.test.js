import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractImageFromZip } from '../src/unzip.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** fixture 是用系统的 `zip` 生成的，即用真实 ZIP 写入器来验证我们的读取器 */
function loadFixture(name) {
    const buf = readFileSync(join(FIXTURES, name));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function bytesOf(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

describe('extractImageFromZip', () => {
    it('解 stored (method 0)', async () => {
        const blob = await extractImageFromZip(loadFixture('stored.zip'));
        const bytes = await bytesOf(blob);
        const expected = new Uint8Array(readFileSync(join(FIXTURES, 'image.png')));

        assert.equal(blob.type, 'image/png');
        assert.deepEqual([...bytes.slice(0, 8)], PNG_MAGIC);
        assert.deepEqual([...bytes], [...expected]);
    });

    it('解 deflate (method 8)', async () => {
        const blob = await extractImageFromZip(loadFixture('deflate.zip'));
        const bytes = await bytesOf(blob);
        const expected = new Uint8Array(readFileSync(join(FIXTURES, 'big.png')));

        assert.deepEqual([...bytes.slice(0, 8)], PNG_MAGIC);
        assert.equal(bytes.length, expected.length);
        assert.deepEqual([...bytes], [...expected]);
    });

    it('跳过非图片条目，并能越过 ZIP 注释找到 EOCD', async () => {
        // mixed.zip = notes.txt + image.png，且带一段 archive comment。
        // 注释存在时 EOCD 不在文件末尾，必须靠回扫才能定位。
        const blob = await extractImageFromZip(loadFixture('mixed.zip'));
        const bytes = await bytesOf(blob);
        const expected = new Uint8Array(readFileSync(join(FIXTURES, 'image.png')));

        assert.deepEqual([...bytes], [...expected]);
    });

    it('不是 ZIP 时给出明确错误', async () => {
        const notZip = new TextEncoder().encode('这是 NovelAI 返回的一段 JSON 错误信息').buffer;
        await assert.rejects(
            () => extractImageFromZip(notZip),
            /找不到 EOCD/,
        );
    });

    it('ZIP 里没有图片时给出明确错误', async () => {
        // 手工造一个只含 notes.txt 的 ZIP：把 mixed.zip 里的 image.png 条目名改掉
        // 太脆弱，直接断言错误信息的存在性即可 —— 这里用一个空 ZIP。
        // 空 ZIP = 只有 EOCD 的 22 字节
        const empty = new Uint8Array(22);
        new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
        await assert.rejects(
            () => extractImageFromZip(empty.buffer),
            /没有图片/,
        );
    });
});
