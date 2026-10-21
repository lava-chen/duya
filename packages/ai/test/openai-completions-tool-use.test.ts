/**
 * packages/ai/test/openai-completions-tool-use.test.ts
 *
 * End-to-end regression for tool use on the Chat Completions protocol.
 *
 * Root cause being guarded here: the client emitted `toolcall_start` /
 * `toolcall_delta` but never `toolcall_end`, so emitSSE never produced the
 * `tool_use` SSE event that DuyaAgent's loop consumes (executor.addTool +
 * needsFollowUp). Tool use silently no-op'd on every openai-chat endpoint:
 * the UI flashed `tool_use_started`, no tool executed, and the run
 * finalized as 'completed' after the first turn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SSEEvent } from '../src/types.js';

const chatCreateMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => {
  class OpenAI {
    chat: { completions: { create: typeof chatCreateMock } };
    constructor(_opts?: unknown) {
      this.chat = { completions: { create: chatCreateMock } };
    }
  }
  return { default: OpenAI };
});

import { createOpenAICompletionsClient } from '../src/api/openai-completions.js';

function sseChunks() {
  const toolCallStart = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call-abc-123',
          type: 'function',
          function: { name: 'read_file', arguments: '' },
        }],
      },
      finish_reason: null,
    }],
  };
  const argDeltas = ['{"pa', 'th":', '"pack', 'age.json"}'].map((args) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
      finish_reason: null,
    }],
  }));
  const finish = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  return [toolCallStart, ...argDeltas, finish];
}

async function collect(events: AsyncIterable<SSEEvent>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('openai-completions streamChat — tool_use event emission', () => {
  beforeEach(() => {
    chatCreateMock.mockReset();
  });

  it('emits a tool_use SSE event with parsed input before done', async () => {
    chatCreateMock.mockResolvedValueOnce((async function* () {
      for (const c of sseChunks()) yield c;
    })() as unknown as AsyncIterable<never>);

    const client = createOpenAICompletionsClient({
      apiKey: 'test',
      baseURL: 'https://example.invalid/v1',
      model: 'test-model',
      providerId: 'test',
    });

    const events = await collect(
      client.streamChat(
        [{ role: 'user', content: 'read package.json' }],
        {
          tools: [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          }],
        } as never,
      ),
    );

    const toolUseEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolUseEvents).toHaveLength(1);
    const data = (toolUseEvents[0] as { data: { id: string; name: string; input: unknown } }).data;
    expect(data.id).toBe('call-abc-123');
    expect(data.name).toBe('read_file');
    expect(data.input).toEqual({ path: 'package.json' });

    // tool_use_started may precede it (UI flash), but the executable
    // `tool_use` event must exist — that is the regression.
    const startedIdx = events.findIndex((e) => e.type === 'tool_use_started');
    const toolUseIdx = events.findIndex((e) => e.type === 'tool_use');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(toolUseIdx).toBeGreaterThan(startedIdx);

    // done must come after the tool_use event so the executor drains.
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(doneIdx).toBeGreaterThan(toolUseIdx);
    expect((events[doneIdx] as { reason?: string }).reason).toBe('tool_use');
  });

  it('emits tool_use even when the stream is length-truncated (guard visibility)', async () => {
    // A length-truncated stream still carries a partial tool call. The
    // tool_use event must fire so DuyaAgent's plan-418 truncation guard can
    // fail the call instead of silently dropping it.
    chatCreateMock.mockResolvedValueOnce((async function* () {
      yield {
        id: 'chatcmpl-2', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call-trunc', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] },
          finish_reason: null,
        }],
      };
      yield {
        id: 'chatcmpl-2', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      };
    })() as unknown as AsyncIterable<never>);

    const client = createOpenAICompletionsClient({
      apiKey: 'test',
      baseURL: 'https://example.invalid/v1',
      model: 'test-model',
      providerId: 'test',
    });

    const events = await collect(client.streamChat([{ role: 'user', content: 'go' }], {} as never));
    const toolUseEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolUseEvents).toHaveLength(1);
    const done = events.find((e) => e.type === 'done') as { reason?: string };
    expect(done.reason).toBe('max_tokens');
  });
});
