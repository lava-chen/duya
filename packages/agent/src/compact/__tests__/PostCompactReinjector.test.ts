import { describe, it, expect, beforeEach } from 'vitest'
import type { Message } from '../../types.js'
import {
  PostCompactReinjector,
  createPostCompactReinjector,
  extractFileState,
  type FileStateEntry,
} from '../PostCompactReinjector.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReadToolUse(id: string, filePath: string, opts?: { offset?: number; limit?: number }): unknown {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: {
      file_path: filePath,
      ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    },
  }
}

function makeToolResult(toolUseId: string, content: string, isError = false): unknown {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  }
}

function makeReadRoundTrip(filePath: string, content: string, id = `tu_${filePath}`): Message[] {
  return [
    { role: 'user', content: 'please read' },
    {
      role: 'assistant',
      content: [makeReadToolUse(id, filePath)] as unknown as Message['content'],
    },
    {
      role: 'user',
      content: [makeToolResult(id, content)] as unknown as Message['content'],
    },
  ]
}

function makeSummaryMessage(): Message {
  return {
    role: 'system',
    content: 'This session is being continued from a previous conversation that ran out of context.',
    timestamp: 1000,
    isCompactSummary: true,
    compactedMessageCount: 5,
  }
}

function makeRecentUserTurn(): Message {
  return { role: 'user', content: 'thanks, continue', timestamp: 2000 }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostCompactReinjector', () => {
  let reinjector: PostCompactReinjector

  beforeEach(() => {
    reinjector = new PostCompactReinjector()
  })

  describe('constructor', () => {
    it('applies defaults when no config is given', () => {
      const r = new PostCompactReinjector()
      const stats = r.getCacheStats()
      expect(stats).toEqual({ filesCached: 0, skillsCached: 0, toolsCached: 0 })
    })

    it('createPostCompactReinjector factory returns an instance', () => {
      const r = createPostCompactReinjector({ maxFilesToReinject: 2 })
      expect(r).toBeInstanceOf(PostCompactReinjector)
    })
  })

  describe('extractFileState', () => {
    it('captures Read tool_use file paths paired with their tool_result content', () => {
      const messages = [
        ...makeReadRoundTrip('src/a.ts', 'content of A'),
        ...makeReadRoundTrip('src/b.ts', 'content of B', 'tu_b'),
      ]

      const state = extractFileState(messages)
      expect(state.size).toBe(2)
      expect(state.get('src/a.ts')?.content).toBe('content of A')
      expect(state.get('src/b.ts')?.content).toBe('content of B')
    })

    it('records offset/limit when the Read tool used partial-view options', () => {
      const messages = makeReadRoundTrip('src/c.ts', 'partial body', 'tu_c')
      // patch the tool_use input to include offset/limit
      const assistant = messages[1]!
      const block = (assistant.content as unknown as Array<Record<string, unknown>>)[0]!
      block.input = { file_path: 'src/c.ts', offset: 100, limit: 50 }

      const state = extractFileState(messages)
      const entry = state.get('src/c.ts')
      // extractFileState preserves offset/limit but does not derive isPartialView;
      // isPartialView is set by callers that consume FileStateEntry downstream.
      expect(entry?.offset).toBe(100)
      expect(entry?.limit).toBe(50)
    })

    it('ignores non-Read tool_use blocks', () => {
      const messages: Message[] = [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tu_glob',
            name: 'Glob',
            input: { pattern: '*.ts' },
          }] as unknown as Message['content'],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_glob',
            content: 'a.ts\nb.ts',
          }] as unknown as Message['content'],
        },
      ]
      const state = extractFileState(messages)
      expect(state.size).toBe(0)
    })
  })

  describe('cacheFileState', () => {
    it('records Read tool_use/result pairs as FileStateEntry entries', () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'content of A'))
      expect(reinjector.getCacheStats().filesCached).toBe(1)
    })

    it('keeps the most recent content when the same file is read multiple times', () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'first read'))
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'second read', 'tu_a_2'))
      expect(reinjector.getCacheStats().filesCached).toBe(1)
    })

    it('trims the cache to half when it grows past 2x maxFilesToReinject', () => {
      const small = new PostCompactReinjector({ maxFilesToReinject: 2 })
      // First fill the cache with 4 files (2x the limit)
      for (let i = 0; i < 4; i++) {
        small.cacheFileState(makeReadRoundTrip(`f${i}.ts`, `c${i}`))
      }
      // Cache is at the 2x boundary — still all 4 should remain
      expect(small.getCacheStats().filesCached).toBe(4)

      // Push one more — trimming kicks in (drop oldest half = 2)
      small.cacheFileState(makeReadRoundTrip('f4.ts', 'c4'))
      expect(small.getCacheStats().filesCached).toBe(3)
    })
  })

  describe('cacheSkillContext', () => {
    it('stores skills by name', () => {
      reinjector.cacheSkillContext([
        { name: 'foo', description: 'desc', invokedAt: 1 },
        { name: 'bar', description: 'desc', invokedAt: 2 },
      ])
      expect(reinjector.getCacheStats().skillsCached).toBe(2)
    })
  })

  describe('cacheToolState', () => {
    it('records tool state with name + timestamp', () => {
      reinjector.cacheToolState('Bash', { status: 'active', lastOutput: 'streaming...' })
      expect(reinjector.getCacheStats().toolsCached).toBe(1)
    })
  })

  describe('reinject', () => {
    it('returns the input unchanged (no embedded messages) when no caches are populated', async () => {
      const compressed: Message[] = [makeSummaryMessage(), makeRecentUserTurn()]
      const result = await reinjector.reinject(compressed)
      // Plan 552: messages are echoed verbatim; context rides systemSegments.
      expect(result.messages).toEqual(compressed)
      expect(result.systemSegments).toEqual([])
      expect(result.filesReinjected).toEqual([])
      expect(result.skillsReinjected).toEqual([])
      expect(result.toolsRestored).toEqual([])
      expect(result.totalTokensAdded).toBe(0)
    })

    it('emits a file-reinject segment (and no embedded message) for cached file state', async () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'content of A'))
      const summary = makeSummaryMessage()
      const recent = makeRecentUserTurn()
      const result = await reinjector.reinject([summary, recent])

      expect(result.messages).toEqual([summary, recent])
      expect(result.systemSegments).toHaveLength(1)
      const segment = result.systemSegments[0]!
      expect(segment).toContain('## Recently Accessed Files')
      expect(segment).toContain('src/a.ts')
      expect(segment).toContain('content of A')
      expect(result.filesReinjected).toHaveLength(1)
    })

    it('selects most-recent files first when more than maxFilesToReinject are cached', async () => {
      const r = new PostCompactReinjector({ maxFilesToReinject: 2 })
      r.cacheFileState(makeReadRoundTrip('old.ts', 'OLD'))
      // small delay so timestamps differ
      await new Promise((res) => setTimeout(res, 5))
      r.cacheFileState(makeReadRoundTrip('mid.ts', 'MID', 'tu_mid'))
      await new Promise((res) => setTimeout(res, 5))
      r.cacheFileState(makeReadRoundTrip('new.ts', 'NEW', 'tu_new'))

      const result = await r.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      const fileSegment = result.systemSegments.find((s) => s.includes('## Recently Accessed Files'))
      expect(fileSegment).toBeDefined()
      const text = fileSegment!
      // new.ts should appear before old.ts (most-recent-first ordering)
      const newIdx = text.indexOf('new.ts')
      const midIdx = text.indexOf('mid.ts')
      const oldIdx = text.indexOf('old.ts')
      expect(newIdx).toBeGreaterThan(-1)
      expect(midIdx).toBeGreaterThan(-1)
      expect(oldIdx).toBe(-1) // dropped by maxFilesToReinject=2
    })

    it('emits a skill-reinject segment', async () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'A'))
      reinjector.cacheSkillContext([{ name: 'foo', description: 'does foo', invokedAt: 1 }])

      const result = await reinjector.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      const skillSegment = result.systemSegments.find((s) => s.includes('## Active Skills Context'))
      expect(skillSegment).toBeDefined()
      expect(skillSegment).toContain('foo')
      expect(result.skillsReinjected).toHaveLength(1)
    })

    it('emits a tool-state segment only for active tools (filters out completed/error)', async () => {
      reinjector.cacheToolState('Task1', { status: 'active', lastOutput: 'live' })
      reinjector.cacheToolState('Task2', { status: 'completed', lastOutput: 'done' })
      reinjector.cacheToolState('Task3', { status: 'error', lastOutput: 'crashed' })

      const result = await reinjector.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      const toolSegment = result.systemSegments.find((s) => s.includes('## Active Tool States'))
      expect(toolSegment).toBeDefined()
      const text = toolSegment!
      expect(text).toContain('Task1')
      expect(text).not.toContain('Task2')
      expect(text).not.toContain('Task3')
      // toolsRestored returns ALL cached tools (so the host can mark the
      // completed/error ones as restored regardless of whether they were in
      // the active-only visible section).
      expect(result.toolsRestored).toHaveLength(3)
    })

    it('emits a working-directory segment with recentChanges when provided', async () => {
      const result = await reinjector.reinject(
        [makeSummaryMessage(), makeRecentUserTurn()],
        {
          workingDirectory: '/tmp/proj',
          recentChanges: [
            { filePath: 'a.ts', operation: 'edit', timestamp: 1 },
            { filePath: 'b.ts', operation: 'create', timestamp: 2 },
          ],
        },
      )
      const dirSegment = result.systemSegments.find((s) => s.includes('## Working Directory'))
      expect(dirSegment).toBeDefined()
      expect(dirSegment).toContain('/tmp/proj')
      expect(dirSegment).toContain('a.ts')
      expect(dirSegment).toContain('b.ts')
    })

    it('appends customContext as the final segment', async () => {
      const result = await reinjector.reinject(
        [makeSummaryMessage(), makeRecentUserTurn()],
        { customContext: 'remember: project uses tabs not spaces' },
      )
      expect(result.systemSegments.at(-1)).toContain('remember: project uses tabs')
    })

    it('orders segments [files → skills → tools → cwd → custom]', async () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'A'))
      reinjector.cacheSkillContext([{ name: 'foo', description: 'foo', invokedAt: 1 }])
      reinjector.cacheToolState('T', { status: 'active', lastOutput: 'live' })

      const result = await reinjector.reinject(
        [makeSummaryMessage(), makeRecentUserTurn()],
        { workingDirectory: '/proj', customContext: 'extra' },
      )

      const sectionOrder: string[] = []
      for (const segment of result.systemSegments) {
        if (segment.includes('## Recently Accessed Files')) sectionOrder.push('files')
        else if (segment.includes('## Active Skills Context')) sectionOrder.push('skills')
        else if (segment.includes('## Active Tool States')) sectionOrder.push('tools')
        else if (segment.includes('## Working Directory')) sectionOrder.push('cwd')
        else if (segment.includes('extra')) sectionOrder.push('custom')
      }
      expect(sectionOrder).toEqual(['files', 'skills', 'tools', 'cwd', 'custom'])
    })

    it('skips the file segment entirely when includeFileContent is false', async () => {
      // includeFileContent: false short-circuits the file reinject branch in
      // `reinject()` — no '## Recently Accessed Files' segment is produced.
      const r = new PostCompactReinjector({ includeFileContent: false })
      r.cacheFileState(makeReadRoundTrip('src/a.ts', 'A'))
      const result = await r.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      expect(result.systemSegments.some((s) => s.includes('## Recently Accessed Files'))).toBe(false)
      // filesReinforced reflects the populated cache regardless of includeFileContent
      expect(result.filesReinjected).toHaveLength(1)
    })

    it('emits the content-available-on-request note when cacheFileState has no content', async () => {
      // Read tool_use with no matching tool_result → entry exists but content=''
      const messages: Message[] = [
        { role: 'user', content: 'read' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tu_x',
            name: 'Read',
            input: { file_path: 'src/x.ts' },
          }] as unknown as Message['content'],
        },
      ]
      reinjector.cacheFileState(messages)
      const result = await reinjector.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      const segment = result.systemSegments.find((s) => s.includes('src/x.ts'))
      expect(segment).toBeDefined()
      expect(segment).toContain('content available on request')
    })

    it('truncates very long file content to roughly maxTokensPerFile * 4 chars', async () => {
      const r = new PostCompactReinjector({ maxTokensPerFile: 10 }) // very small
      const huge = 'x'.repeat(1000)
      r.cacheFileState(makeReadRoundTrip('src/big.ts', huge))
      const result = await r.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      const segment = result.systemSegments.find((s) => s.includes('src/big.ts'))
      expect(segment).toContain('[truncated')
      expect(segment!.length).toBeLessThan(huge.length)
    })

    it('totalTokensAdded reflects the bytes the reinjector restored', async () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'a'.repeat(40)))
      reinjector.cacheSkillContext([{ name: 's', description: 'd', invokedAt: 1 }])
      reinjector.cacheToolState('T', { status: 'active', lastOutput: 'o'.repeat(80) })
      const result = await reinjector.reinject([makeSummaryMessage(), makeRecentUserTurn()])
      // 40 chars (file) + ~16 chars (skill) + ~80 chars (tool) — all three
      // segments contribute to the reported token cost.
      expect(result.totalTokensAdded).toBeGreaterThan(0)
      expect(result.totalTokensAdded).toBeLessThan(200)
    })
  })

  describe('clearCache', () => {
    it('wipes all three caches atomically', () => {
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'A'))
      reinjector.cacheSkillContext([{ name: 's', description: 'd', invokedAt: 1 }])
      reinjector.cacheToolState('T', { status: 'active' })
      expect(reinjector.getCacheStats().filesCached).toBe(1)
      expect(reinjector.getCacheStats().skillsCached).toBe(1)
      expect(reinjector.getCacheStats().toolsCached).toBe(1)

      reinjector.clearCache()
      expect(reinjector.getCacheStats()).toEqual({ filesCached: 0, skillsCached: 0, toolsCached: 0 })
    })
  })

  describe('regression: the message array is never mutated (plan 552 single channel)', () => {
    it('echoes the input — including system rows — without splicing segments into it', async () => {
      const summary = makeSummaryMessage()
      const unrelatedSystem: Message = {
        role: 'system',
        content: 'Some arbitrary system note (not a compact summary).',
        timestamp: 1500,
      }
      const recent = makeRecentUserTurn()
      reinjector.cacheFileState(makeReadRoundTrip('src/a.ts', 'A'))

      const result = await reinjector.reinject([summary, unrelatedSystem, recent])
      expect(result.messages).toEqual([summary, unrelatedSystem, recent])
      // The restored context lives exclusively in systemSegments.
      expect(result.systemSegments).toHaveLength(1)
      expect(result.systemSegments[0]).toContain('## Recently Accessed Files')
    })
  })
})
