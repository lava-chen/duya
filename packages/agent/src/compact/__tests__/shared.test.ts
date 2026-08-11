import { describe, it, expect } from 'vitest'
import type { Message, MessageContent } from '../../types.js'
import { findLastUserIndex, buildToolNameByUseId, contentToStr } from '../transforms/shared.js'

describe('shared guards', () => {
  it('findLastUserIndex returns the last user-role index', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    expect(findLastUserIndex(messages)).toBe(2)
  })

  it('findLastUserIndex returns -1 when there is no user message', () => {
    expect(findLastUserIndex([{ role: 'assistant', content: 'b' }])).toBe(-1)
  })

  it('buildToolNameByUseId maps ids to names from assistant tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'grep', input: {} },
          { type: 'tool_use', id: 't2', name: 'bash', input: {} },
        ],
      },
    ]
    const map = buildToolNameByUseId(messages)
    expect(map.get('t1')).toBe('grep')
    expect(map.get('t2')).toBe('bash')
  })

  it('contentToStr flattens array content to a string', () => {
    const blocks: MessageContent[] = [{ type: 'text', text: 'hello' }]
    expect(contentToStr('plain')).toBe('plain')
    expect(contentToStr(blocks)).toBe(JSON.stringify(blocks))
  })
})