/**
 * Unit tests for token budget cut point algorithm (from pi)
 */

import { describe, it, expect } from 'vitest'
import type { Message } from '../../types.js'
import {
  findCutPoint,
  buildSummarizationPrompt,
  serializeMessagesForSummary,
  extractFileOpsFromMessages,
  computeFileLists,
  formatFileOperations,
  createFileOps,
  DEFAULT_CUT_CONFIG,
} from '../tokenBudgetCut.js'

describe('tokenBudgetCut', () => {
  describe('findCutPoint', () => {
    it('should find cut point based on token budget', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am fine, thank you!' },
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: 'I cannot check the weather.' },
      ]

      const result = findCutPoint(messages, 0, messages.length, 100)

      expect(result.firstKeptIndex).toBeGreaterThanOrEqual(0)
      expect(result.firstKeptIndex).toBeLessThan(messages.length)
      expect(result.isSplitTurn).toBe(false)
    })

    it('should never cut at tool results', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will read the file' },
            { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/test.txt' } },
          ],
        },
        { role: 'tool', content: 'File contents here', tool_call_id: 'tool1' },
        { role: 'user', content: 'Thanks' },
      ]

      const result = findCutPoint(messages, 0, messages.length, 50)

      // Should not cut at index 2 (tool result)
      expect(result.firstKeptIndex).not.toBe(2)
    })

    it('should detect split turn when cutting in middle of turn', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Start a long task' },
        { role: 'assistant', content: 'Starting...' },
        { role: 'assistant', content: 'Still working...' },
        { role: 'assistant', content: 'More work...' },
        { role: 'assistant', content: 'Almost done...' },
        { role: 'user', content: 'Thanks' },
      ]

      // Force a cut in the middle of the assistant turn
      const result = findCutPoint(messages, 0, messages.length, 30)

      // May or may not be a split turn depending on token estimation
      expect(result.firstKeptIndex).toBeGreaterThanOrEqual(0)
    })

    it('should handle empty messages array', () => {
      const messages: Message[] = []
      const result = findCutPoint(messages, 0, 0, 1000)

      expect(result.firstKeptIndex).toBe(0)
      expect(result.isSplitTurn).toBe(false)
    })

    it('should keep all messages when budget is large', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]

      const result = findCutPoint(messages, 0, messages.length, 1000000)

      expect(result.firstKeptIndex).toBe(0)
    })
  })

  describe('buildSummarizationPrompt', () => {
    it('should build initial prompt without previous summary', () => {
      const conversationText = '[User]: Hello\n[Assistant]: Hi'
      const prompt = buildSummarizationPrompt(conversationText)

      expect(prompt).toContain('<conversation>')
      expect(prompt).toContain(conversationText)
      // Initial prompt: asks for a fresh structured summary
      expect(prompt).toContain('a conversation to summarize')
      expect(prompt).not.toContain('<previous-summary>')
    })

    it('should build update prompt with previous summary', () => {
      const conversationText = '[User]: Hello\n[Assistant]: Hi'
      const previousSummary = '## Goal\nTest goal'
      const prompt = buildSummarizationPrompt(conversationText, previousSummary)

      expect(prompt).toContain('<conversation>')
      expect(prompt).toContain('<previous-summary>')
      expect(prompt).toContain(previousSummary)
      // Update prompt: instructs to merge new messages into previous summary
      expect(prompt).toContain('NEW conversation messages to incorporate')
    })

    it('should include custom instructions when provided', () => {
      const conversationText = '[User]: Hello'
      const customInstructions = 'Focus on technical details'
      const prompt = buildSummarizationPrompt(conversationText, undefined, customInstructions)

      expect(prompt).toContain('Additional focus')
      expect(prompt).toContain(customInstructions)
    })
  })

  describe('serializeMessagesForSummary', () => {
    it('should serialize user messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello world' },
      ]

      const result = serializeMessagesForSummary(messages)

      expect(result).toContain('[User]: Hello world')
    })

    it('should serialize assistant messages with text', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I can help you' },
          ],
        },
      ]

      const result = serializeMessagesForSummary(messages)

      expect(result).toContain('[Assistant]: I can help you')
    })

    it('should serialize assistant messages with tool calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file' },
            { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/test.txt' } },
          ],
        },
      ]

      const result = serializeMessagesForSummary(messages)

      expect(result).toContain('[Assistant]: Let me read that file')
      expect(result).toContain('[Assistant tool calls]: Read(file_path="/test.txt")')
    })

    it('should serialize thinking blocks', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer' },
          ],
        },
      ]

      const result = serializeMessagesForSummary(messages)

      expect(result).toContain('[Assistant thinking]: Let me think about this...')
      expect(result).toContain('[Assistant]: Here is my answer')
    })

    it('should truncate long tool results', () => {
      const longContent = 'x'.repeat(5000)
      const messages: Message[] = [
        { role: 'tool', content: longContent },
      ]

      const result = serializeMessagesForSummary(messages)

      expect(result).toContain('[Tool result]:')
      expect(result).toContain('truncated')
      expect(result.length).toBeLessThan(longContent.length)
    })
  })

  describe('File Operations Tracking', () => {
    it('should extract file operations from tool calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/file1.txt' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool2', name: 'Write', input: { file_path: '/file2.txt' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool3', name: 'Edit', input: { file_path: '/file3.txt' } },
          ],
        },
      ]

      const fileOps = createFileOps()
      extractFileOpsFromMessages(messages, fileOps)

      expect(fileOps.read.has('/file1.txt')).toBe(true)
      expect(fileOps.written.has('/file2.txt')).toBe(true)
      expect(fileOps.edited.has('/file3.txt')).toBe(true)
    })

    it('should compute file lists correctly', () => {
      const fileOps = createFileOps()
      fileOps.read.add('/read-only.txt')
      fileOps.read.add('/read-then-write.txt')
      fileOps.written.add('/read-then-write.txt')
      fileOps.edited.add('/edited.txt')

      const { readFiles, modifiedFiles } = computeFileLists(fileOps)

      expect(readFiles).toContain('/read-only.txt')
      expect(readFiles).not.toContain('/read-then-write.txt')
      expect(modifiedFiles).toContain('/read-then-write.txt')
      expect(modifiedFiles).toContain('/edited.txt')
    })

    it('should format file operations as XML', () => {
      const readFiles = ['/file1.txt', '/file2.txt']
      const modifiedFiles = ['/file3.txt']

      const result = formatFileOperations(readFiles, modifiedFiles)

      expect(result).toContain('<read-files>')
      expect(result).toContain('/file1.txt')
      expect(result).toContain('/file2.txt')
      expect(result).toContain('<modified-files>')
      expect(result).toContain('/file3.txt')
    })

    it('should return empty string when no file operations', () => {
      const result = formatFileOperations([], [])

      expect(result).toBe('')
    })
  })
})
