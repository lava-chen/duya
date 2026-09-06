/**
 * Tests for the bot dual-key epoch + frozen snapshot (Plan 474 §2.3/P1.2).
 *
 * Covers:
 * - computeBotContentHash: stability, sensitivity, roster order-insensitivity
 * - botSectionCacheKey: exact key shape
 * - countTimelineCompactions: the summaryEpoch (E1 analog)
 * - Frozen snapshot semantics through BotPromptAssembly.renderSections:
 *   same dual key → same string (compute runs once); summaryEpoch advance →
 *   forced re-render; content change → re-render.
 */

import { describe, it, expect } from 'vitest'
import {
  computeBotContentHash,
  botSectionCacheKey,
  countTimelineCompactions,
} from '../epoch'
import { BotPromptAssembly } from '../framework'
import type { BotPromptContext, BotSectionDef, BotRosterEntry } from '../framework'

describe('computeBotContentHash', () => {
  it('is stable for identical context content', () => {
    const ctx: BotPromptContext = {
      botAgentId: 'alpha',
      botName: 'Alpha',
      botDescription: 'test bot',
      agentDirectory: [{ id: 'beta', name: 'Beta' }],
    }
    expect(computeBotContentHash(ctx)).toBe(computeBotContentHash({ ...ctx }))
  })

  it('changes when the bot identity changes', () => {
    const base: BotPromptContext = { botAgentId: 'alpha', botName: 'Alpha' }
    const renamed: BotPromptContext = { botAgentId: 'alpha', botName: 'Alpha2' }
    const redescribed: BotPromptContext = {
      botAgentId: 'alpha',
      botName: 'Alpha',
      botDescription: 'new',
    }
    const h = computeBotContentHash(base)
    expect(computeBotContentHash(renamed)).not.toBe(h)
    expect(computeBotContentHash(redescribed)).not.toBe(h)
  })

  it('is insensitive to roster ordering', () => {
    const rosterA: BotRosterEntry[] = [
      { id: 'beta', name: 'Beta' },
      { id: 'gamma', name: 'Gamma' },
    ]
    const rosterB: BotRosterEntry[] = [
      { id: 'gamma', name: 'Gamma' },
      { id: 'beta', name: 'Beta' },
    ]
    expect(computeBotContentHash({ agentDirectory: rosterA })).toBe(
      computeBotContentHash({ agentDirectory: rosterB }),
    )
  })

  it('changes when a roster member changes', () => {
    const a: BotPromptContext = { agentDirectory: [{ id: 'beta', name: 'Beta' }] }
    const b: BotPromptContext = {
      agentDirectory: [{ id: 'beta', name: 'Beta', description: 'renamed role' }],
    }
    expect(computeBotContentHash(a)).not.toBe(computeBotContentHash(b))
  })

  it('is INSENSITIVE to volatile data slots (memory/channels/…) — Plan 501 L1', () => {
    // Volatile slots churn mid-epoch (the memory extractor writes every
    // turn); they key on summaryEpoch alone and must not invalidate the
    // content hash that stable sections freeze under.
    const a: BotPromptContext = { memory: { tier: 'recent', items: ['x'] } }
    const b: BotPromptContext = { memory: { tier: 'recent', items: ['x', 'y'] } }
    expect(computeBotContentHash(a)).toBe(computeBotContentHash(b))
    expect(
      computeBotContentHash({ channels: [{ platform: 'telegram', label: 't' } as never] }),
    ).toBe(computeBotContentHash({}))
  })

  it('treats undefined and absent fields alike', () => {
    expect(computeBotContentHash({})).toBe(computeBotContentHash({ botName: undefined }))
  })
})

describe('botSectionCacheKey', () => {
  it('follows the Plan 474 §2.3 key shape', () => {
    expect(botSectionCacheKey('alpha', 'abc123', 3, 'botIdentity')).toBe(
      'bot:alpha:abc123:3:botIdentity',
    )
  })
})

describe('countTimelineCompactions (summaryEpoch, E1 analog)', () => {
  it('returns 0 for an empty or compaction-free timeline', () => {
    expect(countTimelineCompactions([])).toBe(0)
    expect(countTimelineCompactions([{ type: 'message' }, { type: 'message' }])).toBe(0)
  })

  it('counts compaction entries', () => {
    expect(
      countTimelineCompactions([
        { type: 'message' },
        { type: 'compaction' },
        { type: 'message' },
        { type: 'compaction' },
      ]),
    ).toBe(2)
  })
})

describe('frozen snapshot (BotPromptAssembly + dual-key epoch)', () => {
  const KEY = { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0 }

  function countingSection(name: string, text: string): { def: BotSectionDef; calls: () => number } {
    let count = 0
    return {
      def: {
        name,
        compute: () => {
          count += 1
          return text
        },
      },
      calls: () => count,
    }
  }

  it('reuses the frozen render while both keys stay the same', async () => {
    const assembly = new BotPromptAssembly('')
    const { def, calls } = countingSection('s', 'FROZEN')
    assembly.register(def)

    const first = await assembly.renderSections({}, { snapshot: KEY })
    const second = await assembly.renderSections({}, { snapshot: KEY })

    expect(first).toBe('FROZEN')
    expect(second).toBe(first)
    expect(calls()).toBe(1)
  })

  it('re-renders when only summaryEpoch advances', async () => {
    const assembly = new BotPromptAssembly('')
    const { def, calls } = countingSection('s', 'FROZEN')
    assembly.register(def)

    await assembly.renderSections({}, { snapshot: KEY })
    const after = await assembly.renderSections({}, {
      snapshot: { ...KEY, summaryEpoch: 1 },
    })

    expect(after).toBe('FROZEN')
    expect(calls()).toBe(2)
  })

  it('re-renders when only the content hash changes', async () => {
    const assembly = new BotPromptAssembly('')
    const { def, calls } = countingSection('s', 'FROZEN')
    assembly.register(def)

    await assembly.renderSections({}, { snapshot: KEY })
    const after = await assembly.renderSections({}, {
      snapshot: { ...KEY, contentHash: 'h2' },
    })

    expect(after).toBe('FROZEN')
    expect(calls()).toBe(2)
  })

  it('caches a null (omitted) verdict so sections cannot pop in mid-epoch', async () => {
    const assembly = new BotPromptAssembly('')
    let count = 0
    assembly.register({
      name: 'maybe',
      compute: (ctx) => {
        count += 1
        return ctx.botName ? `named ${ctx.botName}` : null
      },
    })

    const key = { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0 }
    const empty = await assembly.renderSections({}, { snapshot: key })
    const stillEmpty = await assembly.renderSections({}, { snapshot: key })

    expect(empty).toBe('')
    expect(stillEmpty).toBe('')
    expect(count).toBe(1)
  })

  it('does not cache failing sections (they retry on the next render)', async () => {
    const assembly = new BotPromptAssembly('')
    let count = 0
    assembly.register({
      name: 'flaky',
      compute: () => {
        count += 1
        throw new Error('boom')
      },
    })

    const key = { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0 }
    await expect(assembly.renderSections({}, { snapshot: key })).resolves.toBe('')
    await expect(assembly.renderSections({}, { snapshot: key })).resolves.toBe('')
    expect(count).toBe(2)
  })

  it('freezes the post-budget render (truncation computed once)', async () => {
    const assembly = new BotPromptAssembly('')
    assembly.register({
      name: 'big',
      budgetChars: 5,
      compute: () => 'abcdefgh', // 8 code points → truncated to 5 + marker
    })

    const key = { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0 }
    const first = await assembly.renderSections({}, { snapshot: key })
    const second = await assembly.renderSections({}, { snapshot: key })

    expect(first).toBe('abcde\n…')
    expect(second).toBe(first)
  })

  it('recomputes on every render when no snapshot key is given', async () => {
    const assembly = new BotPromptAssembly('')
    const { def, calls } = countingSection('s', 'LIVE')
    assembly.register(def)

    await assembly.renderSections({})
    await assembly.renderSections({})
    expect(calls()).toBe(2)
  })

  it('clearSnapshotCache forces a re-render for the same key', async () => {
    const assembly = new BotPromptAssembly('')
    const { def, calls } = countingSection('s', 'FROZEN')
    assembly.register(def)

    await assembly.renderSections({}, { snapshot: KEY })
    assembly.clearSnapshotCache()
    await assembly.renderSections({}, { snapshot: KEY })

    expect(calls()).toBe(2)
  })

  it('keeps bots isolated: a different botId misses the cache', async () => {
    const assembly = new BotPromptAssembly('')
    const { def, calls } = countingSection('s', 'FROZEN')
    assembly.register(def)

    await assembly.renderSections({}, { snapshot: KEY })
    await assembly.renderSections({}, { snapshot: { ...KEY, botId: 'beta' } })

    expect(calls()).toBe(2)
  })

  describe('volatile sections (Plan 501 L1: epoch-only freeze)', () => {
    function countingVolatile(name: string, make: () => string): {
      def: BotSectionDef
      calls: () => number
      set: (text: string) => void
    } {
      let count = 0
      let text = make()
      return {
        def: {
          name,
          volatile: true,
          compute: () => {
            count += 1
            return text
          },
        },
        calls: () => count,
        set: (t: string) => {
          text = t
        },
      }
    }

    it('freezes per epoch: mid-epoch data churn does NOT re-render', async () => {
      const assembly = new BotPromptAssembly('')
      const { def, calls, set } = countingVolatile('memoryOwn', () => 'SNAP A')
      assembly.register(def)

      const first = await assembly.renderSections({}, { snapshot: KEY })
      expect(first).toBe('SNAP A')

      // The memory store changed underneath — the frozen render stands.
      set('SNAP B')
      const second = await assembly.renderSections({}, { snapshot: KEY })
      expect(second).toBe('SNAP A')
      expect(calls()).toBe(1)
    })

    it('re-renders when the compaction epoch advances', async () => {
      const assembly = new BotPromptAssembly('')
      const { def, calls, set } = countingVolatile('memoryOwn', () => 'SNAP A')
      assembly.register(def)

      await assembly.renderSections({}, { snapshot: KEY })
      set('SNAP B')
      const after = await assembly.renderSections({}, {
        snapshot: { ...KEY, summaryEpoch: 1 },
      })

      expect(after).toBe('SNAP B')
      expect(calls()).toBe(2)
    })

    it('identity change mid-epoch re-renders stable sections but keeps volatile frozen', async () => {
      const assembly = new BotPromptAssembly('')
      let stableCalls = 0
      let stableText = 'IDENT-1'
      assembly.register({
        name: 'botIdentity',
        compute: () => {
          stableCalls += 1
          return stableText
        },
      })
      const volatile = countingVolatile('memoryOwn', () => 'M1')
      assembly.register(volatile.def)

      await assembly.renderSections({}, { snapshot: KEY })

      // Identity changed (new content hash), epoch unchanged: the stable
      // section re-renders, the volatile one stays frozen per epoch.
      stableText = 'IDENT-2'
      const out = await assembly.renderSections({}, {
        snapshot: { ...KEY, contentHash: 'h2' },
      })

      expect(stableCalls).toBe(2)
      expect(volatile.calls()).toBe(1)
      expect(out).toContain('IDENT-2')
      expect(out).toContain('M1')
    })
  })
})
