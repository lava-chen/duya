/**
 * Unit tests for CompactionManager loop guards:
 * - provider-usage anchoring of shouldCompact
 * - post-compaction cooldown
 * - compaction-loop breaker (strike counter + block + event)
 * - post-compact over-threshold self-check flag
 *
 * Regression context: session 5e930b44 (2026-08-26) compacted every ~50-90s
 * because the post-compaction projection kept reading above the threshold and
 * nothing prevented immediate re-triggering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Message } from '../../types.js'
import {
  CompactionManager,
  type CompactionManagerEvent,
} from '../CompactionManager.js'

function makeMessages(chars: number): Message[] {
  return [
    { role: 'user', content: 'a'.repeat(Math.max(chars, 1)) },
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

  describe('post-compaction cooldown', () => {
    it('blocks proactive compaction right after a successful one', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      manager.updateContextTokens(messages)
      expect(manager.shouldCompact()).toBe(true)

      await manager.compact(messages, { trigger: 'auto' })

      // Even with a fresh high anchor, the cooldown window blocks it.
      manager.setObservedPromptTokens(180_000)
      expect(manager.shouldCompact()).toBe(false)

      // ...and expires after the cooldown elapses.
      vi.advanceTimersByTime(121_000)
      expect(manager.shouldCompact()).toBe(true)
    })

    it('does not prefire during the cooldown either', async () => {
      const messages = makeMessages(OVER_THRESHOLD_CHARS)
      await manager.compact(messages, { trigger: 'auto' })
      expect(manager.shouldPrefire(messages)).toBe(false)
    })
  })

  describe('loop breaker', () => {
    it('counts near-identical auto compactions as strikes and then blocks', async () => {
      const messages = makeMessages(4_000) // well under threshold; compacted explicitly

      await manager.compact(messages, { trigger: 'auto' }) // baseline
      expect(manager.getLoopStrikes()).toBe(0)

      await manager.compact(messages, { trigger: 'auto' }) // strike 1
      expect(manager.getLoopStrikes()).toBe(1)
      expect(events.filter((e) => e.type === 'compaction_loop_suspected')).toHaveLength(0)

      await manager.compact(messages, { trigger: 'auto' }) // strike 2 → trip
      expect(manager.getLoopStrikes()).toBe(2)
      const suspected = events.find((e) => e.type === 'compaction_loop_suspected')
      expect(suspected).toBeDefined()

      // Next auto attempt is refused before any summarizer work.
      const summarizeCallsBefore = mockSummarizer.mock.calls.length
      const aborted = await manager.compact(messages, { trigger: 'auto' })
      expect(aborted.strategy).toBe('none')
      expect(aborted.messages).toHaveLength(0)
      expect(mockSummarizer.mock.calls.length).toBe(summarizeCallsBefore)
    })

    it('meaningful input growth resets strikes', async () => {
      await manager.compact(makeMessages(4_000), { trigger: 'auto' })
      await manager.compact(makeMessages(8_000), { trigger: 'auto' }) // +100% → reset
      expect(manager.getLoopStrikes()).toBe(0)
    })

    it('never blocks manual or emergency triggers', async () => {
      const messages = makeMessages(4_000)
      await manager.compact(messages, { trigger: 'auto' })
      await manager.compact(messages, { trigger: 'auto' })
      await manager.compact(messages, { trigger: 'auto' })
      expect(manager.getLoopStrikes()).toBe(2)

      const manual = await manager.compact(messages, { trigger: 'manual' })
      expect(manual.strategy).not.toBe('none')

      const emergency = await manager.compact(messages, { trigger: 'emergency' })
      expect(emergency.strategy).not.toBe('none')
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
