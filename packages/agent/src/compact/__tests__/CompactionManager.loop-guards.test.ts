/**
 * Unit tests for CompactionManager loop guards (grok-aligned 5-state
 * suppression machine):
 * - provider-usage anchoring of shouldCompact
 * - SUPPRESS_TURN clears at turn start
 * - SUPPRESS_STICKY clears only on a context-budget change (post-compact)
 * - SUPPRESS_UNTIL_SUCCESS clears on LLM success
 * - SUPPRESS_AUTH clears only on auth refresh
 * - post-compact over-threshold self-check flag
 *
 * Regression context: session 5e930b44 (2026-08-26) compacted every ~50-90s
 * because the post-compaction projection kept reading above the threshold.
 * The grok-aligned suppression machine (see compactErrors.ts and the grok
 * reference at `xai-grok-shell/src/session/compaction.rs:444-810`) replaces
 * the legacy cooldown + loop-strikes + circuit-breaker three-piece set.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Message } from '../../types.js'
import {
  CompactionManager,
  type CompactionManagerEvent,
} from '../CompactionManager.js'

function makeMessages(chars: number): Message[] {
  // Need > maxMessagesToKeep (default 15) so the strategy actually invokes
  // the summarizer instead of returning the input unchanged.
  const filler = (c: string, n: number) => Array.from({ length: n }, () => ({
    role: 'user' as const,
    content: c.repeat(Math.max(chars, 1)),
  }))
  return [
    ...filler('a', 20),
    { role: 'assistant', content: 'b'.repeat(Math.max(chars, 1)) },
    { role: 'user', content: 'continue' },
  ]
}

/** ~700k ASCII chars ≈ 175k estimated tokens — above the 78% threshold of a 200k window. */
const OVER_THRESHOLD_CHARS = 700_000

describe('CompactionManager loop guards', () => {
  let manager: CompactionManager
  let mockSummarizer: ReturnType<typeof vi.fn>
  let events: CompactionManagerEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    mockSummarizer = vi.fn().mockResolvedValue(
      '## Goal\nTest\n\n## Progress\n### Done\n- [x] Task\n\n' +
        '## Decisions\n- Keep going.\n\n## Technical Concepts\n- Testing.\n\n' +
        '## Pending Tasks\n- [ ] None\n\n## Optional Next Step\n- Continue.\n',
    )
    // Small keepRecentTokens so the strategy produces a real summary marker.
    manager = new CompactionManager({ keepRecentTokens: 30 })
    manager.setSummarizer(mockSummarizer)
    events = []
    manager.addEventHandler((e) => events.push(e))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('usage anchoring', () => {
    it('uses the char estimate when no provider usage was observed', () => {
      manager.updateContextTokens(makeMessages(OVER_THRESHOLD_CHARS))
      expect(manager.shouldCompact()).toBe(true)
    })

    it('prefers observed provider usage over an inflated estimate', () => {
      manager.updateContextTokens(makeMessages(OVER_THRESHOLD_CHARS))
      manager.setObservedPromptTokens(50_000)
      expect(manager.shouldCompact()).toBe(false)

      manager.clearObservedPromptTokens()
      expect(manager.shouldCompact()).toBe(true)
    })

    it('ignores non-positive observed usage', () => {
      manager.updateContextTokens([])
      manager.setObservedPromptTokens(0)
      manager.setObservedPromptTokens(-5)
      // Falls back to the (tiny) estimate — must NOT read the anchor as 0/-5
      // and must not throw.
      expect(manager.shouldCompact()).toBe(false)
    })
  })

  describe('preflight overflow check', () => {
    it('reports over-window totals through effectiveTotalTokensForOverflowCheck', () => {
      // Anchor just over the 200k window — must fire preflight_overflow.
      manager.updateContextTokens(makeMessages(OVER_THRESHOLD_CHARS))
      manager.setObservedPromptTokens(250_000)
      expect(
        manager.effectiveTotalTokensForOverflowCheck(),
      ).toBeGreaterThan(200_000)
    })

    it('reports under-window totals correctly', () => {
      manager.updateContextTokens([])
      manager.setObservedPromptTokens(180_000)
      expect(
        manager.effectiveTotalTokensForOverflowCheck(),
      ).toBeLessThanOrEqual(200_000)
    })
  })

  describe('5-state suppression — TURN', () => {
    it('clears SUPPRESS_TURN at the next turn start', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      manager.updateContextTokens(messages)
      // Force a deterministic failure to land in TURN.
      mockSummarizer.mockRejectedValueOnce(new Error('HTTP 500 transient'))
      let caught: unknown = null
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch (e) {
        caught = e
      }
      expect(caught).not.toBeNull()
      expect(manager.getSuppressionState()).toBeGreaterThan(0)
      expect(manager.isCircuitBreakerTriggered()).toBe(true)

      manager.onTurnStart()
      expect(manager.isCircuitBreakerTriggered()).toBe(false)
      expect(manager.shouldCompact()).toBe(true)
    })

    it('STICKY survives onTurnStart (only clearOnBudgetChange clears it)', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      // context_length_exceeded → size → STICKY
      manager.onTurnStart()
      expect(manager.isCircuitBreakerTriggered()).toBe(true)
    })
  })

  describe('5-state suppression — STICKY clear on budget change', () => {
    it('a successful compaction clears STICKY', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      // Now size → STICKY. Successful compaction in this fresh state must
      // clear it (clearOnBudgetChange is called inside compact()'s success
      // path when tokensAfter < tokensBefore).
      await manager.compact(makeMessages(OVER_THRESHOLD_CHARS), {
        trigger: 'auto',
      })
      expect(manager.isCircuitBreakerTriggered()).toBe(false)
    })
  })

  describe('5-state suppression — UNTIL_SUCCESS / AUTH', () => {
    it('clearOnSuccess clears UNTIL_SUCCESS (credit) but not AUTH', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(new Error('out of credits'))
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      manager.onLlmSuccess()
      expect(manager.isCircuitBreakerTriggered()).toBe(false)

      // Now produce an AUTH failure.
      mockSummarizer.mockRejectedValueOnce(new Error('HTTP 401 unauthorized'))
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      manager.onLlmSuccess()
      expect(manager.isCircuitBreakerTriggered()).toBe(true)

      manager.onAuthRefresh()
      expect(manager.isCircuitBreakerTriggered()).toBe(false)
    })
  })

  describe('5-state suppression — manual / emergency / model_switch bypass', () => {
    it('manual trigger succeeds even when suppressed', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      expect(manager.isCircuitBreakerTriggered()).toBe(true)
      // Manual trigger calls compact() directly, never hits shouldCompact(),
      // so the suppression gate does not apply.
      const result = await manager.compact(messages, { trigger: 'manual' })
      expect(result.strategy).not.toBe('none')
    })

    it('emergency trigger succeeds even when suppressed', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      const result = await manager.compact(messages, { trigger: 'emergency' })
      expect(result.strategy).not.toBe('none')
    })

    it('model_switch trigger succeeds even when suppressed', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      try {
        await manager.compact(messages, { trigger: 'auto' })
      } catch {
        // ignored
      }
      const result = await manager.compact(messages, { trigger: 'model_switch' })
      expect(result.strategy).not.toBe('none')
    })
  })

  describe('runtime model-switch wiring', () => {
    it('updateMaxTokens rewrites the budget', () => {
      manager.updateMaxTokens(1_000_000)
      expect(manager.getMaxTokens()).toBe(1_000_000)
    })

    it('does nothing on non-positive values', () => {
      const before = manager.getMaxTokens()
      manager.updateMaxTokens(0)
      manager.updateMaxTokens(-1)
      expect(manager.getMaxTokens()).toBe(before)
    })
  })

  describe('post-compact self-check', () => {
    it('flags overThresholdAfterCompact when the projection stays over the line', async () => {
      // keepRecentTokens=30 retains only a few tokens, so use a single giant
      // message that cannot be cut below the threshold by retention alone.
      const messages: Message[] = [{ role: 'user', content: 'x'.repeat(OVER_THRESHOLD_CHARS * 2) }]
      const result = await manager.compact(messages, { trigger: 'auto' })
      // Either the strategy retained too much or fitCompactedToBudget clamped
      // it — the flag must agree with reality either way.
      expect(result.overThresholdAfterCompact).toBe(
        result.tokensRetained >= 200_000 * 0.78,
      )
    })

    it('is false for a normal small compaction', async () => {
      const result = await manager.compact(makeMessages(4_000), { trigger: 'auto' })
      expect(result.overThresholdAfterCompact).toBe(false)
    })
  })
})