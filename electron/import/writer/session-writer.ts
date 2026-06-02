import * as fs from 'fs';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { createSession, deleteSession } from '../../db/queries/sessions';
import { addMessage } from '../../db/queries/messages';
import { getLogger, LogComponent } from '../../logging/logger';
import type { SessionImportItem } from '../types';

const logger = getLogger();
const COMPONENT = 'SessionWriter' as LogComponent;

interface ParsedMessage {
  id: string;
  role: string;
  content: string;
  msg_type: string;
  tool_name?: string;
  tool_input?: string;
  parent_tool_call_id?: string;
  thinking?: string;
  seq_index: number;
  created_at: number;
}

function parseCodexJsonlLine(line: string): ParsedMessage | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'response_item' || !parsed.payload) return null;

    const { payload, timestamp } = parsed;
    const ts = timestamp ? new Date(timestamp).getTime() : Date.now();

    if (payload.type === 'message') {
      return {
        id: payload.id || randomUUID(),
        role: payload.role || 'unknown',
        content: typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content),
        msg_type: 'text',
        seq_index: 0,
        created_at: isNaN(ts) ? Date.now() : ts,
      };
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      return {
        id: payload.id || randomUUID(),
        role: 'assistant',
        content: payload.arguments || '',
        msg_type: 'tool_use',
        tool_name: payload.name || '',
        tool_input: payload.arguments || '',
        seq_index: 0,
        created_at: isNaN(ts) ? Date.now() : ts,
      };
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      return {
        id: payload.id || randomUUID(),
        role: 'tool',
        content: payload.output || '',
        msg_type: 'tool_result',
        parent_tool_call_id: payload.call_id || '',
        seq_index: 0,
        created_at: isNaN(ts) ? Date.now() : ts,
      };
    }

    return null;
  } catch {
    return null;
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
      input?: Record<string, unknown>;
      tool_use_id?: string;
    }>;
  };
}

function parseClaudeJsonlLine(line: string): ParsedMessage | null {
  try {
    const parsed: ClaudeJsonlLine = JSON.parse(line);
    if (!parsed.type) return null;

    const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now();
    const createdAt = isNaN(ts) ? Date.now() : ts;
    const msgId = parsed.uuid || randomUUID();

    if (parsed.type === 'system' || parsed.type === 'checkpoint' || parsed.type === 'file-history-snapshot') {
      return null;
    }

    const content = parsed.message?.content;

    if (parsed.type === 'user') {
      if (typeof content === 'string') {
        return {
          id: msgId,
          role: 'user',
          content,
          msg_type: 'text',
          seq_index: 0,
          created_at: createdAt,
        };
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            return {
              id: msgId,
              role: 'tool',
              content: typeof block.text === 'string' ? block.text : JSON.stringify(block),
              msg_type: 'tool_result',
              parent_tool_call_id: block.tool_use_id || parsed.parentUuid || '',
              seq_index: 0,
              created_at: createdAt,
            };
          }
          if (block.type === 'text') {
            return {
              id: msgId,
              role: 'user',
              content: block.text || '',
              msg_type: 'text',
              seq_index: 0,
              created_at: createdAt,
            };
          }
        }
      }
    }

    if (parsed.type === 'assistant') {
      if (typeof content === 'string') {
        return {
          id: msgId,
          role: 'assistant',
          content,
          msg_type: 'text',
          seq_index: 0,
          created_at: createdAt,
        };
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            return {
              id: msgId,
              role: 'assistant',
              content: block.text || '',
              msg_type: 'text',
              seq_index: 0,
              created_at: createdAt,
            };
          }
          if (block.type === 'tool_use') {
            return {
              id: msgId,
              role: 'assistant',
              content: block.input ? JSON.stringify(block.input) : '',
              msg_type: 'tool_use',
              tool_name: block.name || '',
              tool_input: block.input ? JSON.stringify(block.input) : '',
              seq_index: 0,
              created_at: createdAt,
            };
          }
          if (block.type === 'thinking') {
            return {
              id: msgId,
              role: 'assistant',
              content: block.thinking || '',
              msg_type: 'thinking',
              thinking: block.thinking || '',
              seq_index: 0,
              created_at: createdAt,
            };
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

function isCodexSource(item: SessionImportItem): boolean {
  return item.source === 'codex';
}

async function parseMessages(
  filePath: string,
  isCodex: boolean,
): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];
  let seqIndex = 0;

  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      const parsed = isCodex ? parseCodexJsonlLine(line) : parseClaudeJsonlLine(line);
      if (parsed) {
        parsed.seq_index = seqIndex++;
        messages.push(parsed);
      }
    }

    rl.close();
    fileStream.destroy();
  } catch (err) {
    logger.warn('Failed to parse session messages', { filePath, error: String(err) }, COMPONENT);
  }

  return messages;
}

export interface SessionWriteResult {
  sessionId: string;
  written: number;
}

export async function writeSessions(
  items: SessionImportItem[],
  _batchId: string,
): Promise<SessionWriteResult[]> {
  const results: SessionWriteResult[] = [];

  for (const item of items) {
    try {
      const isCodex = isCodexSource(item);
      const messages = await parseMessages(item.sourcePath, isCodex);

      if (messages.length === 0) {
        logger.debug('Session has no parseable messages, skipping', { sessionId: item.sessionId }, COMPONENT);
        continue;
      }

      createSession({
        id: item.sessionId,
        title: item.title,
        working_directory: item.workingDirectory,
        project_name: item.projectName,
        status: 'active',
        mode: 'code',
        provider_id: 'env',
        agent_type: 'main',
      });

      let seqIndex = 0;
      for (const msg of messages) {
        addMessage({
          id: msg.id,
          session_id: item.sessionId,
          role: msg.role,
          content: msg.content,
          msg_type: msg.msg_type,
          tool_name: msg.tool_name,
          tool_input: msg.tool_input,
          parent_tool_call_id: msg.parent_tool_call_id,
          thinking: msg.thinking,
          seq_index: seqIndex++,
          status: 'done',
        });
      }

      results.push({
        sessionId: item.sessionId,
        written: messages.length,
      });

      logger.info('Session imported', { sessionId: item.sessionId, messageCount: messages.length }, COMPONENT);
    } catch (err) {
      logger.warn('Failed to import session', { sessionId: item.sessionId, error: String(err) }, COMPONENT);
    }
  }

  return results;
}

export async function rollbackSessions(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      deleteSession(sessionId);
      logger.info('Session rolled back', { sessionId }, COMPONENT);
    } catch (err) {
      logger.warn('Failed to rollback session', { sessionId, error: String(err) }, COMPONENT);
    }
  }
}