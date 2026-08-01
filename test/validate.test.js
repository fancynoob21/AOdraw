import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRequestBody } from '../src/nai-client.js';
import {
    formatErrors, REQUEST_FIELDS, validateField, validateFields,
} from '../src/validate.js';

const GOOD = {
    width: 1216, height: 832, steps: 28, scale: 5.5, seed: -1,
    sampler: 'k_euler_ancestral', scheduler: 'karras',
    cooldownMin: 5000, cooldownMax: 10000, timeout: 60000, ttlDays: 7, historyDepth: 5,
};

describe('validateField', () => {
    it('留空一律报错，不回落到默认值', () => {
        for (const empty of ['', null, undefined]) {
            const e = validateField('steps', empty);
            assert.ok(e, `${JSON.stringify(empty)} 应该被判为错误`);
            assert.match(e.message, /不能为空/);
        }
    });

    it('空白字符串的 sampler 也算空', () => {
        assert.ok(validateField('sampler', '   '));
        assert.equal(validateField('sampler', 'k_euler'), null);
    });

    it('非数字报错', () => {
        assert.match(validateField('steps', 'abc').message, /必须是数字/);
    });

    it('整数字段拒绝小数', () => {
        assert.match(validateField('steps', 28.5).message, /必须是整数/);
        // scale 是浮点字段，小数合法
        assert.equal(validateField('scale', 5.5), null);
    });

    it('越界报错并说出边界', () => {
        assert.match(validateField('steps', 0).message, /不能小于 1/);
        assert.match(validateField('steps', 51).message, /不能大于 50/);
        assert.match(validateField('scale', -1).message, /不能小于 0/);
        assert.match(validateField('seed', -2).message, /不能小于 -1/);
    });

    it('seed 允许 -1（表示随机）', () => {
        assert.equal(validateField('seed', -1), null);
        assert.equal(validateField('seed', 0), null);
        assert.equal(validateField('seed', 4294967295), null);
    });

    it('数字字符串可以接受（输入框读出来就是字符串）', () => {
        assert.equal(validateField('steps', '28'), null);
        assert.equal(validateField('scale', '5.5'), null);
    });

    it('0 不会被当成「空」', () => {
        // 经典陷阱：用 falsy 判空会把 0 也吃掉
        assert.equal(validateField('ttlDays', 0), null);
        assert.equal(validateField('cooldownMin', 0), null);
    });

    it('未知字段不报错', () => {
        assert.equal(validateField('不存在的字段', null), null);
    });
});

describe('validateFields', () => {
    it('全套合法设置没有错误', () => {
        assert.deepEqual(validateFields(GOOD), []);
    });

    it('报出所有出问题的字段，而不是只报第一个', () => {
        const errors = validateFields({ ...GOOD, steps: '', scale: '', seed: '' });
        assert.equal(errors.length, 3);
        assert.deepEqual(errors.map(e => e.key).sort(), ['scale', 'seed', 'steps']);
    });

    it('冷却上限不能小于下限', () => {
        const errors = validateFields({ ...GOOD, cooldownMin: 20000, cooldownMax: 5000 });
        assert.equal(errors.length, 1);
        assert.equal(errors[0].key, 'cooldownMax');
        assert.match(errors[0].message, /不能小于冷却下限/);
    });

    it('下限本身就非法时，不再叠加一条区间报错', () => {
        const errors = validateFields({ ...GOOD, cooldownMin: '', cooldownMax: 5000 });
        assert.equal(errors.length, 1);
        assert.equal(errors[0].key, 'cooldownMin');
    });

    it('可以只校验一部分字段', () => {
        // 队列参数坏了，但只看报文字段的话应该是干净的
        const settings = { ...GOOD, timeout: '' };
        assert.deepEqual(validateFields(settings, REQUEST_FIELDS), []);
        assert.equal(validateFields(settings).length, 1);
    });

    it('formatErrors 拼出人能读的一句话', () => {
        const errors = validateFields({ ...GOOD, steps: '', scale: 99 });
        const text = formatErrors(errors);
        assert.match(text, /Steps 不能为空/);
        assert.match(text, /Prompt Guidance 不能大于 10/);
        assert.match(text, /；/);
    });
});

describe('buildRequestBody 不做静默兜底', () => {
    // 回归测试：这里曾经写满了 `Number(params.width) || 1216` 这类兜底。
    // 面板留空会被悄悄换成一个用户没选过的值，生成结果和面板显示对不上。
    it('参数留空时抛错，而不是套用默认值', () => {
        for (const key of REQUEST_FIELDS) {
            const params = { ...GOOD, [key]: '' };
            assert.throws(
                () => buildRequestBody({ positive: 'a', negative: '', params }),
                (e) => {
                    assert.match(e.message, /参数有误/);
                    assert.equal(e.errorType.code, 'config');
                    return true;
                },
                `${key} 留空时应该抛错`,
            );
        }
    });

    it('参数越界时抛错', () => {
        assert.throws(
            () => buildRequestBody({ positive: 'a', negative: '', params: { ...GOOD, steps: 999 } }),
            /Steps 不能大于 50/,
        );
    });

    it('报错点名是哪个字段', () => {
        assert.throws(
            () => buildRequestBody({ positive: 'a', negative: '', params: { ...GOOD, scale: '' } }),
            /Prompt Guidance 不能为空/,
        );
    });

    it('合法参数原样进报文，不被任何默认值改写', () => {
        const params = {
            ...GOOD, width: 1024, height: 1536, steps: 12, scale: 3.2,
            seed: 777, sampler: 'k_dpmpp_2m', scheduler: 'native',
        };
        const p = buildRequestBody({ positive: 'a', negative: '', params }).parameters;
        assert.equal(p.width, 1024);
        assert.equal(p.height, 1536);
        assert.equal(p.steps, 12);
        assert.equal(p.scale, 3.2);
        assert.equal(p.seed, 777);
        assert.equal(p.sampler, 'k_dpmpp_2m');
        assert.equal(p.noise_schedule, 'native');
    });

    it('字符串形式的数字也能正确进报文', () => {
        const params = { ...GOOD, steps: '20', scale: '4.5', width: '832', height: '1216' };
        const p = buildRequestBody({ positive: 'a', negative: '', params }).parameters;
        assert.equal(p.steps, 20);
        assert.equal(p.scale, 4.5);
        assert.equal(p.width, 832);
        assert.equal(p.height, 1216);
    });
});
