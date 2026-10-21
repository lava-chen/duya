/**
 * Plan 445 regression tests for token_usage round-trip.
 *
 * Verifies that the persisted assistant message's `token_usage` JSON column
 * carries the cumulative tokenUsage block with `last_call` sub-block
 * (the persisted anchor the renderer's computeContextEstimate prefers).
 *
 * Without plan 445, journal fired before the cumulative was built; the
 * persisted row carried only the single-call usageBlock (no `last_call`),
 * which inflated the ring on tool-heavy turns and lost the anchor.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Journal } from '../Journal.js';
import type { Message, TokenUsage } from '@duya/ai';

// ─── Mocks ───

const recordedAppends: Array<{
  sessionId: string;
  messages: unknown[];
  turnId: string | null;
}> = [];

vi.mock('../../ipc/db-client.js', () => ({
  messageDb: {
    append: (sessionId: string, messages: unknown[], turnId: string | null) => {
      recordedAppends.push({ sessionId, messages, turnId });
      return Promise.resolve({ success: true, count: messages.length });
    },
    emit: (sessionId: string, event: unknown, turnId: string | null) =>
      Promise.resolve({ success: true }),
  },
}));

// ─── Builders ───

function assistantMsg(overrides: Partial<Message> = {}): Message {
  return {
    role: 'assistant',
    id: 'a-test',
    content: [{ type: 'text', text: 'hi' }],
    timestamp: 1100,
    ...overrides,
  } as Message;
}

// ─── Tests ───

describe('Journal plan 445: cumulative + last_call persistence', () => {
  beforeEach(() => {
    recordedAppends.length = 0;
  });

  it('persists a cumulative tokenUsage with last_call sub-block', () => {
    // Simulate the agent-process-entry → DuyaAgent flow:
    // 1. agent loop builds `pushed` with `pushed.tokenUsage = cumulative`
    //    (read from `options.cumulativeTokenUsageRef.current`)
    // 2. `_pushDurable` → `journal.assistantMsgFinalized(pushed)`
    // 3. journal.fire reads `pushed.tokenUsage` and writes dto.token_usage
    const cumulative: TokenUsage = {
      input_tokens: 150, // sum of 3 LLM calls (50+30+70)
      output_tokens: 25,
      total_tokens: 175,
      cache_hit_tokens: 300,
      cache_creation_tokens: 20,
      // Per-call ledger (token-accounting):
      calls: [
        { input_tokens: 50, output_tokens: 8, cache_hit_tokens: 100, cache_creation_tokens: 10, total_tokens: 58 } as TokenUsage['calls'] extends Array<infer C> ? C : never,
        { input_tokens: 30, output_tokens: 7, cache_hit_tokens: 80, cache_creation_tokens: 5, total_tokens: 37 } as TokenUsage['calls'] extends Array<infer C> ? C : never,
        { input_tokens: 70, output_tokens: 10, cache_hit_tokens: 120, cache_creation_tokens: 5, total_tokens: 80 } as TokenUsage['calls'] extends Array<infer C> ? C : never,
      ],
      // Single-call snapshot (the largest-prompt call of the turn) — the
      // persisted anchor the renderer's computeContextEstimate prefers.
      last_call: {
        input_tokens: 70,
        output_tokens: 10,
        cache_hit_tokens: 120,
        cache_creation_tokens: 5,
      },
    };

    const journal = new Journal({ sessionId: 'sess-1' });
    journal.assistantMsgFinalized(
      assistantMsg({
        id: 'a-cumulative',
        tokenUsage: cumulative,
      } as Partial<Message> as Message),
      'turn-1',
    );

    expect(recordedAppends).toHaveLength(1);
    const dto = recordedAppends[0].messages[0] as { token_usage?: string };
    expect(dto.token_usage).toBeTypeOf('string');
    const parsed = JSON.parse(dto.token_usage!);

    // Cumulative sums survive the round-trip
    expect(parsed.input_tokens).toBe(150);
    expect(parsed.output_tokens).toBe(25);
    expect(parsed.total_tokens).toBe(175);
    expect(parsed.cache_hit_tokens).toBe(300);
    expect(parsed.cache_creation_tokens).toBe(20);

    // `calls` ledger (token-accounting) survives
    expect(parsed.calls).toHaveLength(3);
    expect(parsed.calls[0].input_tokens).toBe(50);
    expect(parsed.calls[2].input_tokens).toBe(70);

    // `last_call` sub-block survives — this was the persistent-anchor fix
    expect(parsed.last_call).toBeDefined();
    expect(parsed.last_call.input_tokens).toBe(70);
    expect(parsed.last_call.output_tokens).toBe(10);
    expect(parsed.last_call.cache_hit_tokens).toBe(120);
    expect(parsed.last_call.cache_creation_tokens).toBe(5);
  });

  it('handles cumulative with no last_call (single-call turn, no plan 445 fix needed)', () => {
    const cumulative: TokenUsage = {
      input_tokens: 50,
      output_tokens: 8,
      total_tokens: 58,
      cache_hit_tokens: 100,
    };
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.assistantMsgFinalized(
      assistantMsg({ id: 'a-nolast', tokenUsage: cumulative } as Partial<Message> as Message),
      'turn-1',
    );

    const dto = recordedAppends[0].messages[0] as { token_usage?: string };
    const parsed = JSON.parse(dto.token_usage!);
    expect(parsed.input_tokens).toBe(50);
    expect(parsed.last_call).toBeUndefined();
  });

  it('does not lose token_usage when journal fires (no legacy re-emit drop)', () => {
    // Regression: pre-plan-445, journal fired with single-call block;
    // a re-emit would be INSERT OR IGNORE dropped. Plan 445 fixes this by
    // making journal's first emit carry the correct cumulative shape, so
    // the load-on-start path gets `last_call` on the very first load.
    const cumulative: TokenUsage = {
      input_tokens: 200,
      output_tokens: 30,
      total_tokens: 230,
      cache_hit_tokens: 500,
      last_call: { input_tokens: 200, output_tokens: 30, cache_hit_tokens: 500 },
    };

    const journal = new Journal({ sessionId: 'sess-1' });
    journal.assistantMsgFinalized(
      assistantMsg({ id: 'a-load', tokenUsage: cumulative } as Partial<Message> as Message),
      'turn-1',
    );

    // Simulate a second emit (retry after crash — INSERT OR IGNORE dedupes
    // by id, but the row already has the correct cumulative + last_call).
    journal.assistantMsgFinalized(
      assistantMsg({ id: 'a-load', tokenUsage: cumulative } as Partial<Message> as Message),
      'turn-1',
    );

    expect(recordedAppends).toHaveLength(2);
    const parsed = JSON.parse((recordedAppends[1].messages[0] as { token_usage: string }).token_usage);
    // First AND second emit carry last_call — no regression to single-call block
    expect(parsed.last_call).toBeDefined();
    expect(parsed.last_call.input_tokens).toBe(200);
  });
});
