/**
 * The provider's usage block -> the engine's usage frame.
 *
 * ## What this pins
 *
 * `toModelFrame` is the boundary where the provider's vocabulary is narrowed
 * to the engine's. The request duration is measured at the provider call and
 * is the only thing that makes the output RATE derivable downstream, so it
 * has to survive the narrowing.
 *
 * Two shapes are pinned, and the second one matters as much as the first: a
 * duration that is ABSENT must stay absent. Zeroing it would turn "nobody
 * measured this call" into "this call took no time", and the first of those
 * divides by zero at the consumer while the second invents a measurement.
 *
 * ## The third case is the one that fails when the wiring is dropped
 *
 * The first two cases hand `toModelFrame` a hand-written event. The third
 * drives the REAL client -- the lazy `@duya/ai` proxy every provider is built
 * by -- against a real socket, and reads the duration off the frame the model
 * port actually yields. A measurement that is never applied to a real request
 * passes the first two cases and fails the third.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAIClient } from '@duya/ai';
import { createClientModelPort, toModelFrame } from '../src/run-engine-model.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe('toModelFrame: the usage frame', () => {
  it('carries the provider request duration', () => {
    expect(toModelFrame({
      type: 'result',
      data: {
        input_tokens: 10,
        output_tokens: 1600,
        total_tokens: 1610,
        request_duration_ms: 20_000,
      },
    })).toEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 1600,
      totalTokens: 1610,
      requestDurationMs: 20_000,
    });
  });

  it('omits the duration when the provider reported none', () => {
    const frame = toModelFrame({
      type: 'result',
      data: { input_tokens: 10, output_tokens: 1600, total_tokens: 1610 },
    });
    expect(frame).toEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 1600,
      totalTokens: 1610,
    });
    expect(frame).not.toHaveProperty('requestDurationMs');
  });
});

describe('the model port: a real provider call carries its own duration', () => {
  it('yields a usage frame with the measured request duration', async () => {
    // An Anthropic-shaped endpoint that waits before answering, so the
    // measured duration is visibly longer than zero.
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        void (async () => {
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":1}}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
          await new Promise((r) => setTimeout(r, 80));
          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1600}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        })();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const client = createAIClient({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${port}`,
      model: 'test-model',
      apiFormat: 'anthropic',
      providerId: 'test',
    });

    const frames: string[] = [];
    const usages: Array<Record<string, unknown>> = [];
    for await (const frame of createClientModelPort(client).stream(
      { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] },
      new AbortController().signal,
    )) {
      frames.push(frame.type);
      if (frame.type === 'usage') usages.push(frame as unknown as Record<string, unknown>);
    }

    expect(frames).toContain('usage');
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ outputTokens: 1600 });
    // The endpoint waited before answering, and the duration covers that
    // wait: this is the provider's time, not the consumer's.
    expect(usages[0]?.requestDurationMs).toBeGreaterThanOrEqual(70);
  });
});
