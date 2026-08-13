import { describe, it, expect } from 'vitest'
import type { Message, MessageContent, ToolResultContent } from '../../types.js'
import { reformatGrepResult, reformatGlobResult, reformatTransform, stripToolResultEnvelope } from '../transforms/reformatCompress.js'

describe('reformatCompress', () => {
  it('reformats a grep result into a table, preserving the envelope', () => {
    const result = JSON.stringify({
      success: true, total: 1, truncated: false, searchPath: '.', engine: 'ripgrep',
      matches: [{ file: 'src/a.ts', line: 12, column: 3, content: 'const x = 1' }],
    })
    const rebuilt = reformatGrepResult(result)
    expect(JSON.parse(rebuilt!)).toEqual({
      success: true, total: 1, truncated: false, searchPath: '.', engine: 'ripgrep',
      matches: '[1]{file,line:int,column:int,content}\nsrc/a.ts,12,3,const x = 1',
    })
  })

  it('returns null for non-JSON or non-grep-shaped input', () => {
    expect(reformatGrepResult('not json')).toBeNull()
    expect(reformatGrepResult('{"foo":1}')).toBeNull()
    expect(reformatGrepResult('{"matches":[]}')).toBeNull()
  })

  it('strips the status/duration envelope before reformatting', () => {
    const result = '[completed] grep\n' + JSON.stringify({
      success: true, total: 1, truncated: false, searchPath: '.', engine: 'ripgrep',
      matches: [{ file: 'src/a.ts', line: 12, column: 3, content: 'const x = 1' }],
    }) + '\n[Duration: 42ms]'
    const rebuilt = reformatGrepResult(result)
    expect(rebuilt).not.toBeNull()
    expect(JSON.parse(rebuilt!)).toEqual({
      success: true, total: 1, truncated: false, searchPath: '.', engine: 'ripgrep',
      matches: '[1]{file,line:int,column:int,content}\nsrc/a.ts,12,3,const x = 1',
    })
  })

  it('leaves input unchanged when no envelope is present', () => {
    expect(stripToolResultEnvelope('[completed] grep\nhello')).toBe('hello')
    expect(stripToolResultEnvelope('plain text')).toBe('plain text')
  })

  it('reformats a glob output into a filename list table', () => {
    const result = JSON.stringify({ durationMs: 1, numFiles: 2, truncated: false, filenames: ['src/a.ts', 'src/b.ts'] })
    const rebuilt = reformatGlobResult(result)
    expect(JSON.parse(rebuilt!)).toEqual({
      durationMs: 1, numFiles: 2, truncated: false,
      filenames: '[2]{filename}\nsrc/a.ts\nsrc/b.ts',
    })
  })

  it('rewrites a historical grep tool_result but leaves the last user turn intact', () => {
    const messages: Message[] = [
      { role: 'user', content: 'search' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: JSON.stringify({
            success: true, total: 1,
            matches: [{ file: 'a.ts', line: 1, column: 1, content: 'x' }],
          }),
        }],
      },
      { role: 'user', content: 'please summarize' },
    ]
    const out = reformatTransform.apply(messages)
    const block = (out[2].content as MessageContent[])[0] as ToolResultContent
    const parsed = JSON.parse(block.content as string)
    expect(parsed.matches).toContain('[1]{file,line:int,column:int,content}')
  })
})