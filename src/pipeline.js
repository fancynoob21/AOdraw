// ════════════════════════════════════════════════════════════════════════════
// 生成流水线：串行队列 + 缓存 + 去重 + 状态广播
// ════════════════════════════════════════════════════════════════════════════
//
// NovelAI 单个 API Key 不支持并发，所以这里是一条严格串行的队列，图与图之间还有
// 随机冷却。「并行」的收益不来自并发生图，而来自**派发时机**：正文还在流式输出
// 的时候第一张图就已经在画了。
//
// 状态是按 hash 而不是按 slot 组织的。同一段正文里出现两个一模一样的 [img:]，
// 或者同一张图在多个楼层被引用，都只会真正生成一次，所有 slot 共享同一份结果。
// ════════════════════════════════════════════════════════════════════════════

import * as cache from './cache.js';
import { getSettings, LOG_PREFIX } from './config.js';
import { ErrorType, generate, NaiError } from './nai-client.js';
import { hash64, randomDelay, sleep } from './util.js';

/**
 * @typedef {'idle'|'queued'|'generating'|'waiting'|'done'|'error'} SlotStatus
 *   idle = 已查过缓存但没命中，且没有人请求生成（翻旧楼层时的常态）
 *
 * @typedef {object} SlotState
 * @property {SlotStatus} status
 * @property {string} prompt
 * @property {string} [url]      done 时的 objectURL
 * @property {number} [position] queued / waiting 时的队内位次（1 起）
 * @property {number} [delayMs]  waiting 时的剩余冷却
 * @property {string} [error]
 * @property {object} [errorType]
 */

/** hash → 状态。renderer 需要**同步**读，所以必须是内存 Map。 @type {Map<string, SlotState>} */
const states = new Map();

/** hash → 监听者 @type {Map<string, Set<(s: SlotState) => void>>} */
const listeners = new Map();

/** hash → 进行中的 Promise，用于同 prompt 去重 @type {Map<string, Promise<void>>} */
const inflight = new Map();

/** 待处理队列 @type {Array<{ h: string, prompt: string }>} */
const queue = [];
let draining = false;

// ════════════════════════════════════════════════════════════════════════════
// 状态读写与广播
// ════════════════════════════════════════════════════════════════════════════

/** @param {string} prompt @returns {string} */
export function hashOf(prompt) {
    return hash64(prompt);
}

/**
 * 同步读状态。renderer 在文本节点手术时靠它决定 slot 渲染成什么样。
 * @param {string} h
 * @returns {SlotState | undefined}
 */
export function peek(h) {
    return states.get(h);
}

function setState(h, patch) {
    const next = { ...(states.get(h) || {}), ...patch };
    states.set(h, next);
    const set = listeners.get(h);
    if (set) {
        for (const fn of set) {
            try { fn(next); } catch (e) { console.warn(LOG_PREFIX, 'listener threw', e); }
        }
    }
}

/**
 * @param {string} h
 * @param {(s: SlotState) => void} fn
 * @returns {() => void} 取消订阅
 */
export function subscribe(h, fn) {
    if (!listeners.has(h)) listeners.set(h, new Set());
    listeners.get(h).add(fn);
    return () => listeners.get(h)?.delete(fn);
}

function revokeUrl(h) {
    const url = states.get(h)?.url;
    if (url) URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════════════════════════════
// 缓存读取（不触发生成）
// ════════════════════════════════════════════════════════════════════════════

/** hash → 正在进行的缓存查询，避免同一 hash 并发查 IndexedDB @type {Map<string, Promise<boolean>>} */
const cacheProbes = new Map();

/**
 * 只查缓存，**不会**发起生成。
 *
 * 这是刷新页面 / 翻旧楼层时走的路径：命中就直接出图，未命中则保持 idle，
 * 由 renderer 显示一个「生成」按钮交给用户决定 —— 滚动历史记录时静默烧掉
 * 一整个聊天的 Anlas 是不可接受的。
 *
 * @param {string} h
 * @returns {Promise<boolean>} 是否命中
 */
export function hydrateFromCache(h, prompt = '') {
    // 只要状态已知就不再查库。这很重要：注水在流式期间每秒会跑好几次，
    // 没有这道闸门就会对每个未命中的 slot 反复读 IndexedDB。
    const existing = states.get(h);
    if (existing) return Promise.resolve(existing.status === 'done');

    if (cacheProbes.has(h)) return cacheProbes.get(h);

    const probe = cache.get(h).then(rec => {
        // 竞态：探测期间真实生成可能已经完成了，别覆盖更新的结果
        if (states.get(h)?.status === 'done') return true;
        if (!rec?.blob) {
            setState(h, { status: 'idle', prompt });
            return false;
        }
        setState(h, {
            status: 'done',
            prompt: rec.prompt || prompt,
            url: URL.createObjectURL(rec.blob),
            error: undefined,
        });
        return true;
    }).catch(() => false).finally(() => cacheProbes.delete(h));

    cacheProbes.set(h, probe);
    return probe;
}

// ════════════════════════════════════════════════════════════════════════════
// 派发
// ════════════════════════════════════════════════════════════════════════════

/**
 * 请求生成一张图。
 *
 * 调用点通常是 `void request(...)` —— STREAM_TOKEN_RECEIVED 的监听器被 ST 的流式
 * 循环 await，绝不能在那里等网络。所以本函数内部自行吞掉所有异常，把失败落到
 * 状态里让 UI 去显示，绝不向外抛。
 *
 * @param {string} prompt
 * @param {{ force?: boolean }} [opts] force = 绕过缓存重新生成（「重绘」按钮）
 * @returns {Promise<void>}
 */
export function request(prompt, { force = false } = {}) {
    const h = hash64(prompt);

    const existing = inflight.get(h);
    if (existing) return existing; // 同 prompt 已在飞，复用

    const task = (async () => {
        if (!force) {
            const hit = await hydrateFromCache(h, prompt);
            if (hit) return;
        }

        setState(h, { status: 'queued', prompt, position: queue.length + 1, error: undefined });
        queue.push({ h, prompt });
        renumberQueue();
        void drain();

        // drain 会在这个 hash 完成时把状态置为 done/error，这里只需等它落地
        await new Promise(resolve => {
            const off = subscribe(h, (s) => {
                if (s.status === 'done' || s.status === 'error') {
                    off();
                    resolve();
                }
            });
        });
    })().catch(e => {
        console.warn(LOG_PREFIX, 'request failed', e);
        setState(h, { status: 'error', prompt, error: e?.message || '失败' });
    }).finally(() => {
        inflight.delete(h);
    });

    inflight.set(h, task);
    return task;
}

function renumberQueue() {
    queue.forEach((item, idx) => {
        const s = states.get(item.h);
        if (s && (s.status === 'queued' || s.status === 'waiting')) {
            setState(item.h, { position: idx + 1 });
        }
    });
}

async function drain() {
    if (draining) return;
    draining = true;

    try {
        while (queue.length > 0) {
            const { h, prompt } = queue.shift();
            renumberQueue();

            setState(h, { status: 'generating', position: queue.length });

            try {
                const settings = getSettings();
                const { blob, meta } = await generate({ prompt, settings });
                await cache.put(h, prompt, blob, meta);
                revokeUrl(h);
                setState(h, {
                    status: 'done',
                    url: URL.createObjectURL(blob),
                    error: undefined,
                    errorType: undefined,
                });
            } catch (e) {
                const err = e instanceof NaiError ? e : new NaiError(e?.message || '失败');
                console.warn(LOG_PREFIX, 'generate failed:', err.message);
                setState(h, {
                    status: 'error',
                    error: err.message,
                    errorType: err.errorType,
                });

                // 认证、额度、参数非法这三类，重试没有意义 —— 直接把整条队列清掉，
                // 免得后面几十张图挨个撞同一堵墙、每张都弹一次同样的错。
                if (err.errorType === ErrorType.AUTH
                    || err.errorType === ErrorType.QUOTA
                    || err.errorType === ErrorType.CONFIG) {
                    failRemaining(err);
                    break;
                }
            }

            // 图与图之间随机冷却。随机而非固定间隔是为了不呈现出机器人节奏。
            if (queue.length > 0) {
                const settings = getSettings();
                const delayMs = randomDelay(settings.cooldownMin, settings.cooldownMax);
                const until = Date.now() + delayMs;

                for (const item of queue) {
                    setState(item.h, { status: 'waiting', delayMs });
                }

                // 每秒刷一次倒计时，让 UI 上的秒数走起来
                while (Date.now() < until) {
                    await sleep(Math.min(1000, until - Date.now()));
                    const remain = Math.max(0, until - Date.now());
                    for (const item of queue) {
                        if (states.get(item.h)?.status === 'waiting') {
                            setState(item.h, { delayMs: remain });
                        }
                    }
                }
            }
        }
    } finally {
        draining = false;
        // drain 期间可能又有新任务入队
        if (queue.length > 0) void drain();
    }
}

function failRemaining(err) {
    while (queue.length > 0) {
        const { h } = queue.shift();
        setState(h, { status: 'error', error: err.message, errorType: err.errorType });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 维护
// ════════════════════════════════════════════════════════════════════════════

/** 清空队列（切聊天等场景）。已在生成的那一张会跑完并入缓存，不打断。 */
export function clearQueue() {
    while (queue.length > 0) {
        const { h } = queue.shift();
        setState(h, { status: 'error', error: '已取消' });
    }
}

/** 丢弃所有 objectURL 与状态（卸载插件时） */
export function dispose() {
    clearQueue();
    for (const h of states.keys()) revokeUrl(h);
    states.clear();
    listeners.clear();
    inflight.clear();
}

/** 供「重绘」用：忘掉某个 hash 的状态，下次会重新查缓存 */
export function forget(h) {
    revokeUrl(h);
    states.delete(h);
}
