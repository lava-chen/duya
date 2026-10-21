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

/**
 * Creates a standalone role: 'tool' message (OpenAI format).
 * This is different from toolResult() which creates a message with a content array
 * containing a tool_result block.
 */
function toolRoleMessage(toolCallId: string, content: string): Message {
  return {
    id: `trm-${toolCallId}`,
    role: 'tool',
    tool_call_id: toolCallId,
    content,
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

  it('keeps a balanced tool round-trip with role: tool messages (OpenAI format)', () => {
    const assistantWithToolUse = {
      id: 'a-1',
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      timestamp: 1,
    }
    const toolMsg = toolRoleMessage('call_1', 'result content')
    const input = [assistantWithToolUse, toolMsg]
    expect(sanitizeCompactedHistory(input)).toEqual(input)
  })

  it('strips orphaned role: tool messages (OpenAI format) when tool_use is missing', () => {
    const assistantWithToolUse = {
      id: 'a-1',
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      timestamp: 1,
    }
    const orphanToolMsg = toolRoleMessage('call_missing', 'result content')
    const result = sanitizeCompactedHistory([assistantWithToolUse, orphanToolMsg])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a-1')
  })

  it('keeps role: tool messages with no tool_call_id (let API validate)', () => {
    const msgWithoutId = {
      id: 'trm-no-id',
      role: 'tool' as const,
      content: 'some result',
      timestamp: 1,
    }
    const result = sanitizeCompactedHistory([text('user', 'hi'), msgWithoutId])
    expect(result).toHaveLength(2)
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

  it('reports orphaned role: tool messages (OpenAI format)', () => {
    const assistantWithToolUse = {
      id: 'a-1',
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      timestamp: 1,
    }
    const orphanToolMsg = toolRoleMessage('call_missing', 'result content')
    expect(validateCompactedHistory([assistantWithToolUse, orphanToolMsg])).toEqual(['call_missing'])
  })

  it('reports no orphans for valid role: tool messages (OpenAI format)', () => {
    const assistantWithToolUse = {
      id: 'a-1',
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      timestamp: 1,
    }
    const toolMsg = toolRoleMessage('call_1', 'result content')
    expect(validateCompactedHistory([assistantWithToolUse, toolMsg])).toEqual([])
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