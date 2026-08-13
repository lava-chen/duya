import { describe, it, expect } from 'vitest'
import type { Message } from '../../types.js'
import {
  sanitizeCompactedHistory,
  validateCompactedHistory,
  fitCompactedToBudget,
} from '../historySanitize.js'

function toolUse(id: string): Message {
  return {
    id: `a-${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'echo', input: {} }],
    timestamp: 1,
  }
}

function toolResult(toolUseId: string): Message {
  return {
    id: `t-${toolUseId}`,
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: false }],
    timestamp: 1,
  }
}

function text(role: 'user' | 'assistant', content: string): Message {
  return { id: `${role}-${content}`, role, content, timestamp: 1 }
}

describe('sanitizeCompactedHistory', () => {
  it('keeps a balanced tool round-trip untouched', () => {
    const input = [toolUse('1'), toolResult('1')]
    expect(sanitizeCompactedHistory(input)).toEqual(input)
  })

  it('strips a tool_result whose tool_use is missing', () => {
    const orphan = toolResult('missing')
    const result = sanitizeCompactedHistory([toolUse('1'), toolResult('1'), orphan])
    expect(result).toHaveLength(2)
    expect(result.map((m) => m.id)).not.toContain(orphan.id)
  })

  it('drops a whole message that contains only orphaned results', () => {
    const orphanOnly = {
      id: 'orphan-only',
      role: 'tool' as const,
      content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'x', is_error: false }],
      timestamp: 1,
    }
    const result = sanitizeCompactedHistory([text('user', 'hi'), orphanOnly])
    expect(result).toHaveLength(1)
  })

  it('does not treat an earlier tool_use as making a later result orphaned', () => {
    const input = [toolUse('1'), toolResult('1')]
    const result = sanitizeCompactedHistory(input)
    expect(result).toHaveLength(2)
  })
})

describe('validateCompactedHistory', () => {
  it('reports no orphans for a valid history', () => {
    expect(validateCompactedHistory([toolUse('1'), toolResult('1')])).toEqual([])
  })

  it('reports an orphaned result id', () => {
    expect(validateCompactedHistory([toolResult('missing')])).toEqual(['missing'])
  })
})

describe('fitCompactedToBudget', () => {
  it('returns the input unchanged when within budget', () => {
    const input = [text('user', 'hi'), text('assistant', 'hello')]
    expect(fitCompactedToBudget(input, 1_000_000)).toEqual(input)
  })

  it('never throws and returns a subset when over budget', () => {
    const input = [text('user', 'a'), text('assistant', 'b'), text('user', 'c')]
    const result = fitCompactedToBudget(input, 1)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThanOrEqual(input.length)
  })
})