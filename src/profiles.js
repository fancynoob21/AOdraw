// ════════════════════════════════════════════════════════════════════════════
// 参数 Profile：命名保存一组“会影响出图结果”的参数
// ════════════════════════════════════════════════════════════════════════════
//
// API Key、队列、缓存、正则这些是插件运行方式；这里保存的是图像风格/请求参数。
// 这样用户切 profile 时切的是“怎么画”，不会顺手改掉“插件怎么跑”。
// ════════════════════════════════════════════════════════════════════════════

import { hash64 } from './util.js';

export const DEFAULT_PROFILE_ID = 'default';

export const PROFILE_FIELDS = [
    'model',
    'positivePrefix',
    'negativePrefix',
    'width',
    'height',
    'steps',
    'scale',
    'seed',
    'sampler',
    'scheduler',
    'varietyBoost',
];

/**
 * 从设置对象里摘出 profile 管理的字段。
 * @param {object} settings
 * @returns {object}
 */
export function pickProfileParams(settings) {
    const params = {};
    for (const key of PROFILE_FIELDS) params[key] = settings?.[key];
    return params;
}

/**
 * 把 profile 参数写回设置对象。
 * @param {object} settings
 * @param {object} params
 */
export function assignProfileParams(settings, params) {
    for (const key of PROFILE_FIELDS) {
        if (params && Object.hasOwn(params, key)) settings[key] = params[key];
    }
}

function makeId(name = 'profile') {
    const base = String(name || 'profile')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'profile';
    return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueName(profiles, wanted) {
    const base = String(wanted || '').trim() || '未命名 Profile';
    const used = new Set(profiles.map(p => p.name));
    if (!used.has(base)) return base;

    let i = 2;
    while (used.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
}

function normalizeProfile(profile, fallbackParams, fallbackName = '默认') {
    const name = String(profile?.name || '').trim() || fallbackName;
    const id = String(profile?.id || '').trim() || makeId(name);
    return {
        id,
        name,
        params: { ...fallbackParams, ...(profile?.params || {}) },
    };
}

/**
 * 确保 settings 里有可用的 profiles。旧版本升级时会把当前面板参数存成默认 profile。
 * @param {object} settings
 */
export function ensureProfiles(settings) {
    const current = pickProfileParams(settings);
    const raw = Array.isArray(settings.profiles) ? settings.profiles : [];

    const profiles = raw.length
        ? raw.map((profile, idx) => normalizeProfile(profile, current, idx === 0 ? '默认' : 'Profile'))
        : [{ id: DEFAULT_PROFILE_ID, name: '默认', params: current }];

    // id 去重。用户手改配置时才会碰到，保守修正即可。
    const seen = new Set();
    for (const profile of profiles) {
        if (!seen.has(profile.id)) {
            seen.add(profile.id);
            continue;
        }
        profile.id = makeId(profile.name);
        seen.add(profile.id);
    }

    settings.profiles = profiles;
    if (!profiles.some(p => p.id === settings.activeProfileId)) {
        settings.activeProfileId = profiles[0].id;
    }
}

/**
 * @param {object} settings
 * @returns {{id: string, name: string, params: object}}
 */
export function getActiveProfile(settings) {
    ensureProfiles(settings);
    return settings.profiles.find(p => p.id === settings.activeProfileId) || settings.profiles[0];
}

/**
 * @param {object} settings
 * @param {string} profileId
 * @returns {boolean}
 */
export function applyProfile(settings, profileId) {
    ensureProfiles(settings);
    const profile = settings.profiles.find(p => p.id === profileId);
    if (!profile) return false;
    settings.activeProfileId = profile.id;
    assignProfileParams(settings, profile.params);
    return true;
}

/**
 * @param {object} settings
 * @param {string} name
 * @returns {{id: string, name: string, params: object}}
 */
export function createProfileFromCurrent(settings, name) {
    ensureProfiles(settings);
    const profile = {
        id: makeId(name),
        name: uniqueName(settings.profiles, name),
        params: pickProfileParams(settings),
    };
    settings.profiles.push(profile);
    settings.activeProfileId = profile.id;
    return profile;
}

/**
 * @param {object} settings
 * @param {string} profileId
 * @returns {{id: string, name: string, params: object} | null}
 */
export function duplicateProfile(settings, profileId) {
    ensureProfiles(settings);
    const source = settings.profiles.find(p => p.id === profileId);
    if (!source) return null;
    const profile = {
        id: makeId(source.name),
        name: uniqueName(settings.profiles, `${source.name} 副本`),
        params: { ...source.params },
    };
    settings.profiles.push(profile);
    settings.activeProfileId = profile.id;
    assignProfileParams(settings, profile.params);
    return profile;
}

/**
 * @param {object} settings
 * @param {string} profileId
 * @param {string} name
 * @returns {boolean}
 */
export function renameProfile(settings, profileId, name) {
    ensureProfiles(settings);
    const profile = settings.profiles.find(p => p.id === profileId);
    const next = String(name || '').trim();
    if (!profile || !next) return false;
    profile.name = uniqueName(settings.profiles.filter(p => p.id !== profileId), next);
    return true;
}

/**
 * @param {object} settings
 * @param {string} profileId
 * @returns {boolean}
 */
export function deleteProfile(settings, profileId) {
    ensureProfiles(settings);
    if (settings.profiles.length <= 1) return false;

    const index = settings.profiles.findIndex(p => p.id === profileId);
    if (index < 0) return false;

    settings.profiles.splice(index, 1);
    if (settings.activeProfileId === profileId) {
        const next = settings.profiles[Math.max(0, index - 1)] || settings.profiles[0];
        settings.activeProfileId = next.id;
        assignProfileParams(settings, next.params);
    }
    return true;
}

/**
 * 把当前面板参数保存进当前 profile。
 * @param {object} settings
 */
export function saveCurrentToActiveProfile(settings) {
    const profile = getActiveProfile(settings);
    profile.params = pickProfileParams(settings);
}

/**
 * @param {object} settings
 * @returns {boolean}
 */
export function isActiveProfileDirty(settings) {
    const profile = getActiveProfile(settings);
    return stableStringify(profile.params) !== stableStringify(pickProfileParams(settings));
}

/**
 * 生成缓存指纹：只有影响图像结果的字段进 hash。
 *
 * seed = -1 表示随机，不进指纹；固定 seed 则进入指纹。这样随机模式下同 profile
 * 可命中缓存，而“重绘”仍然用 force 绕过缓存生成新图。
 * @param {string} prompt
 * @param {object} settings
 * @returns {string}
 */
export function generationHash(prompt, settings) {
    const params = pickProfileParams(settings);
    if (Number(params.seed) < 0) delete params.seed;
    return hash64(stableStringify({ prompt, params }));
}

export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(
            key => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}
