import * as fs from 'fs';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { ipcMessageToNewEvent } from '../../ipc/core-db-adapters';
import { getDesktopHostLocalRolloutApi, getDesktopHostSessionApi } from '../../cli/desktop-host-api';
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
  tool_call_id?: string;
  parent_tool_call_id?: string;
  thinking?: string;
  seq_index: number;
  created_at: number;
}

export function parseCodexJsonlLine(line: string): ParsedMessage[] | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'response_item' || !parsed.payload) return null;

    const { payload, timestamp } = parsed;
    const ts = timestamp ? new Date(timestamp).getTime() : Date.now();
    const createdAt = isNaN(ts) ? Date.now() : ts;

    if (payload.type === 'message') {
      // Codex `developer`/`system` roles map to the combined `system` role.
      const role = payload.role === 'developer' || payload.role === 'system' ? 'system' : (payload.role || 'user');
      // Content may be a plain string or an array of input_text blocks.
      const rawContent: unknown = payload.content;
      let content = '';
      if (typeof rawContent === 'string') content = rawContent;
      else if (Array.isArray(rawContent)) {
        content = rawContent.map((b: { text?: string } | string) => typeof b === 'string' ? b : (b.text ?? '')).join('');
      } else content = JSON.stringify(rawContent);
      return [{
        id: payload.id || randomUUID(),
        role,
        content,
        msg_type: 'text',
        seq_index: 0,
        created_at: createdAt,
      }];
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      return [{
        id: payload.id || randomUUID(),
        role: 'assistant',
        content: payload.arguments || '',
        msg_type: 'tool_use',
        tool_call_id: payload.id || '',
        tool_name: payload.name || '',
        tool_input: payload.arguments || '',
        seq_index: 0,
        created_at: createdAt,
      }];
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      // Rollout output may be a string (legacy) or an array of content blocks
      // (codex-compatible: [{type:'input_text', text:'...'}]). Normalize to text.
      const rawOutput = payload.output;
      const outputText = Array.isArray(rawOutput)
        ? rawOutput.map((block: { text?: string } | string) => typeof block === 'string' ? block : (block.text ?? '')).join('')
        : (typeof rawOutput === 'string' ? rawOutput : '');
      return [{
        id: payload.id || randomUUID(),
        role: 'tool',
        content: outputText || '',
        msg_type: 'tool_result',
        tool_call_id: payload.call_id || '',
        parent_tool_call_id: payload.call_id || '',
        seq_index: 0,
        created_at: createdAt,
      }];
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
      content?: string | Array<{ type: string; text?: string }>;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
    }>;
  };
}

export function parseClaudeJsonlLine(line: string): ParsedMessage[] | null {
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
    const out: ParsedMessage[] = [];

    if (parsed.type === 'user') {
      if (typeof content === 'string') {
        out.push({
          id: msgId,
          role: 'user',
          content,
          msg_type: 'text',
          seq_index: 0,
          created_at: createdAt,
        });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            // Tool result output may be a plain string or an array of content
            // blocks (e.g. [{type:'text', text:'...'}]). Normalize to text.
            const rawOutput = block.content;
            const outputText = Array.isArray(rawOutput)
              ? rawOutput.map((b) => (typeof b === 'string' ? b : (b.text ?? ''))).join('')
              : (typeof rawOutput === 'string' ? rawOutput : '');
            out.push({
              id: msgId,
              role: 'tool',
              content: outputText || '',
              msg_type: 'tool_result',
              tool_call_id: block.tool_use_id || parsed.parentUuid || '',
              parent_tool_call_id: block.tool_use_id || parsed.parentUuid || '',
              seq_index: 0,
              created_at: createdAt,
            });
          } else if (block.type === 'text') {
            out.push({
              id: msgId,
              role: 'user',
              content: block.text || '',
              msg_type: 'text',
              seq_index: 0,
              created_at: createdAt,
            });
          }
        }
      }
    }

    if (parsed.type === 'assistant') {
      if (typeof content === 'string') {
        out.push({
          id: msgId,
          role: 'assistant',
          content,
          msg_type: 'text',
          seq_index: 0,
          created_at: createdAt,
        });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            out.push({
              id: msgId,
              role: 'assistant',
              content: block.text || '',
              msg_type: 'text',
              seq_index: 0,
              created_at: createdAt,
            });
          } else if (block.type === 'tool_use') {
            out.push({
              id: msgId,
              role: 'assistant',
              content: block.input ? JSON.stringify(block.input) : '',
              msg_type: 'tool_use',
              tool_call_id: block.id || '',
              tool_name: block.name || '',
              tool_input: block.input ? JSON.stringify(block.input) : '',
              seq_index: 0,
              created_at: createdAt,
            });
          } else if (block.type === 'thinking') {
            out.push({
              id: msgId,
              role: 'assistant',
              content: block.thinking || '',
              msg_type: 'thinking',
              thinking: block.thinking || '',
              seq_index: 0,
              created_at: createdAt,
            });
          }
        }
      }
    }

    return out.length > 0 ? out : null;
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
        for (const msg of parsed) {
          msg.seq_index = seqIndex++;
          messages.push(msg);
        }
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
    let createdByImport = false;
    try {
      const isCodex = isCodexSource(item);
      const messages = await parseMessages(item.sourcePath, isCodex);

      if (messages.length === 0) {
        logger.debug('Session has no parseable messages, skipping', { sessionId: item.sessionId }, COMPONENT);
        continue;
      }

      await getDesktopHostLocalRolloutApi().createImportedSession({
        sessionId: item.sessionId,
        title: item.title,
        workingDirectory: item.workingDirectory,
        projectName: item.projectName,
      });
      createdByImport = true;

      const entries = messages.map((msg) =>
        ipcMessageToNewEvent(item.sessionId, { ...msg, session_id: item.sessionId }).payload,
      );
      const sessionApi = getDesktopHostSessionApi();
      for (let offset = 0; offset < entries.length; offset += 50) {
        await sessionApi.appendTimeline(item.sessionId, { entries: entries.slice(offset, offset + 50) });
      }

      results.push({
        sessionId: item.sessionId,
        written: messages.length,
      });

      logger.info('Session imported', { sessionId: item.sessionId, messageCount: messages.length }, COMPONENT);
    } catch (err) {
      if (createdByImport) {
        try {
          const rollback = await getDesktopHostLocalRolloutApi().rollbackImportedSessions([item.sessionId]);
          if (rollback.failedSessionIds.includes(item.sessionId)) {
            logger.warn('Failed to clean up a partially imported session', { sessionId: item.sessionId }, COMPONENT);
          }
        } catch {
          // Preserve the original import error; batch rollback can retry cleanup.
        }
      }
      logger.warn('Failed to import session', { sessionId: item.sessionId, error: String(err) }, COMPONENT);
    }
  }

  return results;
}

export async function rollbackSessions(sessionIds: string[]): Promise<void> {
  const result = await getDesktopHostLocalRolloutApi().rollbackImportedSessions(sessionIds);
  for (const sessionId of result.deletedSessionIds) {
    logger.info('Session rolled back', { sessionId }, COMPONENT);
  }
  for (const sessionId of result.failedSessionIds) {
    logger.warn('Failed to rollback session', { sessionId }, COMPONENT);
  }
}
