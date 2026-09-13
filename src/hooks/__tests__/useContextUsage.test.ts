/**
 * useContextUsage — data-source priority and fallback coverage
 *
 * Verifies the context ring's hook behavior:
 *  1. live snapshot (worker SSE) wins over the persisted scan;
 *  2. persisted `tokenUsage` scan is used when no live snapshot exists
 *     (and after `done` clears the live store);
 *  3. the no-usage local estimate includes the system prompt + tools
 *     overhead broadcast by the worker (`systemTokens`), so a brand-new
 *     session shows a non-trivial context instead of ~0.
 */

import { describe, it, expect, beforeEach } from 'vitest';
// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { useContextUsage, getContextWindowForModel } from '@/hooks/useContextUsage';
import { useContextUsageStore } from '@/stores/context-usage-store';
import type { Message } from '@/types/message';

function makeAssistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'response text',
    timestamp: Date.now(),
    tokenUsage: {
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      cache_hit_tokens: 8000,
      cache_creation_tokens: 0,
    },
    ...overrides,
  };
}

describe('useContextUsage', () => {
  beforeEach(() => {
    // Reset the live store between tests.
    useContextUsageStore.setState({ liveBySession: {} });
  });

  it('uses the persisted tokenUsage scan when no live snapshot exists', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
      makeAssistantMessage(),
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-1'),
    );
    const usage = result.current;
    expect(usage.hasData).toBe(true);
    // normalizedInput = rawInput + cacheHit (8000 > 1000) = 9000; used =
    // input + output + trailing = 9200.
    expect(usage.inputTokens).toBe(9000);
    expect(usage.used).toBe(9200);
    expect(usage.totalInput).toBe(9000);
  });

  it('prefers the live worker snapshot when present', () => {
    useContextUsageStore.getState().setLive('sess-1', {
      usedTokens: 15_000,
      inputTokens: 14_000,
      outputTokens: 1000,
      cacheHitTokens: 9000,
      cacheCreationTokens: 0,
      totalInput: 40_000,
      totalInputRaw: 20_000,
      totalOutput: 5000,
      totalCacheHit: 25_000,
      totalCacheCreation: 1000,
      anchored: true,
    });
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
      makeAssistantMessage(),
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-1'),
    );
    expect(result.current.used).toBe(15_000);
    expect(result.current.totalInput).toBe(40_000);
  });

  it('returns noData when there is no persisted usage and no authoritative live value', () => {
    // Worker broadcast a systemTokens estimate but usedTokens=0 (no real
    // usage yet). Since 9567a9f9 the hook returns noData instead of a
    // renderer-side local guess: a local estimate omits system/tool overhead
    // and swings against the worker's numbers, which read as the ring
    // jumping. The ring renders a dim dash until the first token_usage.
    useContextUsageStore.getState().setLive('sess-1', {
      usedTokens: 0, // no usage yet — hook must NOT treat this as authority
      inputTokens: 0,
      outputTokens: 0,
      systemTokens: 9000,
      anchored: false,
    });
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hello world', timestamp: Date.now() },
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-1'),
    );
    expect(result.current.hasData).toBe(false);
    expect(result.current.used).toBe(0);
    expect(result.current.state).toBe('normal');
  });

  it('uses persisted scan after the live snapshot is cleared (post-done)', () => {
    // Simulate an explicit invalidation (rewind / compaction on an older
    // worker bundle): the live entry is dropped and the ring falls back to
    // the persisted scan over the reloaded messages.
    useContextUsageStore.getState().setLive('sess-1', {
      usedTokens: 25_000,
      inputTokens: 24_000,
      outputTokens: 1000,
      anchored: true,
    });
    useContextUsageStore.getState().clearLive('sess-1');
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
      makeAssistantMessage(),
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-1'),
    );
    // Falls back to the persisted scan: normalized input + output + trailing.
    expect(result.current.used).toBe(9200);
    expect(result.current.hasData).toBe(true);
  });

  it('bases the ring on the last_call sub-block, not the cumulative block', () => {
    // The worker persists a TURN-CUMULATIVE tokenUsage (every LLM call of
    // the turn summed onto the last assistant) plus a `last_call` sub-block
    // with the final request's single-call usage. The ring's context base
    // must use the single-call value; only the ↑/↓/R/W totals keep summing
    // the cumulative block.
    const messages: Message[] = [
      makeAssistantMessage({
        id: 'a-cum',
        tokenUsage: {
          input_tokens: 3000, // cumulative raw input across 3 calls
          output_tokens: 600,
          total_tokens: 3600,
          cache_hit_tokens: 24000,
          cache_creation_tokens: 300,
          last_call: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_hit_tokens: 8000,
            cache_creation_tokens: 100,
          },
        },
      }),
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-1'),
    );
    // last_call normalized (8000 > 1000 → cache omitted from input):
    // 1000 + 8000 + 100 = 9100; used = 9100 + 200 output = 9300. NOT the
    // cumulative 3000 + 24000 + 300 + 600 = 27900 that made the ring spike
    // at turn start.
    expect(result.current.inputTokens).toBe(9100);
    expect(result.current.used).toBe(9300);
    // Cumulative totals keep summing the whole block with the same 3-field
    // cache guard as the worker's seeding/result accumulation:
    // 3000 + 24000 + 300 = 27300.
    expect(result.current.totalInput).toBe(27_300);
  });

  it('ignores unanchored live frames — the ring shows "?" instead of a guess', () => {
    // Plan 443: worker frames without a real usage anchor (fresh session
    // estimate, post-compaction unknown) must not drive the ring, or the
    // displayed number swings when the first authoritative result lands.
    useContextUsageStore.getState().setLive('sess-1', {
      usedTokens: 15_000,
      inputTokens: 14_000,
      outputTokens: 1000,
      anchored: false,
    });
    const messages: Message[] = [
      makeAssistantMessage(), // persisted anchor still exists
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-1'),
    );
    // Falls through to the persisted scan (anchored), not the live guess.
    expect(result.current.hasData).toBe(true);
    expect(result.current.used).toBe(9200);
  });


  it('reports cacheHitRate against raw input + cache read + cache write (not the tautological totalInput)', () => {
    // Plan 443 P0: totalInput already includes cache reads (normalizeInputTokens
    // adds them back when hit > raw), so dividing cacheHit / totalInput was
    // mathematically always 100% on fully-cached sessions. The fix is to
    // sum uncached input + cache read + cache write and divide cache reads
    // by that raw prompt volume.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: Date.now() },
      makeAssistantMessage({
        id: 'a1',
        tokenUsage: {
          input_tokens: 50,         // tiny uncached delta
          output_tokens: 20,
          total_tokens: 60070,
          cache_hit_tokens: 60000,
          cache_creation_tokens: 0,
        },
      }),
    ];
    const { result } = renderHook(() =>
      useContextUsage(messages, 'claude-sonnet', 200_000, 'sess-ch'),
    );
    // CH% = 60000 / (50 + 60000 + 0) ≈ 99.92%, NOT 100%.
    expect(result.current.cacheHitRate).toBeGreaterThan(0.99);
    expect(result.current.cacheHitRate).toBeLessThan(1);
  });

  describe('getContextWindowForModel', () => {
    it('prefers the caller-supplied capability window', () => {
      expect(getContextWindowForModel('gpt-4o', 1_000_000)).toBe(1_000_000);
    });

    it('resolves known models from the @duya/ai static catalog', () => {
      expect(getContextWindowForModel('deepseek-flash')).toBe(1_048_576);
      expect(getContextWindowForModel('claude-sonnet-4-20250514')).toBe(200_000);
    });

    it('falls back to 200K for unknown ids (custom gateways, aliases)', () => {
      expect(getContextWindowForModel('totally-made-up-model')).toBe(200_000);
      expect(getContextWindowForModel(undefined)).toBe(200_000);
      expect(getContextWindowForModel('claude-sonnet-4-6[1M]')).toBe(200_000);
    });
  });
});
