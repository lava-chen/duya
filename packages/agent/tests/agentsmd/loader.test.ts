/**
 * AGENTS.md Loader Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  loadAgentsMdFiles,
  buildAgentsMdPrompt,
  isAgentsMdFile,
  stripHtmlComments,
} from '../../src/agentsmd/loader.js'
import type { AgentsMdConfig } from '../../src/agentsmd/types.js'

describe('agentsmd loader', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('loadAgentsMdFiles', () => {
    it('should load project AGENTS.md', async () => {
      // Create AGENTS.md
      fs.writeFileSync(
        path.join(tempDir, 'AGENTS.md'),
        '# Project Instructions\n\nThis is a test project.',
      )

      const files = await loadAgentsMdFiles({
        cwd: tempDir,
        config: {
          enableManaged: false,
          enableUser: false,
          enableProject: true,
          enableLocal: false,
          excludes: [],
          maxFileSize: 40000,
          maxIncludeDepth: 5,
        },
      })

      expect(files.length).toBeGreaterThan(0)
      expect(files[0].type).toBe('Project')
      expect(files[0].content).toContain('This is a test project')
    })

    it('should load .duya/AGENTS.md', async () => {
      const duyaDir = path.join(tempDir, '.duya')
      fs.mkdirSync(duyaDir, { recursive: true })

      fs.writeFileSync(
        path.join(duyaDir, 'AGENTS.md'),
        '# Duya Instructions\n\nUse TypeScript.',
      )

      const files = await loadAgentsMdFiles({
        cwd: tempDir,
        config: {
          enableManaged: false,
          enableUser: false,
          enableProject: true,
          enableLocal: false,
          excludes: [],
          maxFileSize: 40000,
          maxIncludeDepth: 5,
        },
      })

      expect(files.length).toBeGreaterThan(0)
      expect(files.some(f => f.path.includes('.duya'))).toBe(true)
    })

    it('should load AGENTS.local.md', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'AGENTS.local.md'),
        '# Local Instructions\n\nPrivate notes.',
      )

      const files = await loadAgentsMdFiles({
        cwd: tempDir,
        config: {
          enableManaged: false,
          enableUser: false,
          enableProject: true,
          enableLocal: true,
          excludes: [],
          maxFileSize: 40000,
          maxIncludeDepth: 5,
        },
      })

      expect(files.some(f => f.type === 'Local')).toBe(true)
    })

    it('should load rules from .duya/rules/', async () => {
      const rulesDir = path.join(tempDir, '.duya', 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })

      fs.writeFileSync(
        path.join(rulesDir, 'typescript.md'),
        '# TypeScript Rules\n\nUse strict mode.',
      )

      const files = await loadAgentsMdFiles({
        cwd: tempDir,
        config: {
          enableManaged: false,
          enableUser: false,
          enableProject: true,
          enableLocal: false,
          excludes: [],
          maxFileSize: 40000,
          maxIncludeDepth: 5,
        },
      })

      expect(files.some(f => f.path.includes('typescript.md'))).toBe(true)
    })

    it('should respect priority order', async () => {
      // Create files at different levels
      fs.writeFileSync(
        path.join(tempDir, 'AGENTS.md'),
        '# Root Level',
      )

      const subDir = path.join(tempDir, 'src')
      fs.mkdirSync(subDir)
      fs.writeFileSync(
        path.join(subDir, 'AGENTS.md'),
        '# Src Level',
      )

      const files = await loadAgentsMdFiles({
        cwd: subDir,
        config: {
          enableManaged: false,
          enableUser: false,
          enableProject: true,
          enableLocal: false,
          excludes: [],
          maxFileSize: 40000,
          maxIncludeDepth: 5,
        },
      })

      // Should have both files, with src level later (higher priority)
      expect(files.length).toBe(2)
      expect(files[0].content).toContain('Root Level')
      expect(files[1].content).toContain('Src Level')
    })
  })

  describe('buildAgentsMdPrompt', () => {
    it('should build prompt from files', () => {
      const files = [
        {
          path: '/test/AGENTS.md',
          type: 'Project' as const,
          content: 'Use TypeScript.',
        },
      ]

      const prompt = buildAgentsMdPrompt(files)

      expect(prompt).toContain('Codebase and user instructions')
      expect(prompt).toContain('Use TypeScript')
      expect(prompt).toContain('/test/AGENTS.md')
    })

    it('should return empty string for no files', () => {
      const prompt = buildAgentsMdPrompt([])
      expect(prompt).toBe('')
    })
  })

  describe('isAgentsMdFile', () => {
    it('should identify AGENTS.md files', () => {
      expect(isAgentsMdFile('/project/AGENTS.md')).toBe(true)
      expect(isAgentsMdFile('/project/AGENTS.local.md')).toBe(true)
      expect(isAgentsMdFile('/project/.duya/rules/test.md')).toBe(true)
    })

    it('should reject non-AGENTS.md files', () => {
      expect(isAgentsMdFile('/project/README.md')).toBe(false)
      expect(isAgentsMdFile('/project/CLAUDE.md')).toBe(false)
      expect(isAgentsMdFile('/project/file.txt')).toBe(false)
    })
  })

  describe('stripHtmlComments', () => {
    it('should strip HTML comments', () => {
      const input = 'Hello <!-- comment --> World'
      const result = stripHtmlComments(input)

      expect(result.content).toBe('Hello  World')
      expect(result.stripped).toBe(true)
    })

    it('should handle multiline comments', () => {
      const input = `Hello
<!-- This is a
multiline comment -->
World`
      const result = stripHtmlComments(input)

      expect(result.content).not.toContain('<!--')
      expect(result.stripped).toBe(true)
    })

    it('should return unchanged if no comments', () => {
      const input = 'Hello World'
      const result = stripHtmlComments(input)

      expect(result.content).toBe(input)
      expect(result.stripped).toBe(false)
    })
  })
})
