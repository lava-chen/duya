import { describe, it, expect } from 'vitest'
import {
  getPatchFromContents,
  transformLinesToObjects,
  processAdjacentLines,
  calculateWordDiffs,
  numberDiffLines,
  convertToDiffHunk,
  countLinesChanged,
  getLanguageFromPath,
  CONTEXT_LINES,
  DIFF_TIMEOUT_MS,
  type DiffLine,
} from '../../diff/diff-utils'

describe('diff-utils', () => {
  describe('constants', () => {
    it('should have correct context lines', () => {
      expect(CONTEXT_LINES).toBe(3)
    })

    it('should have correct diff timeout', () => {
      expect(DIFF_TIMEOUT_MS).toBe(5_000)
    })
  })

  describe('getPatchFromContents', () => {
    it('should return empty array for identical content', () => {
      const content = 'line1\nline2\nline3'
      const result = getPatchFromContents({
        filePath: 'test.ts',
        oldContent: content,
        newContent: content,
      })
      expect(result).toHaveLength(0)
    })

    it('should detect added lines', () => {
      const oldContent = 'line1\nline2'
      const newContent = 'line1\nline2\nline3'
      const result = getPatchFromContents({
        filePath: 'test.ts',
        oldContent,
        newContent,
      })
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].lines.some(line => line.includes('+line3'))).toBe(true)
    })

    it('should detect removed lines', () => {
      const oldContent = 'line1\nline2\nline3'
      const newContent = 'line1\nline3'
      const result = getPatchFromContents({
        filePath: 'test.ts',
        oldContent,
        newContent,
      })
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].lines.some(line => line.includes('-line2'))).toBe(true)
    })

    it('should handle single hunk mode', () => {
      const oldContent = 'a\n'.repeat(100)
      const newContent = 'b\n'.repeat(100)
      const result = getPatchFromContents({
        filePath: 'test.ts',
        oldContent,
        newContent,
        singleHunk: true,
      })
      expect(result).toHaveLength(1)
    })

    it('should handle ignore whitespace option', () => {
      const oldContent = 'line1\nline2'
      const newContent = 'line1\n  line2  '
      const resultWithIgnore = getPatchFromContents({
        filePath: 'test.ts',
        oldContent,
        newContent,
        ignoreWhitespace: true,
      })
      expect(resultWithIgnore).toHaveLength(0)
    })

    it('should escape special characters', () => {
      const oldContent = 'const x = a & b'
      const newContent = 'const x = a && b'
      const result = getPatchFromContents({
        filePath: 'test.ts',
        oldContent,
        newContent,
      })
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('transformLinesToObjects', () => {
    it('should transform add lines', () => {
      const lines = ['+new line', '+another new']
      const result = transformLinesToObjects(lines)
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('add')
      expect(result[0].code).toBe('new line')
    })

    it('should transform remove lines', () => {
      const lines = ['-old line']
      const result = transformLinesToObjects(lines)
      expect(result[0].type).toBe('remove')
      expect(result[0].code).toBe('old line')
    })

    it('should transform unchanged lines', () => {
      const lines = [' unchanged line']
      const result = transformLinesToObjects(lines)
      expect(result[0].type).toBe('nochange')
      expect(result[0].code).toBe('unchanged line')
    })

    it('should preserve original code', () => {
      const lines = ['+new line']
      const result = transformLinesToObjects(lines)
      expect(result[0].originalCode).toBe('new line')
    })
  })

  describe('processAdjacentLines', () => {
    it('should mark adjacent add/remove as word diff candidates', () => {
      const lines = [
        { code: 'old line', type: 'remove' as const, originalCode: 'old line' },
        { code: 'new line', type: 'add' as const, originalCode: 'new line' },
      ]
      const result = processAdjacentLines(lines)
      expect(result[0].wordDiff).toBe(true)
      expect(result[1].wordDiff).toBe(true)
    })

    it('should not mark non-adjacent changes', () => {
      const lines = [
        { code: 'old', type: 'remove' as const, originalCode: 'old' },
        { code: 'unchanged', type: 'nochange' as const, originalCode: 'unchanged' },
        { code: 'new', type: 'add' as const, originalCode: 'new' },
      ]
      const result = processAdjacentLines(lines)
      expect(result[0].wordDiff).toBeUndefined()
      expect(result[2].wordDiff).toBeUndefined()
    })

    it('should handle multiple consecutive removes followed by adds', () => {
      const lines = [
        { code: 'old1', type: 'remove' as const, originalCode: 'old1' },
        { code: 'old2', type: 'remove' as const, originalCode: 'old2' },
        { code: 'new1', type: 'add' as const, originalCode: 'new1' },
        { code: 'new2', type: 'add' as const, originalCode: 'new2' },
      ]
      const result = processAdjacentLines(lines)
      expect(result[0].wordDiff).toBe(true)
      expect(result[1].wordDiff).toBe(true)
      expect(result[2].wordDiff).toBe(true)
      expect(result[3].wordDiff).toBe(true)
    })
  })

  describe('calculateWordDiffs', () => {
    it('should detect added words', () => {
      const result = calculateWordDiffs('hello world', 'hello beautiful world')
      const added = result.find(r => r.added)
      expect(added).toBeDefined()
      expect(added?.value).toContain('beautiful')
    })

    it('should detect removed words', () => {
      const result = calculateWordDiffs('hello old world', 'hello world')
      const removed = result.find(r => r.removed)
      expect(removed).toBeDefined()
      expect(removed?.value).toContain('old')
    })

    it('should preserve unchanged words', () => {
      const result = calculateWordDiffs('hello world', 'hello world')
      expect(result.every(r => !r.added && !r.removed)).toBe(true)
    })
  })

  describe('numberDiffLines', () => {
    it('should number unchanged lines sequentially', () => {
      const lines = [
        { code: 'a', type: 'nochange' as const, originalCode: 'a' },
        { code: 'b', type: 'nochange' as const, originalCode: 'b' },
      ]
      const result = numberDiffLines(lines, 1)
      expect(result[0].lineNumber).toBe(1)
      expect(result[1].lineNumber).toBe(2)
    })

    it('should number added lines sequentially', () => {
      const lines = [
        { code: 'a', type: 'add' as const, originalCode: 'a' },
        { code: 'b', type: 'add' as const, originalCode: 'b' },
      ]
      const result = numberDiffLines(lines, 1)
      expect(result[0].lineNumber).toBe(1)
      expect(result[1].lineNumber).toBe(2)
    })

    it('should handle remove lines correctly', () => {
      const lines = [
        { code: 'a', type: 'remove' as const, originalCode: 'a' },
        { code: 'b', type: 'remove' as const, originalCode: 'b' },
        { code: 'c', type: 'nochange' as const, originalCode: 'c' },
      ]
      const result = numberDiffLines(lines, 1)
      // Remove lines share the same line number
      expect(result[0].lineNumber).toBe(1)
      expect(result[1].lineNumber).toBe(2)
      // Next line continues from the original position
      expect(result[2].lineNumber).toBe(1)
    })
  })

  describe('countLinesChanged', () => {
    it('should count additions correctly', () => {
      const hunks = [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: [
            { code: 'a', type: 'add' as const, lineNumber: 1, originalCode: 'a' },
            { code: 'b', type: 'add' as const, lineNumber: 2, originalCode: 'b' },
          ],
        },
      ]
      const result = countLinesChanged(hunks)
      expect(result.additions).toBe(2)
      expect(result.removals).toBe(0)
    })

    it('should count removals correctly', () => {
      const hunks = [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 0,
          lines: [
            { code: 'a', type: 'remove' as const, lineNumber: 1, originalCode: 'a' },
            { code: 'b', type: 'remove' as const, lineNumber: 2, originalCode: 'b' },
          ],
        },
      ]
      const result = countLinesChanged(hunks)
      expect(result.additions).toBe(0)
      expect(result.removals).toBe(2)
    })

    it('should count across multiple hunks', () => {
      const hunks = [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { code: 'a', type: 'add' as const, lineNumber: 1, originalCode: 'a' },
          ],
        },
        {
          oldStart: 10,
          oldLines: 1,
          newStart: 10,
          newLines: 1,
          lines: [
            { code: 'b', type: 'remove' as const, lineNumber: 10, originalCode: 'b' },
          ],
        },
      ]
      const result = countLinesChanged(hunks)
      expect(result.additions).toBe(1)
      expect(result.removals).toBe(1)
    })
  })

  describe('getLanguageFromPath', () => {
    it('should detect JavaScript files', () => {
      expect(getLanguageFromPath('test.js')).toBe('javascript')
    })

    it('should detect TypeScript files', () => {
      expect(getLanguageFromPath('test.ts')).toBe('typescript')
      expect(getLanguageFromPath('test.tsx')).toBe('tsx')
    })

    it('should detect Python files', () => {
      expect(getLanguageFromPath('test.py')).toBe('python')
    })

    it('should detect JSON files', () => {
      expect(getLanguageFromPath('config.json')).toBe('json')
    })

    it('should detect Markdown files', () => {
      expect(getLanguageFromPath('README.md')).toBe('markdown')
    })

    it('should handle paths with directories', () => {
      expect(getLanguageFromPath('/path/to/file.ts')).toBe('typescript')
    })

    it('should return text for unknown extensions', () => {
      expect(getLanguageFromPath('file.unknown')).toBe('text')
    })

    it('should return text for files without extensions', () => {
      expect(getLanguageFromPath('Makefile')).toBe('text')
    })
  })
})
