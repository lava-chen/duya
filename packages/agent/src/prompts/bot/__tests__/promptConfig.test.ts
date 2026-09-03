/**
 * Tests for Plan 474 P3.2 — `[agents.<id>.prompt]` structured config:
 * section enable/disable mapping, voice rendering, content-hash coverage,
 * and the loader mapping (sanitize + identity precedence).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeBotContentHash } from '../epoch'
import { BotPromptAssembly } from '../framework'
import type { BotPromptContext, BotSectionDef } from '../framework'
import { renderBotIdentity } from '../identity'
import { loadBotPromptContext } from '../loader'

const mocks = vi.hoisted(() => ({
  agents: {} as Record<string, unknown>,
  profiles: {} as Record<string, { name?: string; description?: string } | undefined>,
}))

vi.mock('../../../agent-profile/config-agents.js', () => ({
  readConfigAgents: async () => mocks.agents,
}))

vi.mock('../../../agent-profile/bot-profile-reader.js', () => ({
  readBotProfileIdentity: async (id: string) => mocks.profiles[id],
}))

beforeEach(() => {
  mocks.agents = {}
  mocks.profiles = {}
})

describe('section enable/disable mapping (assembly)', () => {
  function assemblyWithTwoSections(): { assembly: BotPromptAssembly; calls: Map<string, number> } {
    const assembly = new BotPromptAssembly('')
    const calls = new Map<string, number>()
    const track = (def: BotSectionDef): BotSectionDef => ({
      ...def,
      compute: (ctx) => {
        calls.set(def.name, (calls.get(def.name) ?? 0) + 1)
        return def.compute(ctx)
      },
    })
    assembly.register(track({ name: 'a', compute: () => 'AAA' }))
    assembly.register(track({ name: 'b', compute: () => 'BBB' }))
    return { assembly, calls }
  }

  it('renders everything when no filter is configured', async () => {
    const { assembly } = assemblyWithTwoSections()
    const text = await assembly.renderSections({})
    expect(text).toBe('AAA\n\nBBB')
  })

  it('disable removes only the listed sections', async () => {
    const { assembly } = assemblyWithTwoSections()
    const text = await assembly.renderSections({
      promptConfig: { sections: { disable: ['a'] } },
    })
    expect(text).toBe('BBB')
  })

  it('a non-empty enable list is a whitelist', async () => {
    const { assembly } = assemblyWithTwoSections()
    const text = await assembly.renderSections({
      promptConfig: { sections: { enable: ['b'] } },
    })
    expect(text).toBe('BBB')
  })

  it('disable wins over enable', async () => {
    const { assembly } = assemblyWithTwoSections()
    const text = await assembly.renderSections({
      promptConfig: { sections: { enable: ['a', 'b'], disable: ['a'] } },
    })
    expect(text).toBe('BBB')
  })

  it('an empty enable list means no whitelist (all render)', async () => {
    const { assembly } = assemblyWithTwoSections()
    const text = await assembly.renderSections({
      promptConfig: { sections: { enable: [] } },
    })
    expect(text).toBe('AAA\n\nBBB')
  })

  it('unknown section names in the filter are ignored', async () => {
    const { assembly } = assemblyWithTwoSections()
    // 'ghost' matches no registered section (ignored); 'b' is not in the
    // whitelist so it is suppressed by design.
    const text = await assembly.renderSections({
      promptConfig: { sections: { enable: ['a', 'ghost'] } },
    })
    expect(text).toBe('AAA')
    // A disable entry matching nothing suppresses nothing.
    const text2 = await assembly.renderSections({
      promptConfig: { sections: { disable: ['phantom'] } },
    })
    expect(text2).toBe('AAA\n\nBBB')
  })

  it('toggling the filter invalidates the frozen snapshot (hash covers promptConfig)', async () => {
    const { assembly, calls } = assemblyWithTwoSections()
    const key = { botId: 'alpha', contentHash: '', summaryEpoch: 0 }

    const ctxA: BotPromptContext = { promptConfig: { sections: { disable: ['b'] } } }
    key.contentHash = computeBotContentHash(ctxA)
    const first = await assembly.renderSections(ctxA, { snapshot: key })
    expect(first).toBe('AAA')

    // Same filter again → frozen (no recompute).
    await assembly.renderSections(ctxA, { snapshot: key })
    expect(calls.get('a')).toBe(1)

    // Filter change → content hash changes → re-render, now with b visible.
    const ctxB: BotPromptContext = {}
    key.contentHash = computeBotContentHash(ctxB)
    const second = await assembly.renderSections(ctxB, { snapshot: key })
    expect(second).toBe('AAA\n\nBBB')
    expect(calls.get('a')).toBe(2)
    expect(calls.get('b')).toBe(1)
  })
})

describe('content hash covers prompt fields', () => {
  it('changes when promptConfig changes', () => {
    const a: BotPromptContext = { promptConfig: { sections: { disable: ['a'] } } }
    const b: BotPromptContext = { promptConfig: { sections: { disable: ['b'] } } }
    expect(computeBotContentHash(a)).not.toBe(computeBotContentHash(b))
  })

  it('changes when voice changes', () => {
    expect(computeBotContentHash({ voice: 'calm' })).not.toBe(
      computeBotContentHash({ voice: 'terse' }),
    )
  })
})

describe('voice rendering (botIdentity)', () => {
  it('renders a voice line when configured', () => {
    const text = renderBotIdentity({ botAgentId: 'alpha', botName: 'Alpha', voice: 'calm and precise' })
    expect(text).toContain('Your voice: calm and precise.')
  })

  it('omits the voice line when unset', () => {
    const text = renderBotIdentity({ botAgentId: 'alpha', botName: 'Alpha' })
    expect(text).not.toContain('voice')
  })
})

describe('loader mapping ([agents.<id>.prompt])', () => {
  it('passes sections filter and promotes voice', async () => {
    mocks.agents['alpha'] = {
      name: 'Alpha',
      prompt: {
        sections: { disable: ['botMemory'], enable: [] },
        identity: { voice: 'calm' },
      },
    }
    const ctx = await loadBotPromptContext('alpha')
    expect(ctx.promptConfig?.sections).toEqual({ disable: ['botMemory'], enable: [] })
    expect(ctx.voice).toBe('calm')
  })

  it('prompt.identity overrides the config fallback but not the runtime profile', async () => {
    mocks.agents['alpha'] = {
      name: 'RegistryName',
      description: 'registry description',
      prompt: { identity: { name: 'PromptName', description: 'prompt description' } },
    }
    const declared = await loadBotPromptContext('alpha')
    expect(declared.botName).toBe('PromptName')
    expect(declared.botDescription).toBe('prompt description')

    mocks.profiles['alpha'] = { name: 'RuntimeName', description: 'runtime description' }
    const runtime = await loadBotPromptContext('alpha')
    expect(runtime.botName).toBe('RuntimeName')
    expect(runtime.botDescription).toBe('runtime description')
  })

  it('drops wrong-typed or empty prompt config', async () => {
    mocks.agents['alpha'] = {
      name: 'Alpha',
      prompt: {
        sections: { disable: 'not-an-array', enable: [42, 'ok'] },
        identity: { name: 7, voice: '   ' },
      },
    }
    const ctx = await loadBotPromptContext('alpha')
    // enable keeps only the string entries; disable is dropped entirely.
    expect(ctx.promptConfig).toEqual({ sections: { enable: ['ok'] } })
    expect(ctx.voice).toBeUndefined()
  })

  it('omits promptConfig entirely when the toml table is absent', async () => {
    mocks.agents['alpha'] = { name: 'Alpha' }
    const ctx = await loadBotPromptContext('alpha')
    expect(ctx.promptConfig).toBeUndefined()
  })
})
