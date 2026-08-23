import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createOpenAIResponsesClient,
  parseResponsesEvent,
  ResponsesParseState,
} from '../src/api/openai-responses.js';
import type { AssistantMessage, Message, SSEEvent } from '../src/types.js';

// Plan 440 phase 2 baseline: this parser previously had ZERO test coverage.
// The mocked SDK drives the real streamChat; protocol-level assertions
// (encrypted reasoning, annotations, service tier) go through the exported
// parseResponsesEvent seam directly.

const mocks = vi.hoisted(() => ({
  state: {
    /** Events yielded by responses.create when streaming. */
    stream: [] as unknown[],
  },
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = {
      create: async () => {
        return (async function* () {
          for (const ev of mocks.state.stream) yield ev;
        })();
      },
    };
    chat = {
      completions: {
        create: async () => {
          throw new Error('chat.completions.create not used in responses tests');
        },
      },
    };
  },
}));

function makeClient() {
  return createOpenAIResponsesClient({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid/v1',
    model: 'gpt-test',
    apiFormat: 'openai-responses',
    providerId: 'test-provider',
  });
}

async function collect(events: AsyncIterable<SSEEvent>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function sseText(events: SSEEvent[]): string {
  return events
    .filter(e => e.type === 'text')
    .map(e => (e as { data: string }).data)
    .join('');
}

function freshState(): { state: ResponsesParseState; msg: AssistantMessage } {
  const msg: AssistantMessage = {
    role: 'assistant',
    content: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    stopReason: 'completed',
    timestamp: 0,
  };
  return {
    msg,
    state: { assistantMsg: msg, itemToContentIdx: new Map<string, number>() },
  };
}

type StreamEvent = Parameters<typeof parseResponsesEvent>[0];

describe('openai-responses streamChat (plan 440 baseline)', () => {
  beforeEach(() => {
    mocks.state.stream = [];
  });

  const MESSAGES: Message[] = [{ role: 'user', content: 'hi' }];

  it('maps a plain text turn end-to-end', async () => {
    mocks.state.stream = [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { type: 'message', id: 'm_1' } },
      { type: 'response.output_text.delta', item_id: 'm_1', delta: 'Hello ' },
      { type: 'response.output_text.delta', item_id: 'm_1', delta: 'world' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'm_1' } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    ];
    const events = await collect(makeClient().streamChat(MESSAGES));
    expect(sseText(events)).toBe('Hello world');
    expect(events.some(e => e.type === 'error')).toBe(false);
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(events.some(e => e.type === 'result')).toBe(true);
  });

  it('carries web_search_call items and surfaces a summary in the text stream', async () => {
    mocks.state.stream = [
      {
        type: 'response.output_item.added',
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    const events = await collect(makeClient().streamChat(MESSAGES));
    const text = sseText(events);
    expect(text).toContain('[web_search_call]');
    expect(text).toContain('"id":"ws_1"');
    expect(events.some(e => e.type === 'error')).toBe(false);
  });

  it('survives function-call turns (regression)', async () => {
    mocks.state.stream = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":"Bei' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'jing"}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 2, output_tokens: 2 } },
      },
    ];
    const events = await collect(makeClient().streamChat(MESSAGES));
    expect(events.some(e => e.type === 'tool_use_started')).toBe(true);
    expect(events.some(e => e.type === 'tool_use')).toBe(true);
    expect(events.some(e => e.type === 'error')).toBe(false);
  });
});

describe('parseResponsesEvent phase-2 captures', () => {
  it('keeps reasoning.encrypted_content on the thinking block', () => {
    const { msg, state } = freshState();
    parseResponsesEvent(
      {
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: 'r_1', encrypted_content: 'enc-secret' },
      } as unknown as StreamEvent,
      state,
    );
    parseResponsesEvent(
      { type: 'response.reasoning_summary_text.delta', item_id: 'r_1', delta: 'hard thought' } as unknown as StreamEvent,
      state,
    );
    expect(msg.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'hard thought',
      encrypted: 'enc-secret',
    });
  });

  it('attaches annotations to the owning text block', () => {
    const { msg, state } = freshState();
    parseResponsesEvent(
      { type: 'response.output_item.added', item: { type: 'message', id: 'm_1' } } as unknown as StreamEvent,
      state,
    );
    const citation = { type: 'url_citation', url: 'https://example.invalid/a', start_index: 0, end_index: 3 };
    parseResponsesEvent(
      { type: 'response.output_text.annotation.added', item_id: 'm_1', annotation: citation } as unknown as StreamEvent,
      state,
    );
    const block = msg.content[0];
    expect(block.type).toBe('text');
    expect(block.type === 'text' && block.annotations).toEqual([citation]);
  });

  it('captures service_tier into providerMeta on completion', () => {
    const { msg, state } = freshState();
    parseResponsesEvent(
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          service_tier: 'flex',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as unknown as StreamEvent,
      state,
    );
    expect(msg.providerMeta).toEqual({ serviceTier: 'flex' });
    // mapStatus('completed', without tool_use) → end_turn.
    expect(msg.stopReason).toBe('end_turn');
  });
});
