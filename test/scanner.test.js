import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamScanner } from '../src/scanner.js';
import { compilePattern, hash64, normalizePrompt } from '../src/util.js';

const DEFAULT_PATTERN = '\\[(?:img|图片)\\s*:\\s*([^\\]]+)\\]';

function newScanner() {
    return new StreamScanner(compilePattern(DEFAULT_PATTERN));
}

/**
 * 模拟 STREAM_TOKEN_RECEIVED：逐字符喂入累积全文的每一个前缀。
 * @returns {{ at: number, prompt: string }[]} 每次派发发生在第几个字符
 */
function feedCharByChar(scanner, text) {
    const dispatches = [];
    for (let i = 1; i <= text.length; i++) {
        for (const token of scanner.feed(text.slice(0, i))) {
            dispatches.push({ at: i, prompt: token.prompt });
        }
    }
    return dispatches;
}

describe('StreamScanner', () => {
    it('只在闭合 ] 到达的那一刻派发', () => {
        const text = '文本[img: 1girl, smile]中间[img: 2girls]尾';
        const dispatches = feedCharByChar(newScanner(), text);

        assert.equal(dispatches.length, 2);
        assert.deepEqual(dispatches.map(d => d.prompt), ['1girl, smile', '2girls']);

        // 派发位置必须正好是各自的 ']' 之后
        assert.equal(dispatches[0].at, text.indexOf(']') + 1);
        assert.equal(dispatches[1].at, text.lastIndexOf(']') + 1);
    });

    it('半截 token 不派发', () => {
        const scanner = newScanner();
        assert.deepEqual(scanner.feed('这是一段正文 [img: 1girl, smi'), []);
        assert.deepEqual(scanner.feed('这是一段正文 [img: 1girl, smile, caf'), []);
        // 补上闭合才派发
        const out = scanner.feed('这是一段正文 [img: 1girl, smile, cafe]');
        assert.equal(out.length, 1);
        assert.equal(out[0].prompt, '1girl, smile, cafe');
    });

    it('重复喂同一全文不重复派发', () => {
        const scanner = newScanner();
        const text = 'a[img: 1girl]b';
        assert.equal(scanner.feed(text).length, 1);
        assert.equal(scanner.feed(text).length, 0);
        assert.equal(scanner.feed(text).length, 0);
        assert.equal(scanner.feed(text + '更多正文').length, 0);
    });

    it('同一段文本里两个相同的 token 各派发一次（位置不同）', () => {
        const scanner = newScanner();
        const out = scanner.feed('[img: 1girl] 和 [img: 1girl]');
        assert.equal(out.length, 2);
        // prompt 相同 → hash 相同 → pipeline 会把它们折叠成一次生成
        assert.equal(hash64(out[0].prompt), hash64(out[1].prompt));
    });

    it('reset 之后可以重新派发（swipe / 新一轮生成）', () => {
        const scanner = newScanner();
        assert.equal(scanner.feed('[img: 1girl]').length, 1);
        scanner.reset();
        assert.equal(scanner.feed('[img: 1girl]').length, 1);
    });

    it('支持中文别名 [图片: ...]', () => {
        const out = newScanner().feed('看这个[图片: 1girl, cat ears]');
        assert.equal(out.length, 1);
        assert.equal(out[0].prompt, '1girl, cat ears');
    });

    it('空 token 被忽略且不会毒化 seen', () => {
        const scanner = newScanner();
        assert.deepEqual(scanner.feed('[img:   ]'), []);
        // 同一位置后来变成合法 token（流式续写）时仍能派发
        assert.equal(scanner.feed('[img:   1girl]').length, 1);
    });

    it('派发的 index 指向 token 起点', () => {
        const out = newScanner().feed('前缀文字[img: 1girl]');
        assert.equal(out[0].index, '前缀文字'.length);
        assert.equal(out[0].raw, '[img: 1girl]');
    });
});

describe('normalizePrompt', () => {
    it('压缩空白并统一分隔', () => {
        assert.equal(normalizePrompt('  1girl ,  smile ,, cafe  '), '1girl, smile, cafe');
    });

    it('nsfw: 前缀转成首位 tag', () => {
        assert.equal(normalizePrompt('nsfw: 1girl, bed'), 'nsfw, 1girl, bed');
        assert.equal(normalizePrompt('sketchy:1girl'), 'nsfw, 1girl');
    });

    it('不同写法归一到同一个 hash（决定缓存能否命中）', () => {
        assert.equal(
            hash64(normalizePrompt('1girl,smile,  cafe')),
            hash64(normalizePrompt('  1girl , smile , cafe ')),
        );
    });
});

describe('hash64', () => {
    it('输出 16 位十六进制', () => {
        assert.match(hash64('1girl, smile'), /^[0-9a-f]{16}$/);
    });

    it('相同输入稳定，不同输入不同', () => {
        assert.equal(hash64('abc'), hash64('abc'));
        assert.notEqual(hash64('abc'), hash64('abd'));
        // 同字符集不同顺序必须区分开（掺入了位置）
        assert.notEqual(hash64('1girl, smile'), hash64('smile, 1girl'));
    });

    it('空串也有合法输出', () => {
        assert.match(hash64(''), /^[0-9a-f]{16}$/);
    });
});

describe('compilePattern', () => {
    it('拒绝没有捕获组的正则', () => {
        assert.equal(compilePattern('\\[img:[^\\]]+\\]'), null);
    });

    it('拒绝非法正则', () => {
        assert.equal(compilePattern('[img:'), null);
    });

    it('接受合法自定义格式', () => {
        const re = compilePattern('【图:([^】]+)】');
        assert.ok(re);
        const out = new StreamScanner(re).feed('看【图: 1girl】');
        assert.equal(out.length, 1);
        assert.equal(out[0].prompt, '1girl');
    });
});
