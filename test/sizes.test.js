import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    DEFAULT_SIZE, FREE_STEPS_LIMIT, isFreeTier, SIZE_OPTIONS, sizeValueOf,
} from '../src/sizes.js';

describe('SIZE_OPTIONS', () => {
    it('三个免费尺寸就是 Opus 的那三个', () => {
        const free = SIZE_OPTIONS.filter(o => o.free).map(o => o.value);
        assert.deepEqual(free, ['832x1216', '1216x832', '1024x1024']);
    });

    it('两个大尺寸不免费', () => {
        const paid = SIZE_OPTIONS.filter(o => !o.free).map(o => o.value);
        assert.deepEqual(paid, ['1024x1536', '1536x1024']);
    });

    it('value 和 width/height 自洽', () => {
        for (const o of SIZE_OPTIONS) {
            assert.equal(o.value, `${o.width}x${o.height}`, `${o.value} 的宽高对不上`);
        }
    });

    it('尺寸都是 64 的倍数', () => {
        for (const o of SIZE_OPTIONS) {
            assert.equal(o.width % 64, 0, `${o.value} 宽不是 64 的倍数`);
            assert.equal(o.height % 64, 0, `${o.value} 高不是 64 的倍数`);
        }
    });

    it('默认尺寸在选项里', () => {
        assert.ok(SIZE_OPTIONS.some(o => o.value === DEFAULT_SIZE));
    });
});

describe('sizeValueOf', () => {
    it('能从 width/height 反查出选项', () => {
        assert.equal(sizeValueOf({ width: 832, height: 1216 }), '832x1216');
        assert.equal(sizeValueOf({ width: 1536, height: 1024 }), '1536x1024');
    });

    it('宽高顺序不能搞混', () => {
        assert.equal(sizeValueOf({ width: 1216, height: 832 }), '1216x832');
        assert.equal(sizeValueOf({ width: 832, height: 1216 }), '832x1216');
    });

    it('对不上的旧配置落回默认值', () => {
        assert.equal(sizeValueOf({ width: 512, height: 512 }), DEFAULT_SIZE);
        assert.equal(sizeValueOf({}), DEFAULT_SIZE);
        assert.equal(sizeValueOf({ width: '不是数字', height: null }), DEFAULT_SIZE);
    });

    it('字符串形式的宽高也能匹配（设置有可能存成字符串）', () => {
        assert.equal(sizeValueOf({ width: '1024', height: '1024' }), '1024x1024');
    });
});

describe('isFreeTier', () => {
    it('免费尺寸 + steps ≤ 28 → 免费', () => {
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: 28 }), true);
        assert.equal(isFreeTier({ width: 832, height: 1216, steps: 1 }), true);
        assert.equal(isFreeTier({ width: 1024, height: 1024, steps: 20 }), true);
    });

    it('免费尺寸但 steps 超了 → 不免费', () => {
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: 29 }), false);
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: 50 }), false);
    });

    it('steps 达标但尺寸超了 → 不免费', () => {
        assert.equal(isFreeTier({ width: 1536, height: 1024, steps: 28 }), false);
        assert.equal(isFreeTier({ width: 1024, height: 1536, steps: 1 }), false);
    });

    it('两个条件缺一不可', () => {
        assert.equal(isFreeTier({ width: 1536, height: 1024, steps: 50 }), false);
    });

    it('边界就是 28', () => {
        assert.equal(FREE_STEPS_LIMIT, 28);
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: FREE_STEPS_LIMIT }), true);
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: FREE_STEPS_LIMIT + 1 }), false);
    });

    it('缺字段或 NaN 时保守判为不免费', () => {
        assert.equal(isFreeTier({}), false);
        assert.equal(isFreeTier({ width: 1216, height: 832 }), false);
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: NaN }), false);
        assert.equal(isFreeTier({ width: 1216, height: 832, steps: '不是数字' }), false);
    });
});
