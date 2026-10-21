/**
 * packages/ai/test/api/google-generative-ai.test.ts
 *
 * Plan 451 Phase 4: Google GenerativeLanguage wire protocol — request
 * conversion, SSE event mapping, and end-to-end fetch flow.
 */

import { describe, it, expect } from 'vitest';
import { createGoogleGenerativeAiClient } from '../../src/api/google-generative-ai.js';
import type { Message, SSEEvent } from '../../src/types.js';

function makeSseResponse(frames: Array<{ data: string }>, status = 200): Response {
  const body = frames.map((f) => `data: ${f.data}\n\n`).join('');
  const enc = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc);
        controller.close();
      },
    }),
    { status },
  );
}

describe('createGoogleGenerativeAiClient — end-to-end with mocked fetch', () => {
  it('yields text events for streamed text parts and folds usage into the final message', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const client = createGoogleGenerativeAiClient({
      apiKey: 'GEM-KEY',
      model: 'gemini-2.5-pro',
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return makeSseResponse([
          { data: JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] }, index: 0 }],
          }) },
          { data: JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] }, index: 0 }],
          }) },
          { data: JSON.stringify({
            candidates: [{ finishReason: 'STOP', index: 0 }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
          }) },
        ]);
      }) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    let finalAssistant: unknown;
    const gen = client.streamChat([{ role: 'user', content: 'hi' }], { systemPrompt: 'be terse' });
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    finalAssistant = next.value;

    // Public events (text deltas downgrade to type:'text' via emit-sse).
    // `result` precedes `done` so the agent loop can anchor usage accounting
    // on real API numbers (previously missing — Gemini turns persisted with
    // no usage at all).
    expect(events).toEqual([
      { type: 'text', data: 'Hello ' },
      { type: 'text', data: 'world' },
      { type: 'result', data: { input_tokens: 12, output_tokens: 5 } },
      { type: 'done', reason: 'end_turn' },
    ]);
    expect((finalAssistant as { usage: { input_tokens: number } }).usage.input_tokens).toBe(12);
    expect((finalAssistant as { usage: { output_tokens: number } }).usage.output_tokens).toBe(5);
    // x-goog-api-key header is set.
    expect(capturedHeaders?.['x-goog-api-key']).toBe('GEM-KEY');
    expect(capturedHeaders?.['content-type']).toBe('application/json');
  });

  it('emits thinking events for parts with thought: true and preserves thoughtSignature', async () => {
    const client = createGoogleGenerativeAiClient({
      apiKey: 'GEM-KEY',
      model: 'gemini-2.5-pro',
      fetchImpl: (async () =>
        makeSseResponse([
          { data: JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [
              { text: 'reasoning step', thought: true, thoughtSignature: 'sig-A' },
            ] }, index: 0 }],
          }) },
          { data: JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [
              { text: ' final answer', thoughtSignature: 'sig-A' },
            ] }, index: 1 }],
          }) },
          { data: JSON.stringify({
            candidates: [{ finishReason: 'STOP', index: 1 }],
          }) },
        ])
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    let finalAssistant: unknown;
    const gen = client.streamChat([{ role: 'user', content: 'hi' }]);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    finalAssistant = next.value;
    // Thinking text and final text both yield type:'thinking' and type:'text'
    // respectively (emit-sse maps them). Since the signature fix, the delta
    // carries the thoughtSignature and a signature-only empty-data event
    // closes the block.
    expect(events).toEqual([
      { type: 'thinking', data: 'reasoning step', signature: 'sig-A' },
      { type: 'thinking', data: '', signature: 'sig-A' },
      { type: 'text', data: ' final answer' },
      { type: 'done', reason: 'end_turn' },
    ]);
    const blocks = (finalAssistant as { content: Array<{ type: string; thinking?: string; text?: string; thinkingSignature?: string; textSignature?: string }> }).content;
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'reasoning step', thinkingSignature: 'sig-A' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: ' final answer', textSignature: 'sig-A' });
  });

  it('emits tool_use events for functionCall parts', async () => {
    const client = createGoogleGenerativeAiClient({
      apiKey: 'GEM-KEY',
      model: 'gemini-2.5-pro',
      fetchImpl: (async () =>
        makeSseResponse([
          { data: JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [
              { functionCall: { name: 'Bash', args: { command: 'ls' } } },
            ] }, finishReason: 'STOP', index: 0 }],
          }) },
        ])
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    for await (const e of client.streamChat([{ role: 'user', content: 'list files' }])) {
      events.push(e);
    }
    expect(events).toContainEqual({
      type: 'tool_use_started',
      data: { id: 'gemini-call-0', name: 'Bash', input: { command: 'ls' } },
    });
    expect(events).toContainEqual({
      type: 'tool_use',
      data: { id: 'gemini-call-0', name: 'Bash', input: { command: 'ls' } },
    });
    expect(events).toContainEqual({ type: 'done', reason: 'end_turn' });
  });

  it('emits HTTP error event on non-2xx', async () => {
    const client = createGoogleGenerativeAiClient({
      apiKey: 'GEM-KEY',
      model: 'gemini-2.5-pro',
      fetchImpl: (async () =>
        new Response('forbidden', { status: 403 })
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    for await (const e of client.streamChat([{ role: 'user', content: 'hi' }])) {
      events.push(e);
    }
    expect(events).toContainEqual({
      type: 'error',
      data: expect.stringContaining('Gemini HTTP 403'),
      code: 'gemini.http.403',
    });
  });

  it('hits the correct endpoint with the model in the path', async () => {
    let capturedUrl: string | URL | Request | undefined;
    const client = createGoogleGenerativeAiClient({
      apiKey: 'GEM-KEY',
      model: 'gemini-2.5-pro',
      fetchImpl: (async (url: string | URL | Request) => {
        capturedUrl = url;
        return makeSseResponse([
          { data: JSON.stringify({
            candidates: [{ finishReason: 'STOP', index: 0 }],
          }) },
        ]);
      }) as typeof fetch,
    });
    for await (const _e of client.streamChat([{ role: 'user', content: 'hi' }])) { /* drain */ }
    expect(String(capturedUrl)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
  });

  it('captures functionCall thoughtSignature onto the tool_use SSE event and the final message', async () => {
    const client = createGoogleGenerativeAiClient({
      apiKey: 'GEM-KEY',
      model: 'gemini-2.5-pro',
      fetchImpl: (async () =>
        makeSseResponse([
          { data: JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [
              { functionCall: { name: 'search', args: { q: 'x' } }, thoughtSignature: 'thought-sig-9' },
            ] }, index: 0 }],
          }) },
          { data: JSON.stringify({
            candidates: [{ finishReason: 'STOP', index: 0 }],
          }) },
        ])
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    let finalAssistant: unknown;
    const gen = client.streamChat([{ role: 'user', content: 'search for x' }]);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    finalAssistant = next.value;

    // The signature rides the tool_use wire event so the agent loop can
    // stamp it onto the durable block (previously dropped entirely).
    expect(events).toContainEqual({
      type: 'tool_use',
      data: { id: 'gemini-call-0', name: 'search', input: { q: 'x' }, signature: 'thought-sig-9' },
    });
    const blocks = (finalAssistant as { content: Array<{ type: string; thoughtSignature?: string }> }).content;
    expect(blocks[0]).toMatchObject({ type: 'tool_use', thoughtSignature: 'thought-sig-9' });
  });
});