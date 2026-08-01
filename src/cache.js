// ════════════════════════════════════════════════════════════════════════════
// IndexedDB：图片缓存 + prompt override 表
// ════════════════════════════════════════════════════════════════════════════
//
// 全链路存 Blob 而不是 base64 字符串：base64 会让体积膨胀 33%，而且每次读写都要
// 编解码一遍。IndexedDB 原生就能存 Blob。
//
// override 表存的是「用户在 slot 上手动改过的 prompt」，key 是正文原始 prompt 的
// hash。这样正文 [img: ...] 保持不动（照常进 LLM 上下文），编辑也不会在重绘中丢失。
// ════════════════════════════════════════════════════════════════════════════

import { LOG_PREFIX } from './config.js';

const DB_NAME = 'aodraw';
const DB_VERSION = 1;
const STORE_IMAGES = 'images';
const STORE_OVERRIDES = 'overrides';

/** @type {IDBDatabase | null} */
let db = null;
/** @type {Promise<IDBDatabase> | null} */
let opening = null;

function openDB() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;

    opening = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_IMAGES)) {
                const store = database.createObjectStore(STORE_IMAGES, { keyPath: 'h' });
                store.createIndex('createdAt', 'createdAt');
            }
            if (!database.objectStoreNames.contains(STORE_OVERRIDES)) {
                database.createObjectStore(STORE_OVERRIDES, { keyPath: 'h' });
            }
        };
    }).finally(() => { opening = null; });

    return opening;
}

function tx(storeName, mode) {
    return openDB().then(database => database.transaction(storeName, mode).objectStore(storeName));
}

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// 图片
// ════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} ImageRecord
 * @property {string} h          prompt 的 hash64
 * @property {string} prompt     生成时用的完整 prompt
 * @property {Blob}   blob
 * @property {number} createdAt
 * @property {boolean} pinned    置位后不被 sweep 清理
 * @property {object} meta       { seed, width, height, model }
 */

/**
 * @param {string} h
 * @returns {Promise<ImageRecord | null>}
 */
export async function get(h) {
    try {
        const store = await tx(STORE_IMAGES, 'readonly');
        return (await promisify(store.get(h))) || null;
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.get failed', e);
        return null;
    }
}

/**
 * @param {string} h
 * @param {string} prompt
 * @param {Blob} blob
 * @param {object} [meta]
 */
export async function put(h, prompt, blob, meta = {}) {
    try {
        const store = await tx(STORE_IMAGES, 'readwrite');
        // pinned 不能被一次重绘悄悄清掉，所以先读旧记录把它带过来
        const existing = await promisify(store.get(h)).catch(() => null);
        await promisify(store.put({
            h,
            prompt,
            blob,
            meta,
            createdAt: Date.now(),
            pinned: existing?.pinned ?? false,
        }));
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.put failed', e);
    }
}

/** @param {string} h */
export async function del(h) {
    try {
        const store = await tx(STORE_IMAGES, 'readwrite');
        await promisify(store.delete(h));
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.del failed', e);
    }
}

/**
 * 按 TTL 清理过期图片，跳过 pinned 的。
 * @param {number} ttlDays 0 表示永不过期
 */
export async function sweep(ttlDays) {
    const days = Number(ttlDays);
    if (!Number.isFinite(days) || days <= 0) return; // 0 = 永久保存

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
        const store = await tx(STORE_IMAGES, 'readwrite');
        await new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onerror = () => reject(req.error);
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) { resolve(); return; }
                const rec = cursor.value;
                if (!rec.pinned && rec.createdAt < cutoff) cursor.delete();
                cursor.continue();
            };
        });
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.sweep failed', e);
    }
}

// ── 预留接口：手动长期保存 / 落盘 / 图库 ─────────────────────────────────────

/**
 * 标记为长期保存，sweep 不再清理它。
 * @param {string} h
 * @param {boolean} [value]
 */
export async function pin(h, value = true) {
    try {
        const store = await tx(STORE_IMAGES, 'readwrite');
        const rec = await promisify(store.get(h));
        if (!rec) return false;
        rec.pinned = !!value;
        await promisify(store.put(rec));
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.pin failed', e);
        return false;
    }
}

/**
 * TODO(post-MVP): 落盘到 SillyTavern 的 /user/images。
 * 接 utils.js 的 saveBase64AsFile(base64, subFolder, fileName, 'png')，
 * 把返回的 URL 写回记录，供图库和聊天记录导出使用。
 * @param {string} h
 */
export async function exportToDisk(h) {
    throw new Error('exportToDisk 尚未实现（post-MVP）');
}

/**
 * TODO(post-MVP): 给全局图库面板分页列出记录。
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<ImageRecord[]>}
 */
export async function list({ limit = 50, offset = 0 } = {}) {
    try {
        const store = await tx(STORE_IMAGES, 'readonly');
        const all = await promisify(store.index('createdAt').getAll());
        return all.reverse().slice(offset, offset + limit);
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.list failed', e);
        return [];
    }
}

/** @returns {Promise<{ count: number, bytes: number }>} */
export async function stats() {
    try {
        const store = await tx(STORE_IMAGES, 'readonly');
        const all = await promisify(store.getAll());
        return {
            count: all.length,
            bytes: all.reduce((sum, r) => sum + (r.blob?.size || 0), 0),
        };
    } catch {
        return { count: 0, bytes: 0 };
    }
}

export async function clearAll() {
    try {
        const store = await tx(STORE_IMAGES, 'readwrite');
        await promisify(store.clear());
    } catch (e) {
        console.warn(LOG_PREFIX, 'cache.clearAll failed', e);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// prompt override
// ════════════════════════════════════════════════════════════════════════════
//
// 内存里镜像一份：renderer 在文本节点手术时需要**同步**拿到 override 来算出生效
// hash，那里没有 await 的余地。启动时 loadOverrides() 预热，之后写入双写。

/** @type {Map<string, string>} */
const overrideCache = new Map();

/** 启动时调用一次，把 override 表读进内存 */
export async function loadOverrides() {
    try {
        const store = await tx(STORE_OVERRIDES, 'readonly');
        const all = await promisify(store.getAll());
        overrideCache.clear();
        for (const rec of all) overrideCache.set(rec.h, rec.prompt);
    } catch (e) {
        console.warn(LOG_PREFIX, 'loadOverrides failed', e);
    }
}

/**
 * 同步查询 override。
 * @param {string} originalHash 正文原始 prompt 的 hash
 * @returns {string | undefined}
 */
export function getOverrideSync(originalHash) {
    return overrideCache.get(originalHash);
}

/**
 * @param {string} originalHash
 * @param {string} prompt
 */
export async function setOverride(originalHash, prompt) {
    overrideCache.set(originalHash, prompt);
    try {
        const store = await tx(STORE_OVERRIDES, 'readwrite');
        await promisify(store.put({ h: originalHash, prompt }));
    } catch (e) {
        console.warn(LOG_PREFIX, 'setOverride failed', e);
    }
}

/** @param {string} originalHash */
export async function clearOverride(originalHash) {
    overrideCache.delete(originalHash);
    try {
        const store = await tx(STORE_OVERRIDES, 'readwrite');
        await promisify(store.delete(originalHash));
    } catch (e) {
        console.warn(LOG_PREFIX, 'clearOverride failed', e);
    }
}
