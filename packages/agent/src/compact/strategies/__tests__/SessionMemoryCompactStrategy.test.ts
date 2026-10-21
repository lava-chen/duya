/**
 * Unit tests for SessionMemoryCompactStrategy with iterative updates
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Message } from '../../../types.js'
import { SessionMemoryCompactStrategy } from '../SessionMemoryCompactStrategy.js'
import { SummaryDegenerateError } from '../../compactErrors.js'

describe('SessionMemoryCompactStrategy', () => {
  let strategy: SessionMemoryCompactStrategy
  let mockSummarizer: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Plan 523 P2: the summary must match the 9-section numbered format the
    // SUMMARIZATION_PROMPT demands (>= 3 numbered section headings + length),
    // otherwise isDegenerateSummary flags it and the retry ladder throws.
    mockSummarizer = vi.fn().mockResolvedValue(
      '1. Primary Request and Intent: Complete the migration to TypeScript strict mode.\n\n' +
        '2. Key Technical Concepts: TypeScript strict mode, MessageTimeline append-only store.\n\n' +
        '3. Files and Code Sections: src/timeline.ts — the append-only message store; ' +
        'src/compaction.ts — bridge from the legacy manager.\n\n' +
        '4. Errors and Fixes: Fixed the tool-call invariant sanitation regression by ' +
        'adding degenerate summary detection with retry.\n\n' +
        '5. Problem Solving: Resolved cross-compaction state leakage by keeping the ' +
        'two-pass prefire seed on the manager instead of the strategy.\n\n' +
        '6. All User Messages: Use TypeScript strict mode throughout the migration.\n\n' +
        '7. Pending Tasks: Wire the two-pass prefire summary into the next compaction.\n\n' +
        '8. Current Work: Phase 2 hardening — error classification with suppression windows.\n\n' +
        '9. Optional Next Step: Inject the cached prefire summary as the previous summary.\n'
    )
    strategy = new SessionMemoryCompactStrategy({
      maxMessagesToKeep: 5,
      // Small budget so short test messages actually exceed it
      keepRecentTokens: 30,
    })
    strategy.setSummarizer(mockSummarizer)
  })

  describe('compact', () => {
    it('should not compact when conversation is small', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ]

      const result = await strategy.compact(messages, {
        totalTokens: 100,
        maxTokens: 1000,
        messageCount: 2,
        toolCallCount: 0,
        sessionAge: 0,
      })

      expect(result.tokensRemoved).toBe(0)
      expect(result.messages).toEqual(messages)
    })

    it('should not compact when nothing exceeds the recent-token budget', async () => {
      // Large budget — everything fits, no older messages to summarize
      const bigBudgetStrategy = new SessionMemoryCompactStrategy({
        maxMessagesToKeep: 1,
        keepRecentTokens: 100000,
      })
      bigBudgetStrategy.setSummarizer(mockSummarizer)

      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' },
      ]

      const result = await bigBudgetStrategy.compact(messages, {
        totalTokens: 100,
        maxTokens: 1000,
        messageCount: 3,
        toolCallCount: 0,
        sessionAge: 0,
      })

      // No summary message should be inserted; history returned unchanged
      expect(result.messages).toEqual(messages)
      expect(result.tokensRemoved).toBe(0)
      expect(mockSummarizer).not.toHaveBeenCalled()
    })

    it('should use token budget cut point when keepRecentTokens is set', async () => {
      const messages: Message[] = []
      for (let i = 0; i < 20; i++) {
        messages.push(
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        )
      }

      const result = await strategy.compact(messages, {
        totalTokens: 5000,
        maxTokens: 10000,
        messageCount: 40,
        toolCallCount: 0,
        sessionAge: 0,
      })

      // Should compact: 40 short messages far exceed the 30-token budget
      expect(result.messages.length).toBeLessThan(messages.length)
      // Verify summary message was created
      const summaryMessage = result.messages.find(m => m.isCompactSummary)
      expect(summaryMessage).toBeDefined()
      expect(mockSummarizer).toHaveBeenCalled()
    })

    it('uses options.previousSummary as the iterative prompt seed without mutating the strategy', async () => {
      // First compaction: no previous summary yet, so the prompt is the
      // plain SUMMARIZATION_PROMPT (no <previous-summary> block).
      const messages1: Message[] = []
      for (let i = 0; i < 10; i++) {
        messages1.push(
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        )
      }

      await strategy.compact(messages1, {
        totalTokens: 2000,
        maxTokens: 10000,
        messageCount: 20,
        toolCallCount: 0,
        sessionAge: 0,
      })

      expect(mockSummarizer).toHaveBeenCalledTimes(1)
      expect(mockSummarizer.mock.calls[0][1]).not.toContain('<previous-summary>')

      // Second compaction: caller (the manager) feeds the prior summary back
      // via options.previousSummary. The strategy does NOT persist it on
      // itself — verify that no leak happens if options.previousSummary is
      // omitted on a third call.
      const messages2: Message[] = []
      for (let i = 10; i < 20; i++) {
        messages2.push(
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        )
      }

      await strategy.compact(messages2, {
        totalTokens: 3000,
        maxTokens: 10000,
        messageCount: 20,
        toolCallCount: 0,
        sessionAge: 0,
      }, { previousSummary: 'summary from first compaction' })

      expect(mockSummarizer).toHaveBeenCalledTimes(2)
      expect(mockSummarizer.mock.calls[1][1]).toContain('<previous-summary>')
      expect(mockSummarizer.mock.calls[1][1]).toContain('summary from first compaction')

      // Third compaction: previousSummary omitted → no iterative update.
      // Regression check for the cross-session leak fix.
      await strategy.compact(messages2, {
        totalTokens: 3000,
        maxTokens: 10000,
        messageCount: 20,
        toolCallCount: 0,
        sessionAge: 0,
      })

      expect(mockSummarizer).toHaveBeenCalledTimes(3)
      expect(mockSummarizer.mock.calls[2][1]).not.toContain('<previous-summary>')
    })

    it('surfaces summaryText on the CompactionResult so the manager can drive iterative updates', async () => {
      const messages: Message[] = []
      for (let i = 0; i < 10; i++) {
        messages.push(
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        )
      }

      const result = await strategy.compact(messages, {
        totalTokens: 2000,
        maxTokens: 10000,
        messageCount: 20,
        toolCallCount: 0,
        sessionAge: 0,
      })

      expect(result.summaryText).toBeDefined()
      expect(result.summaryText!.length).toBeGreaterThan(0)
      // The summary text should be the same content embedded in the visible
      // summary message — the manager no longer has to regex-extract it.
      const visible = result.messages.find((m) => m.isCompactSummary)
      expect(visible).toBeDefined()
      expect(visible!.content as string).toContain(result.summaryText!)
    })

    it('should surface tracked file operations in the summary text', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read file' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/test1.txt' } },
          ],
        },
        { role: 'tool', content: 'File 1 contents', tool_call_id: 'tool1' },
      ]

      // Add more messages to trigger compaction
      for (let i = 0; i < 10; i++) {
        messages.push(
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        )
      }

      const result = await strategy.compact(messages, {
        totalTokens: 2000,
        maxTokens: 10000,
        messageCount: messages.length,
        toolCallCount: 1,
        sessionAge: 0,
      })

      // Plan 523: file operations are now surfaced through the summary text
      // (via formatFileOperations) rather than a removed getFileOperations() API.
      expect(result.summaryText).toBeDefined()
      expect(result.summaryText).toContain('/test1.txt')
    })

    it('throws SummaryDegenerateError when the ladder exhausts on degenerate output (Plan 523)', async () => {
      const bad = new SessionMemoryCompactStrategy({
        maxMessagesToKeep: 1,
        keepRecentTokens: 5,
      })
      bad.setSummarizer(async () => 'junk') // always degenerate (< 500 chars)
      const messages: Message[] = []
      for (let i = 0; i < 10; i++) {
        messages.push(
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        )
      }
      // Degenerate exhaustion must propagate — compaction fails loudly instead
      // of producing the old "[Session memory unavailable …]" placeholder.
      await expect(
        bad.compact(messages, {
          totalTokens: 5000,
          maxTokens: 10000,
          messageCount: 20,
          toolCallCount: 0,
          sessionAge: 0,
        }),
      ).rejects.toBeInstanceOf(SummaryDegenerateError)
    })

    it('should handle split turn correctly', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Start task' },
        { role: 'assistant', content: 'Starting...' },
        { role: 'assistant', content: 'Working...' },
        { role: 'assistant', content: 'Still working...' },
        { role: 'assistant', content: 'Almost done...' },
        { role: 'user', content: 'Thanks' },
      ]

      // Force small keepRecentTokens to trigger split turn
      const smallStrategy = new SessionMemoryCompactStrategy({
        maxMessagesToKeep: 2,
        keepRecentTokens: 5, // Very small budget
      })
      smallStrategy.setSummarizer(mockSummarizer)

      const result = await smallStrategy.compact(messages, {
        totalTokens: 500,
        maxTokens: 1000,
        messageCount: 6,
        toolCallCount: 0,
        sessionAge: 0,
      })

      // Should compact the messages
      expect(result.messages.length).toBeLessThan(messages.length)
    })
  })
})
