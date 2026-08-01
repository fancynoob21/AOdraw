// ════════════════════════════════════════════════════════════════════════════
// 参数校验
// ════════════════════════════════════════════════════════════════════════════
//
// 默认值的定位是**面板的预填充**，不是后台的兜底。
//
// 曾经 buildRequestBody 里写满了 `Number(params.width) || 1216` 这种东西 ——
// 面板留空会被悄悄换成一个用户没选过的值，生成出来的图和面板显示的参数对不上，
// 而且不会有任何提示。现在留空就是留空，校验会指名道姓地报出来。
//
// 本文件不引 SillyTavern，可在 node 下单测。
// ════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} FieldSpec
 * @property {string} label   报错时显示的字段名
 * @property {'int'|'number'|'string'} type
 * @property {number} [min]
 * @property {number} [max]
 */

/** @type {Record<string, FieldSpec>} */
export const FIELD_SPECS = {
    width: { label: '宽', type: 'int', min: 64, max: 2048 },
    height: { label: '高', type: 'int', min: 64, max: 2048 },
    steps: { label: 'Steps', type: 'int', min: 1, max: 50 },
    scale: { label: 'Prompt Guidance', type: 'number', min: 0, max: 10 },
    seed: { label: 'Seed', type: 'int', min: -1, max: 0xffffffff },
    sampler: { label: 'Sampler', type: 'string' },
    scheduler: { label: 'Noise schedule', type: 'string' },
    cooldownMin: { label: '冷却下限', type: 'int', min: 0, max: 600000 },
    cooldownMax: { label: '冷却上限', type: 'int', min: 0, max: 600000 },
    timeout: { label: '超时', type: 'int', min: 5000, max: 600000 },
    ttlDays: { label: '缓存保留天数', type: 'int', min: 0, max: 3650 },
    historyDepth: { label: '历史楼层渲染', type: 'int', min: -1, max: 9999 },
};

/** 进入 NAI 报文的字段。buildRequestBody 用这一组。 */
export const REQUEST_FIELDS = [
    'width', 'height', 'steps', 'scale', 'seed', 'sampler', 'scheduler',
];

/** 面板上所有需要校验的字段 */
export const ALL_FIELDS = Object.keys(FIELD_SPECS);

/**
 * @typedef {object} FieldError
 * @property {string} key
 * @property {string} label
 * @property {string} message
 */

/**
 * 校验单个字段。
 * @param {string} key
 * @param {any} value
 * @returns {FieldError | null}
 */
export function validateField(key, value) {
    const spec = FIELD_SPECS[key];
    if (!spec) return null;

    const fail = (message) => ({ key, label: spec.label, message });

    // 留空一律算错，绝不回落到默认值
    if (value === '' || value === null || value === undefined) {
        return fail('不能为空');
    }

    if (spec.type === 'string') {
        return String(value).trim() ? null : fail('不能为空');
    }

    const num = Number(value);
    if (!Number.isFinite(num)) return fail('必须是数字');
    if (spec.type === 'int' && !Number.isInteger(num)) return fail('必须是整数');
    if (spec.min !== undefined && num < spec.min) return fail(`不能小于 ${spec.min}`);
    if (spec.max !== undefined && num > spec.max) return fail(`不能大于 ${spec.max}`);

    return null;
}

/**
 * 校验一组字段。
 * @param {object} settings
 * @param {string[]} [keys]
 * @returns {FieldError[]} 空数组表示全部通过
 */
export function validateFields(settings, keys = ALL_FIELDS) {
    const errors = [];
    for (const key of keys) {
        const error = validateField(key, settings?.[key]);
        if (error) errors.push(error);
    }

    // 跨字段：冷却区间不能反着来。只在两端各自都合法时才检查，
    // 否则会在「下限为空」之上再叠一条没用的报错。
    if (keys.includes('cooldownMin') && keys.includes('cooldownMax')) {
        const min = Number(settings?.cooldownMin);
        const max = Number(settings?.cooldownMax);
        const bothValid = !errors.some(e => e.key === 'cooldownMin' || e.key === 'cooldownMax');
        if (bothValid && min > max) {
            errors.push({
                key: 'cooldownMax',
                label: FIELD_SPECS.cooldownMax.label,
                message: `不能小于冷却下限 (${min})`,
            });
        }
    }

    return errors;
}

/**
 * 把校验结果拼成一句人能读的话。
 * @param {FieldError[]} errors
 * @returns {string}
 */
export function formatErrors(errors) {
    return errors.map(e => `${e.label} ${e.message}`).join('；');
}
