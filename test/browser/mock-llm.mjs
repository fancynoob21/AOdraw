// ════════════════════════════════════════════════════════════════════════════
// 假的 OpenAI 兼容流式端点
// ════════════════════════════════════════════════════════════════════════════
//
// 为什么需要它：timing.mjs 只是手动 emit STREAM_TOKEN_RECEIVED，从来没走过
// SillyTavern 真正的 onProgressStreaming —— 也就是每个 tick 重写
// messageTextDom.innerHTML 的那段。凡是「我们改 DOM」和「ST 重写 DOM」之间的
// 冲突，那个测试都看不见。
//
// 这个 mock 让 ST 跑一次完完整整的真实流式生成，只是把 LLM 换成了可控的脚本。
// ════════════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';

/**
 * @param {object} o
 * @param {string} o.reply     要一个字一个字吐出来的完整回复
 * @param {number} [o.port]
 * @param {number} [o.chunkSize]
 * @param {number} [o.delayMs]  chunk 之间的间隔
 * @returns {Promise<{ port: number, close: () => Promise<void>, requests: object[] }>}
 */
export function startMockLlm({ reply, port = 8199, chunkSize = 6, delayMs = 25 }) {
    const requests = [];

    const server = createServer((req, res) => {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': '*',
        };

        if (req.method === 'OPTIONS') {
            res.writeHead(204, cors).end();
            return;
        }

        if (req.url.includes('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
            res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
            return;
        }

        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
            try { requests.push(JSON.parse(body)); } catch { requests.push({ raw: body }); }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                ...cors,
            });

            for (let i = 0; i < reply.length; i += chunkSize) {
                const delta = reply.slice(i, i + chunkSize);
                res.write(`data: ${JSON.stringify({
                    id: 'mock', object: 'chat.completion.chunk', model: 'mock-model',
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                })}\n\n`);
                await new Promise(r => setTimeout(r, delayMs));
            }

            res.write(`data: ${JSON.stringify({
                id: 'mock', object: 'chat.completion.chunk', model: 'mock-model',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({
            port,
            requests,
            close: () => new Promise(r => server.close(r)),
        }));
    });
}
