import { promises as fs, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { getDuyaRoot } from '../utils/duyaRoot.js'

export class OutputFileWriter {
  static allocate(taskId: string): string {
    const dir = path.join(getDuyaRoot(), 'subagent-transcripts')
    mkdirSync(dir, { recursive: true })
    return path.join(dir, `${taskId}.jsonl`)
  }

  static async append(filePath: string, line: object): Promise<void> {
    await fs.appendFile(filePath, JSON.stringify(line) + '\n', 'utf8')
  }

  static async close(_filePath: string): Promise<void> {
    // appendFile is unbuffered; explicit close is a no-op
    // kept for API symmetry + future buffered implementation
  }
}