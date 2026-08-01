import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { testConnection } from '../src/nai-client.js';
import { isFreeTier } from '../src/sizes.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const realFetch = globalThis.fetch;

/** 拿真实 ZIP fixture 当成 NovelAI 的响应 */
function zipResponse() {
    const buf = readFileSync(join(FIXTURES, 'stored.zip'));
    return new Response(buf, { status: 200 });
}

/** @returns {{ calls: any[] }} */
function stubFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init, body: JSON.parse(init.body) });
        return responder();
    };
    return { calls };
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('testConnection', () => {
    it('探针报文必须是完整的 V4.5 形状', async () => {
        // 回归测试：这里曾经手搓过一个 V3 形状的精简报文
        // （parameters 只有 width/height/steps），而 model 是 V4.5。
        // NovelAI 对这种缺字段的请求回 500，导致有效的 Key 被报成「服务不可用」。
        const { calls } = stubFetch(zipResponse);
        await testConnection('pst-fake');

        assert.equal(calls.length, 1);
        const body = calls[0].body;

        assert.equal(body.model, 'nai-diffusion-4-5-full');
        assert.equal(body.action, 'generate');
        assert.equal(typeof body.input, 'string');

        // V4.5 的必填字段，缺任何一个都会 500
        for (const key of [
            'params_version', 'width', 'height', 'scale', 'seed', 'sampler',
            'noise_schedule', 'steps', 'n_samples', 'ucPreset', 'qualityToggle',
            'v4_prompt', 'v4_negative_prompt', 'negative_prompt',
        ]) {
            assert.ok(key in body.parameters, `探针报文缺少必填字段: ${key}`);
        }

        assert.ok(body.parameters.v4_prompt.caption);
        assert.ok(body.parameters.v4_negative_prompt.caption);
    });

    it('探针落在 Opus 免费额度内', async () => {
        const { calls } = stubFetch(zipResponse);
        await testConnection('pst-fake');

        const p = calls[0].body.parameters;
        // 1024×1024 且 steps ≤ 28 → Opus 订阅下测试连接是免费的
        assert.equal(p.width, 1024);
        assert.equal(p.height, 1024);
        assert.equal(p.steps, 1);
        assert.ok(isFreeTier({ width: p.width, height: p.height, steps: p.steps }));
    });

    it('探针不会被用户设置里的尺寸带偏', async () => {
        const { calls } = stubFetch(zipResponse);
        // 就算用户选了收费的大尺寸，探针也必须固定用免费组合
        await testConnection('pst-fake', { width: 1536, height: 1024, steps: 50 });

        const p = calls[0].body.parameters;
        assert.equal(p.width, 1024);
        assert.equal(p.height, 1024);
        assert.equal(p.steps, 1);
    });

    it('沿用用户设置里的 sampler / scheduler', async () => {
        const { calls } = stubFetch(zipResponse);
        await testConnection('pst-fake', { sampler: 'k_dpmpp_2m', scheduler: 'native' });

        assert.equal(calls[0].body.parameters.sampler, 'k_dpmpp_2m');
        assert.equal(calls[0].body.parameters.noise_schedule, 'native');
    });

    it('带上 Bearer 认证头', async () => {
        const { calls } = stubFetch(zipResponse);
        await testConnection('pst-abc123');
        assert.equal(calls[0].init.headers.Authorization, 'Bearer pst-abc123');
    });

    it('成功时连 ZIP 也解开，返回图片字节数', async () => {
        stubFetch(zipResponse);
        const r = await testConnection('pst-fake');
        assert.equal(r.success, true);
        assert.ok(r.bytes > 0, '应该真的解出了图片');
    });

    it('401 → Key 无效', async () => {
        stubFetch(() => new Response('', { status: 401 }));
        await assert.rejects(() => testConnection('pst-bad'), /API Key 无效/);
    });

    it('402 → Key 有效但没额度', async () => {
        stubFetch(() => new Response('', { status: 402 }));
        const r = await testConnection('pst-fake');
        assert.equal(r.success, true);
        assert.equal(r.bytes, 0);
    });

    it('5xx 把服务端原话带出来，而不是只说「服务不可用」', async () => {
        stubFetch(() => new Response(
            JSON.stringify({ statusCode: 500, message: 'invalid parameters: v4_prompt' }),
            { status: 500 },
        ));
        await assert.rejects(
            () => testConnection('pst-fake'),
            (e) => {
                assert.match(e.message, /500/);
                assert.match(e.message, /invalid parameters: v4_prompt/);
                return true;
            },
        );
    });

    it('5xx 返回纯文本时也能带出来', async () => {
        stubFetch(() => new Response('upstream timeout', { status: 502 }));
        await assert.rejects(() => testConnection('pst-fake'), /502.*upstream timeout/s);
    });

    it('没填 Key 时不发请求', async () => {
        const { calls } = stubFetch(zipResponse);
        await assert.rejects(() => testConnection(''), /请先填写 API Key/);
        assert.equal(calls.length, 0);
    });
});
