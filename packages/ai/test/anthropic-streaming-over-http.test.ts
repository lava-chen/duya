/**
 * Plan 418 streaming over a REAL HTTP transport.
 *
 * ## What the existing Plan 418 cases do NOT cover
 *
 * `tool-protocol-adaptation.test.ts:311` and `:346` are the two cases written
 * for Plan 418's tolerant SSE parsing, and they are real tests — but the body
 * comes from `new Response(frames)` handed straight to a MOCKED
 * `@anthropic-ai/sdk`. Two things are therefore never exercised:
 *
 *   1. **The transport.** No socket, no chunked transfer encoding, no
 *      backpressure. `new Response(string)` delivers the whole body as one
 *      chunk, so any code that assumed "one chunk == one SSE frame" would pass.
 *   2. **`__binaryResponse` itself.** It is a PRIVATE option
 *      (`internal/request-options.d.ts:65`), and its whole purpose is to make
 *      `client.post(...)` hand back the raw `Response` instead of a parsed
 *      object. With the SDK mocked, the option is never sent to anything: it is
 *      an unread property on a mock call. If Anthropic renamed or dropped it,
 *      every existing Plan 418 test would stay green while the real streaming
 *      path broke on the first token.
 *
 * This file closes both: a real `@anthropic-ai/sdk`, a real `http.Server` on
 * 127.0.0.1, and frames written with `res.write()` — deliberately SPLIT MID-FRAME
 * with a delay, so the decoder has to reassemble across chunk boundaries the
 * way it must in production.
 *
 * ## What a failure here means
 *
 * A red here is a real defect, not a test-authoring problem: either the frame
 * reassembly is wrong, or `__binaryResponse` is not producing a raw Response
 * (in which case the failure surfaces as a stream that yields nothing).
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAnthropicClient } from '../src/api/anthropic-messages.js';

interface FakeEndpoint {
    server: Server;
    baseURL: string;
    /** Paths the client hit, in order. */
    paths: string[];
    /** The decoded JSON body of the last request. */
    lastBody: () => unknown;
}

/**
 * A server that answers `/v1/messages` with an SSE stream.
 *
 * `script` receives the response object so each case controls its own chunking;
 * that is the whole point of this file, so the helper does not abstract it away.
 */
function startFakeAnthropic(script: (res: import('node:http').ServerResponse) => void | Promise<void>): Promise<FakeEndpoint> {
    const paths: string[] = [];
    let body: unknown = null;

    const server: Server = createServer((req, res) => {
        paths.push(req.url ?? '');
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            try {
                body = raw ? JSON.parse(raw) : null;
            } catch {
                body = null;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            // No Content-Length: this is what makes Node chunk the response.
            res.flushHeaders();
            void script(res);
        });
    });

    return new Promise<FakeEndpoint>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                server,
                baseURL: `http://127.0.0.1:${port}`,
                paths,
                lastBody: () => body,
            });
        });
    });
}

const writeSse = (res: import('node:http').ServerResponse, frame: string): void => {
    res.write(frame);
};

/** One SSE event, as the wire really spells it. */
const sseEvent = (name: string, data: string): string => `event: ${name}\ndata: ${data}\n\n`;

const clientFor = (baseURL: string) =>
    createAnthropicClient({
        apiKey: 'test-key',
        baseURL,
        model: 'test-model',
        apiFormat: 'anthropic',
        providerId: 'test',
    });

describe('Plan 418 streaming over a real HTTP transport', () => {
    beforeAll(() => {
        // The production path logs a warning per skipped frame; keep the test
        // output readable without silencing the assertion that looks for it.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    beforeEach(() => {
        // Cleared per case, not per file. Two of these cases make OPPOSITE
        // claims about the same warning — "a corrupt frame was skipped" vs "a
        // repairable frame was repaired, not skipped" — so a warning recorded by
        // an earlier case would fail the later one for the wrong reason.
        vi.mocked(console.warn).mockClear();
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    it('streams a text turn over chunked transfer encoding', async () => {
        const endpoint = await startFakeAnthropic(async (res) => {
            writeSse(res, sseEvent('message_start', '{"type":"message_start","message":{"id":"m1"}}'));
            writeSse(res, sseEvent('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'));
            writeSse(res, sseEvent('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}'));
            // A real delay forces the decoder to hold a partial buffer rather
            // than assume the next read continues the current frame.
            await new Promise((r) => setTimeout(r, 15));
            writeSse(res, sseEvent('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}'));
            writeSse(res, sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}'));
            writeSse(res, sseEvent('message_stop', '{"type":"message_stop"}'));
            res.end();
        });

        try {
            const client = clientFor(endpoint.baseURL);
            const texts: string[] = [];
            const types: string[] = [];

            for await (const ev of client.streamChat([{ role: 'user', content: 'hi' }], {
                tools: [],
                systemPrompt: 'sys',
            })) {
                types.push(ev.type);
                if (ev.type === 'text') texts.push(ev.data);
            }

            expect(texts.join('')).toBe('hello world');
            expect(types).toContain('done');
            // Proof the request really crossed a socket, not a mock.
            expect(endpoint.paths).toContain('/v1/messages');
            expect(endpoint.lastBody()).toMatchObject({ model: 'test-model' });
        } finally {
            endpoint.server.close();
        }
    });

    it('reassembles a frame delivered in two TCP writes', async () => {
        // The frame most likely to break a naive reader: its JSON payload is
        // cut in half mid-object. Anything that parses per-chunk instead of
        // per-frame fails here and nowhere else.
        const endpoint = await startFakeAnthropic(async (res) => {
            writeSse(res, sseEvent('message_start', '{"type":"message_start","message":{"id":"m2"}}'));
            writeSse(res, sseEvent('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'));

            const frame = sseEvent(
                'content_block_delta',
                '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"split across writes"}}',
            );
            const cut = Math.floor(frame.length / 2);
            writeSse(res, frame.slice(0, cut));
            await new Promise((r) => setTimeout(r, 20));
            writeSse(res, frame.slice(cut));

            writeSse(res, sseEvent('message_stop', '{"type":"message_stop"}'));
            res.end();
        });

        try {
            const client = clientFor(endpoint.baseURL);
            const texts: string[] = [];
            for await (const ev of client.streamChat([{ role: 'user', content: 'hi' }], {
                tools: [],
                systemPrompt: 'sys',
            })) {
                if (ev.type === 'text') texts.push(ev.data);
            }
            expect(texts.join('')).toBe('split across writes');
        } finally {
            endpoint.server.close();
        }
    });

    it('skips a malformed frame that arrives split across chunks (Plan 418)', async () => {
        // Both halves of the Plan 418 guarantee, over the transport: the good
        // frames around a corrupt one must still arrive, and the stream must
        // finish rather than throw.
        const endpoint = await startFakeAnthropic(async (res) => {
            writeSse(res, sseEvent('message_start', '{"type":"message_start","message":{"id":"m3"}}'));
            writeSse(res, sseEvent('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'));
            writeSse(res, sseEvent('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"before"}}'));

            const garbage = sseEvent('garbage', 'this is {not] valid json at position 72');
            const cut = Math.floor(garbage.length / 2);
            writeSse(res, garbage.slice(0, cut));
            await new Promise((r) => setTimeout(r, 15));
            writeSse(res, garbage.slice(cut));

            writeSse(res, sseEvent('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"after"}}'));
            writeSse(res, sseEvent('message_stop', '{"type":"message_stop"}'));
            res.end();
        });

        try {
            const client = clientFor(endpoint.baseURL);
            const texts: string[] = [];
            const types: string[] = [];
            for await (const ev of client.streamChat([{ role: 'user', content: 'hi' }], {
                tools: [],
                systemPrompt: 'sys',
            })) {
                types.push(ev.type);
                if (ev.type === 'text') texts.push(ev.data);
            }

            // The frames on either side of the corrupt one both survived.
            expect(texts.join('')).toContain('before');
            expect(texts.join('')).toContain('after');
            expect(types).toContain('done');
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('Skipping malformed SSE event'),
                expect.anything(),
            );
        } finally {
            endpoint.server.close();
        }
    });

    it('repairs a frame whose text carries a raw tab, over the transport (Plan 418)', async () => {
        // The counterpart: a frame that strict JSON.parse rejects but
        // `parseJsonWithRepair` accepts, so the text must survive INTACT —
        // not merely not-crash. This is the assertion that distinguishes repair
        // from skipping.
        const endpoint = await startFakeAnthropic(async (res) => {
            writeSse(res, sseEvent('message_start', '{"type":"message_start","message":{"id":"m4"}}'));
            writeSse(res, sseEvent('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'));

            // The tab is spliced in after JSON.stringify so the fixture cannot
            // be "fixed" by the author noticing it.
            const payload = JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'line1\tline2' },
            });
            writeSse(res, sseEvent('content_block_delta', payload));

            writeSse(res, sseEvent('message_stop', '{"type":"message_stop"}'));
            res.end();
        });

        try {
            const client = clientFor(endpoint.baseURL);
            const texts: string[] = [];
            for await (const ev of client.streamChat([{ role: 'user', content: 'hi' }], {
                tools: [],
                systemPrompt: 'sys',
            })) {
                if (ev.type === 'text') texts.push(ev.data);
            }

            expect(texts.join('')).toContain('line1');
            expect(texts.join('')).toContain('line2');
            expect(console.warn).not.toHaveBeenCalledWith(
                expect.stringContaining('Skipping malformed SSE event'),
                expect.anything(),
            );
        } finally {
            endpoint.server.close();
        }
    });
});
