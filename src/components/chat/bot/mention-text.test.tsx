/**
 * Tests for the mention-chip text renderer (grok sand-mention parity).
 */

import { describe, it, expect } from 'vitest'
import { renderTextWithMentions } from './mention-text'
import { isValidElement } from 'react'

const NAMES = ['Ops Bot', 'Alpha', '小助手']

function expectChip(node: unknown, label: string) {
  expect(isValidElement(node)).toBe(true)
  const el = node as { props: { className?: string; children?: unknown } }
  expect(el.props.className).toBe('bot-mention')
  expect(el.props.children).toBe(label)
}

describe('renderTextWithMentions', () => {
  it('returns plain text when no names or no mentions', () => {
    expect(renderTextWithMentions('hello', NAMES)).toBe('hello')
    expect(renderTextWithMentions('@nobody here', NAMES)).toBe('@nobody here')
    expect(renderTextWithMentions('just text', [])).toBe('just text')
  })

  it('wraps a word-bounded @Name in a chip with the canonical name', () => {
    const parts = renderTextWithMentions('ask @ops bot to check', NAMES)
    expect(parts).not.toBe('ask @ops bot to check')
    const list = Array.isArray(parts) ? parts : [parts]
    expect(list).toHaveLength(3)
    expect(list[0]).toBe('ask ')
    expectChip(list[1], '@Ops Bot')
    expect(list[2]).toBe(' to check')
  })

  it('prefers the longest matching name at the same offset', () => {
    const parts = renderTextWithMentions('@ops', ['Ops', 'Ops Bot'])
    const list = Array.isArray(parts) ? parts : [parts]
    expect(list).toHaveLength(1)
    expectChip(list[0], '@Ops Bot')
  })

  it('does not match inside longer ASCII words', () => {
    expect(renderTextWithMentions('x@alpha and @alphas', NAMES)).toBe(
      'x@alpha and @alphas',
    )
  })

  it('matches CJK names', () => {
    const parts = renderTextWithMentions('让@小助手 看一下', NAMES)
    const list = Array.isArray(parts) ? parts : [parts]
    expect(list).toHaveLength(3)
    expectChip(list[1], '@小助手')
  })
})
