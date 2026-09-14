import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    applyProfile, createProfileFromCurrent, deleteProfile, ensureProfiles,
    generationHash, getActiveProfile, isActiveProfileDirty, saveCurrentToActiveProfile,
} from '../src/profiles.js';

const SETTINGS = {
    model: 'nai-diffusion-5-full',
    positivePrefix: 'artist',
    negativePrefix: 'lowres',
    width: 1216,
    height: 832,
    steps: 28,
    scale: 5.5,
    seed: -1,
    sampler: 'k_euler_ancestral',
    scheduler: 'karras',
    varietyBoost: false,
    cooldownMin: 5000,
    cooldownMax: 10000,
};

const clone = (o = SETTINGS) => structuredClone(o);

describe('profiles', () => {
    it('旧配置会迁移出一个默认 profile', () => {
        const settings = clone();
        ensureProfiles(settings);

        assert.equal(settings.profiles.length, 1);
        assert.equal(settings.activeProfileId, 'default');
        assert.equal(settings.profiles[0].name, '默认');
        assert.equal(settings.profiles[0].params.positivePrefix, 'artist');
        assert.equal(settings.profiles[0].params.cooldownMin, undefined);
    });

    it('新建 profile 使用当前面板参数', () => {
        const settings = clone();
        ensureProfiles(settings);
        settings.positivePrefix = 'cinematic';

        const profile = createProfileFromCurrent(settings, '电影感');

        assert.equal(settings.activeProfileId, profile.id);
        assert.equal(profile.name, '电影感');
        assert.equal(profile.params.positivePrefix, 'cinematic');
    });

    it('切换 profile 会把参数写回当前设置', () => {
        const settings = clone();
        ensureProfiles(settings);
        const profile = createProfileFromCurrent(settings, '竖图');
        profile.params.width = 832;
        profile.params.height = 1216;

        settings.width = 1216;
        settings.height = 832;
        assert.equal(applyProfile(settings, profile.id), true);

        assert.equal(settings.width, 832);
        assert.equal(settings.height, 1216);
    });

    it('当前参数改动后能识别 dirty，并保存回 active profile', () => {
        const settings = clone();
        ensureProfiles(settings);

        assert.equal(isActiveProfileDirty(settings), false);
        settings.steps = 20;
        assert.equal(isActiveProfileDirty(settings), true);

        saveCurrentToActiveProfile(settings);
        assert.equal(isActiveProfileDirty(settings), false);
        assert.equal(getActiveProfile(settings).params.steps, 20);
    });

    it('删除当前 profile 时会切到剩余 profile 且至少保留一个', () => {
        const settings = clone();
        ensureProfiles(settings);
        const created = createProfileFromCurrent(settings, '临时');

        assert.equal(deleteProfile(settings, created.id), true);
        assert.equal(settings.profiles.length, 1);
        assert.equal(settings.activeProfileId, 'default');
        assert.equal(deleteProfile(settings, 'default'), false);
    });

    it('生成 hash 随出图参数变化，但不受队列参数影响', () => {
        const a = clone();
        const b = clone();
        const c = clone();
        b.steps = 20;
        c.cooldownMin = 0;

        assert.notEqual(generationHash('1girl, smile', a), generationHash('1girl, smile', b));
        assert.equal(generationHash('1girl, smile', a), generationHash('1girl, smile', c));
    });

    it('随机 seed 不进 hash，固定 seed 进 hash', () => {
        const randomA = clone();
        const randomB = clone();
        randomA.seed = -1;
        randomB.seed = -1;

        const fixedA = clone();
        const fixedB = clone();
        fixedA.seed = 1;
        fixedB.seed = 2;

        assert.equal(generationHash('same', randomA), generationHash('same', randomB));
        assert.notEqual(generationHash('same', fixedA), generationHash('same', fixedB));
    });
});
