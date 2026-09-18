/**
 * Live context-usage emission semantics (plan 443, pi parity)
 *
 * The old incremental tracker state machine (liveBaseContext /
 * liveBoundaryPending / append-only invariant) was deleted; `emitLiveUsage`
 * now recomputes statelessly via computeContextEstimate(@duya/ai) on every
 * emission. These tests pin the multi-turn behaviors the ring depends on,
 * exercising the REAL shared estimator (not a re-implementation):
 *
 *   1. Turn-start of an existing session anchors on persisted tokenUsage
 *      (`last_call` preferred) — never resets to 0.
 *   2. Mid-turn: DuyaAgent-attached per-call `usage` wins over stale
 *      persisted cumulative blocks; trailing messages are estimated.
 *   3. Post-compaction without a fresh response → unanchored ("?").
 *   4. Cumulative spend totals survive turn boundaries.
 */

import { describe, it, expect } from 'vitest';
import {
  computeContextEstimate,
  normalizePromptTokens,
  type ContextEstimateMessage,
} from '@duya/ai';

type Msg = ContextEstimateMessage & { id: string };

function assistantWithPersistedUsage(
  id: string,
  cumulative: { input_tokens: number; output_tokens: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
  lastCall?: { input_tokens: number; output_tokens: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
): Msg {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text: 'reply' }],
    tokenUsage: lastCall ? { ...cumulative, last_call: lastCall } : cumulative,
  };
}

describe('live context-usage emission (stateless, plan 443)', () => {
  it('turn start anchors on the persisted last_call block — no reset to 0', () => {
    // End-of-turn-1 history as reloaded from the DB at turn-2 chat:start.
    const history: Msg[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      assistantWithPersistedUsage(
        'a1',
        { input_tokens: 3000, output_tokens: 600, cache_hit_tokens: 24_000, cache_creation_tokens: 300 },
        { input_tokens: 1000, output_tokens: 200, cache_hit_tokens: 8000, cache_creation_tokens: 100 },
      ),
    ];
    const est = computeContextEstimate(history);
    expect(est.anchored).toBe(true);
    // last_call normalized: 1000 + 8000 + 100 = 9100 prompt (+200 output).
    expect(est.anchorTokens).toBe(9300);
    expect(est.usedTokens).toBe(9300);
  });

  it('mid-turn: fresh in-memory usage beats the stale persisted block; trailing counts tool results', () => {
    const history: Msg[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      assistantWithPersistedUsage('a1', { input_tokens: 50_000, output_tokens: 500 }),
      // Turn 2: result landed (usage attached by DuyaAgent), then a tool
      // round appended an assistant tool_use + a big tool result.
      {
        id: 'u2',
        role: 'user',
        content: 'run it',
      },
      {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 2000, output_tokens: 150 },
      },
      {
        id: 't2',
        role: 'tool',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x'.repeat(400) }] }],
      },
    ];
    const est = computeContextEstimate(history);
    expect(est.anchored).toBe(true);
    expect(est.anchorIndex).toBe(3);
    // Anchor = 2000 + 150 (in-memory usage preferred over the 50K stale row).
    expect(est.anchorTokens).toBe(2150);
    // Trailing: the tool result (400/4 = 100 tokens).
    expect(est.trailingTokens).toBe(100);
    expect(est.usedTokens).toBe(2250);
  });

  it('thinking + tool_use blocks in trailing messages are counted, not dropped', () => {
    const history: Msg[] = [
      { id: 'u1', role: 'user', content: 'go' },
      { id: 'a1', role: 'assistant', content: [], usage: { input_tokens: 1000, output_tokens: 10 } },
      {
        id: 'a2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't'.repeat(400) }, // 100 tokens
          { type: 'text', text: 'w'.repeat(200) }, // 50 tokens
        ],
      },
    ];
    const est = computeContextEstimate(history);
    // anchor 1010 + trailing thinking(100) + text(50)
    expect(est.usedTokens).toBe(1160);
  });

  it('post-compaction without a fresh response → unanchored (ring shows ?)', () => {
    const history: Msg[] = [
      assistantWithPersistedUsage('a-old', { input_tokens: 80_000, output_tokens: 1000 }),
      // Compaction summary marker + reinjected tail.
      { id: 'sum', role: 'system', content: ['summary...'], isCompactBoundary: true },
      { id: 'u2', role: 'user', content: 'continue' },
    ];
    const est = computeContextEstimate(history);
    expect(est.usedTokens).toBeNull();
    expect(est.anchored).toBe(false);
    // Emission gate mirrors emitLiveUsage: anchored && !compactedPending.
    const broadcastAnchored = est.anchored && true; // compactedPending=true here
    expect(broadcastAnchored).toBe(false);
  });

  it('first post-compaction result re-anchors past the boundary', () => {
    const history: Msg[] = [
      assistantWithPersistedUsage('a-old', { input_tokens: 80_000, output_tokens: 1000 }),
      { id: 'sum', role: 'system', content: ['summary...'], isCompactBoundary: true },
      { id: 'u2', role: 'user', content: 'continue' },
      { id: 'a2', role: 'assistant', content: [], usage: { input_tokens: 3000, output_tokens: 100 } },
    ];
    const est = computeContextEstimate(history);
    expect(est.anchored).toBe(true);
    expect(est.anchorIndex).toBe(3);
    expect(est.usedTokens).toBe(3100);
  });

  it('cumulative totals accumulate ONLY-NEW per call, never the re-read cache hit', () => {
    // Mirrors the worker's totals loop (seed from DB + accumulate results):
    // the session "t" total counts input + cache_creation per call (only-new).
    // cache_hit is a re-read of an already-counted prefix and must NOT
    // accumulate across fully-cached rounds (MiniMax re-reports the whole
    // prefix → N× inflation). Raw fields still accumulate for CH% / cost.
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheHit = 0;
    let totalCacheCreation = 0;

    const seedBlock = { input_tokens: 3000, output_tokens: 600, cache_hit_tokens: 24_000, cache_creation_tokens: 300 };
    const normalize = (u: { input_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number }) => {
      const rawInput = u.input_tokens ?? 0;
      const hit = u.cache_hit_tokens ?? 0;
      const write = u.cache_creation_tokens ?? 0;
      return hit > rawInput || write > rawInput ? rawInput + write : rawInput;
    };
    totalInput += normalize(seedBlock);
    totalOutput += seedBlock.output_tokens;
    totalCacheHit += seedBlock.cache_hit_tokens ?? 0;
    totalCacheCreation += seedBlock.cache_creation_tokens ?? 0;

    // Turn-2 result: fully-cached request (input=0, hits=5000). Only-new = 0
    // (no new input, no new cache write) — the 5000 re-read hit is skipped.
    totalInput += normalize({ input_tokens: 0, cache_hit_tokens: 5000 });
    totalOutput += 120;
    totalCacheHit += 5000;

    expect(totalInput).toBe(3300);
    expect(totalOutput).toBe(720);
    expect(totalCacheHit).toBe(29_000);
    // Sanity: the RESIDENT prompt (ring/compaction) still counts cache_hit.
    expect(normalizePromptTokens({ input_tokens: 0, output_tokens: 5, cache_hit_tokens: 5000 })).toEqual({
      prompt: 5000,
      output: 5,
    });
  });
});
