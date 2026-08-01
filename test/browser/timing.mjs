// ════════════════════════════════════════════════════════════════════════════
// 时序测试：验证「派发发生在流式中途」这一核心主张
// ════════════════════════════════════════════════════════════════════════════
//
// 这是本插件唯一的存在理由，所以值得有一个能真正测出来的测试。
// 它模拟一次含两个 [img:] 的流式回复，逐 chunk 触发 STREAM_TOKEN_RECEIVED，
// 然后核对：第一个 NovelAI 请求发出的时刻，是否早于正文流结束的时刻。
//
// NovelAI 的请求被拦截，不会真的出图也不会消耗 Anlas。
//
// 需要手动跑，因为它依赖一个正在运行的 SillyTavern 和本机 Chrome：
//
//     node server.js --port 8123 --listen false     # 在 SillyTavern 目录
//     ST_URL=http://127.0.0.1:8123 node test/browser/timing.mjs
//
// 环境变量：ST_URL、CHROME、CDP_PORT
// ════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8123';
const CDP_PORT = process.env.CDP_PORT || '9225';
const CHROME = process.env.CHROME
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PROFILE = mkdtempSync(join(tmpdir(), 'sd-chrome-'));
const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const consoleLines = [];
const cmd = (method, params = {}) => new Promise(res => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
});
async function evaluate(expr) {
    const r = await cmd('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
}

try {
    let page;
    for (let i = 0; i < 40; i++) {
        try { page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); if (page) break; } catch {}
        await sleep(250);
    }
    if (!page) page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
        if (m.method === 'Runtime.consoleAPICalled') {
            consoleLines.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
        }
    });
    await cmd('Runtime.enable');
    await cmd('Page.enable');
    await cmd('Page.navigate', { url: ST_URL });
    await sleep(14000);

    const out = await evaluate(`
        const { eventSource, event_types } = await import('/script.js');
        const pipeline = await import('/scripts/extensions/third-party/StreamDraw/src/pipeline.js');
        const { getSettings } = await import('/scripts/extensions/third-party/StreamDraw/src/config.js');

        // 给个假 key 并把冷却清零，让 fetch 路径真的被走到
        const s = getSettings();
        s.apiKey = 'pst-dummy-for-test';
        s.cooldownMin = 0; s.cooldownMax = 0;

        const FULL = '她把手机转过来给你看。[img: 1girl, smile, cafe] "就是这张。"'
            + '窗外的雨还在下，她低头搅了搅杯子里已经凉掉的咖啡，'
            + '过了很久才又开口说了些别的什么，声音轻得几乎听不见。'
            + '最后她翻到相册的最后一页。[img: 2girls, rain, umbrella] "还有这张。"';

        const CHUNKS = 40;
        const step = Math.ceil(FULL.length / CHUNKS);
        // chunk i 覆盖 [0, i*step)，所以位置 p 首次出现在 floor(p/step)+1
        const chunkOf = p => Math.floor(p / step) + 1;

        // 拦截 NovelAI 请求：本测试只关心时序，不真的出图
        const realFetch = window.fetch;
        const naiAt = [];
        const t0 = performance.now();
        window.fetch = (url, ...rest) => {
            if (String(url).includes('novelai.net')) {
                naiAt.push(Math.round(performance.now() - t0));
                return Promise.resolve(new Response(new ArrayBuffer(0), { status: 500 }));
            }
            return realFetch(url, ...rest);
        };

        console.info('SDTEST_MARK chunkOfClose1=' + chunkOf(FULL.indexOf(']')));
        console.info('SDTEST_MARK chunkOfClose2=' + chunkOf(FULL.lastIndexOf(']')));

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        for (let i = 1; i <= CHUNKS; i++) {
            console.info('SDTEST_CHUNK ' + i);
            await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, FULL.slice(0, Math.min(i * step, FULL.length)));
            await new Promise(r => setTimeout(r, 5));
        }
        const streamEnd = Math.round(performance.now() - t0);
        console.info('SDTEST_MARK streamEnd=' + streamEnd);

        await new Promise(r => setTimeout(r, 1500)); // 让队列跑完
        window.fetch = realFetch;
        await eventSource.emit(event_types.GENERATION_ENDED, 0);

        return { streamEnd, naiAt, naiCalls: naiAt.length };
    `);

    // 从 console 流里还原「dispatch 发生在第几个 chunk」
    const marks = {};
    let chunk = 0; const dispatchChunks = [];
    for (const line of consoleLines) {
        const c = line.match(/^SDTEST_CHUNK (\d+)/);
        if (c) { chunk = +c[1]; continue; }
        const m = line.match(/^SDTEST_MARK (\w+)=(\d+)/);
        if (m) { marks[m[1]] = +m[2]; continue; }
        if (line.includes('[StreamDraw] dispatch @')) {
            dispatchChunks.push({ chunk, line: line.trim() });
        }
    }

    console.log('\n流式派发时序（共 40 个 chunk，token 间隔 5ms）:');
    for (const d of dispatchChunks) console.log(`  chunk ${String(d.chunk).padStart(2)} — ${d.line}`);
    console.log(`  闭合 "]" 分别落在 chunk ${marks.chunkOfClose1} 和 ${marks.chunkOfClose2}`);
    console.log(`  正文流结束于 +${out.streamEnd}ms`);
    console.log(`  NovelAI 请求发出时刻: ${out.naiAt.map(t => '+' + t + 'ms').join(', ') || '(无)'}`);

    const d1 = dispatchChunks[0], d2 = dispatchChunks[1];
    const checks = [
        ['两个 token 各派发一次', dispatchChunks.length === 2],
        ['第 1 张图在其闭合 ] 的那个 chunk 派发', d1?.chunk === marks.chunkOfClose1],
        ['第 2 张图在其闭合 ] 的那个 chunk 派发', d2?.chunk === marks.chunkOfClose2],
        ['★ 第 1 张图在正文过半之前就已派发', d1?.chunk < 20],
        ['★ 第 1 个 NovelAI 请求早于正文流结束', out.naiAt[0] != null && out.naiAt[0] < out.streamEnd],
        ['两张图各发一次 NovelAI 请求', out.naiCalls === 2],
    ];
    console.log('');
    let failed = 0;
    for (const [name, ok] of checks) { if (!ok) failed++; console.log(`${ok ? '✔' : '✘'} ${name}`); }
    console.log(`\n${checks.length - failed}/${checks.length} passed`);
    ws.close();
    process.exitCode = failed ? 1 : 0;
} catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
} finally {
    chrome.kill();
}
