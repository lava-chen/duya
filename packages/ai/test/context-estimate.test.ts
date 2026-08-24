import { describe, it, expect } from 'vitest';
import {
  computeContextEstimate,
  normalizePromptTokens,
  estimateMessageTokens,
  IMAGE_TOKEN_FLOOR,
  type ContextEstimateMessage,
} from '../src/utils/context-estimate.js';

function assistant(
  usage: Record<string, number | undefined> & { last_call?: Record<string, number> },
  extra: Partial<ContextEstimateMessage> = {},
): ContextEstimateMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    tokenUsage: usage as ContextEstimateMessage['tokenUsage'],
    ...extra,
  };
}

describe('normalizePromptTokens', () => {
  it('adds cache back when a cache counter exceeds raw input (Anthropic convention)', () => {
    // input=1000 cannot already contain cacheHit=9000 → full = 1000+9000+500.
    expect(
      normalizePromptTokens({
        input_tokens: 1000,
        output_tokens: 200,
        cache_hit_tokens: 9000,
        cache_creation_tokens: 500,
      }),
    ).toEqual({ prompt: 10500, output: 200 });
  });

  it('treats input as inclusive when cache counters are smaller (gateway convention)', () => {
    expect(
      normalizePromptTokens({ input_tokens: 14000, output_tokens: 10, cache_hit_tokens: 9000 }),
    ).toEqual({ prompt: 14000, output: 10 });
  });

  it('prefers the last_call sub-block over the turn-cumulative sum', () => {
    expect(
      normalizePromptTokens({
        input_tokens: 50_000,
        output_tokens: 5_000,
        last_call: { input_tokens: 2_000, output_tokens: 150 },
      }),
    ).toEqual({ prompt: 2000, output: 150 });
  });

  it('survives fully-cached requests (input=0 with large hits)', () => {
    expect(normalizePromptTokens({ input_tokens: 0, output_tokens: 10, cache_hit_tokens: 3000 })).toEqual({
      prompt: 3000,
      output: 10,
    });
  });
});

describe('estimateMessageTokens (block-aware extraction)', () => {
  it('charges thinking blocks and tool_use input blobs', () => {
    const msg: ContextEstimateMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'a'.repeat(400) },
        { type: 'tool_use', name: 'Bash', input: { command: 'b'.repeat(400) } },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // 400 (thinking) + 416 (tool_use: JSON.stringify wraps input in
    // {"command":"..."} — pi charges the serialized blob too) = 816 / 4.
    expect(tokens).toBe(204);
  });

  it('recurses into tool_result content arrays', () => {
    const msg: ContextEstimateMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', content: [{ type: 'text', text: 'c'.repeat(100) }] }],
    };
    expect(estimateMessageTokens(msg)).toBe(25);
  });

  it('charges images at the floor instead of dropping or base64-stringifying them', () => {
    const msg: ContextEstimateMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', data: 'x'.repeat(10_000) } },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(1 + IMAGE_TOKEN_FLOOR);
  });

  it('uses CJK-aware ratios for Chinese text (~2.5 chars/token)', () => {
    expect(estimateMessageTokens({ role: 'user', content: '一二三四五' })).toBe(2);
  });

  it('never stringifies unknown block shapes (no structural overcount)', () => {
    const msg: ContextEstimateMessage = {
      role: 'system',
      content: [{ type: 'mystery', payload: { blob: 'd'.repeat(1000) } }],
    };
    expect(estimateMessageTokens(msg)).toBe(0);
  });
});

describe('computeContextEstimate', () => {
  it('anchors on the latest valid assistant usage and estimates trailing messages', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'user', content: 'hello' },
      assistant({ input_tokens: 1000, output_tokens: 200, cache_hit_tokens: 9000 }), // anchor → 10200
      { role: 'assistant', content: [{ type: 'text', text: 'e'.repeat(400) }] },
      { role: 'user', content: 'f'.repeat(200) },
    ];
    const est = computeContextEstimate(messages);
    expect(est.anchored).toBe(true);
    expect(est.anchorIndex).toBe(1);
    expect(est.anchorTokens).toBe(10200); // normalized input 10000 + output 200
    expect(est.trailingTokens).toBe(150);
    expect(est.usedTokens).toBe(10350);
  });

  it('ignores aborted/errored assistants as anchors', () => {
    const messages: ContextEstimateMessage[] = [
      assistant({ input_tokens: 5000, output_tokens: 100 }),
      assistant({ input_tokens: 9000, output_tokens: 900 }, { stopReason: 'aborted' }),
      { role: 'user', content: 'retry' },
    ];
    const est = computeContextEstimate(messages);
    expect(est.anchored).toBe(true);
    expect(est.anchorIndex).toBe(0);
  });

  it('ignores all-zero usage blocks', () => {
    const messages: ContextEstimateMessage[] = [
      assistant({ input_tokens: 0, output_tokens: 0 }),
      assistant({ input_tokens: 1200, output_tokens: 30 }),
    ];
    expect(computeContextEstimate(messages).anchorIndex).toBe(1);
  });

  it('falls back to whole-history + system prefix when no anchor exists', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'user', content: 'g'.repeat(100) },
      { role: 'assistant', content: [{ type: 'text', text: 'h'.repeat(100) }] },
    ];
    const est = computeContextEstimate(messages, { systemPrefixTokens: 5000 });
    expect(est.anchored).toBe(false);
    expect(est.usedTokens).toBe(5050);
  });

  it('returns null ("?") when post-boundary history has no fresh anchor', () => {
    const messages: ContextEstimateMessage[] = [
      { role: 'user', content: 'old' },
      assistant({ input_tokens: 80_000, output_tokens: 1000 }), // pre-compaction anchor
      { role: 'assistant', content: [{ type: 'compact_summary' }], isCompactBoundary: true },
      { role: 'assistant', content: [{ type: 'text', text: 'reinject tail' }] },
    ];
    const est = computeContextEstimate(messages);
    expect(est.usedTokens).toBeNull();
    expect(est.anchored).toBe(false);
  });

  it('accepts an anchor AFTER the compaction boundary', () => {
    const messages: ContextEstimateMessage[] = [
      assistant({ input_tokens: 80_000, output_tokens: 1000 }),
      { role: 'assistant', content: [], isCompactBoundary: true },
      { role: 'user', content: 'continue' },
      assistant({ input_tokens: 3000, output_tokens: 100 }),
    ];
    const est = computeContextEstimate(messages);
    expect(est.anchored).toBe(true);
    expect(est.anchorIndex).toBe(3);
    expect(est.usedTokens).toBe(3100);
  });

  it('prefers in-memory per-call usage over persisted cumulative tokenUsage', () => {
    const messages: ContextEstimateMessage[] = [
      {
        role: 'assistant',
        content: [],
        tokenUsage: { input_tokens: 99_999, output_tokens: 999 }, // stale cumulative
        usage: { input_tokens: 2000, output_tokens: 100 }, // fresh in-memory
      },
    ];
    const est = computeContextEstimate(messages);
    expect(est.anchorTokens).toBe(2100);
  });

  it('empty history yields used=0 (not null) so a fresh session shows an empty ring', () => {
    const est = computeContextEstimate([], { systemPrefixTokens: 12_000 });
    expect(est).toMatchObject({ usedTokens: 12_000, anchored: false });
  });
});
