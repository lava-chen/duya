import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { FileMemoryStore } from '../../../src/memory/FileMemoryStore.js'

const today = () => new Date().toISOString().split('T')[0]

let tmpFile: string
let store: FileMemoryStore

beforeEach(async () => {
  tmpFile = path.join(
    os.tmpdir(),
    `filememory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  )
  store = new FileMemoryStore(tmpFile, { charLimit: 10_000 })
  store.load()
  // Seed with a few entries
  await store.add('Wiki agent 不用 RAG，直接用 wiki-llm 文件夹维护记忆', undefined, 'project')
  await store.add('E:/wiki 是核心个人知识库（Obsidian）', undefined, 'project')
  await store.add('RAG retrieval pipeline', 'embedding model + vector db', 'reference')
})

afterEach(() => {
  try {
    fs.unlinkSync(tmpFile)
  } catch {
    // best-effort cleanup
  }
})

describe('FileMemoryStore.replace', () => {
  it('matches by exact entry id', async () => {
    const entries = store.list()
    const target = entries[1]
    const result = await store.replace(target.id, 'E:/wiki 是陈炫羽的核心个人知识库（Obsidian，双视图）')

    expect(result.success).toBe(true)
    const after = store.list()
    expect(after).toHaveLength(3)
    const updated = after.find(e => e.id === target.id)
    expect(updated).toBeDefined()
    expect(updated?.summary).toContain('双视图')
    // Timestamp gets refreshed to today
    expect(updated?.timestamp).toBe(today())
  })

  it('matches a full header line including ## [type] prefix and § date', async () => {
    const header = '## [project] Wiki agent 不用 RAG，直接用 wiki-llm 文件夹维护记忆 § 2026-06-04'
    const result = await store.replace(header, 'Wiki agent 记忆方案：纯文件维护')

    expect(result.success).toBe(true)
    const updated = store.list().find(e => e.summary.startsWith('Wiki agent 记忆方案'))
    expect(updated).toBeDefined()
  })

  it('matches a header line plus the *(Nd ago)* age hint the renderer appends', async () => {
    const headerWithAge =
      '## [project] Wiki agent 不用 RAG，直接用 wiki-llm 文件夹维护记忆 § 2026-06-04  *(8d ago)*'
    const result = await store.replace(headerWithAge, 'Wiki agent — refreshed')

    expect(result.success).toBe(true)
    expect(store.list().some(e => e.summary === 'Wiki agent — refreshed')).toBe(true)
  })

  it('matches a bare substring of the summary', async () => {
    const result = await store.replace('vector db', 'RAG retrieval pipeline', 'embedding + faiss index')

    expect(result.success).toBe(true)
    const updated = store.list().find(e => e.summary === 'RAG retrieval pipeline')
    expect(updated?.content).toBe('embedding + faiss index')
  })

  it('returns failure with a clear error when nothing matches', async () => {
    const result = await store.replace('definitely-not-an-entry')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No entry found matching/i)
  })

  it('preserves the id of the replaced entry', async () => {
    const target = store.list()[0]
    await store.replace(target.id, 'completely new summary text')

    const updated = store.list().find(e => e.summary === 'completely new summary text')
    expect(updated?.id).toBe(target.id)
  })
})

describe('FileMemoryStore.remove', () => {
  it('removes by exact entry id', async () => {
    const target = store.list()[2]
    const result = await store.remove(target.id)

    expect(result.success).toBe(true)
    expect(store.list()).toHaveLength(2)
    expect(store.list().some(e => e.id === target.id)).toBe(false)
  })

  it('removes by a full header line (with prefix + date + age hint)', async () => {
    const headerWithAge =
      '## [reference] RAG retrieval pipeline § 2026-06-04  *(today)*'
    const result = await store.remove(headerWithAge)

    expect(result.success).toBe(true)
    expect(store.list()).toHaveLength(2)
  })

  it('returns failure when nothing matches', async () => {
    const result = await store.remove('this entry does not exist')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No entry found matching/i)
  })
})

describe('FileMemoryStore.add — id assignment and duplicate detection', () => {
  it('assigns a fresh id to each new entry', async () => {
    const result = await store.add('A brand new memory', undefined, 'feedback')
    expect(result.success).toBe(true)
    const added = store.list().find(e => e.summary === 'A brand new memory')
    expect(added?.id).toMatch(/^m-[0-9a-z]{8}$/)
  })

  it('detects duplicates even when surrounding whitespace differs', async () => {
    const result = await store.add('  Wiki agent 不用 RAG，直接用 wiki-llm 文件夹维护记忆  ')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/similar entry already exists/i)
  })

  it('detects duplicates case-insensitively', async () => {
    const result = await store.add('wiki AGENT 不用 rag，直接用 wiki-llm 文件夹维护记忆')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/similar entry already exists/i)
  })
})

describe('FileMemoryStore — legacy file (no id markers)', () => {
  it('parses existing entries without id markers and assigns ids on load', async () => {
    const legacy = path.join(
      os.tmpdir(),
      `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
    )
    fs.writeFileSync(
      legacy,
      [
        '## [project] legacy entry one § 2025-01-01',
        'first body',
        '§',
        '## [user] legacy entry two § 2024-12-15',
        '',
      ].join('\n'),
      'utf-8',
    )

    const legacyStore = new FileMemoryStore(legacy, { charLimit: 10_000 })
    legacyStore.load()
    const entries = legacyStore.list()
    expect(entries).toHaveLength(2)
    expect(entries[0].summary).toBe('legacy entry one')
    expect(entries[1].summary).toBe('legacy entry two')
    expect(entries[0].id).toMatch(/^m-[0-9a-z]{8}$/)
    expect(entries[1].id).toMatch(/^m-[0-9a-z]{8}$/)
    expect(entries[0].id).not.toBe(entries[1].id)

    // After a replace by substring, the id gets persisted on the next write
    const result = await legacyStore.replace('legacy entry one', 'updated legacy entry one')
    expect(result.success).toBe(true)
    const written = fs.readFileSync(legacy, 'utf-8')
    expect(written).toContain('<!--id:')

    fs.unlinkSync(legacy)
  })
})
