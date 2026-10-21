import { describe, it, expect } from 'vitest'
import type { Message } from '../../types.js'
import { offloadPlaceholder, offloadTransform, OFFLOAD_THRESHOLD } from '../transforms/offloadCompress.js'

describe('offloadCompress', () => {
  it('replaces an oversized historical bash output with a placeholder', () => {
    const long = 'x'.repeat(OFFLOAD_THRESHOLD + 1)
    const messages: Message[] = [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', content: long, tool_call_id: 't1' },
      { role: 'user', content: 'ok done' },
    ]
    const out = offloadTransform.apply(messages)
    expect(out[2].content).toBe(offloadPlaceholder('bash'))
    expect(out[2].role).toBe('tool')
    expect(out[2].tool_call_id).toBe('t1')
  })

  it('leaves short bodies alone', () => {
    const messages: Message[] = [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', content: 'ok', tool_call_id: 't1' },
      { role: 'user', content: 'done' },
    ]
    const out = offloadTransform.apply(messages)
    expect(out[2].content).toBe('ok')
  })

  it('leaves the last user turn intact', () => {
    const long = 'x'.repeat(OFFLOAD_THRESHOLD + 1)
    const messages: Message[] = [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'tool', content: long, tool_call_id: 't1' },
      { role: 'user', content: 'now summarize the file' },
    ]
    const out = offloadTransform.apply(messages)
    expect(out[2].content).toBe(offloadPlaceholder('read'))
    expect(out[3].content).toBe('now summarize the file')
  })
})