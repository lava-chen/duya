import { promises as fs } from 'node:fs'
import { mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function getDuyaRoot(): string {
  const envPath = process.env.DUYA_APP_DATA_PATH
  if (envPath) return envPath
  return path.join(os.homedir(), '.duya')
}

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