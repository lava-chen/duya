/**
 * Plan 523 P1 — degenerate-exhaustion failure semantics.
 *
 * Regression lock: after the retry ladder's placeholder contract was removed,
 * a summarizer that keeps producing degenerate output must *throw*
 * `SummaryDegenerateError` (so compaction routes into the suppression machine
 * and real history is never replaced by a zero-information placeholder)
 * instead of returning ''.
 */
import { describe, it, expect } from 'vitest'
import { MAX_SUMMARY_RETRIES, summarizeWithRetryLadder } from '../summaryRetry.js'
import { SummaryDegenerateError } from '../compactErrors.js'
import type { Message } from '../../types.js'

function text(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 }
}

function rejectDegenerate(_t: string): boolean {
  return true
}

describe('summarizeWithRetryLadder — degenerate exhaustion throws (Plan 523)', () => {
  it('throws SummaryDegenerateError after MAX_SUMMARY_RETRIES degenerate results', async () => {
    let calls = 0
    let caught: unknown
    try {
      await summarizeWithRetryLadder(
        async () => {
          calls++
          return '[Session memory unavailable - 155 messages truncated]'
        },
        {
          conversationText: 'c',
          prompt: 'p',
          messages: [text('m0', 'user', 'x'), text('m1', 'user', 'summarize')],
          rebuild: (r) => ({ conversationText: r.map((m) => String(m.content)).join('\n'), prompt: 'p' }),
        },
        rejectDegenerate,
      )
    } catch (err) {
      caught = err
    }
    expect(calls).toBe(MAX_SUMMARY_RETRIES)
    expect(caught).toBeInstanceOf(SummaryDegenerateError)
  })

  it('carries attempts and last-char diagnostics on the thrown error', async () => {
    let calls = 0
    try {
      await summarizeWithRetryLadder(
        async () => {
          calls++
          return 'junk'
        },
        {
          conversationText: 'c',
          prompt: 'p',
          messages: [],
          rebuild: () => ({ conversationText: 'c', prompt: 'p' }),
        },
        rejectDegenerate,
      )
    } catch (err) {
      expect(err).toBeInstanceOf(SummaryDegenerateError)
      const e = err as SummaryDegenerateError
      expect(e.attempts).toBe(MAX_SUMMARY_RETRIES)
      expect(e.lastChars).toBe(4) // 'junk'
    }
  })

  it('returns normally when a later attempt is good (not a false throw)', async () => {
    let calls = 0
    const result = await summarizeWithRetryLadder(
      async () => {
        calls++
        return calls === 2 ? 'good summary' : 'junk'
      },
      {
        conversationText: 'c',
        prompt: 'p',
        messages: [],
        rebuild: () => ({ conversationText: 'c', prompt: 'p' }),
      },
      (t) => t === 'junk',
    )
    expect(result.text).toBe('good summary')
    expect(result.attempts).toBe(2)
  })
})