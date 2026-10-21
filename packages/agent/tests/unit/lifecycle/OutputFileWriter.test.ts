import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { OutputFileWriter } from '../../../src/lifecycle/OutputFileWriter.js'

let tmpDir: string
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofw-'))
  process.env.DUYA_APP_DATA_PATH = tmpDir
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('OutputFileWriter', () => {
  it('allocate returns a path under subagent-transcripts/<taskId>.jsonl', () => {
    const p = OutputFileWriter.allocate('abc-123')
    expect(p.endsWith(path.join('subagent-transcripts', 'abc-123.jsonl'))).toBe(true)
  })

  it('allocate creates the parent directory', async () => {
    const p = OutputFileWriter.allocate('abc-123')
    const parent = path.dirname(p)
    const stat = await fs.stat(parent)
    expect(stat.isDirectory()).toBe(true)
  })

  it('append produces valid jsonl', async () => {
    const p = OutputFileWriter.allocate('task-1')
    await OutputFileWriter.append(p, { at: 1, type: 'text', payload: 'hello' })
    await OutputFileWriter.append(p, { at: 2, type: 'done' })
    const content = await fs.readFile(p, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ at: 1, type: 'text', payload: 'hello' })
    expect(JSON.parse(lines[1])).toEqual({ at: 2, type: 'done' })
  })
})