/**
 * Wire-level proof that the prompt-cache breakpoints actually reach the wire.
 *
 * `prompt-caching.test.ts` pins the eligibility rule and the marker helpers
 * as isolated units. Neither proves that the CLIENT emits the marker: the
 * client assembles `system`, `messages` and `tools` separately, decides
 * whether the tools breakpoint applies, and hands the result to the SDK.
 * A wiring mistake in any of those steps would leave every unit test green
 * while the provider still receives a request with no `cache_control` at all.
 *
 * This closes that gap with the real chain: a real `@anthropic-ai/sdk`, a
 * real `http.Server` on 127.0.0.1, and the decoded request body. The
 * endpoint is addressed through an `/anthropic` path so the client resolves
 * it as an Anthropic-compatible surface — the shape MiniMax and GLM serve.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAnthropicClient } from '../src/api/anthropic-messages.js';

let server: Server;
let baseURL: string;
let lastBody: Record<string, unknown> | null = null;

const sse = (name: string, data: string): string => `event: ${name}\ndata: ${data}\n\n`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        lastBody = raw ? JSON.parse(raw) : null;
      } catch {
        lastBody = null;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write(sse('message_start', '{"type":"message_start","message":{"id":"m1"}}'));
      res.write(sse('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'));
      res.write(sse('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}'));
      res.write(sse('content_block_stop', '{"type":"content_block_stop","index":0}'));
      res.write(sse('message_stop', '{"type":"message_stop"}'));
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  // The `/anthropic` path segment is what marks this as an
  // Anthropic-compatible surface, exactly like `api.minimaxi.com/anthropic`.
  baseURL = `http://127.0.0.1:${port}/anthropic`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The tools array as it went over the wire. */
const wireTools = (): Array<Record<string, unknown>> =>
  ((lastBody?.tools ?? []) as Array<Record<string, unknown>>);

const TOOLS = [
  { name: 'alpha', description: 'a', input_schema: { type: 'object', properties: {} } },
  { name: 'beta', description: 'b', input_schema: { type: 'object', properties: {} } },
  { name: 'gamma', description: 'c', input_schema: { type: 'object', properties: {} } },
];

async function sendOneTurn(providerId: string, baseUrl: string): Promise<void> {
  const client = createAnthropicClient({
    apiKey: 'test-key',
    baseURL: baseUrl,
    model: 'MiniMax-M3.1-Flash',
    apiFormat: 'anthropic',
    providerId,
  });
  for await (const _ev of client.streamChat([{ role: 'user', content: 'hi' }], {
    tools: TOOLS,
    systemPrompt: 'system prompt',
  })) {
    // Drain the stream so the request is fully sent.
  }
}

describe('prompt-cache breakpoints on the wire', () => {
  it('marks the final tool definition for an Anthropic-compatible endpoint', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lastBody = null;
    await sendOneTurn('minimax-cn', baseURL);

    const tools = wireTools();
    expect(tools).toHaveLength(3);
    // Only the LAST tool carries the marker — it terminates the stable
    // prefix that keeps the whole tools array cache-resident.
    expect(tools[2].cache_control).toEqual({ type: 'ephemeral' });
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toBeUndefined();
  });

  it('marks the system field so the stable system prefix is cache-resident', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lastBody = null;
    await sendOneTurn('minimax-cn', baseURL);

    const system = lastBody?.system;
    expect(Array.isArray(system)).toBe(true);
    const blocks = system as Array<Record<string, unknown>>;
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0].text).toBe('system prompt');
  });

  it('sends no cache_control to a surface that does not accept the marker', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lastBody = null;
    // OpenRouter's surface rejects a marker on tool definitions.
    await sendOneTurn('openrouter', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    const tools = wireTools();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.cache_control).toBeUndefined();
    }
  });

  it('never exceeds Anthropic’s four-breakpoint budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lastBody = null;
    await sendOneTurn('minimax-cn', baseURL);

    let count = 0;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.cache_control !== undefined) count++;
        for (const nested of Object.values(record)) walk(nested);
      }
    };
    walk(lastBody);
    expect(count).toBeLessThanOrEqual(4);
  });
});
