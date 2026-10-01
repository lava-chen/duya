import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../../logging/logger';
import type { SessionImportItem } from '../types';

const logger = getLogger();
const COMPONENT = 'CodexSessionScanner' as LogComponent;

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function* walkDirs(dirPath: string): AsyncGenerator<string> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        yield* walkDirs(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        yield fullPath;
      }
    }
  } catch {
    // skip inaccessible directories
  }
}

interface CodexJsonlLine {
  type: string;
  payload?: {
    type?: string;
    role?: string;
    content?: string;
    name?: string;
    arguments?: string;
    id?: string;
    call_id?: string;
    output?: string;
  };
  timestamp?: string;
}

async function parseSessionFile(filePath: string): Promise<{
  messageCount: number;
  firstUserMessage: string | null;
  workingDirectory: string | null;
  lastTimestamp: number | null;
} | null> {
  let messageCount = 0;
  let firstUserMessage: string | null = null;
  let workingDirectory: string | null = null;
  let lastTimestamp: number | null = null;

  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const parsed: CodexJsonlLine = JSON.parse(line);

        if (parsed.timestamp) {
          const ts = new Date(parsed.timestamp).getTime();
          if (!isNaN(ts)) {
            lastTimestamp = ts;
          }
        }

        if (parsed.type === 'response_item') {
          const payload = parsed.payload;
          if (!payload) continue;

          if (payload.type === 'message') {
            messageCount++;
            if (payload.role === 'user' && !firstUserMessage && payload.content) {
              firstUserMessage = payload.content;
            }
          } else if (
            payload.type === 'function_call' ||
            payload.type === 'custom_tool_call' ||
            payload.type === 'function_call_output' ||
            payload.type === 'custom_tool_call_output'
          ) {
            messageCount++;
          }
        } else if (parsed.type === 'event_msg') {
          const payload = parsed.payload;
          if (payload?.type === 'cwd' && (payload as Record<string, unknown>).cwd) {
            workingDirectory = (payload as Record<string, unknown>).cwd as string;
          }
        }
      } catch {
        logger.debug('Skipping unparseable JSONL line', { filePath }, COMPONENT);
      }
    }

    rl.close();
    fileStream.destroy();
  } catch (err) {
    logger.warn('Failed to read session file', { filePath, error: String(err) }, COMPONENT);
    return null;
  }

  if (messageCount === 0) return null;

  return { messageCount, firstUserMessage, workingDirectory, lastTimestamp };
}

function extractSessionIdFromPath(filePath: string): string {
  const fileName = path.basename(filePath, '.jsonl');
  const parts = fileName.split('-');
  if (parts.length >= 5) {
    return parts.slice(1).join('-');
  }
  return fileName;
}

export async function scanCodexSessions(): Promise<SessionImportItem[]> {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const items: SessionImportItem[] = [];

  if (!(await dirExists(sessionsDir))) {
    logger.debug('No Codex sessions directory found', { path: sessionsDir }, COMPONENT);
    return items;
  }

  let fileCount = 0;
  for await (const filePath of walkDirs(sessionsDir)) {
    fileCount++;
    try {
      const stat = await fs.promises.stat(filePath);
      const result = await parseSessionFile(filePath);
      if (!result) continue;

      const title = result.firstUserMessage
        ? result.firstUserMessage.slice(0, 80)
        : 'Imported Session';

      const workingDir = result.workingDirectory || '';
      const projectName = workingDir ? path.basename(workingDir) : '';

      items.push({
        id: randomUUID(),
        source: 'codex',
        sourcePath: filePath,
        sessionId: extractSessionIdFromPath(filePath),
        title,
        messageCount: result.messageCount,
        workingDirectory: workingDir,
        projectName,
        createdAt: result.lastTimestamp || stat.birthtimeMs,
        lastActivityAt: result.lastTimestamp || stat.mtimeMs,
        sizeBytes: stat.size,
        defaultSelected: true,
      });
    } catch (err) {
      logger.warn('Failed to scan session file', { filePath, error: String(err) }, COMPONENT);
    }
  }

  logger.info('Codex session scan complete', { fileCount, sessionCount: items.length }, COMPONENT);
  return items;
}