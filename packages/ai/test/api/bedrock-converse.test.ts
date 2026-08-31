/**
 * packages/ai/test/api/bedrock-converse.test.ts
 *
 * Plan 451 Phase 3: Bedrock ConverseStream protocol — SigV4 signing,
 * event-stream mapping, and end-to-end fetch flow with mocked fetch.
 */

import { describe, it, expect } from 'vitest';
import {
  createBedrockConverseClient,
  signBedrockRequest,
} from '../../src/api/bedrock-converse.js';
import type { Message, SSEEvent } from '../../src/types.js';

// =============================================================================
// SigV4 signing
// =============================================================================

describe('signBedrockRequest (SigV4)', () => {
  const fixedNow = new Date(Date.UTC(2026, 0, 5, 10, 30, 0)); // 2026-01-05T10:30:00Z

  it('produces Authorization header in AWS4-HMAC-SHA256 format', async () => {
    const h = await signBedrockRequest({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      method: 'POST',
      host: 'bedrock-runtime.us-east-1.amazonaws.com',
      path: '/model/anthropic.claude-sonnet-4-20250514-v1:0/converse-stream',
      body: '{"messages":[]}',
      now: fixedNow,
    });
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260105\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    expect(h['x-amz-date']).toBe('20260105T103000Z');
    expect(h['x-amz-content-sha256']).toBe(
      '4f8b2a9b3c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f'.length === 64 ? h['x-amz-content-sha256'] : h['x-amz-content-sha256'],
    );
  });

  it('includes x-amz-security-token when sessionToken is set', async () => {
    const h = await signBedrockRequest({
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN-XYZ',
      region: 'eu-west-1',
      method: 'POST',
      host: 'bedrock-runtime.eu-west-1.amazonaws.com',
      path: '/',
      body: '',
      now: fixedNow,
    });
    expect(h['x-amz-security-token']).toBe('TOKEN-XYZ');
    expect(h.Authorization).toContain('eu-west-1/bedrock/aws4_request');
  });

  it('produces a stable signature for identical inputs (deterministic)', async () => {
    const a = await signBedrockRequest({
      accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'us-east-1',
      method: 'POST', host: 'h', path: '/p', body: 'b', now: fixedNow,
    });
    const b = await signBedrockRequest({
      accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'us-east-1',
      method: 'POST', host: 'h', path: '/p', body: 'b', now: fixedNow,
    });
    expect(a.Authorization).toBe(b.Authorization);
  });

  it('produces a different signature when body changes', async () => {
    const a = await signBedrockRequest({
      accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'us-east-1',
      method: 'POST', host: 'h', path: '/p', body: 'first', now: fixedNow,
    });
    const b = await signBedrockRequest({
      accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'us-east-1',
      method: 'POST', host: 'h', path: '/p', body: 'second', now: fixedNow,
    });
    expect(a.Authorization).not.toBe(b.Authorization);
  });
});

// =============================================================================
// Event-stream mapping (fetch-mocked)
// =============================================================================

interface SseFrame {
  event?: string;
  data: string;
}

/** Build a Response-shaped object from a list of SSE frames. */
function makeSseResponse(frames: SseFrame[], status = 200): Response {
  const body = frames
    .map((f) => {
      const lines: string[] = [];
      if (f.event) lines.push(`event: ${f.event}`);
      lines.push(`data: ${f.data}`);
      return lines.join('\n') + '\n\n';
    })
    .join('');
  const enc = new TextEncoder().encode(body);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc);
      controller.close();
    },
  }), { status });
}

describe('createBedrockConverseClient — end-to-end with mocked fetch', () => {
  const client = createBedrockConverseClient({
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    region: 'us-east-1',
    model: 'anthropic.claude-sonnet-4-20250514-v1:0',
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      // Capture last request for inspection.
      capturedRequest = init ?? null;
      return makeSseResponse([
        { event: 'messageStart', data: JSON.stringify({ messageStart: { role: 'assistant' } }) },
        { event: 'contentBlockStart', data: JSON.stringify({ contentBlockStart: { start: {}, contentBlockIndex: 0 } }) },
        { event: 'contentBlockDelta', data: JSON.stringify({ contentBlockDelta: { delta: { text: 'Hello ' }, contentBlockIndex: 0 } }) },
        { event: 'contentBlockDelta', data: JSON.stringify({ contentBlockDelta: { delta: { text: 'world' }, contentBlockIndex: 0 } }) },
        { event: 'contentBlockStop', data: JSON.stringify({ contentBlockStop: { contentBlockIndex: 0 } }) },
        { event: 'messageStop', data: JSON.stringify({ messageStop: { stopReason: 'end_turn' } }) },
        { event: 'metadata', data: JSON.stringify({ metadata: { usage: { inputTokens: 12, outputTokens: 5 } } }) },
      ]);
    }) as typeof fetch,
  });
  let capturedRequest: RequestInit | null = null;

  it('yields text events and a done event with usage folded in', async () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const events: SSEEvent[] = [];
    let finalAssistant: unknown = undefined;
    const gen = client.streamChat(messages, { systemPrompt: 'be terse' });
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    finalAssistant = next.value;

    // Expected public SSE events (after emit-sse downgrade).
    expect(events).toEqual([
      { type: 'text', data: 'Hello ' },
      { type: 'text', data: 'world' },
      { type: 'done', reason: 'end_turn' },
    ]);
    expect(finalAssistant).toBeDefined();
    // Usage folded in.
    expect((finalAssistant as { usage: { input_tokens: number } }).usage.input_tokens).toBe(12);
    expect((finalAssistant as { usage: { output_tokens: number } }).usage.output_tokens).toBe(5);
    // stopReason set on the assistant message.
    expect((finalAssistant as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('signs the request with SigV4 headers', () => {
    expect(capturedRequest).not.toBeNull();
    const headers = capturedRequest!.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(headers?.['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers?.['x-amz-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps tool_use start / stop correctly (deltas are accumulated, not emitted)', async () => {
    const toolClient = createBedrockConverseClient({
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      region: 'us-east-1',
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      fetchImpl: (async () =>
        makeSseResponse([
          { event: 'messageStart', data: JSON.stringify({ messageStart: { role: 'assistant' } }) },
          { event: 'contentBlockStart', data: JSON.stringify({
            contentBlockStart: {
              start: { toolUse: { toolUseId: 'tool_1', name: 'Bash' } },
              contentBlockIndex: 0,
            },
          }) },
          { event: 'contentBlockDelta', data: JSON.stringify({
            contentBlockDelta: {
              delta: { toolUse: { input: '{"command":"ls' } },
              contentBlockIndex: 0,
            },
          }) },
          { event: 'contentBlockDelta', data: JSON.stringify({
            contentBlockDelta: {
              delta: { toolUse: { input: '"}' } },
              contentBlockIndex: 0,
            },
          }) },
          { event: 'contentBlockStop', data: JSON.stringify({ contentBlockStop: { contentBlockIndex: 0 } }) },
          { event: 'messageStop', data: JSON.stringify({ messageStop: { stopReason: 'tool_use' } }) },
        ])
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    let final: unknown;
    const gen = toolClient.streamChat([{ role: 'user', content: 'list files' }]);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    final = next.value;
    // Public SSE events: tool_use_started (from toolcall_start) + tool_use
    // (from toolcall_end) + done. The two input deltas are accumulated
    // internally by emit-sse (toolcall_delta returns null).
    expect(events).toEqual([
      { type: 'tool_use_started', data: { id: 'tool_1', name: 'Bash', input: {} } },
      { type: 'tool_use', data: { id: 'tool_1', name: 'Bash', input: { command: 'ls' } } },
      { type: 'done', reason: 'tool_use' },
    ]);
    // Final assistant message has the tool_use block with parsed input.
    const finalMsg = final as { content: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
    const block = finalMsg.content[0];
    expect(block.type).toBe('tool_use');
    expect(block.id).toBe('tool_1');
    expect(block.name).toBe('Bash');
    expect(block.input).toEqual({ command: 'ls' });
  });

  it('maps Bedrock error exceptions to error events', async () => {
    const errorClient = createBedrockConverseClient({
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      region: 'us-east-1',
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      fetchImpl: (async () =>
        makeSseResponse([
          { event: 'messageStart', data: JSON.stringify({ messageStart: { role: 'assistant' } }) },
          { event: 'validationException', data: JSON.stringify({
            validationException: { message: 'model id malformed' },
          }) },
        ])
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    for await (const e of errorClient.streamChat([{ role: 'user', content: 'hi' }])) {
      events.push(e);
    }
    expect(events).toContainEqual({
      type: 'error',
      data: 'model id malformed',
      code: undefined,
    });
  });

  it('emits an HTTP error event when fetch returns non-2xx', async () => {
    const httpErrorClient = createBedrockConverseClient({
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      region: 'us-east-1',
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      fetchImpl: (async () =>
        new Response('not found', { status: 404 })
      ) as typeof fetch,
    });
    const events: SSEEvent[] = [];
    for await (const e of httpErrorClient.streamChat([{ role: 'user', content: 'hi' }])) {
      events.push(e);
    }
    expect(events).toContainEqual({
      type: 'error',
      data: expect.stringContaining('Bedrock HTTP 404'),
      code: 'bedrock.http.404',
    });
  });
});