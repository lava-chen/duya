import { describe, it, expect } from 'vitest';
import {
  resolveProviderBlockOutbound,
  summarizeProviderBlock,
} from '../src/api/degrade.js';
import {
  parseAnthropicEvent,
  toAnthropicMessages,
} from '../src/api/anthropic-messages.js';
import { toOpenAIMessages } from '../src/api/openai-completions.js';
import { toResponsesInput } from '../src/api/openai-responses.js';
import type {
  AssistantMessage,
  Message,
  Model,
  ProviderBlockContent,
} from '../src/types.js';

type StreamEvent = Parameters<typeof parseAnthropicEvent>[0];

function makeCarrier(
  origin: ProviderBlockContent['origin'],
  kind: string,
  payload: unknown,
): ProviderBlockContent {
  return { type: 'provider_block', origin, kind, payload };
}

function freshAssistant(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    stopReason: 'completed',
    timestamp: 0,
  };
}

const ANTHROPIC_MODEL: Model<'anthropic'> = {
  id: 'claude-test',
  name: 'Claude Test',
  api: 'anthropic',
  providerId: 'test-provider',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 8192,
};

describe('summarizeProviderBlock', () => {
  it('emits kind plus compact JSON of the payload', () => {
    const summary = summarizeProviderBlock(
      makeCarrier('anthropic', 'server_tool_use', { id: 'srvtoolu_1', name: 'web_search' }),
    );
    expect(summary.startsWith('[server_tool_use]')).toBe(true);
    expect(summary).toContain('"name":"web_search"');
  });

  it('truncates oversized payloads to a bounded line', () => {
    const summary = summarizeProviderBlock(
      makeCarrier('openai-responses', 'web_search_call', { blob: 'x'.repeat(500) }),
    );
    expect(summary.length).toBeLessThanOrEqual(220); // prefix + 200 + ellipsis
    expect(summary.endsWith('…')).toBe(true);
  });

  it('survives unserializable payloads without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const summary = summarizeProviderBlock(makeCarrier('anthropic', 'mcp_tool_use', circular));
    expect(summary.startsWith('[mcp_tool_use]')).toBe(true);
  });
});

describe('resolveProviderBlockOutbound', () => {
  const carrier = makeCarrier('anthropic', 'server_tool_use', { id: 'x' });

  it('forwards verbatim for same-origin Anthropic replay', () => {
    const resolved = resolveProviderBlockOutbound(carrier, 'anthropic');
    expect(resolved).toBe(carrier);
  });

  it('degrades cross-format targets to a bounded text placeholder', () => {
    for (const target of ['openai-chat', 'openai-responses'] as const) {
      const resolved = resolveProviderBlockOutbound(carrier, target);
      expect(resolved.type).toBe('text');
      expect(resolved.type === 'text' && resolved.text).toContain('[server_tool_use]');
    }
  });

  it('degrades foreign-origin payloads even when the target is Anthropic', () => {
    const foreign = makeCarrier('openai-responses', 'web_search_call', { id: 'ws_1' });
    const resolved = resolveProviderBlockOutbound(foreign, 'anthropic');
    expect(resolved.type).toBe('text');
  });
});

describe('parseAnthropicEvent server-side blocks (plan 440 phase 1)', () => {
  function drive(events: object[]): AssistantMessage {
    const msg = freshAssistant();
    const state = { currentBlockIdx: 0, isMiniMax: false };
    for (const event of events) {
      parseAnthropicEvent(event as StreamEvent, msg, state);
    }
    return msg;
  }

  it('carries streamed server_tool_use and folds input_json_delta into the payload', () => {
    const msg = drive([
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"quer' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'y":"duya"}' } },
      { type: 'content_block_stop', index: 0 },
    ]);

    const carrier = msg.content.find(b => b.type === 'provider_block') as ProviderBlockContent | undefined;
    expect(carrier).toBeDefined();
    expect(carrier?.kind).toBe('server_tool_use');
    expect((carrier?.payload as { input?: unknown }).input).toEqual({ query: 'duya' });

    // Visible degradation: a trailing text block carries the summary.
    const last = msg.content[msg.content.length - 1];
    expect(last.type).toBe('text');
    expect(last.type === 'text' && last.text).toContain('[server_tool_use]');
  });

  it('carries complete-at-start result blocks like web_search_tool_result', () => {
    const msg = drive([
      { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: 'result text' } },
      { type: 'content_block_stop', index: 0 },
    ]);

    const carrier = msg.content.find(b => b.type === 'provider_block') as ProviderBlockContent | undefined;
    expect(carrier?.kind).toBe('web_search_tool_result');
    expect(carrier?.payload).toMatchObject({ content: 'result text' });
  });
});

describe('outbound round-trip (plan 440 phase 1)', () => {
  it('replays anthropic-origin carriers verbatim through toAnthropicMessages', () => {
    const stuPayload = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'duya' } };
    const wsrPayload = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: 'found it' };
    const history: Message[] = [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'searching…' },
          makeCarrier('anthropic', 'server_tool_use', stuPayload),
          makeCarrier('anthropic', 'web_search_tool_result', wsrPayload),
          { type: 'text', text: 'done' },
        ],
      },
    ];

    const out = toAnthropicMessages(history, ANTHROPIC_MODEL);
    const blocks = out[1].content as Array<{ type: string }>;
    const carried = blocks.filter(b => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
    expect(carried).toHaveLength(2);
    // Verbatim identity, not re-shape.
    expect(blocks).toContain(stuPayload);
    expect(blocks).toContain(wsrPayload);
  });

  it('degrades foreign carriers to summaries in toOpenAIMessages', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [makeCarrier('anthropic', 'web_search_tool_result', { content: 'r' })],
      },
    ];
    const out = toOpenAIMessages(history);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(String(out[0].content)).toContain('[web_search_tool_result]');
  });

  it('degrades carriers to summaries in toResponsesInput', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'before ' },
          makeCarrier('openai-responses', 'code_interpreter_call', { id: 'ci_1' }),
          { type: 'text', text: 'after' },
        ],
      },
    ];
    const out = toResponsesInput(history);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'before [code_interpreter_call] {"id":"ci_1"}after',
    });
  });

  it('keeps plain histories untouched (regression)', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    expect(toOpenAIMessages(history)).toHaveLength(2);
    expect(toResponsesInput(history)).toHaveLength(2);
    expect(toAnthropicMessages(history, ANTHROPIC_MODEL)).toHaveLength(2);
  });

  it('downgrades thinking to wrapped text in toResponsesInput (official-harness parity)', () => {
    const history: Message[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'step 1' },
          { type: 'text', text: 'a1' },
        ],
      },
    ];
    const out = toResponsesInput(history);
    expect(out).toHaveLength(2);
    const assistantItem = out[1] as { type: string; role: string; content: string };
    expect(assistantItem.role).toBe('assistant');
    expect(assistantItem.content).toContain('<|prior-thinking|>');
    expect(assistantItem.content).toContain('step 1');
    expect(assistantItem.content).toContain('<|/prior-thinking|>');
    expect(assistantItem.content).toContain('a1');
  });

  it('drops empty thinking blocks in toResponsesInput without creating empty text', () => {
    const history: Message[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '   ' },
          { type: 'text', text: 'a1' },
        ],
      },
    ];
    const out = toResponsesInput(history);
    expect(out).toHaveLength(2);
    const assistantItem = out[1] as { content: string };
    expect(assistantItem.content).toBe('a1');
  });
});
