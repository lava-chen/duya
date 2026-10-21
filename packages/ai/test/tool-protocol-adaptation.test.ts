/**
 * packages/ai/test/tool-protocol-adaptation.test.ts
 *
 * Plan 418 — Tool Protocol Adaptation:
 * - Endpoint feature inference (isDeepSeekAnthropicEndpoint)
 * - Tool-result transport resolution (resolveToolResultTransport)
 * - Tool-result textification (textifyToolResults) + no tool_result blocks in payload
 * - Schema-mismatch error classification (isToolSchemaMismatchError)
 * - Progressive degradation ladder in createAnthropicClient.streamChat
 *   (L0 standard blocks -> L1 textified results -> L2 no tools) with
 *   per-client memory across turns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SSEEvent, Message } from '../src/types.js';

// ─── Mock @anthropic-ai/sdk before importing the client module ─────────────
// createAnthropicClient constructs `new Anthropic(...)`. The streaming path
// uses `client.post('/v1/messages', { body, __binaryResponse: true })` (raw
// fetch Response) + `_iterSSEMessages` — see Plan 418 tolerant SSE parsing.
// All mock state lives inside vi.hoisted so the (hoisted) vi.mock factory and
// the test bodies share one singleton.
const mocks = vi.hoisted(() => {
  class MockMessages {
    create = vi.fn();
  }
  class MockAnthropic {
    messages = new MockMessages();
    post = vi.fn();
    constructor(public options: unknown) {
      instances.push(this);
    }
  }
  const instances: Array<{
    messages: { create: ReturnType<typeof vi.fn> };
    post: ReturnType<typeof vi.fn>;
  }> = [];
  return { MockAnthropic, instances };
});

vi.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: mocks.MockAnthropic,
}));

/** Build a raw fetch Response whose body streams the given SSE frames. */
const sseResponse = (frames: string): Response =>
  new Response(frames, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const emptyStream = (): Response => sseResponse('');

import {
  isDeepSeekAnthropicEndpoint,
  resolveToolResultTransport,
} from '../src/api/anthropic-messages.js';
import { createAnthropicClient } from '../src/api/anthropic-messages.js';
import { textifyToolResults } from '../src/api/transform-messages.js';
import { isToolSchemaMismatchError } from '../src/utils/errors.js';

const instances = mocks.instances;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  instances.length = 0;
});

// ─── Endpoint inference ─────────────────────────────────────────────────────

describe('isDeepSeekAnthropicEndpoint', () => {
  it('detects the DeepSeek /anthropic compat surface', () => {
    expect(isDeepSeekAnthropicEndpoint('https://api.deepseek.com/anthropic')).toBe(true);
    expect(isDeepSeekAnthropicEndpoint('https://api.deepseek.com/anthropic/')).toBe(true);
  });

  it('does not flag the OpenAI-compatible DeepSeek surface or others', () => {
    expect(isDeepSeekAnthropicEndpoint('https://api.deepseek.com/v1')).toBe(false);
    expect(isDeepSeekAnthropicEndpoint('https://api.deepseek.com/chat/completions')).toBe(false);
    expect(isDeepSeekAnthropicEndpoint('https://api.anthropic.com')).toBe(false);
    expect(isDeepSeekAnthropicEndpoint('https://api.minimax.io/anthropic')).toBe(false);
    expect(isDeepSeekAnthropicEndpoint(undefined)).toBe(false);
  });
});

// ─── Transport resolution ───────────────────────────────────────────────────

describe('resolveToolResultTransport', () => {
  it('defaults to standard tool-result blocks', () => {
    expect(resolveToolResultTransport(undefined, undefined)).toBe('tool-result-block');
    expect(resolveToolResultTransport('https://api.anthropic.com', undefined)).toBe('tool-result-block');
    expect(resolveToolResultTransport('https://api.minimax.io/anthropic', undefined)).toBe('tool-result-block');
  });

  it('infers text-user-message for the DeepSeek /anthropic surface', () => {
    expect(resolveToolResultTransport('https://api.deepseek.com/anthropic', undefined)).toBe('text-user-message');
  });

  it('lets an explicit ModelCompat declaration win over endpoint inference', () => {
    expect(
      resolveToolResultTransport('https://api.deepseek.com/anthropic', {
        toolResultTransport: 'tool-result-block',
      }),
    ).toBe('tool-result-block');
    expect(
      resolveToolResultTransport('https://api.anthropic.com', {
        toolResultTransport: 'text-user-message',
      }),
    ).toBe('text-user-message');
    expect(
      resolveToolResultTransport('https://api.anthropic.com', {
        toolResultTransport: 'none',
      }),
    ).toBe('none');
  });
});

// ─── Textification ─────────────────────────────────────────────────────────

describe('textifyToolResults', () => {
  it('converts role:tool messages into text user messages with markers', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'tool', tool_call_id: 't1', name: 'Read', content: 'file content' },
    ];
    const out = textifyToolResults(messages);
    expect(out).toHaveLength(3);
    expect(out[2]?.role).toBe('user');
    expect(out[2]?.content).toContain('[Tool result: Read tool_use_id=t1]');
    expect(out[2]?.content).toContain('file content');
    expect(out[2]?.content).toContain('[Tool result ended]');
    // tool_use blocks survive untouched.
    expect(out[1]?.content).toEqual([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]);
  });

  it('marks error results', () => {
    const messages: Message[] = [
      { role: 'tool', tool_call_id: 't2', name: 'Bash', content: '<tool_error>command failed</tool_error>' },
    ];
    const [out] = textifyToolResults(messages);
    expect(out?.content).toContain('[Tool result: error Bash tool_use_id=t2]');
  });

  it('extracts legacy tool_result content blocks into separate user messages', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running' },
          { type: 'tool_use', id: 't3', name: 'Read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't3', content: 'legacy result' }],
      },
    ];
    const out = textifyToolResults(messages);
    expect(out).toHaveLength(3);
    expect(out[1]?.content).not.toContain('tool_result');
    expect(out[2]?.role).toBe('user');
    expect(out[2]?.content).toContain('[Tool result: tool_use_id=t3]');
    expect(out[2]?.content).toContain('legacy result');
  });

  it('flattens image blocks in tool results to placeholder text', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        tool_call_id: 't4',
        content: [
          { type: 'text', text: 'caption' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaa' } },
        ],
      },
    ];
    const [out] = textifyToolResults(messages);
    expect(out?.content).toContain('caption');
    expect(out?.content).not.toContain('data:image');
    expect(out?.content).toContain('image omitted');
  });
});

// ─── Error classification ───────────────────────────────────────────────────

describe('isToolSchemaMismatchError', () => {
  const schemaError = (status: number, message: string): Error & { status: number } => {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
  };

  it('classifies 400 deserialization rejections', () => {
    expect(
      isToolSchemaMismatchError(
        schemaError(400, 'Failed to deserialize the JSON body into the target type: messages[4].content: unknown variant `tool_result`, expected one of `text`, `tool_reference`, `image`, `document`'),
      ),
    ).toBe(true);
  });

  it('rejects non-400 and unrelated errors', () => {
    expect(isToolSchemaMismatchError(schemaError(429, 'rate limited'))).toBe(false);
    expect(isToolSchemaMismatchError(schemaError(500, 'server error'))).toBe(false);
    // A status-less local error mentioning "unknown variant" is not an
    // endpoint schema rejection — without a 400 status only the strong
    // deserialization markers count.
    expect(isToolSchemaMismatchError(new Error('unknown variant in a local parser'))).toBe(false);
    expect(isToolSchemaMismatchError(undefined)).toBe(false);
  });
});

// ─── Degradation ladder (integration) ───────────────────────────────────────

describe('createAnthropicClient.streamChat degradation ladder', () => {
  const messages: Message[] = [
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'Read', content: 'file content' },
  ];
  const tools = [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }];

  async function drain(client: ReturnType<typeof createAnthropicClient>): Promise<void> {
    for await (const _ of client.streamChat(messages, { tools, systemPrompt: 'sys' })) {
      // consume all events
    }
  }

  it('degrades from standard blocks to textified results on schema mismatch', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    const schemaError = new Error(
      '400 {"error":{"message":"Failed to deserialize the JSON body ... unknown variant `tool_result` ..."}}',
    ) as Error & { status: number };
    schemaError.status = 400;
    sdk.post
      .mockRejectedValueOnce(schemaError)
      .mockResolvedValueOnce(emptyStream());

    await drain(client);

    expect(sdk.post).toHaveBeenCalledTimes(2);
    const firstBody = sdk.post.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    const secondBody = sdk.post.mock.calls[1]?.[1]?.body as Record<string, unknown>;
    // L0 payload still carries tool_result blocks.
    expect(JSON.stringify(firstBody.messages)).toContain('"type":"tool_result"');
    // L1 payload is textified (no tool_result blocks), tools still passed.
    expect(JSON.stringify(secondBody.messages)).not.toContain('"type":"tool_result"');
    expect(secondBody.tools).toBeDefined();
    expect(JSON.stringify(secondBody.messages)).toContain('[Tool result: Read tool_use_id=t1]');
  });

  it('remembers the degraded transport for subsequent calls on the same client', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    const schemaError = new Error('400 unknown variant `tool_result`') as Error & { status: number };
    schemaError.status = 400;
    sdk.post
      .mockRejectedValueOnce(schemaError)
      .mockResolvedValueOnce(emptyStream())
      .mockResolvedValueOnce(emptyStream());

    await drain(client); // turn 1: L0 fails -> L1 succeeds
    expect(sdk.post).toHaveBeenCalledTimes(2);

    sdk.post.mockClear();
    await drain(client); // turn 2: starts at L1 directly, no 400 round-trip
    expect(sdk.post).toHaveBeenCalledTimes(1);
    const params = sdk.post.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(JSON.stringify(params.messages)).not.toContain('"type":"tool_result"');
  });

  it('drops tools entirely at L2 when textified results are also rejected', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    const schemaError = new Error('400 unknown variant `tool_use`') as Error & { status: number };
    schemaError.status = 400;
    sdk.post
      .mockRejectedValueOnce(schemaError) // L0 -> 400
      .mockRejectedValueOnce(schemaError) // L1 -> 400
      .mockResolvedValueOnce(emptyStream()); // L2 -> success

    await drain(client);

    expect(sdk.post).toHaveBeenCalledTimes(3);
    const thirdBody = sdk.post.mock.calls[2]?.[1]?.body as Record<string, unknown>;
    expect(thirdBody.tools).toBeUndefined();
    // L2 system prompt tells the model tools are unavailable.
    expect(String(thirdBody.system)).toContain('does not support tool calling');
  });

  it('skips malformed SSE frames instead of crashing the stream (Plan 418)', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    // A malformed data: frame followed by a valid message_stop. The trailing
    // blank line is required for the SSE decoder to flush the final frame.
    const frames = [
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      'event: garbage',
      'data: this is {not] valid json at position 72',
      '',
      '',
    ].join('\n');
    sdk.post.mockResolvedValueOnce(sseResponse(frames));

    const events: string[] = [];
    for await (const ev of client.streamChat(messages, { tools, systemPrompt: 'sys' })) {
      events.push(ev.type);
    }
    // The stream completes (message_stop is delivered); the malformed frame
    // was skipped, and the console warning was emitted.
    expect(events).toContain('done');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping malformed SSE event'),
      expect.anything(),
    );
  });

  it('repairs repairable SSE frames instead of skipping them (Plan 418)', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    // A text_delta whose content carries a raw tab (SSE-line-legal, but an
    // illegal control character inside a JSON string literal). Strict
    // JSON.parse rejects the frame; parseJsonWithRepair escapes the tab and
    // the text survives intact.
    const frames = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"line1\tline2"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    sdk.post.mockResolvedValueOnce(sseResponse(frames));

    const texts: string[] = [];
    for await (const ev of client.streamChat([{ role: 'user', content: 'hi' }], { tools: [], systemPrompt: 'sys' })) {
      if (ev.type === 'text') texts.push(ev.data);
    }
    expect(texts.join('')).toContain('line1');
    expect(texts.join('')).toContain('line2');
    // The malformed frame was repaired, not skipped.
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping malformed SSE event'),
      expect.anything(),
    );
  });

  it('preserves tool input delivered on content_block_start (Plan 418 L1)', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    // Some Anthropic-compatible endpoints deliver the full tool input on
    // content_block_start instead of streaming input_json_delta deltas.
    const frames = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"Read","input":{"path":"a.txt"}}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    sdk.post.mockResolvedValueOnce(sseResponse(frames));

    const toolUses: Array<{ name: string; input: unknown }> = [];
    for await (const ev of client.streamChat([{ role: 'user', content: 'read it' }], { tools: [], systemPrompt: 'sys' })) {
      if (ev.type === 'tool_use') toolUses.push({ name: ev.data.name, input: ev.data.input });
    }
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('Read');
    expect(toolUses[0].input).toEqual({ path: 'a.txt' });
  });

  it('recovers truncated tool input via partial-json parse (Plan 418 L1)', async () => {
    const client = createAnthropicClient({
      apiKey: 'k',
      baseURL: 'https://unknown.example.com/anthropic',
      model: 'm',
      apiFormat: 'anthropic',
      providerId: 'x',
    });
    const sdk = instances[0];
    // input_json_delta stream truncated before the JSON object closed.
    const frames = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"Read"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\""}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    sdk.post.mockResolvedValueOnce(sseResponse(frames));

    const toolUses: Array<{ name: string; input: unknown }> = [];
    for await (const ev of client.streamChat([{ role: 'user', content: 'read it' }], { tools: [], systemPrompt: 'sys' })) {
      if (ev.type === 'tool_use') toolUses.push({ name: ev.data.name, input: ev.data.input });
    }
    // The unclosed JSON was recovered via partial parse instead of {}.
    expect(toolUses[0].input).toEqual({ path: 'a.txt' });
  });
});
