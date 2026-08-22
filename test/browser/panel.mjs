// ════════════════════════════════════════════════════════════════════════════
// 设置面板与渲染管线的浏览器测试
// ════════════════════════════════════════════════════════════════════════════
//
// 覆盖：面板控件完整性、id 不与内置扩展撞车、默认值预填充、参数校验、
// 尺寸与免费额度提示、模型下拉、历史楼层深度、slot 注入的幂等性。
//
//     node server.js --port 8123 --listen false      # 在 SillyTavern 目录
//     ST_URL=http://127.0.0.1:8123 node test/browser/panel.mjs
//
// 环境变量：ST_URL、CHROME、CDP_PORT、EXT_DIR
//
// 全程摘掉 API Key，绝不产生真实的 NovelAI 请求。结束时还原所有被改动的设置 ——
// 这里写的是用户真实的 ST 配置。
// ════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8123';
const CDP_PORT = process.env.CDP_PORT || '9250';
const EXT_DIR = process.env.EXT_DIR || 'AOdraw';
const CHROME = process.env.CHROME
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CFG = `/scripts/extensions/third-party/${EXT_DIR}/src/config.js`;
const RENDERER = `/scripts/extensions/third-party/${EXT_DIR}/src/renderer.js`;
const PIPELINE = `/scripts/extensions/third-party/${EXT_DIR}/src/pipeline.js`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
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
        });
        await cmd('Runtime.enable');
        await cmd('Page.enable');
        await cmd('Page.navigate', { url: ST_URL });
        await sleep(15000);

        // 摘掉 Key，本测试绝不打真实 NovelAI
        await ev(`
            const { getSettings } = await import('${CFG}');
            const s = getSettings();
            window.__saved = JSON.parse(JSON.stringify(s));
            s.apiKey = '';
            return true;
        `);

        // ── 面板完整性 ──────────────────────────────────────────────────
        check('面板控件齐全', await ev(`
            const ids = ['aod_enabled','aod_api_key','aod_model','aod_positive','aod_negative',
                         'aod_size','aod_steps','aod_scale','aod_seed','aod_sampler','aod_scheduler',
                         'aod_variety_boost','aod_cooldown_min','aod_cooldown_max','aod_timeout',
                         'aod_ttl_days','aod_live_preview','aod_history_depth','aod_pattern',
                         'aod_guideline','aod_test_key','aod_test_prompt','aod_test_generate',
                         'aod_validation'];
            return ids.filter(i => !document.getElementById(i));
        `), v => v.length === 0);

        // 内置的 Stable Diffusion 扩展用的是 sd_ 前缀，曾经和我们撞了 8 个 id
        check('我们的 id 全文档唯一，且不与内置 SD 扩展撞车', await ev(`
            const dupes = [];
            for (const el of document.querySelectorAll('[id^="aod_"]')) {
                if (document.querySelectorAll('[id="' + el.id + '"]').length > 1) dupes.push(el.id);
            }
            const builtins = ['sd_width','sd_height','sd_steps','sd_scale','sd_seed',
                              'sd_sampler','sd_scheduler'].filter(i => !document.getElementById(i));
            return { dupes: [...new Set(dupes)], missingBuiltins: builtins };
        `), v => v.dupes.length === 0 && v.missingBuiltins.length === 0);

        // ── 模型下拉 ────────────────────────────────────────────────────
        check('模型下拉列出全部可选模型，默认 V5 Full', await ev(`
            const { MODEL_OPTIONS, DEFAULT_MODEL, getSettings } = await import('${CFG}');
            const sel = document.getElementById('aod_model');
            sel.value = getSettings().model;
            return {
                count: sel.options.length,
                expected: MODEL_OPTIONS.length,
                first: sel.options[0].value,
                def: DEFAULT_MODEL,
                current: sel.value,
            };
        `), v => v.count === v.expected && v.first === 'nai-diffusion-5-full'
              && v.def === 'nai-diffusion-5-full' && v.current === v.def);

        check('切换模型会写入设置并进到报文里', await ev(`
            const { getSettings } = await import('${CFG}');
            const { buildRequestBody } = await import(
                '/scripts/extensions/third-party/${EXT_DIR}/src/nai-client.js');
            const sel = document.getElementById('aod_model');
            sel.value = 'nai-diffusion-4-5-full';
            sel.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 100));
            const body = buildRequestBody({
                positive: 'a', negative: '', params: getSettings() });
            return { stored: getSettings().model, inBody: body.model };
        `), v => v.stored === 'nai-diffusion-4-5-full' && v.inBody === 'nai-diffusion-4-5-full');

        // ── 默认值是预填充，不是后台兜底 ────────────────────────────────
        check('默认值正确，且面板忠实反映设置', await ev(`
            const { DEFAULT_SETTINGS, getSettings } = await import('${CFG}');
            const d = DEFAULT_SETTINGS, s = getSettings();
            return {
                defaults: [d.steps, d.scale, d.seed, d.historyDepth],
                mirrors: ['aod_steps','aod_scale','aod_seed'].every((id, i) =>
                    document.getElementById(id).value === String([s.steps, s.scale, s.seed][i])),
            };
        `), v => v.defaults[0] === 28 && v.defaults[1] === 5.5
              && v.defaults[2] === -1 && v.defaults[3] === 5 && v.mirrors === true);

        check('清空字段 → 报错 + 标红，且不被换成默认值', await ev(`
            const { getSettings } = await import('${CFG}');
            const el = document.getElementById('aod_steps');
            el.value = ''; el.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 100));
            const banner = document.getElementById('aod_validation');
            return { shown: !banner.hidden, text: banner.textContent,
                     red: el.classList.contains('aod-invalid'), stored: getSettings().steps };
        `), v => v.shown && v.text.includes('Steps 不能为空') && v.red && v.stored === '');

        check('参数非法时生图被拒且点名字段，不发请求', await ev(`
            const pipeline = await import('${PIPELINE}');
            const { getSettings } = await import('${CFG}');
            getSettings().apiKey = 'pst-dummy';
            let nai = 0;
            const real = window.fetch;
            window.fetch = (u, ...r) => { if (String(u).includes('novelai.net')) nai++; return real(u, ...r); };
            await pipeline.request('panel validation probe');
            window.fetch = real;
            getSettings().apiKey = '';
            const s = pipeline.peek(pipeline.hashOf('panel validation probe'));
            return { status: s?.status, error: s?.error, nai };
        `), v => v.status === 'error' && /Steps 不能为空/.test(v.error || '') && v.nai === 0);

        check('填回合法值后报错消失、红框撤销', await ev(`
            const el = document.getElementById('aod_steps');
            el.value = '28'; el.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 150));
            return { hidden: document.getElementById('aod_validation').hidden,
                     reds: document.querySelectorAll('.aod-invalid').length };
        `), v => v.hidden === true && v.reds === 0);

        // ── 尺寸与免费额度 ──────────────────────────────────────────────
        check('尺寸下拉标出三个免费组合', await ev(`
            const sel = document.getElementById('aod_size');
            return [...sel.options].filter(o => o.textContent.includes('免费')).length;
        `), v => v === 3);

        check('免费提示同时取决于尺寸和 steps', await ev(`
            const size = document.getElementById('aod_size');
            const steps = document.getElementById('aod_steps');
            const hint = document.getElementById('aod_size_hint');
            size.value = '1216x832'; size.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 80));
            const free = hint.textContent;
            steps.value = '40'; steps.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 80));
            const overSteps = hint.textContent;
            steps.value = '28'; steps.dispatchEvent(new Event('change'));
            size.value = '1536x1024'; size.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 80));
            const overSize = hint.textContent;
            return { free, overSteps, overSize };
        `), v => v.free.includes('✅') && v.overSteps.includes('⚠️')
              && v.overSteps.includes('28') && v.overSize.includes('⚠️'));

        // ── slot 注入 ───────────────────────────────────────────────────
        check('注入 slot：跳过代码块、幂等、可从重写中恢复', await ev(`
            const mod = await import('${RENDERER}');
            const chat = document.getElementById('chat');
            chat.querySelectorAll('.mes[mesid^="99"]').forEach(e => e.remove());
            chat.insertAdjacentHTML('beforeend',
                '<div class="mes" mesid="9901"><div class="mes_block">' +
                '<div class="mes_buttons"><div class="extraMesButtons"></div></div>' +
                '<div class="mes_text">她转过手机。[img: 1girl, smile, cafe] "看。" ' +
                '<pre><code>[img: 应该被跳过]</code></pre></div></div></div>');

            const mes = () => chat.querySelector('.mes[mesid="9901"]');
            const slots = () => mes().querySelectorAll('.aod-slot');

            mod.hydrateAll();
            await new Promise(r => setTimeout(r, 250));
            const first = { n: slots().length, h: slots()[0]?.dataset.h,
                            prompt: slots()[0]?.dataset.prompt,
                            code: mes().querySelector('code').textContent,
                            panelBtn: !!mes().querySelector('.aod_message_panel') };

            for (let i = 0; i < 20; i++) mod.hydrateAll();
            await new Promise(r => setTimeout(r, 200));
            const idempotent = slots().length;

            // 模拟 ST 的整段重写
            mes().querySelector('.mes_text').innerHTML = '她转过手机。[img: 1girl, smile, cafe] "看。"';
            mod.hydrateAll();
            await new Promise(r => setTimeout(r, 200));
            const recovered = { n: slots().length, h: slots()[0]?.dataset.h };

            chat.querySelectorAll('.mes[mesid^="99"]').forEach(e => e.remove());
            return { first, idempotent, recovered };
        `), v => v.first.n === 1 && /^[0-9a-f]{16}$/.test(v.first.h || '')
              && v.first.prompt === '1girl, smile, cafe'
              && v.first.code === '[img: 应该被跳过]' && v.first.panelBtn
              && v.idempotent === 1
              && v.recovered.n === 1 && v.recovered.h === v.first.h);

        // ── 历史楼层深度 ────────────────────────────────────────────────
        check('历史深度限制批量注水，最新层永远渲染', await ev(`
            const mod = await import('${RENDERER}');
            const { getSettings } = await import('${CFG}');
            const chat = document.getElementById('chat');
            chat.querySelectorAll('.mes[mesid^="98"]').forEach(e => e.remove());
            for (let i = 0; i < 12; i++) {
                chat.insertAdjacentHTML('beforeend',
                    '<div class="mes" mesid="98' + i + '"><div class="mes_block">' +
                    '<div class="mes_buttons"><div class="extraMesButtons"></div></div>' +
                    '<div class="mes_text">层 ' + i + ' [img: floor' + i + ', 1girl]</div>' +
                    '</div></div>');
            }
            const reset = () => {
                for (const m of chat.querySelectorAll('.mes[mesid^="98"]')) {
                    const i = m.getAttribute('mesid').slice(2);
                    m.querySelector('.mes_text').innerHTML = '层 ' + i + ' [img: floor' + i + ', 1girl]';
                }
            };
            const measure = async (depth) => {
                reset();
                getSettings().historyDepth = depth;
                mod.hydrateAll();
                await new Promise(r => setTimeout(r, 200));
                return [...chat.querySelectorAll('.mes[mesid^="98"]')]
                    .filter(m => m.querySelector('.aod-slot')).length;
            };
            const out = { d5: await measure(5), d0: await measure(0), all: await measure(-1) };

            // 单层注水不受深度限制
            await measure(5);
            mod.hydrateMessage('980');
            await new Promise(r => setTimeout(r, 150));
            out.oldFloorOnDemand = !!chat.querySelector('.mes[mesid="980"] .aod-slot');

            chat.querySelectorAll('.mes[mesid^="98"]').forEach(e => e.remove());
            return out;
        `), v => v.d5 === 6 && v.d0 === 1 && v.all === 12 && v.oldFloorOnDemand === true);

        // ── 还原 ────────────────────────────────────────────────────────
        const restored = await ev(`
            const { getSettings, saveSettings } = await import('${CFG}');
            const s = getSettings();
            Object.assign(s, window.__saved);
            saveSettings();
            return { model: s.model, steps: s.steps, size: s.width + 'x' + s.height,
                     depth: s.historyDepth, keyRestored: !!s.apiKey };
        `);
        console.log('已还原设置:', JSON.stringify(restored));

        console.log('');
        let failed = 0;
        for (const r of results) {
            if (!r.ok) failed++;
            console.log(`${r.ok ? '✔' : '✘'} ${r.n}${r.ok ? '' : '  → ' + JSON.stringify(r.v)}`);
        }
        console.log(`\n${results.length - failed}/${results.length} passed`);
        process.exitCode = failed ? 1 : 0;
    } finally {
        try { ws?.close(); } catch { /* 已经关了 */ }
        chrome.kill();
    }
}

main().catch(e => {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
});
