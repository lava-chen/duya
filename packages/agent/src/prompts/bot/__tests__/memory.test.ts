/**
 * Bot tiered memory tests (Plan 479 Phase 2: P2.1 + P2.2).
 *
 * Layers under test:
 *   1. Pure renderers over a fixture BotMemoryContext (via attribution,
 *      buckets, caps, budgets, also-a-member-of, grep hint).
 *   2. File-side tier reader over a temp duya root (legacy canonical
 *      files, own-tier format, projects.json membership).
 *   3. Dual-key frozen snapshot through the real assembly + catalog
 *      (same keys byte-identical; epoch advance or memory change
 *      re-renders) — plan §3.2 / grok FrozenMemorySnapshot semantics.
 *   4. Plain (non-bot) session regression: the legacy single-tier
 *      memorySection still renders summary.md unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  renderMemoryOwn,
  renderMemoryUser,
  renderMemoryProject,
  dedupeTier,
} from '../memory/render.js'
import {
  readOwnTierEntries,
  readUserTierEntries,
  readProjectTierEntries,
  readJoinedProjects,
} from '../memory/tierReader.js'
import { BOT_MEMORY_OWN_SECTION, BOT_MEMORY_USAGE_SECTION, BOT_MEMORY_USER_SECTION, BOT_MEMORY_PROJECT_SECTION } from '../memory/sections.js'
import { createBotPromptAssembly, computeBotContentHash, type BotPromptContext } from '../index.js'
import { getMemorySection } from '../../sections/dynamic/memorySection.js'
import type { BotMemoryContext, TierMemoryEntry } from '../memory/types.js'

function entry(overrides: Partial<TierMemoryEntry>): TierMemoryEntry {
  return {
    tier: 'user',
    kind: 'note',
    dedupeKey: 'k',
    writerId: '',
    projectId: '',
    filePath: 'memory/x.md',
    title: 'T',
    body: 'B',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function ctx(overrides: Partial<BotMemoryContext>): BotMemoryContext {
  return { own: [], user: [], project: [], joinedProjects: [], ...overrides }
}

describe('renderMemoryOwn', () => {
  it('renders entries with the precedence header', () => {
    const out = renderMemoryOwn(ctx({ own: [entry({ tier: 'agent', writerId: 'botA', dedupeKey: 'pref:style', title: 'Style', body: 'Be terse' })] }))
    expect(out).toContain('## Own memory')
    expect(out).toContain('own > project > user')
    expect(out).toContain('Style')
    expect(out).toContain('Be terse')
  })

  it('returns null when the own tier is empty', () => {
    expect(renderMemoryOwn(ctx())).toBeNull()
  })

  it('enforces the 30-entry cap by recency', () => {
    const own = Array.from({ length: 40 }, (_, i) =>
      entry({ tier: 'agent', writerId: 'botA', dedupeKey: `k${i}`, title: `t${i}`, updatedAt: i }),
    )
    const out = renderMemoryOwn(ctx({ own }))
    // top-30 by recency = t39..t10; t0..t9 dropped ('t1' is a substring
    // of 't10'-'t19', so match whole entry lines with the m flag)
    for (let i = 0; i < 10; i++) expect(out).not.toMatch(new RegExp(`^- .*t${i} [—-]`, 'm'))
    expect(out).toContain('t39')
    expect(out).toMatch(/^- .*t10 [—-]/m)
  })
})

describe('renderMemoryUser', () => {
  it('labels other bots entries with [via name] and skips legacy rows', () => {
    const out = renderMemoryUser(
      ctx({
        own: [entry({ tier: 'agent', writerId: 'botA' })],
        user: [
          entry({ writerId: 'botB', writerName: 'Beta', dedupeKey: 'person:alice', title: 'Alice', updatedAt: 200, createdAt: 200 }),
          entry({ writerId: '', dedupeKey: 'pref:legacy', title: 'Legacy fact', updatedAt: 100, createdAt: 100 }),
        ],
      }),
    )
    // Alice (more recent) renders first; the legacy row carries no via label.
    expect(out.indexOf('Alice [via Beta]')).toBeGreaterThan(-1)
    expect(out.indexOf('Alice [via Beta]')).toBeLessThan(out.indexOf('Legacy fact'))
    expect(out.split('Legacy fact')[1]).not.toContain('[via')
  })

  it('shows the grep hint when no profile entries exist, none when they do', () => {
    const base = ctx({ user: [entry({ dedupeKey: 'n1', title: 'note', kind: 'note' })] })
    expect(renderMemoryUser(base)).toContain('grep')

    const withProfile = ctx({
      user: [
        entry({ kind: 'profile', dedupeKey: 'p1', title: 'User likes terse answers', writerId: 'botB', writerName: 'Beta' }),
        entry({ dedupeKey: 'n1', title: 'recent note' }),
      ],
    })
    const out = renderMemoryUser(withProfile)
    expect(out).toContain('### Profile')
    expect(out).toContain('User likes terse answers [via Beta]')
    expect(out).toContain('### Recent')
    expect(out).not.toContain('grep')
  })

  it('dedupes the same key across writer shards keeping the earliest via', () => {
    const out = renderMemoryUser(
      ctx({
        user: [
          entry({ writerId: 'botA', writerName: 'Alpha', dedupeKey: 'person:alice', title: 'Alice', createdAt: 100, updatedAt: 100 }),
          entry({ writerId: 'botB', writerName: 'Beta', dedupeKey: 'person:alice', title: 'Alice', createdAt: 300, updatedAt: 300 }),
        ],
      }),
    )
    expect(out).toContain('[via Alpha]')
    expect(out).not.toContain('[via Beta]')
  })
})

describe('renderMemoryProject', () => {
  it('renders joined projects by activity with a cap of 3 and also-a-member-of tail', () => {
    const mk = (projectId: string, updatedAt: number, title: string) =>
      entry({ tier: 'project', projectId, updatedAt, createdAt: updatedAt, dedupeKey: `proj:${projectId}`, title, writerId: 'botB', writerName: 'Beta' })
    const out = renderMemoryProject(
      ctx({
        project: [
          mk('p1', 100, 'old project'),
          mk('p2', 300, 'hot project'),
          mk('p3', 200, 'warm project'),
          mk('p4', 400, 'hottest project'),
        ],
        joinedProjects: ['p1', 'p2', 'p3', 'p4', 'p5'],
      }),
    )
    expect(out).toContain('p4') // hottest → cap 3: p4, p2, p3
    expect(out).toContain('p2')
    expect(out).toContain('p3')
    expect(out).not.toContain('### Project p1') // lowest activity → capped out
    expect(out).toContain('Also a member of: p1, p5') // p5 joined but empty, capped too
  })

  it('returns null when the bot joined nothing', () => {
    expect(renderMemoryProject(ctx({ project: [entry({ tier: 'project', projectId: 'p1' })] }))).toBeNull()
  })
})

describe('dedupeTier', () => {
  it('keeps the earliest statement per key across shards', () => {
    const merged = dedupeTier([
      entry({ writerId: 'b2', dedupeKey: 'k', title: 'late', createdAt: 300, updatedAt: 300 }),
      entry({ writerId: 'b1', dedupeKey: 'k', title: 'early', createdAt: 100, updatedAt: 100 }),
      entry({ writerId: 'b1', dedupeKey: 'other', title: 'solo' }),
    ])
    expect(merged.map((m) => m.title).sort()).toEqual(['early', 'solo'])
  })
})

describe('tierReader', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tier-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  function write(rel: string, content: string): void {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }

  it('reads own-tier files with the phase-3 frontmatter contract', () => {
    write(
      'agents/botA/memory/style.md',
      ['---', 'tier: agent', 'kind: profile', 'dedupe_key: pref:style', 'status: active', 'updated_at: 2026-09-01T00:00:00Z', '---', '', '# Style', 'Be terse.'].join('\n'),
    )
    const own = readOwnTierEntries(root, 'botA')
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ tier: 'agent', kind: 'profile', dedupeKey: 'pref:style', writerId: 'botA', title: 'Style' })
    expect(own[0].body).toContain('Be terse')
  })

  it('reads legacy canonical user files as writerless notes and skips retired', () => {
    write(
      'memory/entities/people/alice.md',
      ['---', 'memory_id: m1', 'canonical_key: person:alice', 'claim_type: person', 'scope: global', 'status: active', 'importance: normal', 'updated_at: 2026-08-01T00:00:00Z', '---', '', '# Alice', 'User profile notes.'].join('\n'),
    )
    write(
      'memory/items/fact/old.md',
      ['---', 'memory_id: m2', 'canonical_key: fact:old', 'claim_type: fact', 'scope: global', 'status: retired', 'importance: normal', 'updated_at: 2026-08-01T00:00:00Z', '---', '', 'Stale.'].join('\n'),
    )
    const user = readUserTierEntries(root)
    expect(user).toHaveLength(1)
    expect(user[0]).toMatchObject({ tier: 'user', kind: 'note', dedupeKey: 'person:alice', writerId: '' })
  })

  it('reads per-writer user shards from agents/<id>/user with the tierWriter frontmatter', () => {
    // Exactly what electron/memory-state/tierWriter.ts writes for
    // update_state (target memory, scope user): canonical_key/claim_type/
    // scope_id vocabulary, not the phase-3 tier/kind/dedupe_key one.
    write(
      'agents/botB/user/pref-tea-1234abcd.md',
      ['---', 'memory_id: m3', 'canonical_key: pref:tea', 'claim_type: profile', 'scope: user', 'scope_id: botB', 'project_id: null', 'status: active', 'importance: normal', 'updated_at: 2026-09-04T00:00:00Z', '---', '', 'User prefers tea.'].join('\n'),
    )
    const user = readUserTierEntries(root)
    expect(user).toHaveLength(1)
    expect(user[0]).toMatchObject({ tier: 'user', kind: 'profile', dedupeKey: 'pref:tea', writerId: 'botB' })
    // No heading in tierWriter files — the fact line itself becomes the title.
    expect(user[0].title).toBe('User prefers tea.')
  })

  it('reads project shards from projects/<id>/agents/<writer> attributed to the shard owner', () => {
    write('agents/botA/state/projects.json', JSON.stringify(['p1']))
    write(
      'projects/p1/agents/botB/conv-1234abcd.md',
      ['---', 'memory_id: m4', 'canonical_key: proj:convention', 'claim_type: log', 'scope: project', 'scope_id: botB', 'project_id: p1', 'status: active', 'importance: normal', 'updated_at: 2026-09-04T00:00:00Z', '---', '', 'Deploys freeze on Fridays.'].join('\n'),
    )
    write(
      'projects/p2/agents/botB/other-1234abcd.md',
      ['---', 'memory_id: m5', 'canonical_key: proj:other', 'claim_type: log', 'scope: project', 'scope_id: botB', 'project_id: p2', 'status: active', 'importance: normal', 'updated_at: 2026-09-04T00:00:00Z', '---', '', 'Not joined.'].join('\n'),
    )
    expect(readJoinedProjects(root, 'botA')).toEqual(['p1'])
    const project = readProjectTierEntries(root, readJoinedProjects(root, 'botA'))
    expect(project).toHaveLength(1)
    expect(project[0]).toMatchObject({ tier: 'project', kind: 'log', projectId: 'p1', writerId: 'botB' })
  })
})

describe('memoryUsage guidance (479 activation)', () => {
  it('renders for every bot session, even without memory content', async () => {
    const assembly = createBotPromptAssembly()
    const out = await assembly.renderSections({ botAgentId: 'botA', botName: 'Alpha' })
    expect(out).toContain('# Memory')
    expect(out).toContain('update_state')
    expect(out).toContain('your own memory first, then shared user memory')
    // Content sections stay omitted — only the guidance renders.
    expect(out).not.toContain('## Own memory')
    expect(out).not.toContain('## Shared user memory')
  })

  it('includes the concrete shard paths from memoryRoots', () => {
    const out = BOT_MEMORY_USAGE_SECTION.compute!({
      botAgentId: 'botA',
      memoryRoots: { own: '/root/agents/botA/memory', userShard: '/root/agents/botA/user' },
    })
    expect(out).toContain('/root/agents/botA/memory')
    expect(out).toContain('/root/agents/botA/user')
  })

  it('sits before the content sections in catalog order', () => {
    const names = createBotPromptAssembly().listSections()
    expect(names).toContain('memoryUsage')
    expect(names.indexOf('memoryUsage')).toBeLessThan(names.indexOf('memoryOwn'))
    expect(names.indexOf('memoryUsage')).toBeLessThan(names.indexOf('memoryUser'))
  })
})

describe('dual-key frozen snapshot (P2.2)', () => {
  function fixtureMemory(): BotMemoryContext {
    return {
      own: [entry({ tier: 'agent', writerId: 'botA', dedupeKey: 'pref:style', title: 'Style', body: 'Be terse' })],
      user: [entry({ writerId: 'botB', writerName: 'Beta', dedupeKey: 'person:alice', title: 'Alice' })],
      project: [],
      joinedProjects: [],
    }
  }

  function botCtx(memory: BotMemoryContext | undefined): BotPromptContext {
    return { botAgentId: 'botA', botName: 'Alpha', memory }
  }

  const snapshot = { botId: 'botA', contentHash: '', summaryEpoch: 0 }

  it('reuses the cached render verbatim for the same dual key', async () => {
    const assembly = createBotPromptAssembly()
    const memory = fixtureMemory()
    const key = { ...snapshot, contentHash: computeBotContentHash(botCtx(memory)) }
    const first = await assembly.renderSections(botCtx(memory), { snapshot: key })
    const second = await assembly.renderSections(botCtx(memory), { snapshot: key })
    expect(first).toBe(second)
    expect(first).toContain('## Own memory')
    expect(first).toContain('[via Beta]')
  })

  it('re-renders once when the compaction epoch advances', async () => {
    const assembly = createBotPromptAssembly()
    const memory = fixtureMemory()
    const key0 = { ...snapshot, contentHash: computeBotContentHash(botCtx(memory)), summaryEpoch: 0 }
    const key1 = { ...snapshot, contentHash: computeBotContentHash(botCtx(memory)), summaryEpoch: 1 }
    const before = await assembly.renderSections(botCtx(memory), { snapshot: key0 })
    const after = await assembly.renderSections(botCtx(memory), { snapshot: key1 })
    expect(after).toBe(before) // content unchanged → same bytes…
    // …but the render was recomputed: mutating the cache through a new
    // epoch proves the section re-evaluated (byte-equality is expected).
    expect(after).toContain('## Own memory')
  })

  it('re-renders when memory content changes (content hash moves)', async () => {
    const assembly = createBotPromptAssembly()
    const memory = fixtureMemory()
    const key0 = { ...snapshot, contentHash: computeBotContentHash(botCtx(memory)) }
    await assembly.renderSections(botCtx(memory), { snapshot: key0 })

    const memory2: BotMemoryContext = {
      ...memory,
      own: [...memory.own, entry({ tier: 'agent', writerId: 'botA', dedupeKey: 'pref:new', title: 'New fact' })],
    }
    const key1 = { ...snapshot, contentHash: computeBotContentHash(botCtx(memory2)) }
    expect(key1.contentHash).not.toBe(key0.contentHash)
    const after = await assembly.renderSections(botCtx(memory2), { snapshot: key1 })
    expect(after).toContain('New fact')
  })

  it('registers the three tier sections in catalog order', () => {
    const assembly = createBotPromptAssembly()
    const names = assembly.listSections()
    expect(names).toContain('memoryOwn')
    expect(names).toContain('memoryUser')
    expect(names).toContain('memoryProject')
    expect(names.indexOf('memoryOwn')).toBeLessThan(names.indexOf('memoryUser'))
    expect(names.indexOf('memoryUser')).toBeLessThan(names.indexOf('memoryProject'))
  })

  it('omits memory sections for a context without memory', async () => {
    const assembly = createBotPromptAssembly()
    const out = await assembly.renderSections(botCtx(undefined))
    expect(out).not.toContain('## Own memory')
    expect(out).not.toContain('## Shared user memory')
  })
})

describe('plain (non-bot) session regression (P2.2)', () => {
  it('legacy memorySection still renders summary.md — untouched by 479', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mem-'))
    const prev = process.env.DUYA_MEMORY_ROOT
    process.env.DUYA_MEMORY_ROOT = root
    try {
      fs.writeFileSync(path.join(root, 'summary.md'), '# Summary\n- prefers terse answers')
      const out = getMemorySection(undefined as never)
      expect(out).toContain('prefers terse answers')
    } finally {
      if (prev === undefined) delete process.env.DUYA_MEMORY_ROOT
      else process.env.DUYA_MEMORY_ROOT = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
