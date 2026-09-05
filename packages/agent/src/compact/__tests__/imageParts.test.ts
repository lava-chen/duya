import { describe, it, expect } from 'vitest'
import type { Message } from '../../types.js'
import { IMAGE_COMPACTION_TRIGGER_COUNT, countImagePartsInMessages } from '../imageParts.js'

function withImages(id: string, role: 'user' | 'assistant', imageCount: number): Message {
  return {
    id,
    role,
    content: [
      ...(imageCount > 0
        ? Array.from({ length: imageCount }, () => ({ type: 'image' as const, source: {} as never }))
        : []),
      { type: 'text' as const, text: 'see attached' },
    ],
    timestamp: 1,
  }
}

describe('countImagePartsInMessages', () => {
  it('counts image blocks across roles and ignores string content', () => {
    const messages: Message[] = [
      withImages('a', 'user', 2),
      { id: 'b', role: 'assistant', content: 'plain text', timestamp: 1 },
      withImages('c', 'assistant', 1),
      withImages('d', 'user', 0),
    ]
    expect(countImagePartsInMessages(messages)).toBe(3)
  })

  it('returns zero for empty input', () => {
    expect(countImagePartsInMessages([])).toBe(0)
  })

  it('uses the grok-parity threshold constant', () => {
    expect(IMAGE_COMPACTION_TRIGGER_COUNT).toBe(85)
  })
})
