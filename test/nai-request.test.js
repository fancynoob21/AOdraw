import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRequestBody, NAI_MODEL } from '../src/nai-client.js';

const PARAMS = {
    width: 1216,
    height: 832,
    scale: 6,
    steps: 28,
    seed: 12345,
    sampler: 'k_euler_ancestral',
    scheduler: 'karras',
    varietyBoost: false,
};

function build(overrides = {}) {
    return buildRequestBody({
        positive: 'best quality, 1girl, smile',
        negative: 'lowres, bad anatomy',
        params: { ...PARAMS, ...overrides },
    });
}

describe('buildRequestBody', () => {
    it('固定使用 4.5 Full', () => {
        assert.equal(build().model, NAI_MODEL);
        assert.equal(NAI_MODEL, 'nai-diffusion-4-5-full');
    });

    it('三处配置键 → 报文键改名', () => {
        const p = build().parameters;
        // scheduler → noise_schedule
        assert.equal(p.noise_schedule, 'karras');
        assert.equal(p.scheduler, undefined);
        // decrisper → dynamic_thresholding（MVP 恒为 false）
        assert.equal(p.dynamic_thresholding, false);
        assert.equal(p.decrisper, undefined);
        // varietyBoost 关闭时是 null，不是 false
        assert.equal(p.skip_cfg_above_sigma, null);
        assert.equal(p.varietyBoost, undefined);
    });

    it('variety boost 按 1216×832 为基准缩放', () => {
        // 基准分辨率下应该正好是 58
        const base = build({ varietyBoost: true }).parameters.skip_cfg_above_sigma;
        assert.ok(Math.abs(base - 58) < 1e-9, `expected ~58, got ${base}`);

        // 面积翻倍 → sqrt(2) 倍
        const doubled = build({ varietyBoost: true, width: 2432 }).parameters.skip_cfg_above_sigma;
        assert.ok(Math.abs(doubled - 58 * Math.SQRT2) < 1e-9);
    });

    it('V4 的正负 prompt 同时出现在 v4_* 和平铺字段里', () => {
        const body = build();
        assert.equal(body.input, 'best quality, 1girl, smile');
        assert.equal(body.parameters.v4_prompt.caption.base_caption, 'best quality, 1girl, smile');
        assert.equal(body.parameters.v4_negative_prompt.caption.base_caption, 'lowres, bad anatomy');
        assert.equal(body.parameters.negative_prompt, 'lowres, bad anatomy');
    });

    it('seed 为 -1 时随机，且落在 uint32 范围内', () => {
        const seeds = new Set();
        for (let i = 0; i < 50; i++) {
            const seed = build({ seed: -1 }).parameters.seed;
            assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
            seeds.add(seed);
        }
        assert.ok(seeds.size > 40, '随机 seed 不应大量重复');
    });

    it('seed >= 0 时原样透传', () => {
        assert.equal(build({ seed: 0 }).parameters.seed, 0);
        assert.equal(build({ seed: 999 }).parameters.seed, 999);
    });

    it('MVP 无角色时 use_coords 为 false、char_captions 为空', () => {
        const p = build().parameters;
        assert.equal(p.use_coords, false);
        assert.deepEqual(p.characterPrompts, []);
        assert.deepEqual(p.v4_prompt.caption.char_captions, []);
        assert.deepEqual(p.v4_negative_prompt.caption.char_captions, []);
    });

    it('预留的多角色参数：有非居中角色时才开 use_coords', () => {
        const centered = buildRequestBody({
            positive: 'a', negative: 'b', params: PARAMS,
            characterPrompts: [{ prompt: '1girl', uc: '', center: { x: 0.5, y: 0.5 } }],
        }).parameters;
        assert.equal(centered.use_coords, false);
        assert.equal(centered.v4_prompt.caption.char_captions.length, 1);

        const placed = buildRequestBody({
            positive: 'a', negative: 'b', params: PARAMS,
            characterPrompts: [{ prompt: '1girl', uc: 'bad', center: { x: 0.3, y: 0.5 } }],
        }).parameters;
        assert.equal(placed.use_coords, true);
        assert.equal(placed.v4_prompt.use_coords, true);
        // 正负两套 caption 的 centers 必须一一对应
        assert.deepEqual(
            placed.v4_prompt.caption.char_captions[0].centers,
            placed.v4_negative_prompt.caption.char_captions[0].centers,
        );
    });

    it('报文可被 JSON 序列化（skip_cfg_above_sigma 的 null 不能变成 undefined）', () => {
        const json = JSON.parse(JSON.stringify(build()));
        assert.ok('skip_cfg_above_sigma' in json.parameters);
        assert.equal(json.parameters.skip_cfg_above_sigma, null);
        assert.equal(json.parameters.params_version, 3);
    });
});
