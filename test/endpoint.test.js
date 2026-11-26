import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENDPOINT, isCustomEndpoint, resolveEndpoint } from '../src/endpoint.js';
import { generate, testConnection } from '../src/nai-client.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const realFetch = globalThis.fetch;

const OFFICIAL = 'https://image.novelai.net/ai/generate-image';
const THIRD_PARTY = 'https://nai.example.com/ai/generate-image';

const SETTINGS = {
    apiKey: 'pst-fake',
    model: 'nai-diffusion-5-full',
    positivePrefix: '',
    negativePrefix: '',
    width: 1216, height: 832, steps: 28, scale: 5.5, seed: 1,
    sampler: 'k_euler_ancestral', scheduler: 'karras', varietyBoost: false,
    timeout: 60000,
};

function zipResponse() {
    return new Response(readFileSync(join(FIXTURES, 'stored.zip')), { status: 200 });
}

/** @returns {{ calls: any[] }} */
function stubFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return responder();
    };
    return { calls };
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('resolveEndpoint', () => {
    it('留空就是 NovelAI 官方地址', () => {
        assert.equal(DEFAULT_ENDPOINT, OFFICIAL);
        for (const empty of ['', '   ', null, undefined]) {
            assert.equal(resolveEndpoint(empty), OFFICIAL);
        }
    });

    it('完整地址原样使用', () => {
        assert.equal(resolveEndpoint(THIRD_PARTY), THIRD_PARTY);
        assert.equal(
            resolveEndpoint('http://127.0.0.1:8080/ai/generate-image'),
            'http://127.0.0.1:8080/ai/generate-image',
        );
    });

    it('只填了域名时补上 NovelAI 的生图路径', () => {
        // 第三方给的往往只是一个域名，意思是「把 image.novelai.net 换成它」
        assert.equal(resolveEndpoint('https://nai.example.com'), THIRD_PARTY);
        assert.equal(resolveEndpoint('https://nai.example.com/'), THIRD_PARTY);
        assert.equal(
            resolveEndpoint('http://127.0.0.1:8080'),
            'http://127.0.0.1:8080/ai/generate-image',
        );
    });

    it('带了路径的地址不被改写', () => {
        // 第三方的路径可以和 NovelAI 不一样，写了路径就以用户写的为准
        for (const url of [
            'https://api.example.com/v1/nai/generate',
            'https://api.example.com/proxy/',
            'https://api.example.com/gen?channel=2',
        ]) {
            assert.equal(resolveEndpoint(url), url);
        }
    });

    it('首尾空白不算数', () => {
        assert.equal(resolveEndpoint(`  ${THIRD_PARTY}\n`), THIRD_PARTY);
    });

    it('域名后面只跟了查询参数，也算没写路径', () => {
        // 「域名 + token」是在说「换个域名，顺便带上这个参数」，不是要 POST 到根路径
        assert.equal(
            resolveEndpoint('https://nai.example.com?key=abc'),
            'https://nai.example.com/ai/generate-image?key=abc',
        );
    });

    it('不是 http(s) 完整地址的一律判为非法', () => {
        for (const bad of [
            'nai.example.com',          // 漏了协议
            'localhost:8080',           // 会被解析成 localhost: 协议
            'ftp://nai.example.com/a',
            'javascript:alert(1)',
            'not a url',
            'https://',
        ]) {
            assert.equal(resolveEndpoint(bad), null, `${bad} 应该被判为非法`);
        }
    });

    it('地址里带账号密码的判为非法', () => {
        // fetch 拒绝为这种 URL 构造请求。放它过校验的话，要等真正发请求时才会
        // 冒出一句看不懂的 TypeError，而且队列里每张图都会去撞一次。
        assert.equal(resolveEndpoint('https://user:pass@nai.example.com'), null);
        assert.equal(resolveEndpoint('https://user@nai.example.com/ai/generate-image'), null);
    });
});

describe('isCustomEndpoint', () => {
    it('留空或填的就是官方地址 → 不算自定义', () => {
        assert.equal(isCustomEndpoint(''), false);
        assert.equal(isCustomEndpoint(undefined), false);
        assert.equal(isCustomEndpoint(OFFICIAL), false);
        assert.equal(isCustomEndpoint('https://image.novelai.net'), false);
    });

    it('官方地址换个写法，仍然是官方', () => {
        // 认的是主机，不是字符串长得一不一样 —— 否则多打一个斜杠，
        // 界面就会把 Opus 免费额度的提示藏起来，还把 404 说成「地址填错」
        for (const same of [
            'https://image.novelai.net/ai/generate-image/',
            'https://IMAGE.novelai.net/ai/generate-image',
            'https://image.novelai.net:443/ai/generate-image',
            'https://image.novelai.net/#x',
        ]) {
            assert.equal(isCustomEndpoint(same), false, `${same} 不该算第三方`);
        }
    });

    it('填了别的地址 → 自定义', () => {
        assert.equal(isCustomEndpoint(THIRD_PARTY), true);
        assert.equal(isCustomEndpoint('https://nai.example.com'), true);
    });

    it('非法地址不算自定义（它根本发不出请求）', () => {
        assert.equal(isCustomEndpoint('nai.example.com'), false);
    });
});

describe('generate 的请求地址', () => {
    it('没配置时发往 NovelAI 官方', async () => {
        const { calls } = stubFetch(zipResponse);
        await generate({ prompt: '1girl', settings: SETTINGS });
        assert.equal(calls[0].url, OFFICIAL);
    });

    it('配置了就发往第三方地址', async () => {
        const { calls } = stubFetch(zipResponse);
        const { blob } = await generate({
            prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: THIRD_PARTY },
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, THIRD_PARTY);
        assert.ok(blob.size > 0);
    });

    it('第三方收到的报文和认证头，与发给官方的完全一样', async () => {
        const official = stubFetch(zipResponse);
        await generate({ prompt: '1girl', settings: SETTINGS });
        const third = stubFetch(zipResponse);
        await generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: THIRD_PARTY } });

        assert.equal(third.calls[0].init.body, official.calls[0].init.body);
        assert.deepEqual(third.calls[0].init.headers, official.calls[0].init.headers);
        assert.equal(third.calls[0].init.headers.Authorization, 'Bearer pst-fake');
    });

    it('地址非法时直接报错并点名字段，不发请求', async () => {
        const { calls } = stubFetch(zipResponse);
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: 'nai.example.com' } }),
            (e) => {
                assert.match(e.message, /API 地址/);
                assert.equal(e.errorType.code, 'config');
                return true;
            },
        );
        assert.equal(calls.length, 0);
    });

    it('第三方报错时不把锅甩给 NovelAI', async () => {
        stubFetch(() => new Response('upstream timeout', { status: 502 }));
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: THIRD_PARTY } }),
            (e) => {
                assert.match(e.message, /502.*upstream timeout/s);
                assert.doesNotMatch(e.message, /NovelAI/);
                return true;
            },
        );
    });

    it('官方地址报 5xx 时仍然说是 NovelAI 返回的', async () => {
        stubFetch(() => new Response('upstream timeout', { status: 502 }));
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: SETTINGS }),
            /NovelAI 返回 502/,
        );
    });

    it('第三方回 404 / 405 → 提示去检查 API 地址，并且不再重试', async () => {
        for (const status of [404, 405]) {
            stubFetch(() => new Response('Not Found', { status }));
            await assert.rejects(
                // 只填域名：路径是我们补的，404 最可能就出在这里，所以报错里必须带上实际地址
                () => generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: 'https://nai.example.com' } }),
                (e) => {
                    assert.match(e.message, new RegExp(String(status)));
                    assert.match(e.message, /API 地址/);
                    assert.ok(e.message.includes(THIRD_PARTY), '报错里应该带上实际请求的地址');
                    // config 类错误会让队列整条清掉，免得每张图都撞一次同一个错地址
                    assert.equal(e.errorType.code, 'config');
                    return true;
                },
            );
        }
    });

    it('官方地址回 404 不会被说成「地址填错」', async () => {
        stubFetch(() => new Response('Not Found', { status: 404 }));
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: SETTINGS }),
            (e) => {
                assert.match(e.message, /请求失败 404/);
                assert.doesNotMatch(e.message, /API 地址/);
                assert.equal(e.errorType.code, 'unknown');
                return true;
            },
        );
    });

    it('402：官方说 Anlas，第三方说额度', async () => {
        stubFetch(() => new Response('', { status: 402 }));
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: SETTINGS }),
            (e) => e.message === 'Anlas 不足' && e.errorType.code === 'quota',
        );
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: THIRD_PARTY } }),
            (e) => {
                assert.doesNotMatch(e.message, /Anlas/);
                assert.match(e.message, /额度不足/);
                assert.equal(e.errorType.code, 'quota');
                return true;
            },
        );
    });

    it('请求发不出去：第三方地址下点出跨域的可能，官方不提', async () => {
        // 各家浏览器对「连不上」的说法不一样，都得认出来
        for (const wording of [
            'Failed to fetch',                                  // Chromium
            'NetworkError when attempting to fetch resource.',  // Firefox
            'Load failed',                                      // Safari
        ]) {
            stubFetch(() => { throw new TypeError(wording); });
            await assert.rejects(
                () => generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: THIRD_PARTY } }),
                (e) => {
                    assert.match(e.message, /跨域/, `${wording} 应该被认作网络错误`);
                    assert.equal(e.errorType.code, 'network');
                    return true;
                },
            );
            await assert.rejects(
                () => generate({ prompt: '1girl', settings: SETTINGS }),
                (e) => e.message === '网络错误' && e.errorType.code === 'network',
            );
        }
    });

    it('地址和别的参数同时填坏时，一次全报出来', async () => {
        const { calls } = stubFetch(zipResponse);
        await assert.rejects(
            () => generate({
                prompt: '1girl',
                settings: { ...SETTINGS, apiEndpoint: 'nai.example.com', steps: '' },
            }),
            (e) => {
                assert.match(e.message, /API 地址/);
                assert.match(e.message, /Steps 不能为空/);
                assert.equal(e.errorType.code, 'config');
                return true;
            },
        );
        assert.equal(calls.length, 0);
    });

    it('第三方回的不是 ZIP → 说清楚是对方的响应格式不对', async () => {
        stubFetch(() => new Response(JSON.stringify({ url: 'https://x/y.png' }), { status: 200 }));
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: { ...SETTINGS, apiEndpoint: THIRD_PARTY } }),
            (e) => {
                assert.equal(e.errorType.code, 'parse');
                assert.match(e.message, /第三方/);
                return true;
            },
        );
    });

    it('官方回的不是 ZIP → 不提第三方', async () => {
        stubFetch(() => new Response('oops', { status: 200 }));
        await assert.rejects(
            () => generate({ prompt: '1girl', settings: SETTINGS }),
            (e) => {
                assert.equal(e.errorType.code, 'parse');
                assert.doesNotMatch(e.message, /第三方/);
                return true;
            },
        );
    });
});

describe('testConnection 的请求地址', () => {
    it('没配置时发往 NovelAI 官方', async () => {
        const { calls } = stubFetch(zipResponse);
        await testConnection('pst-fake');
        assert.equal(calls[0].url, OFFICIAL);
    });

    it('测试按钮测的就是配置的那个地址', async () => {
        const { calls } = stubFetch(zipResponse);
        const r = await testConnection('pst-fake', { apiEndpoint: 'https://nai.example.com' });
        assert.equal(calls[0].url, THIRD_PARTY);
        assert.equal(calls[0].init.headers.Authorization, 'Bearer pst-fake');
        assert.ok(r.bytes > 0);
    });

    it('地址非法时不发请求', async () => {
        const { calls } = stubFetch(zipResponse);
        await assert.rejects(
            () => testConnection('pst-fake', { apiEndpoint: 'ftp://nai.example.com' }),
            /API 地址/,
        );
        assert.equal(calls.length, 0);
    });

    it('第三方回的不是 ZIP → 说清楚是对方的响应格式不对', async () => {
        stubFetch(() => new Response('<html>hello</html>', { status: 200 }));
        await assert.rejects(
            () => testConnection('pst-fake', { apiEndpoint: THIRD_PARTY }),
            (e) => {
                assert.match(e.message, /第三方/);
                assert.equal(e.errorType.code, 'parse');
                return true;
            },
        );
    });

    it('别的参数填坏了也照样能测地址（探针用的是自己那套固定参数）', async () => {
        const { calls } = stubFetch(zipResponse);
        await testConnection('pst-fake', { apiEndpoint: THIRD_PARTY, steps: '', width: '' });
        assert.equal(calls[0].url, THIRD_PARTY);
    });
});
