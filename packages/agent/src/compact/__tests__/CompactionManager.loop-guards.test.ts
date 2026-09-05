/**
 * Unit tests for CompactionManager loop guards (Pi-aligned flat suppression):
 * - provider-usage anchoring of shouldCompact
 * - 'other' suppression clears at the next turn start (onTurnStart)
 * - 'size' suppression survives onTurnStart and clears only on a successful
 *   compaction — the budget change it was waiting for (see updateMaxTokens)
 * - 'auth' suppression clears only on auth refresh (onAuthRefresh)
 * - non-auto triggers (manual / emergency / model_switch) call compact()
 *   directly and never consult shouldCompact(), so the gate does not apply
 * - runtime model-switch wiring: updateMaxTokens rewrites the budget
 * - post-compact over-threshold self-check flag
 *
 * Regression context: session 5e930b44 (2026-08-26) compacted every ~50-90s
 * because the post-compaction projection kept reading above the threshold.
 * Rewritten 2026-09-05 for the pi-aligned flat design (commit 59e9cbd8) —
 * the grok 5-state API this file previously exercised (updateContextTokens /
 * isCircuitBreakerTriggered / onLlmSuccess / effectiveTotalTokensForOverflowCheck)
 * no longer exists.
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

/** 22 messages × ~700k ASCII chars ≈ several M estimated tokens — far above
 *  the compaction threshold of a 200k-window manager. */
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
      expect(manager.shouldCompact(makeMessages(OVER_THRESHOLD_CHARS))).toBe(
        true,
      )
    })

    it('prefers observed provider usage over an inflated estimate', () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      manager.setObservedPromptTokens(50_000)
      expect(manager.shouldCompact(messages)).toBe(false)

      manager.clearObservedPromptTokens()
      expect(manager.shouldCompact(messages)).toBe(true)
    })

    it('ignores non-positive observed usage', () => {
      manager.setObservedPromptTokens(0)
      manager.setObservedPromptTokens(-5)
      // Falls back to the (tiny) char estimate — must NOT read the anchor as
      // 0/-5 and must not throw.
      expect(manager.shouldCompact(makeMessages(4_000))).toBe(false)
    })
  })

  describe('failure suppression (flat)', () => {
    it("clears a transient 'other' failure at the next turn start", async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(new Error('HTTP 500 transient'))
      await expect(manager.compact(messages, { trigger: 'auto' })).rejects.toThrow()
      expect(manager.isSuppressed()).toBe(true)
      expect(manager.getSuppressionType()).toBe('other')

      manager.onTurnStart()
      expect(manager.isSuppressed()).toBe(false)
      expect(manager.shouldCompact(messages)).toBe(true)
    })

    it("'size' failures survive onTurnStart and clear only on a successful compaction", async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      await expect(manager.compact(messages, { trigger: 'auto' })).rejects.toThrow()
      expect(manager.getSuppressionType()).toBe('size')

      // onTurnStart clears only 'other' — size suppression must survive.
      manager.onTurnStart()
      expect(manager.isSuppressed()).toBe(true)

      // A successful compaction clears 'size' (the budget change it waited
      // for — clearOnBudgetChange runs in onCompactionSuccess).
      await manager.compact(messages, { trigger: 'auto' })
      expect(manager.isSuppressed()).toBe(false)
    })

    it("'auth' failures clear only on auth refresh", async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(new Error('HTTP 401 unauthorized'))
      await expect(manager.compact(messages, { trigger: 'auto' })).rejects.toThrow()
      expect(manager.getSuppressionType()).toBe('auth')

      manager.onTurnStart()
      expect(manager.isSuppressed()).toBe(true)

      manager.onAuthRefresh()
      expect(manager.isSuppressed()).toBe(false)
    })

    it('non-auto triggers bypass the suppression gate', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      mockSummarizer.mockRejectedValueOnce(
        new Error('context_length_exceeded'),
      )
      await expect(manager.compact(messages, { trigger: 'auto' })).rejects.toThrow()
      expect(manager.isSuppressed()).toBe(true)

      // manual / emergency / model_switch call compact() directly and never
      // consult shouldCompact(), so the suppression gate does not apply.
      for (const trigger of ['manual', 'emergency', 'model_switch'] as const) {
        const result = await manager.compact(messages, { trigger })
        expect(result.strategy).not.toBe('none')
      }
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
