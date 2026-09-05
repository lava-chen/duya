import { describe, it, expect } from 'vitest'
import type { Message } from '../../types.js'
import {
  MAX_SUMMARY_RETRIES,
  TOOL_MESSAGE_DROP_THRESHOLD,
  classifySummaryError,
  appendShorterOutputInstruction,
  reduceSummaryInputs,
  summarizeWithRetryLadder,
} from '../summaryRetry.js'

function text(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 }
}

function toolUse(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'echo', input: {} }],
    timestamp: 1,
  }
}

function toolResult(id: string, toolUseId: string): Message {
  return {
    id,
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: false }],
    timestamp: 1,
  }
}

describe('classifySummaryError', () => {
  it('classifies output-length errors', () => {
    expect(classifySummaryError(new Error('max_output_tokens exceeded'))).toBe('output_length')
    expect(classifySummaryError(new Error('output max_tokens reached'))).toBe('output_length')
  })

  it('classifies input-length errors', () => {
    expect(classifySummaryError(new Error('context_length_exceeded'))).toBe('input_length')
    expect(classifySummaryError(new Error('prompt is too long: 300000 tokens'))).toBe('input_length')
  })

  it('classifies transient errors', () => {
    expect(classifySummaryError(new Error('request timeout after 30s'))).toBe('transient')
    expect(classifySummaryError(new Error('HTTP 503 overloaded'))).toBe('transient')
  })

  it('classifies everything else as fatal', () => {
    expect(classifySummaryError(new Error('invalid api key'))).toBe('fatal')
  })
})

describe('appendShorterOutputInstruction', () => {
  it('appends the shorter-output instruction once', () => {
    const next = appendShorterOutputInstruction('summarize this')
    expect(next.startsWith('summarize this')).toBe(true)
    expect(next).toContain('much shorter')
  })
})

describe('reduceSummaryInputs', () => {
  it('keeps head and prompt verbatim, drops tool traffic when share >= threshold', () => {
    const head = text('m0', 'user', 'anchor')
    const middle = [
      toolUse('m1'),
      toolResult('m2', 'm1'),
      text('m3', 'assistant', 'worked'),
      toolUse('m4'),
      toolResult('m5', 'm4'),
      text('m6', 'assistant', 'done'),
    ]
    const prompt = text('m7', 'user', 'summarize')
    const reduced = reduceSummaryInputs([head, ...middle, prompt])
    // 4/6 = 0.67 >= 0.25 → tool messages dropped
    expect(reduced).toEqual([head, text('m3', 'assistant', 'worked'), text('m6', 'assistant', 'done'), prompt])
  })

  it('drops the first half of the middle when tool share is low', () => {
    const head = text('m0', 'user', 'anchor')
    const middle = [
      text('m1', 'user', 'a'),
      text('m2', 'assistant', 'b'),
      text('m3', 'user', 'c'),
      text('m4', 'assistant', 'd'),
    ]
    const prompt = text('m5', 'user', 'summarize')
    const reduced = reduceSummaryInputs([head, ...middle, prompt])
    expect(reduced).toHaveLength(4)
    expect(reduced[0]).toBe(head)
    expect(reduced[reduced.length - 1]).toBe(prompt)
    expect(reduced.slice(1, -1)).toEqual([text('m3', 'user', 'c'), text('m4', 'assistant', 'd')])
  })

  it('never returns an empty middle (halving falls back when all tool traffic)', () => {
    const head = text('m0', 'user', 'anchor')
    const middle = [toolUse('m1'), toolResult('m2', 'm1')]
    const prompt = text('m3', 'user', 'summarize')
    const reduced = reduceSummaryInputs([head, ...middle, prompt])
    // 2/2 >= 0.25 → drop tool → empty middle → halving path keeps half
    expect(reduced[0]).toBe(head)
    expect(reduced[reduced.length - 1]).toBe(prompt)
    expect(reduced.length).toBeGreaterThanOrEqual(2)
  })

  it('leaves trivial inputs untouched', () => {
    const head = text('m0', 'user', 'anchor')
    const prompt = text('m1', 'user', 'summarize')
    expect(reduceSummaryInputs([head, prompt])).toEqual([head, prompt])
  })
})

describe('summarizeWithRetryLadder', () => {
  it('returns the first good result without retries', async () => {
    let calls = 0
    const { text: out, attempts } = await summarizeWithRetryLadder(
      async () => { calls++; return 'good summary' },
      { conversationText: 'c', prompt: 'p', messages: [text('m0', 'user', 'x'), text('m1', 'user', 'summarize')], rebuild: (r) => ({ conversationText: r.map((m) => String(m.content)).join('\n'), prompt: 'p' }) },
      () => false,
    )
    expect(out).toBe('good summary')
    expect(attempts).toBe(1)
    expect(calls).toBe(1)
  })

  it('retries with a shorter-output instruction on output-length errors', async () => {
    const prompts: string[] = []
    const result = await summarizeWithRetryLadder(
      async (_c, prompt) => {
        prompts.push(prompt)
        if (prompts.length === 1) throw new Error('max_output_tokens reached')
        return 'shorter summary'
      },
      { conversationText: 'c', prompt: 'p', messages: [text('m0', 'user', 'x'), text('m1', 'user', 'summarize')], rebuild: (r) => ({ conversationText: r.map((m) => String(m.content)).join('\n'), prompt: 'p' }) },
      () => false,
    )
    expect(result.attempts).toBe(2)
    expect(prompts[1]).toContain('much shorter')
  })

  it('shrinks the input on input-length errors', async () => {
    const head = text('m0', 'user', 'anchor')
    const messages = [
      head,
      toolUse('m1'),
      toolResult('m2', 'm1'),
      text('m3', 'assistant', 'worked'),
      text('m4', 'user', 'summarize'),
    ]
    const inputs: string[] = []
    const result = await summarizeWithRetryLadder(
      async (conversationText) => {
        inputs.push(conversationText)
        if (inputs.length === 1) throw new Error('context_length_exceeded')
        return 'ok'
      },
      {
        conversationText: 'full',
        prompt: 'p',
        messages,
        rebuild: (r) => ({ conversationText: r.map((m) => m.id).join(','), prompt: 'p' }),
      },
      () => false,
    )
    expect(result.text).toBe('ok')
    expect(inputs[1]).not.toBe('full')
    expect(inputs[1]).toContain('m0')
    expect(inputs[1]).toContain('m4')
  })

  it('throws immediately on fatal errors', async () => {
    let calls = 0
    await expect(
      summarizeWithRetryLadder(
        async () => { calls++; throw new Error('invalid api key') },
        { conversationText: 'c', prompt: 'p', messages: [], rebuild: () => ({ conversationText: 'c', prompt: 'p' }) },
        () => false,
      ),
    ).rejects.toThrow('invalid api key')
    expect(calls).toBe(1)
  })

  it('gives up after MAX_SUMMARY_RETRIES attempts', async () => {
    let calls = 0
    await expect(
      summarizeWithRetryLadder(
        async () => { calls++; throw new Error('HTTP 503 overloaded') },
        { conversationText: 'c', prompt: 'p', messages: [], rebuild: () => ({ conversationText: 'c', prompt: 'p' }) },
        () => false,
      ),
    ).rejects.toThrow()
    expect(calls).toBe(MAX_SUMMARY_RETRIES)
  })

  it('returns empty text (not a throw) when every attempt is empty/degenerate', async () => {
    let calls = 0
    const { text, attempts } = await summarizeWithRetryLadder(
      async () => { calls++; return '' },
      { conversationText: 'c', prompt: 'p', messages: [], rebuild: () => ({ conversationText: 'c', prompt: 'p' }) },
      () => false,
    )
    expect(text).toBe('')
    expect(attempts).toBe(MAX_SUMMARY_RETRIES)
    expect(calls).toBe(MAX_SUMMARY_RETRIES)
  })
})

describe('constants', () => {
  it('matches grok parity values', () => {
    expect(MAX_SUMMARY_RETRIES).toBe(3)
    expect(TOOL_MESSAGE_DROP_THRESHOLD).toBe(0.25)
  })
})
