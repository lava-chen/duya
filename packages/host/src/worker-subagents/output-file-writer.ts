import { promises as fs, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { resolveDataRoot } from '@duya/data/data-paths'

function getOutputRoot(): string {
  const legacyRoot = process.env.DUYA_APP_DATA_PATH?.trim()
  if (!process.env.DUYA_DATA_ROOT?.trim() && legacyRoot) return legacyRoot
  return resolveDataRoot()
}

export class OutputFileWriter {
  static allocate(taskId: string): string {
    const dir = path.join(getOutputRoot(), 'subagent-transcripts')
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
