import { describe, it, expect } from 'vitest'
import { BotPromptAssembly, fitToBudget } from '../framework'
import { BOT_BASIC_SYSTEM_PROMPT } from '../basicPrompt'
import { createBotPromptAssembly } from '../factory'
import { BOT_IDENTITY_SECTION } from '../catalog'
import { BOT_MEMORY_USAGE_SECTION } from '../memory/sections'
import { isBotAgentProfile } from '../loader'
import type { AgentProfile } from '../../../agent-profile/types'
import type { BotPromptContext } from '../framework'

const emptyCtx: BotPromptContext = {}

describe('fitToBudget (SectionBudget pure helper)', () => {
  it('returns text unchanged when within budget', () => {
    const res = fitToBudget('hello', 100)
    expect(res.text).toBe('hello')
    expect(res.truncated).toBe(false)
  })

  it('truncates by code points, keeping CJK whole', () => {
    const res = fitToBudget('abc中文', 4)
    expect(res.text).toBe('abc中')
    expect(res.truncated).toBe(true)
  })

  it('counts CJK as single code points (not UTF-16 halves)', () => {
    const res = fitToBudget('中文', 1)
    expect(res.text).toBe('中')
  })

  it('handles surrogate pairs (emoji) without splitting', () => {
    const res = fitToBudget('a😀b', 2)
    expect(res.text).toBe('a😀')
  })
})

describe('BotPromptAssembly', () => {
  it('emits the basic prompt plus the static memory guidance when only placeholders are registered', async () => {
    const assembly = createBotPromptAssembly()
    const out = await assembly.render(emptyCtx)
    // memoryUsage is deliberately static (always renders); every other
    // catalog entry stays a placeholder that omits on an empty ctx.
    expect(out).toBe(`${BOT_BASIC_SYSTEM_PROMPT}\n\n${BOT_MEMORY_USAGE_SECTION.compute!(emptyCtx)}`)
    // All catalog placeholders must be listed so future wiring is discoverable.
    expect(assembly.listSections()).toContain('botIdentity')
    expect(assembly.listSections()).toContain('botRoster')
    expect(assembly.listSections()).toContain('botChannels')
  })

  it('renders a registered section after the basic prompt', async () => {
    const assembly = createBotPromptAssembly()
    assembly.register({
      ...BOT_IDENTITY_SECTION,
      compute: (ctx) => `## Bot\n\nYou are ${ctx.botName ?? 'unnamed'}.`,
    })
    const out = await assembly.render({ botName: 'Alpha' })
    expect(out).toContain(BOT_BASIC_SYSTEM_PROMPT)
    expect(out).toContain('## Bot\n\nYou are Alpha.')
    // Order: basic first, section after.
    expect(out.indexOf(BOT_BASIC_SYSTEM_PROMPT)).toBeLessThan(out.indexOf('You are Alpha.'))
  })

  it('renderSections omits the basic prompt (tail-append mode)', async () => {
    const assembly = new BotPromptAssembly()
    assembly.register({ name: 'a', compute: () => 'AAA' })
    assembly.register({ name: 'b', compute: () => null })
    const out = await assembly.renderSections(emptyCtx)
    expect(out).toBe('AAA')
    expect(out).not.toContain(BOT_BASIC_SYSTEM_PROMPT)
  })

  it('renderSections degrades to the static memory guidance when all data sections are null', async () => {
    const assembly = createBotPromptAssembly()
    // Catalog placeholders (identity needs ctx data, roster needs directory) →
    // only memoryUsage renders — the one section that must never be absent,
    // so a fresh bot still learns its memory tiers exist.
    const out = await assembly.renderSections(emptyCtx)
    expect(out).toBe(BOT_MEMORY_USAGE_SECTION.compute!(emptyCtx))
  })

  it('omits sections that return null and keeps the rest', async () => {
    const assembly = new BotPromptAssembly()
    assembly.register({ name: 'a', compute: () => null })
    assembly.register({ name: 'b', compute: () => 'BBB' })
    assembly.register({ name: 'c', compute: () => null })
    const out = await assembly.render(emptyCtx)
    expect(out).toBe(`${BOT_BASIC_SYSTEM_PROMPT}\n\nBBB`)
  })

  it('applies per-section budget truncation', async () => {
    const assembly = new BotPromptAssembly()
    assembly.register({ name: 'big', budgetChars: 5, compute: () => '1234567890' })
    const out = await assembly.render(emptyCtx)
    expect(out).toContain('12345')
    expect(out).not.toContain('123456')
  })

  it('isolates a failing section without breaking the prompt', async () => {
    const assembly = new BotPromptAssembly()
    assembly.register({ name: 'boom', compute: () => { throw new Error('x') } })
    assembly.register({ name: 'ok', compute: () => 'OK' })
    const out = await assembly.render(emptyCtx)
    expect(out).toBe(`${BOT_BASIC_SYSTEM_PROMPT}\n\nOK`)
  })

  it('supports unregister and replace keeping original slot order', async () => {
    const assembly = new BotPromptAssembly()
    assembly.register({ name: 'first', compute: () => '1' })
    assembly.register({ name: 'second', compute: () => '2' })
    assembly.unregister('first')
    expect(assembly.listSections()).toEqual(['second'])

    // Replace keeps position even when unregistered slot was removed first.
    assembly.register({ name: 'first', compute: () => '1' })
    assembly.register({ name: 'first', compute: () => '1b' })
    const out = await assembly.render(emptyCtx)
    expect(out).toContain('1b')
  })
})

describe('isBotAgentProfile', () => {
  const base = (over: Partial<AgentProfile>): AgentProfile => ({
    id: 'x',
    name: 'X',
    userVisible: true,
    isPreset: false,
    isEnabled: true,
    kind: 'main',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  })

  it('true for a config-driven main agent (non-preset)', () => {
    expect(isBotAgentProfile(base({}))).toBe(true)
  })

  it('false for built-in presets', () => {
    expect(isBotAgentProfile(base({ isPreset: true, id: 'general' }))).toBe(false)
    expect(isBotAgentProfile(base({ isPreset: true, kind: 'main' }))).toBe(false)
  })

  it('false for subagent/special profiles', () => {
    expect(isBotAgentProfile(base({ kind: 'subagent' }))).toBe(false)
    expect(isBotAgentProfile(base({ kind: 'special' }))).toBe(false)
  })

  it('false when no profile is supplied', () => {
    expect(isBotAgentProfile(undefined)).toBe(false)
  })
})
