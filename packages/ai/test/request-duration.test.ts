/**
 * The physical request duration, and the throughput it makes possible.
 *
 * ## What is under test
 *
 * 1. `calculateOutputTokensPerSecond` -- the pure rate function every
 *    consumer shares.
 * 2. `stampRequestDuration` -- the copy, not the mutation, and the fact that
 *    only the usage event is rewritten.
 * 3. `withRequestDuration` -- the measurement itself.
 * 4. The WIRING: a real provider call over a real socket, through the lazy
 *    client every provider is built by, so the duration on the wire is the
 *    one the product will show.
 *
 * ## Why the end-to-end case matters
 *
 * The pure cases would all pass if the measurement were never applied to a
 * real request. The socket case is the one that fails when the wiring is
 * dropped, so it is the one that carries the claim.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAIClient } from '../src/index.js';
import {
  calculateOutputTokensPerSecond,
  stampRequestDuration,
  withRequestDuration,
} from '../src/utils/request-duration.js';
import type { SSEEvent } from '../src/types.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** One SSE event, as the wire really spells it. */
const sseEvent = (name: string, data: string): string => `event: ${name}\ndata: ${data}\n\n`;

/**
 * An Anthropic-shaped endpoint that answers `/v1/messages` with an SSE
 * stream, after a deliberate delay so the measured duration is visibly
 * longer than zero.
 */
async function startFakeAnthropic(delayMs: number): Promise<{ server: Server; baseURL: string }> {
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      void (async () => {
        res.write(sseEvent('message_start', '{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":1}}}'));
        res.write(sseEvent('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'));
        res.write(sseEvent('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}'));
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        res.write(sseEvent('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}'));
        res.write(sseEvent('message_stop', '{"type":"message_stop"}'));
        res.end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, baseURL: `http://127.0.0.1:${port}` };
}

describe('calculateOutputTokensPerSecond', () => {
  it('divides the output tokens by the elapsed seconds', () => {
    expect(calculateOutputTokensPerSecond(63, 1000)).toBeCloseTo(63, 6);
    expect(calculateOutputTokensPerSecond(1000, 2000)).toBeCloseTo(500, 6);
  });

  it('answers null for every input that has no rate to report', () => {
    // No output tokens, no elapsed time, a negative duration, and the two
    // non-finite values. Each of them is "there is no rate", and each of
    // them would divide by zero or produce a number nobody measured.
    expect(calculateOutputTokensPerSecond(0, 1000)).toBeNull();
    expect(calculateOutputTokensPerSecond(100, 0)).toBeNull();
    expect(calculateOutputTokensPerSecond(100, -1)).toBeNull();
    expect(calculateOutputTokensPerSecond(-100, 1000)).toBeNull();
    expect(calculateOutputTokensPerSecond(Number.NaN, 1000)).toBeNull();
    expect(calculateOutputTokensPerSecond(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('stampRequestDuration', () => {
  it('adds the duration to a COPY of the usage, leaving the provider block alone', () => {
    const usage = { input_tokens: 10, output_tokens: 25 };
    const stamped = stampRequestDuration({ type: 'result', data: usage }, 1234);

    expect(stamped).toEqual({
      type: 'result',
      data: { input_tokens: 10, output_tokens: 25, request_duration_ms: 1234 },
    });
    // The provider keeps handing out the same usage object it holds on its
    // assistant message; mutating it would put a transport measurement onto
    // the message the runtime persists.
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 25 });
  });

  it('leaves every event that does not carry usage untouched', () => {
    const text: SSEEvent = { type: 'text', data: 'hello' };
    expect(stampRequestDuration(text, 1234)).toBe(text);
  });
});

describe('withRequestDuration', () => {
  it('measures the elapsed time and stamps it onto the usage event', async () => {
    async function* provider(): AsyncGenerator<SSEEvent, void, unknown> {
      yield { type: 'text', data: 'hi' };
      await new Promise((r) => setTimeout(r, 60));
      yield { type: 'result', data: { input_tokens: 10, output_tokens: 25 } };
    }

    const events: SSEEvent[] = [];
    for await (const event of withRequestDuration(provider())) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result');
    expect(result?.type).toBe('result');
    if (result?.type !== 'result') throw new Error('unreachable');
    // The clock ran while the provider waited, so the measured duration
    // covers the request and not just the bookkeeping around it.
    expect(result.data.request_duration_ms).toBeGreaterThanOrEqual(50);
  });
});

describe('the provider call carries its own duration', () => {
  it('stamps the request duration on the usage a real provider call reports', async () => {
    const endpoint = await startFakeAnthropic(80);
    servers.push(endpoint.server);

    const client = createAIClient({
      apiKey: 'test-key',
      baseURL: endpoint.baseURL,
      model: 'test-model',
      apiFormat: 'anthropic',
      providerId: 'test',
    });

    const results: SSEEvent[] = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'hi' }], {
      tools: [],
      systemPrompt: 'sys',
    })) {
      results.push(event);
    }

    const usage = results.find((e) => e.type === 'result');
    expect(usage?.type).toBe('result');
    if (usage?.type !== 'result') throw new Error('unreachable');
    expect(usage.data.output_tokens).toBe(25);
    // The endpoint waited before answering, and the measured duration
    // includes that wait: this is the provider's time, not the time the
    // consumer spent handling the frames.
    expect(usage.data.request_duration_ms).toBeGreaterThanOrEqual(70);
  });
});
