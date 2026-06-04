import { describe, it, expect } from 'vitest'
import {
  parseEntries,
  serializeEntry,
  serializeEntries,
  findEntryIndex,
  stripEntryDecorations,
  generateMemoryId,
  type MemoryEntry,
} from '../../../src/memory/memoryParser.js'

const TODAY = new Date().toISOString().split('T')[0]

const makeEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: overrides.id ?? generateMemoryId(),
  summary: overrides.summary ?? 'default summary',
  content: overrides.content,
  timestamp: overrides.timestamp ?? TODAY,
  type: overrides.type,
})

describe('generateMemoryId', () => {
  it('returns ids with the m- prefix and 8 base36 chars', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateMemoryId()
      expect(id).toMatch(/^m-[0-9a-z]{8}$/)
    }
  })

  it('produces unique ids across many calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateMemoryId()))
    expect(ids.size).toBe(500)
  })
})

describe('stripEntryDecorations', () => {
  it('strips the ## [type] header prefix', () => {
    expect(stripEntryDecorations('## [project] Wiki agent uses RAG')).toBe(
      'Wiki agent uses RAG',
    )
  })

  it('strips a header without type tag', () => {
    expect(stripEntryDecorations('## Plain header')).toBe('Plain header')
  })

  it('strips a trailing § YYYY-MM-DD timestamp', () => {
    expect(stripEntryDecorations('Wiki agent uses RAG § 2026-06-04')).toBe(
      'Wiki agent uses RAG',
    )
  })

  it('strips combined header + timestamp + age hint', () => {
    expect(
      stripEntryDecorations('## [project] Wiki agent uses RAG § 2026-06-04  *(3d ago)*'),
    ).toBe('Wiki agent uses RAG')
  })

  it('strips a "(today)" age hint', () => {
    expect(stripEntryDecorations('## summary text § 2026-06-04  *(today)*')).toBe(
      'summary text',
    )
  })

  it('leaves plain substrings untouched', () => {
    expect(stripEntryDecorations('RAG is great')).toBe('RAG is great')
  })
})

describe('findEntryIndex — decoration-aware substring matching', () => {
  const entries: MemoryEntry[] = [
    makeEntry({ summary: 'Wiki agent memory UI 优先做 graph + tree 双视图' }),
    makeEntry({ summary: 'E:/wiki 是陈炫羽的核心个人知识库（Obsidian）' }),
    makeEntry({ summary: 'RAG retrieval pipeline', content: 'embedding model + vector db' }),
  ]

  it('matches a bare substring of summary', () => {
    expect(findEntryIndex(entries, 'graph + tree')).toBe(0)
  })

  it('matches case-insensitively', () => {
    expect(findEntryIndex(entries, 'WIKI AGENT')).toBe(0)
  })

  it('matches against content', () => {
    expect(findEntryIndex(entries, 'vector db')).toBe(2)
  })

  it('matches a full header line with ## [type] prefix and § date', () => {
    const header = '## [project] Wiki agent memory UI 优先做 graph + tree 双视图 § 2026-06-04'
    expect(findEntryIndex(entries, header)).toBe(0)
  })

  it('matches a header line plus the *(Nd ago)* age hint the renderer appends', () => {
    const headerWithAge = '## [project] Wiki agent memory UI 优先做 graph + tree 双视图 § 2026-06-04  *(3d ago)*'
    expect(findEntryIndex(entries, headerWithAge)).toBe(0)
  })

  it('matches a header even when type tag is missing', () => {
    const header = '## RAG retrieval pipeline § 2026-06-04'
    expect(findEntryIndex(entries, header)).toBe(2)
  })

  it('returns -1 when nothing matches', () => {
    expect(findEntryIndex(entries, 'no such text here')).toBe(-1)
  })

  it('returns -1 for empty or whitespace-only text', () => {
    expect(findEntryIndex(entries, '')).toBe(-1)
    expect(findEntryIndex(entries, '   ')).toBe(-1)
  })
})

describe('parseEntries / serializeEntry — id round-trip', () => {
  it('persists and restores a stable id', () => {
    const original = makeEntry({ id: 'm-abcdef01', summary: 'stable identity test' })
    const serialized = serializeEntry(original)
    expect(serialized).toContain('<!--id:m-abcdef01-->')

    const [parsed] = parseEntries(serialized)
    expect(parsed.id).toBe('m-abcdef01')
    expect(parsed.summary).toBe('stable identity test')
  })

  it('backward-compat: parses entries without an id marker and assigns a new one', () => {
    const legacy = `## [project] legacy memory § 2025-01-01\nold content`
    const [parsed] = parseEntries(legacy)
    expect(parsed.summary).toBe('legacy memory')
    expect(parsed.content).toBe('old content')
    expect(parsed.type).toBe('project')
    expect(parsed.id).toMatch(/^m-[0-9a-z]{8}$/)
  })

  it('does not leak an id marker into the parsed content body', () => {
    const original = makeEntry({
      id: 'm-deadbeef',
      summary: 'no id leak',
      content: 'real content line',
    })
    const serialized = serializeEntry(original)
    const [parsed] = parseEntries(serialized)
    expect(parsed.content).toBe('real content line')
    expect(parsed.content).not.toContain('id:')
  })

  it('round-trips multiple entries preserving ids', () => {
    const entries: MemoryEntry[] = [
      makeEntry({ id: 'm-aaaaaaaa', summary: 'first' }),
      makeEntry({ id: 'm-bbbbbbbb', summary: 'second', type: 'feedback' }),
      makeEntry({ id: 'm-cccccccc', summary: 'third', content: 'body' }),
    ]
    const serialized = serializeEntries(entries)
    const parsed = parseEntries(serialized)
    expect(parsed.map(e => e.id)).toEqual(['m-aaaaaaaa', 'm-bbbbbbbb', 'm-cccccccc'])
    expect(parsed.map(e => e.summary)).toEqual(['first', 'second', 'third'])
    expect(parsed[1].type).toBe('feedback')
    expect(parsed[2].content).toBe('body')
  })
})
