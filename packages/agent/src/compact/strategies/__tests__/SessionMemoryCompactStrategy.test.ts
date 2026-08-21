/**
 * Unit tests for SessionMemoryCompactStrategy with iterative updates
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Message } from '../../../types.js'
import { SessionMemoryCompactStrategy } from '../SessionMemoryCompactStrategy.js'

describe('SessionMemoryCompactStrategy', () => {
  let strategy: SessionMemoryCompactStrategy
  let mockSummarizer: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSummarizer = vi.fn().mockResolvedValue(
      '## Goal\nTest goal\n\n## Progress\n### Done\n- [x] Task 1\n\n' +
        '## Decisions\n- Use TypeScript strict mode throughout the migration.\n\n' +
        '## Technical Concepts\n- MessageTimeline is an append-only store; the compaction controller ' +
        'bridges the legacy manager to it without mutating existing entries.\n\n' +
        '## Current Work\n- Phase 2 hardening: tool-call invariant sanitation, degenerate summary ' +
        'detection with retry, and error classification with suppression windows.\n\n' +
        '## Pending Tasks\n- [ ] Wire the two-pass prefire summary into the next compaction.\n' +
        '## Optional Next Step\n- Inject the cached prefire summary as the previous summary.\n'
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

    it('should track file operations across compactions', async () => {
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

      await strategy.compact(messages, {
        totalTokens: 2000,
        maxTokens: 10000,
        messageCount: messages.length,
        toolCallCount: 1,
        sessionAge: 0,
      })

      // Check that file operations are tracked
      const fileOps = strategy.getFileOperations()
      expect(fileOps.length).toBeGreaterThan(0)
      expect(fileOps.some(op => op.filePath === '/test1.txt')).toBe(true)
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

  describe('getFileOperations', () => {
    it('should return empty array when no file operations', () => {
      const fileOps = strategy.getFileOperations()
      expect(fileOps).toEqual([])
    })
  })

  describe('setPreviousSummary', () => {
    it('should update previous summary', () => {
      const summary = '## Goal\nUpdated goal'
      strategy.setPreviousSummary(summary)

      // Verify by checking that next compact uses update prompt
      expect(strategy['config'].previousSummary).toBe(summary)
    })
  })
})
