import { describe, it, expect } from 'vitest'
import type { Message } from '../../types.js'
import { compressProjectedToolMessages, type ProjectionTransform } from '../projectionCompress.js'

const identity: ProjectionTransform = {
  name: 'identity',
  apply: (messages) => messages,
}

describe('projectionCompress', () => {
  it('returns the same reference when the transform list is empty', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    expect(compressProjectedToolMessages(messages, [])).toBe(messages)
  })

  it('returns the same reference when no transform changes anything', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    expect(compressProjectedToolMessages(messages, [identity])).toBe(messages)
  })

  it('folds transforms in order', () => {
    const calls: string[] = []
    const a: ProjectionTransform = {
      name: 'a',
      apply: (m) => { calls.push('a'); return m },
    }
    const b: ProjectionTransform = {
      name: 'b',
      apply: (m) => { calls.push('b'); return m },
    }
    compressProjectedToolMessages([{ role: 'user', content: 'x' }], [a, b])
    expect(calls).toEqual(['a', 'b'])
  })
})