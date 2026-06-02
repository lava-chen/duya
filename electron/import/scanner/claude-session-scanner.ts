import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../../logging/logger';
import type { SessionImportItem } from '../types';

const logger = getLogger();
const COMPONENT = 'ClaudeSessionScanner' as LogComponent;

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readDir(dirPath: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dirPath);
  } catch {
    return [];
  }
}

interface ClaudeJsonlLine {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    content?: string | Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: unknown;
      tool_use_id?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  cwd?: string;
  model?: string;
}

async function parseSessionFile(filePath: string): Promise<{
  messageCount: number;
  firstUserMessage: string | null;
  workingDirectory: string | null;
  sessionId: string | null;
  lastTimestamp: number | null;
} | null> {
  let messageCount = 0;
  let firstUserMessage: string | null = null;
  let workingDirectory: string | null = null;
  let sessionId: string | null = null;
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
        const parsed: ClaudeJsonlLine = JSON.parse(line);

        if (parsed.sessionId && !sessionId) {
          sessionId = parsed.sessionId;
        }

        if (parsed.timestamp) {
          const ts = new Date(parsed.timestamp).getTime();
          if (!isNaN(ts)) {
            lastTimestamp = ts;
          }
        }

        if (parsed.type === 'user') {
          const content = parsed.message?.content;
          if (typeof content === 'string') {
            messageCount++;
            if (!firstUserMessage) {
              firstUserMessage = content;
            }
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                messageCount++;
              } else if (block.type === 'text') {
                messageCount++;
                if (!firstUserMessage && block.text) {
                  firstUserMessage = block.text;
                }
              }
            }
          }
        } else if (parsed.type === 'assistant') {
          const content = parsed.message?.content;
          if (typeof content === 'string') {
            messageCount++;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                messageCount++;
              } else if (block.type === 'tool_use') {
                messageCount++;
              } else if (block.type === 'thinking') {
                messageCount++;
              }
            }
          }
        } else if (parsed.type === 'system') {
          if (!workingDirectory && parsed.cwd) {
            workingDirectory = parsed.cwd;
          }
        } else if (parsed.type === 'checkpoint') {
          // skip
        } else if (parsed.type === 'file-history-snapshot') {
          // skip
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

  return { messageCount, firstUserMessage, workingDirectory, sessionId, lastTimestamp };
}

export async function scanClaudeSessions(): Promise<SessionImportItem[]> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const items: SessionImportItem[] = [];

  if (!(await dirExists(projectsDir))) {
    logger.debug('No Claude Code projects directory found', { path: projectsDir }, COMPONENT);
    return items;
  }

  const projectEntries = await readDir(projectsDir);

  let fileCount = 0;
  for (const projectEntry of projectEntries) {
    const projectPath = path.join(projectsDir, projectEntry);
    if (!(await dirExists(projectPath))) continue;

    const entries = await readDir(projectPath);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      if (entry.startsWith('.')) continue; // skip hidden files

      const filePath = path.join(projectPath, entry);
      fileCount++;

      try {
        const stat = await fs.promises.stat(filePath);
        const result = await parseSessionFile(filePath);
        if (!result) continue;

        const title = result.firstUserMessage
          ? result.firstUserMessage.slice(0, 80)
          : 'Imported Session';

        const workingDir = result.workingDirectory || '';
        const projectName = workingDir ? path.basename(workingDir) : projectEntry;

        items.push({
          id: randomUUID(),
          source: 'claude-code',
          sourcePath: filePath,
          sessionId: result.sessionId || entry.replace('.jsonl', ''),
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
  }

  logger.info('Claude Code session scan complete', { fileCount, sessionCount: items.length }, COMPONENT);
  return items;
}