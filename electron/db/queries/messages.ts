/**
 * queries/messages.ts - Message SQL queries
 *
 * Extracted from db-handlers.ts IPC handlers.
 * All functions operate on messages table.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from '../connection';

type BetterSqlite3 = InstanceType<typeof import('better-sqlite3')>;

function db(): BetterSqlite3 {
  const d = getDatabase();
  if (!d) throw new Error('Database not initialized');
  return d;
}

export interface AddMessageInput {
  id: string;
  session_id: string;
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  token_usage?: string;
  msg_type?: string;
  thinking?: string;
  tool_name?: string;
  tool_input?: string;
  parent_tool_call_id?: string;
  viz_spec?: string;
  status?: string;
  seq_index?: number;
  duration_ms?: number;
  sub_agent_id?: string;
  attachments?: unknown[];
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  name: string | null;
  tool_call_id: string | null;
  token_usage: string | null;
  msg_type: string;
  thinking: string | null;
  tool_name: string | null;
  tool_input: string | null;
  parent_tool_call_id: string | null;
  viz_spec: string | null;
  status: string;
  seq_index: number | null;
  duration_ms: number | null;
  sub_agent_id: string | null;
  attachments: string | null;
  created_at: number;
}

const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
  VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
`;

export function addMessage(data: AddMessageInput): MessageRow {
  const now = Date.now();
  db().prepare(INSERT_MESSAGE_SQL).run({
    id: data.id,
    session_id: data.session_id,
    role: data.role,
    content: data.content,
    name: data.name ?? null,
    tool_call_id: data.tool_call_id ?? null,
    token_usage: data.token_usage ?? null,
    msg_type: data.msg_type ?? 'text',
    thinking: data.thinking ?? null,
    tool_name: data.tool_name ?? null,
    tool_input: data.tool_input ?? null,
    parent_tool_call_id: data.parent_tool_call_id ?? null,
    viz_spec: data.viz_spec ?? null,
    status: data.status ?? 'done',
    seq_index: data.seq_index ?? null,
    duration_ms: data.duration_ms ?? null,
    sub_agent_id: data.sub_agent_id ?? null,
    attachments: data.attachments ? JSON.stringify(data.attachments) : null,
    created_at: now,
  });

  db().prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id);

  // Return constructed MessageRow directly instead of re-querying
  return {
    id: data.id,
    session_id: data.session_id,
    role: data.role,
    content: data.content,
    name: data.name ?? null,
    tool_call_id: data.tool_call_id ?? null,
    token_usage: data.token_usage ?? null,
    msg_type: data.msg_type ?? 'text',
    thinking: data.thinking ?? null,
    tool_name: data.tool_name ?? null,
    tool_input: data.tool_input ?? null,
    parent_tool_call_id: data.parent_tool_call_id ?? null,
    viz_spec: data.viz_spec ?? null,
    status: data.status ?? 'done',
    seq_index: data.seq_index ?? null,
    duration_ms: data.duration_ms ?? null,
    sub_agent_id: data.sub_agent_id ?? null,
    attachments: data.attachments ? JSON.stringify(data.attachments) : null,
    created_at: now,
  };
}

export function getMessagesBySession(sessionId: string): MessageRow[] {
  return db().prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as MessageRow[];
}

export function getMessageCount(sessionId: string): number {
  const result = db().prepare(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
  ).get(sessionId) as { count: number };
  return result.count;
}

export function deleteMessagesBySession(sessionId: string): number {
  const result = db().prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  return result.changes;
}

export function truncateMessagesAfter(sessionId: string, messageId: string): number {
  const target = db().prepare(
    'SELECT created_at FROM messages WHERE id = ? AND session_id = ?'
  ).get(messageId, sessionId) as { created_at: number } | undefined;

  if (!target) return 0;

  const result = db().prepare(
    'DELETE FROM messages WHERE session_id = ? AND created_at > ?'
  ).run(sessionId, target.created_at);

  db().prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);

  return result.changes;
}

export interface ReplaceMessagesResult {
  success: boolean;
  newGeneration?: number;
  messageCount?: number;
  reason?: string;
}

export function replaceMessages(
  sessionId: string,
  rawMessages: unknown[],
  generation: number,
): ReplaceMessagesResult {
  const now = Date.now();

  const session = db().prepare(
    'SELECT generation FROM chat_sessions WHERE id = ?'
  ).get(sessionId) as { generation: number } | undefined;

  if (!session) {
    return { success: false, reason: 'session_not_found' };
  }

  if (generation < session.generation) {
    return { success: false, reason: 'stale_generation' };
  }

  const newGeneration = Math.max(generation, session.generation + 1);

  try {
    db().transaction(() => {
      db().prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?')
        .run(newGeneration, now, sessionId);

      db().prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

      const stmt = db().prepare(INSERT_MESSAGE_SQL);

      for (const rawMsg of rawMessages) {
        const msg = rawMsg as Record<string, unknown>;
        let msgType = (msg.msg_type as string) || 'text';
        let thinking: string | null = (msg.thinking as string) || null;
        let toolName: string | null = (msg.tool_name as string) || null;
        let toolInput: string | null = (msg.tool_input as string) || null;
        let parentToolCallId: string | null = (msg.parent_tool_call_id as string) || null;
        let contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        if (!msg.msg_type && Array.isArray(msg.content)) {
          const blocks = msg.content as Array<{ type: string; thinking?: string; name?: string; input?: unknown; tool_use_id?: string }>;
          const types = blocks.map(b => b.type);
          if (types.includes('thinking') && types.length === 1) {
            msgType = 'thinking';
            thinking = blocks[0].thinking || null;
            contentStr = thinking || '';
          } else if (types.includes('tool_use') && types.length === 1) {
            msgType = 'tool_use';
            toolName = blocks[0].name || null;
            toolInput = blocks[0].input ? JSON.stringify(blocks[0].input) : null;
            contentStr = toolInput || '';
          } else if (msg.role === 'tool') {
            msgType = 'tool_result';
            parentToolCallId = (msg.tool_call_id as string) || null;
          } else {
            const thinkingBlock = blocks.find(b => b.type === 'thinking');
            if (thinkingBlock) thinking = thinkingBlock.thinking || null;
          }
        } else if (!msg.msg_type && typeof msg.content === 'string') {
          if (msg.role === 'tool') {
            msgType = 'tool_result';
            parentToolCallId = (msg.tool_call_id as string) || null;
          }
        }

        const attachments = msg.attachments
          ? (typeof msg.attachments === 'string' ? msg.attachments : JSON.stringify(msg.attachments))
          : null;

        stmt.bind({
          id: (msg.id as string) || randomUUID(),
          session_id: sessionId,
          role: msg.role as string,
          content: contentStr,
          name: (msg.name as string) || null,
          tool_call_id: (msg.tool_call_id as string) || null,
          token_usage: (msg.token_usage as string) || null,
          msg_type: msgType,
          thinking,
          tool_name: toolName,
          tool_input: toolInput,
          parent_tool_call_id: parentToolCallId,
          viz_spec: (msg.viz_spec as string) || null,
          status: (msg.status as string) || 'done',
          seq_index: (msg.seq_index as number) ?? null,
          duration_ms: (msg.duration_ms as number) ?? null,
          sub_agent_id: (msg.sub_agent_id as string) || null,
          attachments,
          created_at: (msg.timestamp as number) || now,
        });
        stmt.step();
        stmt.reset();
      }
      stmt.free();
    })();

    return { success: true, newGeneration, messageCount: rawMessages.length };
  } catch (error) {
    return { success: false, reason: error instanceof Error ? error.message : String(error) };
  }
}