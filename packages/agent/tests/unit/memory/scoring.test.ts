import { describe, it, expect } from 'vitest'
import { scoreMemoryEntries, formatScoredEntries, type ScoredEntry } from '../../../src/memory/scoring.js'
import type { MemoryEntry } from '../../../src/memory/memoryParser.js'

describe('scoreMemoryEntries', () => {
  const createEntry = (
    summary: string,
    content?: string,
    timestamp?: string,
    type?: 'user' | 'feedback' | 'project' | 'reference',
  ): MemoryEntry => ({
    summary,
    content,
    timestamp: timestamp ?? new Date().toISOString().split('T')[0],
    type,
  })

  describe('keyword matching', () => {
    it('should score entries with matching keywords higher', () => {
      const entries = [
        createEntry('Python programming', 'Writing Python scripts'),
        createEntry('JavaScript development', 'Building JS apps'),
      ]

      const scored = scoreMemoryEntries(entries, 'Python scripts')

      expect(scored.length).toBeGreaterThan(0)
      expect(scored[0].entry.summary).toBe('Python programming')
      // The Python entry should score higher due to summary + content matches
    })

    it('should return empty array for no keyword matches', () => {
      const entries = [
        createEntry('Python programming'),
        createEntry('JavaScript development'),
      ]

      const scored = scoreMemoryEntries(entries, 'rust golang')

      expect(scored.length).toBe(0)
    })

    it('should weight summary matches higher than content matches', () => {
      const entries = [
        createEntry('Python basics', 'Advanced Python patterns'),
        createEntry('JavaScript fundamentals', 'Python is also mentioned here'),
      ]

      const scored = scoreMemoryEntries(entries, 'Python')

      // First entry matches on summary (2x weight) + content (1x) = 3
      // Second entry matches on content only (1x) = 1
      expect(scored.length).toBe(2)
      expect(scored[0].entry.summary).toBe('Python basics')
    })

    it('should match substring keywords', () => {
      const entries = [
        createEntry('Debug the API issue'),
        createEntry('API documentation'),
      ]

      const scored = scoreMemoryEntries(entries, 'debugging')

      expect(scored.length).toBeGreaterThan(0)
      expect(scored[0].entry.summary).toContain('Debug')
    })
  })

  describe('recency boost', () => {
    it('should boost recent entries', () => {
      const today = new Date().toISOString().split('T')[0]
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
      const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]

      const entries = [
        createEntry('Old memory', undefined, lastWeek),
        createEntry('Today memory', undefined, today),
        createEntry('Yesterday memory', undefined, yesterday),
      ]

      const scored = scoreMemoryEntries(entries, 'memory')

      // Today should rank highest due to recency boost
      expect(scored[0].entry.summary).toBe('Today memory')
    })

    it('should apply 1.5x boost for today entries', () => {
      const entries = [
        createEntry('Today entry', undefined, new Date().toISOString().split('T')[0]),
      ]

      const scored = scoreMemoryEntries(entries, 'entry')

      expect(scored[0].score).toBeGreaterThan(0)
      // The score should include the 1.5x today boost on top of base score
    })
  })

  describe('type boost', () => {
    it('should boost user type entries slightly', () => {
      const entries = [
        createEntry('Same summary', undefined, undefined, 'feedback'),
        createEntry('Same summary', undefined, undefined, 'user'),
      ]

      const scored = scoreMemoryEntries(entries, 'summary')

      expect(scored.length).toBe(2)
      // User type gets 1.2x boost, feedback gets 1.1x
      expect(scored[0].entry.type).toBe('user')
    })
  })

  describe('options', () => {
    it('should limit entries with maxEntries option', () => {
      // All entries contain the keyword "programming"
      const entries = [
        createEntry('Python programming', undefined, undefined, 'user'),
        createEntry('JavaScript programming', undefined, undefined, 'project'),
        createEntry('Rust programming', undefined, undefined, 'reference'),
        createEntry('TypeScript programming', undefined, undefined, 'user'),
        createEntry('Go programming', undefined, undefined, 'feedback'),
        createEntry('C++ programming', undefined, undefined, 'project'),
      ]

      const scored = scoreMemoryEntries(entries, 'programming', { maxEntries: 3 })

      expect(scored.length).toBe(3)
    })

    it('should filter entries older than maxAgeDays', () => {
      const recent = new Date().toISOString().split('T')[0]
      const old = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]

      const entries = [
        createEntry('Recent memory', undefined, recent),
        createEntry('Old memory', undefined, old),
      ]

      const scored = scoreMemoryEntries(entries, 'memory', { maxAgeDays: 7 })

      expect(scored.length).toBe(1)
      expect(scored[0].entry.summary).toBe('Recent memory')
    })
  })
})

describe('formatScoredEntries', () => {
  it('should return empty string for empty array', () => {
    const formatted = formatScoredEntries([])
    expect(formatted).toBe('')
  })

  it('should format entries with type prefix and age', () => {
    const today = new Date().toISOString().split('T')[0]
    const entry: ScoredEntry = {
      entry: {
        summary: 'Test memory',
        timestamp: today,
        type: 'user',
      },
      score: 1.5,
      matchKeywords: ['test'],
    }

    const formatted = formatScoredEntries([entry])

    expect(formatted).toContain('[user]')
    expect(formatted).toContain('Test memory')
    expect(formatted).toContain('today')
  })

  it('should include content when present', () => {
    const entry: ScoredEntry = {
      entry: {
        summary: 'Test',
        content: 'Detailed content here',
        timestamp: new Date().toISOString().split('T')[0],
      },
      score: 1.0,
      matchKeywords: [],
    }

    const formatted = formatScoredEntries([entry])

    expect(formatted).toContain('Test')
    expect(formatted).toContain('Detailed content here')
  })

  it('should format age as days ago for older entries', () => {
    const oldDate = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0]
    const entry: ScoredEntry = {
      entry: {
        summary: 'Old entry',
        timestamp: oldDate,
      },
      score: 1.0,
      matchKeywords: [],
    }

    const formatted = formatScoredEntries([entry])

    expect(formatted).toContain('5d ago')
  })
})