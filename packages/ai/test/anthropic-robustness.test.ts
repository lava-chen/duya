/**
 * packages/ai/test/anthropic-robustness.test.ts
 *
 * Covers the defensive provider-communication logic ported from
 * packages/agent/src/llm/anthropic-client.ts:
 * - MiniMax max_tokens clamping
 * - MiniMax 2013 error classification
 * - Tool ID sanitization (history) and runtime ID synthesis
 * - Tool round ordering normalization + recovery synthesis
 * - Thinking block handling per endpoint type
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { AssistantMessage, Message, Model } from '../src/types.js';
import {
  getMiniMaxAnthropicMaxTokens,
  isMiniMaxInvalidParameters2013,
  sanitizeToolId,
  synthesizeRuntimeToolId,
  normalizeToolResultOrdering,
  handleThinkingBlocks,
  toAnthropicMessages,
  parseAnthropicEvent,
} from '../src/api/anthropic-messages.js';
import { ThinkTagParser } from '../src/utils/think-tag-parser.js';
import { anthropicModels } from '../src/providers/anthropic.models.js';
import { minimaxModels } from '../src/providers/minimax.models.js';

// ─── Block builders ─────────────────────────────────────────────────────────

const text = (t: string): ContentBlockParam =>
  ({ type: 'text', text: t } as ContentBlockParam);

const toolUse = (id: string): ContentBlockParam =>
  ({ type: 'tool_use', id, name: 'bash', input: { command: 'ls' } } as ContentBlockParam);

const toolResult = (id: string, content = 'ok'): ContentBlockParam =>
  ({ type: 'tool_result', tool_use_id: id, content } as ContentBlockParam);

const thinking = (signature?: string): ContentBlockParam =>
  ({
    type: 'thinking',
    thinking: 'deep thought',
    ...(signature ? { signature } : {}),
  } as unknown as ContentBlockParam);

const redacted = (data?: string): ContentBlockParam =>
  ({
    type: 'redacted_thinking',
    ...(data ? { data } : {}),
  } as unknown as ContentBlockParam);

const blockTypes = (m: MessageParam): string[] =>
  (Array.isArray(m.content) ? m.content : []).map(b => (b as { type: string }).type);

// Silence the '[duya-ai]' diagnostics that the reorder/repair passes emit.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── getMiniMaxAnthropicMaxTokens ───────────────────────────────────────────

describe('getMiniMaxAnthropicMaxTokens', () => {
  it('clamps MiniMax-M3 to its 524288 ceiling', () => {
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M3')).toBe(524_288);
  });

  it('matches model names case-insensitively', () => {
    expect(getMiniMaxAnthropicMaxTokens('MINIMAX-M3')).toBe(524_288);
  });

  it('clamps highspeed variants to 196608', () => {
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M2.7-highspeed')).toBe(196_608);
  });

  it('defaults other MiniMax models to 204800', () => {
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M2')).toBe(204_800);
  });

  it('respects a smaller configured value', () => {
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M3', 4096)).toBe(4096);
  });

  it('clamps a larger configured value to the model ceiling', () => {
    expect(getMiniMaxAnthropicMaxTokens('MiniMax-M3', 999_999)).toBe(524_288);
  });

  it('ignores non-positive configured values', () => {
    expect(getMiniMaxAnthropicMaxTokens('minimax-m3', 0)).toBe(524_288);
  });
});

// ─── isMiniMaxInvalidParameters2013 ─────────────────────────────────────────

describe('isMiniMaxInvalidParameters2013', () => {
  it('matches the MiniMax max_tokens rejection', () => {
    const err = new Error('400 invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)');
    expect(isMiniMaxInvalidParameters2013(err)).toBe(true);
  });

  it('matches the invalid_request_error shape', () => {
    const err = new Error('invalid_request_error: tool call id is invalid (2013)');
    expect(isMiniMaxInvalidParameters2013(err)).toBe(true);
  });

  it('matches non-Error values via String()', () => {
    expect(isMiniMaxInvalidParameters2013('invalid params 2013')).toBe(true);
  });

  it('rejects 2013 without an invalid-params marker', () => {
    expect(isMiniMaxInvalidParameters2013(new Error('upstream returned code 2013'))).toBe(false);
  });

  it('rejects invalid params without the 2013 code', () => {
    expect(isMiniMaxInvalidParameters2013(new Error('invalid params, bad request'))).toBe(false);
  });

  it('does not match 2013 embedded in a longer number', () => {
    expect(isMiniMaxInvalidParameters2013(new Error('invalid params 20133'))).toBe(false);
  });
});

// ─── sanitizeToolId ─────────────────────────────────────────────────────────

describe('sanitizeToolId', () => {
  it('synthesizes a positional id for empty input', () => {
    expect(sanitizeToolId('', 0)).toBe('tool_synth_0');
    expect(sanitizeToolId('', 7)).toBe('tool_synth_7');
  });

  it('produces unique ids for different counter values', () => {
    expect(sanitizeToolId('', 0)).not.toBe(sanitizeToolId('', 1));
  });

  it('replaces invalid characters with underscores', () => {
    expect(sanitizeToolId('tool.call/id', 0)).toBe('tool_call_id');
    expect(sanitizeToolId('a b', 0)).toBe('a_b');
  });

  it('keeps already-valid ids unchanged', () => {
    expect(sanitizeToolId('toolu_01ABC-x_y', 0)).toBe('toolu_01ABC-x_y');
  });
});

// ─── synthesizeRuntimeToolId ────────────────────────────────────────────────

describe('synthesizeRuntimeToolId', () => {
  it('passes valid ids through unchanged', () => {
    expect(synthesizeRuntimeToolId('toolu_01ABC')).toBe('toolu_01ABC');
  });

  it('cleans invalid characters', () => {
    expect(synthesizeRuntimeToolId('a.b c')).toBe('a_b_c');
  });

  it('synthesizes a toolu_synth_ id for empty input', () => {
    const id = synthesizeRuntimeToolId('');
    expect(id).toMatch(/^toolu_synth_[0-9a-f_]+$/);
    expect(id).not.toContain('-');
  });

  it('synthesizes for null/undefined input', () => {
    expect(synthesizeRuntimeToolId(null)).toMatch(/^toolu_synth_/);
    expect(synthesizeRuntimeToolId(undefined)).toMatch(/^toolu_synth_/);
  });

  it('produces globally unique ids on repeated calls', () => {
    expect(synthesizeRuntimeToolId('')).not.toBe(synthesizeRuntimeToolId(''));
  });
});

// ─── normalizeToolResultOrdering ────────────────────────────────────────────

describe('normalizeToolResultOrdering', () => {
  it('keeps an already-adjacent tool round unchanged', () => {
    const input: MessageParam[] = [
      { role: 'assistant', content: [toolUse('A')] },
      { role: 'user', content: [toolResult('A')] },
    ];
    const out = normalizeToolResultOrdering(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toStrictEqual(input[0]);
    expect(out[1]).toStrictEqual(input[1]);
  });

  it('moves a deferred user message behind the tool round', () => {
    const input: MessageParam[] = [
      { role: 'assistant', content: [toolUse('A')] },
      { role: 'user', content: [text('<task-notification>done</task-notification>')] },
      { role: 'user', content: [toolResult('A')] },
    ];
    const out = normalizeToolResultOrdering(input);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('assistant');

    // tool_result immediately follows the assistant turn
    expect(out[1].role).toBe('user');
    const resultBlocks = out[1].content as ContentBlockParam[];
    expect(resultBlocks).toHaveLength(1);
    expect((resultBlocks[0] as { type: string }).type).toBe('tool_result');
    expect((resultBlocks[0] as { tool_use_id: string }).tool_use_id).toBe('A');

    // the deferred notification survives after the tool round
    expect(out[2].role).toBe('user');
    expect(blockTypes(out[2])).toEqual(['text']);
  });

  it('removes orphan tool_use blocks when the result is missing and not recovering', () => {
    const input: MessageParam[] = [
      { role: 'assistant', content: [toolUse('A')] },
      { role: 'user', content: [text('next user message')] },
    ];
    const out = normalizeToolResultOrdering(input);
    expect(out).toHaveLength(2);
    expect(blockTypes(out[0])).toEqual(['text']);
    expect(out[1]).toStrictEqual(input[1]);
  });

  it('synthesizes is_error results for unresolved calls in recovery mode', () => {
    const input: MessageParam[] = [
      { role: 'assistant', content: [toolUse('A')] },
      { role: 'user', content: [text('next user message')] },
    ];
    const out = normalizeToolResultOrdering(input, true);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('assistant');

    const resultBlocks = out[1].content as ContentBlockParam[];
    expect(resultBlocks).toHaveLength(1);
    const synth = resultBlocks[0] as unknown as {
      type: string;
      tool_use_id: string;
      is_error?: boolean;
      content: string;
    };
    expect(synth.type).toBe('tool_result');
    expect(synth.tool_use_id).toBe('A');
    expect(synth.is_error).toBe(true);
    expect(synth.content).toContain('synthesized');

    // deferred user text is preserved after the closed round
    expect(blockTypes(out[2])).toEqual(['text']);
  });

  it('collects results scattered across user messages into one round', () => {
    const input: MessageParam[] = [
      { role: 'assistant', content: [toolUse('A'), toolUse('B')] },
      { role: 'user', content: [toolResult('A')] },
      { role: 'user', content: [toolResult('B')] },
    ];
    const out = normalizeToolResultOrdering(input);
    expect(out).toHaveLength(2);
    const resultBlocks = out[1].content as ContentBlockParam[];
    // results follow the tool_use order of the assistant turn
    expect(resultBlocks.map(b => (b as { tool_use_id: string }).tool_use_id)).toEqual(['A', 'B']);
  });

  it('pulls delayed tool results forward even when another assistant turn sits between', () => {
    // Anthropic-compatible providers reject tool_use blocks that are not
    // immediately followed by their tool_result blocks. This scenario can
    // arise when a model correction or streaming save inserts a second
    // assistant tool_use turn before the first round's results are persisted.
    const input: MessageParam[] = [
      { role: 'assistant', content: [toolUse('A')] },
      { role: 'user', content: [text('intervening user message')] },
      { role: 'assistant', content: [toolUse('B')] },
      { role: 'user', content: [toolResult('B'), toolResult('A')] },
    ];
    const out = normalizeToolResultOrdering(input);

    // Every tool_use must be immediately followed by its tool_result.
    const events = out.flatMap(m => {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        return (m.content as ContentBlockParam[]).map(b => ({ role: 'assistant', type: (b as { type: string }).type, id: (b as { id?: string }).id }));
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        return (m.content as ContentBlockParam[]).map(b => ({ role: 'user', type: (b as { type: string }).type, id: (b as { tool_use_id?: string }).tool_use_id }));
      }
      return [];
    });

    const assistantUseIndices = events
      .map((e, idx) => (e.type === 'tool_use' ? idx : -1))
      .filter(idx => idx !== -1);
    for (const useIdx of assistantUseIndices) {
      const next = events[useIdx + 1];
      expect(next).toBeDefined();
      expect(next.type).toBe('tool_result');
      expect(next.id).toBe(events[useIdx].id);
    }
  });
});

// ─── handleThinkingBlocks ───────────────────────────────────────────────────

describe('handleThinkingBlocks', () => {
  const minimaxModel = minimaxModels[0];
  const anthropicModel = anthropicModels[0];
  const otherThirdPartyModel: Model<'anthropic'> = {
    ...anthropicModel,
    baseUrl: 'https://proxy.example.com/anthropic',
  };

  const conversation: MessageParam[] = [
    { role: 'user', content: [text('q1')] },
    { role: 'assistant', content: [thinking('sig1'), text('a1'), redacted('data1')] },
    { role: 'user', content: [text('q2')] },
    { role: 'assistant', content: [thinking('sig2'), text('a2')] },
  ];

  it('strips ALL thinking blocks for non-MiniMax third-party endpoints', () => {
    const out = handleThinkingBlocks(conversation, otherThirdPartyModel);
    for (const m of out) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        expect(['thinking', 'redacted_thinking']).not.toContain((b as { type: string }).type);
      }
    }
    // text content survives
    expect(blockTypes(out[1])).toEqual(['text']);
    expect(blockTypes(out[3])).toEqual(['text']);
  });

  it('strips ALL thinking blocks for MiniMax Anthropic-compatible endpoints', () => {
    const out = handleThinkingBlocks(conversation, minimaxModel);
    expect(blockTypes(out[1])).toEqual(['text']);
    expect(blockTypes(out[3])).toEqual(['text']);
  });

  it('strips unsigned thinking blocks for MiniMax Anthropic-compatible endpoints', () => {
    const input: MessageParam[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [thinking(), text('answer')] },
    ];
    const out = handleThinkingBlocks(input, minimaxModel);
    expect(blockTypes(out[1])).toEqual(['text']);
  });

  it('strips thinking from non-last assistant messages on direct Anthropic', () => {
    const out = handleThinkingBlocks(conversation, anthropicModel);
    expect(blockTypes(out[1])).toEqual(['text']);
  });

  it('keeps signed thinking on the last assistant message on direct Anthropic', () => {
    const out = handleThinkingBlocks(conversation, anthropicModel);
    expect(blockTypes(out[3])).toEqual(['thinking', 'text']);
    const kept = (out[3].content as ContentBlockParam[])[0] as unknown as { signature?: string };
    expect(kept.signature).toBe('sig2');
  });

  it('downgrades unsigned thinking to text and drops dataless redacted blocks on direct Anthropic', () => {
    const input: MessageParam[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [thinking(), redacted(), text('answer')] },
    ];
    const out = handleThinkingBlocks(input, anthropicModel);
    const blocks = out[1].content as ContentBlockParam[];
    expect(blocks.map(b => (b as { type: string }).type)).toEqual(['text', 'text']);
    expect((blocks[0] as { text: string }).text).toBe('deep thought');
  });

  it('keeps redacted_thinking with data on the last assistant message on direct Anthropic', () => {
    const input: MessageParam[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [redacted('encrypted-data'), text('answer')] },
    ];
    const out = handleThinkingBlocks(input, anthropicModel);
    expect(blockTypes(out[1])).toEqual(['redacted_thinking', 'text']);
  });
});

// ─── toAnthropicMessages thinking handling ──────────────────────────────────

describe('toAnthropicMessages drops MiniMax thinking blocks', () => {
  const minimaxModel = minimaxModels[0];
  const anthropicModel = anthropicModels[0];

  it('drops unsigned thinking blocks for MiniMax Anthropic-compatible endpoint', () => {
    const messages: Message[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'step 1' },
          { type: 'text', text: 'a1' },
        ],
        providerId: 'minimax',
        model: 'MiniMax-M3',
        api: 'anthropic',
      },
    ];

    const out = toAnthropicMessages(messages, minimaxModel);
    expect(out).toHaveLength(2);
    const assistantContent = out[1].content as ContentBlockParam[];
    expect(assistantContent.map(b => (b as { type: string }).type)).toEqual(['text']);
    expect((assistantContent[0] as { text: string }).text).toBe('a1');
  });

  it('drops unsigned thinking blocks for direct Anthropic endpoint', () => {
    const messages: Message[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'step 1' },
          { type: 'text', text: 'a1' },
        ],
        providerId: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        api: 'anthropic',
      },
    ];

    const out = toAnthropicMessages(messages, anthropicModel);
    const assistantContent = out[1].content as ContentBlockParam[];
    expect(assistantContent.map(b => (b as { type: string }).type)).toEqual(['text']);
  });
});

// ─── toAnthropicMessages end-to-end tool ID binding ─────────────────────────

/**
 * Flatten an outgoing-API message array into a chronological list of
 * (kind, id) pairs so we can assert on adjacency and identity.
 */
function flattenBindingEvents(messages: MessageParam[]): Array<{ kind: 'use' | 'result'; id: string }> {
  const out: Array<{ kind: 'use' | 'result'; id: string }> = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (typeof b !== 'object' || b === null) continue;
      const type = (b as { type?: string }).type;
      if (type === 'tool_use') {
        const id = (b as { id?: string }).id;
        if (id) out.push({ kind: 'use', id });
      } else if (type === 'tool_result') {
        const id = (b as { tool_use_id?: string }).tool_use_id;
        if (id) out.push({ kind: 'result', id });
      }
    }
  }
  return out;
}

function assertStrictAdjacency(messages: MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;

    const useIds = m.content
      .filter(b => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use')
      .map(b => (b as { id?: string }).id)
      .filter((id): id is string => !!id);
    if (useIds.length === 0) continue;

    const next = messages[i + 1];
    expect(next).toBeDefined();
    expect(next!.role).toBe('user');

    const resultIds = new Set(
      (next!.content as ContentBlockParam[])
        .filter(b => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result')
        .map(b => (b as { tool_use_id?: string }).tool_use_id)
        .filter((id): id is string => !!id),
    );

    for (const id of useIds) {
      expect(resultIds.has(id)).toBe(true);
    }
  }
}

describe('toAnthropicMessages strict tool ID binding', () => {
  const minimaxModel = minimaxModels[0];

  it('tightens tool results when an assistant turn interrupts the round', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Plan the work' },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'bash', input: { command: 'ls' } }],
      },
      { id: 'u2', role: 'user', content: 'I meant list files first' },
      {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_B', name: 'bash', input: { command: 'pwd' } }],
      },
      {
        id: 'u3',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_B', content: '/home' },
          { type: 'tool_result', tool_use_id: 'toolu_A', content: 'file1 file2' },
        ],
      },
    ];

    const out = toAnthropicMessages(messages, minimaxModel);
    assertStrictAdjacency(out);
  });

  it('pairs empty tool_use/tool_result ids even when result order differs from call order', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Do two things' },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '', name: 'bash', input: { command: 'a' } },
          { type: 'tool_use', id: '', name: 'bash', input: { command: 'b' } },
        ],
      },
      { id: 't1', role: 'tool', content: 'b-out', tool_call_id: '' },
      { id: 't2', role: 'tool', content: 'a-out', tool_call_id: '' },
    ];

    const out = toAnthropicMessages(messages, minimaxModel);
    assertStrictAdjacency(out);

    const events = flattenBindingEvents(out);
    expect(events.filter(e => e.kind === 'use').length).toBe(2);
    expect(events.filter(e => e.kind === 'result').length).toBe(2);
  });

  it('reproduces and repairs the user-reported 400 ordering error shape', () => {
    // The provider error was: "messages.1.3: tool_use ids were found without
    // tool result blocks immediately after call <id>". This simulates a
    // history where an assistant turn with multiple tool_use blocks is not
    // immediately followed by the matching tool_result blocks.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run tools' },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run the tools.' },
          { type: 'tool_use', id: '00_LCM7BXtf67pezZx89R6G669', name: 'bash', input: { command: 'a' } },
          { type: 'tool_use', id: 'toolu_B', name: 'bash', input: { command: 'b' } },
          { type: 'tool_use', id: 'toolu_C', name: 'bash', input: { command: 'c' } },
        ],
      },
      {
        id: 'u2',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_B', content: 'b-out' },
          { type: 'tool_result', tool_use_id: 'toolu_C', content: 'c-out' },
        ],
      },
      {
        id: 'u3',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '00_LCM7BXtf67pezZx89R6G669', content: 'a-out' }],
      },
    ];

    const out = toAnthropicMessages(messages, minimaxModel);
    assertStrictAdjacency(out);

    const events = flattenBindingEvents(out);
    expect(events.length).toBe(6); // 3 uses + 3 results
  });
});

// ─── parseAnthropicEvent MiniMax thinking handling ──────────────────────────

describe('parseAnthropicEvent MiniMax thinking handling', () => {
  const baseMsg = (): AssistantMessage => ({
    role: 'assistant',
    content: [],
    api: 'anthropic',
    providerId: 'minimax',
    model: 'MiniMax-M3',
    usage: { input_tokens: 0, output_tokens: 0 },
    stopReason: 'completed',
    timestamp: 0,
  });

  const miniMaxState = () => ({
    currentBlockIdx: -1,
    isMiniMax: true,
    thinkParser: new ThinkTagParser(),
  });

  const anthropicState = () => ({
    currentBlockIdx: -1,
    isMiniMax: false,
  });

  it('synthesizes a thinking block when thinking_delta arrives without content_block_start', () => {
    const msg = baseMsg();
    const state = miniMaxState();
    const event = {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'step 1' },
    } as unknown as Anthropic.MessageStreamEvent;

    const result = parseAnthropicEvent(event, msg, state);

    expect(result).toEqual({
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'step 1',
      partial: msg,
    });
    expect(msg.content).toEqual([{ type: 'thinking', thinking: 'step 1', thinkingSignature: '' }]);
    expect(state.currentBlockIdx).toBe(0);
  });

  it('accumulates multiple orphan thinking_delta events into the same block', () => {
    const msg = baseMsg();
    const state = miniMaxState();
    const e1 = {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'step 1' },
    } as unknown as Anthropic.MessageStreamEvent;
    const e2 = {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'step 2' },
    } as unknown as Anthropic.MessageStreamEvent;

    parseAnthropicEvent(e1, msg, state);
    parseAnthropicEvent(e2, msg, state);

    expect(msg.content).toEqual([{ type: 'thinking', thinking: 'step 1step 2', thinkingSignature: '' }]);
  });

  it('splits <thinking> text deltas into thinking and text channels (MiniMax)', () => {
    const msg = baseMsg();
    const state = miniMaxState();
    const event = {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '<thinking>reasoning here</thinking>final answer' },
    } as unknown as Anthropic.MessageStreamEvent;

    const result = parseAnthropicEvent(event, msg, state);

    expect(Array.isArray(result)).toBe(true);
    const events = result as Array<{ type: string; delta: string }>;
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('thinking_delta');
    expect(events[0].delta).toBe('reasoning here');
    expect(events[1].type).toBe('text_delta');
    expect(events[1].delta).toBe('final answer');

    expect(msg.content).toEqual([
      { type: 'thinking', thinking: 'reasoning here', thinkingSignature: '' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('handles <thinking> tags split across multiple text deltas', () => {
    const msg = baseMsg();
    const state = miniMaxState();
    const e1 = {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '<thinkin' },
    } as unknown as Anthropic.MessageStreamEvent;
    const e2 = {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'g>reasoning</thinking>answer' },
    } as unknown as Anthropic.MessageStreamEvent;

    const r1 = parseAnthropicEvent(e1, msg, state);
    const r2 = parseAnthropicEvent(e2, msg, state);

    expect(r1).toEqual({ type: 'start', partial: msg });
    const events = r2 as Array<{ type: string; delta: string }>;
    expect(events).toHaveLength(2);
    expect(events[0].delta).toBe('reasoning');
    expect(events[1].delta).toBe('answer');
    expect(msg.content).toEqual([
      { type: 'thinking', thinking: 'reasoning', thinkingSignature: '' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('does not split <thinking> tags for non-MiniMax Anthropic streams', () => {
    const msg = baseMsg();
    msg.providerId = 'anthropic';
    msg.model = 'claude-sonnet-4-20250514';
    const state = anthropicState();
    // Seed a text block as if content_block_start had occurred.
    msg.content.push({ type: 'text', text: '' });
    state.currentBlockIdx = 0;

    const event = {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '<thinking>reasoning</thinking>answer' },
    } as unknown as Anthropic.MessageStreamEvent;

    const result = parseAnthropicEvent(event, msg, state);

    expect(result).toEqual({
      type: 'text_delta',
      contentIndex: 0,
      delta: '<thinking>reasoning</thinking>answer',
      partial: msg,
    });
    expect(msg.content).toEqual([
      { type: 'text', text: '<thinking>reasoning</thinking>answer' },
    ]);
  });
});
