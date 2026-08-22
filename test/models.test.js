import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/nai-client.js';
import { DEFAULT_MODEL, isKnownModel, MODEL_OPTIONS, resolveModel } from '../src/models.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const SETTINGS = {
    apiKey: 'pst-fake', model: DEFAULT_MODEL,
    width: 1216, height: 832, steps: 28, scale: 5.5, seed: 42,
    sampler: 'k_euler_ancestral', scheduler: 'karras', varietyBoost: false,
    positivePrefix: 'best quality,', negativePrefix: 'lowres', timeout: 60000,
};

function stubFetch() {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(readFileSync(join(FIXTURES, 'stored.zip')), { status: 200 });
    };
    return { calls };
}

describe('MODEL_OPTIONS', () => {
    it('默认模型是 V5 Full，且在选项里', () => {
        assert.equal(DEFAULT_MODEL, 'nai-diffusion-5-full');
        assert.ok(MODEL_OPTIONS.some(o => o.value === DEFAULT_MODEL));
    });

    it('V5 Full 排在第一个（下拉里最先看到）', () => {
        assert.equal(MODEL_OPTIONS[0].value, 'nai-diffusion-5-full');
    });

    it('不包含 V3 —— 那需要完全不同的报文结构', () => {
        assert.ok(!MODEL_OPTIONS.some(o => /diffusion-3|furry-3/.test(o.value)));
    });

    it('不包含探测过不存在的写法', () => {
        // 这两个 ID 会被 NovelAI 明确回「model doesn't exist」
        for (const bogus of ['nai-diffusion-v5-full', 'nai-diffusion-5']) {
            assert.ok(!isKnownModel(bogus), `${bogus} 不该出现在选项里`);
        }
    });

    it('每个选项都有 label 且 value 不重复', () => {
        const values = MODEL_OPTIONS.map(o => o.value);
        assert.equal(new Set(values).size, values.length);
        assert.ok(MODEL_OPTIONS.every(o => o.label && o.label.trim()));
    });
});

describe('resolveModel', () => {
    it('空值回落到默认模型', () => {
        for (const empty of ['', '   ', null, undefined]) {
            assert.equal(resolveModel(empty), DEFAULT_MODEL);
        }
    });

    it('有值就原样用', () => {
        assert.equal(resolveModel('nai-diffusion-4-5-full'), 'nai-diffusion-4-5-full');
    });
});

describe('generate 的 meta', () => {
    // 回归测试：meta.model 曾经引用了一个不在作用域里的变量（params），
    // 于是每次生成都抛 "params is not defined"。单测当时只覆盖 buildRequestBody，
    // 完全看不见 generate() 里的这一行。
    it('返回的 meta 与实际发出的报文一致', async () => {
        const { calls } = stubFetch();
        const { blob, meta } = await generate({ prompt: '1girl', settings: SETTINGS });

        assert.ok(blob.size > 0);
        assert.equal(meta.model, calls[0].body.model);
        assert.equal(meta.seed, calls[0].body.parameters.seed);
        assert.equal(meta.width, calls[0].body.parameters.width);
        assert.equal(meta.height, calls[0].body.parameters.height);
    });

    it('每个可选模型都能走通 generate 并如实回报', async () => {
        for (const option of MODEL_OPTIONS) {
            stubFetch();
            const { meta } = await generate({
                prompt: '1girl', settings: { ...SETTINGS, model: option.value },
            });
            assert.equal(meta.model, option.value);
        }
    });

    it('positivePrefix 会拼进 input', async () => {
        const { calls } = stubFetch();
        await generate({ prompt: '1girl, smile', settings: SETTINGS });
        assert.equal(calls[0].body.input, 'best quality, 1girl, smile');
    });
});
