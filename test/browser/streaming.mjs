// ════════════════════════════════════════════════════════════════════════════
// 真实流式生成下的端到端测试
// ════════════════════════════════════════════════════════════════════════════
//
// 用一个假的 OpenAI 兼容端点驱动 SillyTavern 跑一次**完整的真实流式生成**，
// 于是 onProgressStreaming、messageFormatting、每 tick 的 innerHTML 重写
// （以及开了 stream_fade_in 时的 morphdom）全都会真的跑起来。
//
// timing.mjs 只手动 emit 事件，看不见「我们改 DOM」和「ST 重写 DOM」之间的冲突。
// 这个测试就是为那类 bug 准备的。
//
//     node server.js --port 8123 --listen false      # 在 SillyTavern 目录
//     ST_URL=http://127.0.0.1:8123 node test/browser/streaming.mjs
//
// 环境变量：ST_URL、CHROME、CDP_PORT、EXT_DIR、MOCK_PORT
// ════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMockLlm } from './mock-llm.mjs';

const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8123';
const CDP_PORT = process.env.CDP_PORT || '9240';
const MOCK_PORT = Number(process.env.MOCK_PORT || 8199);
const EXT_DIR = process.env.EXT_DIR || 'AOdraw';
const CHROME = process.env.CHROME
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// stream_fade_in 会让 ST 走 morphdom 增量 patch 而不是整段 innerHTML 重写，
// 那是完全不同的一条渲染路径，得单独验一遍
const FADE_IN = process.env.STREAM_FADE_IN === '1';

// 两个 [img:]，中间隔着足够多的正文 —— 用来观察「下一行正文出来之后」的行为
const REPLY = '她把手机转过来给你看。\n'
    + '[img: 1girl, smile, cafe, window light]\n'
    + '"就是这张。"窗外的雨还在下，她低头搅了搅杯子里已经凉掉的咖啡，'
    + '勺子碰到杯壁发出很轻的一声响。她没有抬头，只是把手机又往前推了推，'
    + '像是要确认你真的看清楚了。过了很久她才又开口，说了些别的什么，'
    + '声音轻得几乎听不见，混在雨声里断断续续的。你想问点什么，'
    + '但看她那个样子又觉得不该打断。窗玻璃上的水痕一道一道往下淌，'
    + '把外面的街灯拉成了长长的光带。\n'
    + '最后她翻到相册的最后一页。\n'
    + '[img: 2girls, rain, umbrella, night]\n'
    + '"还有这张。"她说完就把手机收了回去，屏幕的光在她脸上熄灭了。';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
const consoleLines = [];
const pageErrors = [];

const cmd = (m, p = {}) => new Promise(res => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params: p }));
});

async function ev(expr) {
    const r = await cmd('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
}

async function main() {
    const mock = await startMockLlm({ reply: REPLY, port: MOCK_PORT, chunkSize: 3, delayMs: 55 });
    const profile = mkdtempSync(join(tmpdir(), 'aod-chrome-'));
    const chrome = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' });

    const results = [];
    const check = (n, v, f) => results.push({ n, v, ok: f(v) });

    try {
        let page;
        for (let i = 0; i < 40; i++) {
            try {
                page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json())
                    .find(t => t.type === 'page');
                if (page) break;
            } catch { /* chrome 还没起来 */ }
            await sleep(250);
        }
        if (!page) {
            page = await (await fetch(
                `http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
        }

        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r));
        ws.addEventListener('message', e => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
            if (m.method === 'Runtime.consoleAPICalled') {
                const text = (m.params.args || [])
                    .map(a => a.value ?? a.description ?? '').join(' ');
                consoleLines.push({ level: m.params.type, text });
            }
            if (m.method === 'Runtime.exceptionThrown') {
                const d = m.params.exceptionDetails;
                pageErrors.push(d.exception?.description || d.text);
            }
        });

        await cmd('Runtime.enable');
        await cmd('Page.enable');
        await cmd('Page.navigate', { url: ST_URL });
        await sleep(15000);

        // ── 把 ST 指向 mock 端点 ──────────────────────────────────────────
        const configured = await ev(`
            const ctx = SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            oai.chat_completion_source = 'custom';
            oai.custom_url = 'http://127.0.0.1:${MOCK_PORT}/v1';
            oai.custom_model = 'mock-model';
            oai.stream_openai = true;
            oai.openai_max_tokens = 500;
            window.main_api = 'openai';

            const sel = document.getElementById('main_api');
            if (sel) { sel.value = 'openai'; sel.dispatchEvent(new Event('change')); }
            const src = document.getElementById('chat_completion_source');
            if (src) { src.value = 'custom'; src.dispatchEvent(new Event('change')); }
            const url = document.getElementById('custom_api_url_text');
            if (url) { url.value = 'http://127.0.0.1:${MOCK_PORT}/v1'; url.dispatchEvent(new Event('input')); }
            const model = document.getElementById('custom_model_id');
            if (model) { model.value = 'mock-model'; model.dispatchEvent(new Event('input')); }

            await new Promise(r => setTimeout(r, 800));
            return { source: oai.chat_completion_source, url: oai.custom_url, api: ctx.mainApi };
        `);
        console.log('mock 端点已接入:', JSON.stringify(configured),
            '| stream_fade_in =', FADE_IN);

        // ── 插件设置：开启流式实时预览，摘掉 key 避免真的花额度 ────────────
        await ev(`
            const { getSettings, saveSettings } =
                await import('/scripts/extensions/third-party/${EXT_DIR}/src/config.js');
            const ctxPower = SillyTavern.getContext().powerUserSettings;
            if (ctxPower) ctxPower.stream_fade_in = ${FADE_IN};

            const s = getSettings();
            window.__savedKey = s.apiKey;
            s.apiKey = 'pst-mock-for-streaming-test';
            s.livePreview = true;
            s.enabled = true;
            saveSettings();

            // 拦截 NovelAI：这个测试只关心渲染与流程，不出真图
            window.__naiCalls = 0;
            const real = window.fetch;
            window.__realFetch = real;
            window.fetch = (u, init) => {
                if (String(u).includes('novelai.net')) {
                    window.__naiCalls++;
                    return new Promise(r => setTimeout(
                        () => r(new Response('', { status: 402 })), 300));
                }
                return real(u, init);
            };
            return true;
        `);

        // 开一个干净的聊天，免得上一轮的回复留在记录里干扰
        await ev(`
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat');
            await new Promise(r => setTimeout(r, 1500));
            return SillyTavern.getContext().chat.length;
        `);

        // ── 挂上观测点，然后真的发一条消息 ────────────────────────────────
        await ev(`
            const { eventSource, event_types } = await import('/script.js');
            window.__ended = false;
            window.__endedAt = 0;
            window.__started = Date.now();
            eventSource.on(event_types.GENERATION_ENDED, () => {
                window.__ended = true;
                window.__endedAt = Date.now() - window.__started;
            });

            // 记录流式过程中 slot 出现/消失的轨迹。
            // 只看本轮生成的那一条 —— 用 .pop() 会在流式开始前采到上一轮的遗留消息。
            // 每轮都从新聊天开始，所以「最后一条非用户消息」就是本轮生成的那条。
            // 不能直接用 .pop() —— 流式真正开始前那会拿到用户消息。
            window.__targetMes = () => [...document.querySelectorAll('#chat .mes')]
                .filter(m => m.getAttribute('is_user') !== 'true')
                .pop();
            window.__trace = [];
            window.__traceTimer = setInterval(() => {
                const mes = window.__targetMes();
                if (!mes) return;
                const t = mes.querySelector('.mes_text');
                if (!t) return;
                // slot 消失时把当时的 HTML 片段抓下来，看 [img: 到底变成了什么
                const html = t.innerHTML;
                const idx = html.indexOf('[img:');
                window.__trace.push({
                    snippet: (t.querySelectorAll('.aod-slot').length === 0 && idx >= 0)
                        ? html.slice(Math.max(0, idx - 60), idx + 60) : null,
                    at: Date.now() - window.__started,
                    slots: t.querySelectorAll('.aod-slot').length,
                    rawTokens: (t.textContent.match(/\\[img:/g) || []).length,
                });
            }, 100);
            return true;
        `);

        await ev(`
            const ta = document.getElementById('send_textarea');
            ta.value = '给我看看照片';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('send_but').click();
            return true;
        `);

        // ── 等生成结束，最多 60s ─────────────────────────────────────────
        let ended = false;
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            ended = await ev('return window.__ended;');
            if (ended) break;
        }

        const state = await ev(`
            clearInterval(window.__traceTimer);
            const mes = window.__targetMes();
            const t = mes?.querySelector('.mes_text');
            return {
                ended: window.__ended,
                endedAt: window.__endedAt,
                naiCalls: window.__naiCalls,
                trace: window.__trace,
                finalSlots: t ? t.querySelectorAll('.aod-slot').length : -1,
                finalRawTokens: t ? (t.textContent.match(/\\[img:/g) || []).length : -1,
                finalText: t ? t.textContent.slice(0, 120) : '',
                sendButtonStuck: !!document.getElementById('mes_stop')
                    && getComputedStyle(document.getElementById('mes_stop')).display !== 'none',
            };
        `);

        // ── 断言 ────────────────────────────────────────────────────────
        check('生成正常结束（没有卡住）', { ended: state.ended, at: state.endedAt },
            v => v.ended === true);
        check('停止按钮已收起（UI 已解锁）', state.sendButtonStuck, v => v === false);
        check('流式期间 slot 出现过', state.trace, v => v.some(s => s.slots > 0));
        check('两个 [img:] 都派发了', state.naiCalls, v => v === 2);
        check('结束后两个 slot 都在', state.finalSlots, v => v === 2);
        check('结束后没有残留的 [img:] 原文', state.finalRawTokens, v => v === 0);
        check('没有未捕获的页面异常', pageErrors, v => v.length === 0);

        // 闪烁：token 完整之后 slot 还反复消失，说明注水追不上 ST 的重写。
        // 只看第一次出现 slot 之后的采样 —— 在那之前 token 本来就没打完。
        const firstSlot = state.trace.findIndex(s => s.slots > 0);
        const after = firstSlot >= 0 ? state.trace.slice(firstSlot) : [];
        const blanks = after.filter(s => s.slots === 0).length;
        check('slot 出现后不再闪烁', { blanks, of: after.length },
            v => v.of > 3 && v.blanks / v.of < 0.15);

        const loopish = consoleLines.filter(l => /Maximum call stack|too much recursion/i.test(l.text));
        check('没有栈溢出/递归迹象', loopish.map(l => l.text), v => v.length === 0);

        // 轨迹里 slot 数反复归零，说明注水追不上重写
        const flaps = state.trace.filter((s, i) =>
            i > 0 && state.trace[i - 1].slots > 0 && s.slots === 0).length;
        console.log(`\nslot 轨迹（每 100ms 采样，共 ${state.trace.length} 个采样点，`
            + `slot 归零 ${flaps} 次）：`);
        console.log('  ' + state.trace.map(s => s.slots).join(''));
        console.log(`最终：slot ${state.finalSlots} 个，残留 [img: 原文 ${state.finalRawTokens} 处，`
            + `NovelAI 请求 ${state.naiCalls} 次，结束于 +${state.endedAt}ms`);
        if (!state.ended) console.log('  最终正文片段：', JSON.stringify(state.finalText));

        const stuck = state.trace.filter(s => s.snippet);
        if (stuck.length) {
            console.log('\n[img: 存在但没被注水的时刻（前 3 个采样）：');
            for (const s of stuck.slice(0, 3)) {
                console.log(`  +${s.at}ms  ${JSON.stringify(s.snippet)}`);
            }
        }

        // ── 还原 ────────────────────────────────────────────────────────
        await ev(`
            const { getSettings, saveSettings } =
                await import('/scripts/extensions/third-party/${EXT_DIR}/src/config.js');
            const s = getSettings();
            s.apiKey = window.__savedKey;
            saveSettings();
            if (window.__realFetch) window.fetch = window.__realFetch;
            return true;
        `).catch(() => {});

        console.log('');
        let failed = 0;
        for (const r of results) {
            if (!r.ok) failed++;
            console.log(`${r.ok ? '✔' : '✘'} ${r.n}${r.ok ? '' : '  → ' + JSON.stringify(r.v)}`);
        }
        console.log(`\n${results.length - failed}/${results.length} passed`);

        if (pageErrors.length) {
            console.log('\n页面异常：');
            for (const e of pageErrors.slice(0, 5)) console.log('  ' + e.split('\n')[0]);
        }

        process.exitCode = failed ? 1 : 0;
    } finally {
        try { ws?.close(); } catch { /* 已经关了 */ }
        chrome.kill();
        await mock.close();
    }
}

main().catch(e => {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
});
