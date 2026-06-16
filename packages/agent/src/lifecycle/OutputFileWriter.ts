import { promises as fs } from 'node:fs'
import { mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function getAppDataDir(): string {
  const envPath = process.env.DUYA_APP_DATA_PATH
  if (envPath) return envPath
  const platform = process.platform
  if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'DUYA')
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'DUYA')
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'DUYA')
}

export class OutputFileWriter {
  static allocate(taskId: string): string {
    const dir = path.join(getAppDataDir(), 'subagent-transcripts')
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