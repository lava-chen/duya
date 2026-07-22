/**
 * db-handlers.ts - Database IPC Handlers (thin proxy layer)
 *
 * Database lifecycle, schema, and migration have moved to electron/db/.
 * This file now only contains IPC handler registration and delegates
 * lifecycle functions from db/ for backward compatibility.
 */

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool';
import { getAutomationScheduler } from '../automation/Scheduler';
import { getLogger, LogComponent } from '../logging/logger';
import { createSession } from '../db/queries/sessions';
import { createCanvas as createConductorCanvas } from '../db/queries/conductors';
import { getChannelManager } from '../messaging/port-manager';
import { updateDatabasePath, readBootConfig } from '../config/boot-config';
import { emitGatewayConfigChanged, isGatewayConfigKey } from '../gateway/config-events';
import { notifyMcpConfigChanged } from '../services/mcp-write-reload';
import {
  initDatabaseFromBoot,
  initDatabase,
  getDatabase,
  getDatabasePath,
  isSafeMode,
  getSafeModeReason,
  getDatabaseStats,
  checkDatabaseSizeWarning,
} from '../db/index';
import type { DbInitResult, DatabaseStats } from '../db/index';
import { emitMailApplied, emitMailCreated, emitMailEdited, emitMailCancelled } from '../messaging/mailbox-broadcaster';
import { uploadAsset as conductorUploadAsset, uploadProjectAsset as conductorUploadProjectAsset } from '../conductor/asset-service';
import { captureWebsiteSnapshot } from '../conductor/link-snapshot-service';
import { prepareCanvasDocument, syncCanvasDocument } from '../conductor/document-service';
import { markMailboxForGuidance, promoteQueuedMailbox } from '../db/mailbox-transitions';

// Re-export lifecycle functions for backward compatibility
export {
  initDatabaseFromBoot,
  initDatabase,
  getDatabase,
  getDatabasePath,
  isSafeMode,
  getSafeModeReason,
  getDatabaseStats,
  checkDatabaseSizeWarning,
} from '../db/index';
export type { DbInitResult, DatabaseStats } from '../db/index';

function serializeMessageContent(value: unknown, role?: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value) && role === 'user') {
    const textBlocks = value.filter(
      (b: unknown) => (b as Record<string, unknown>).type === 'text'
    );
    return textBlocks.length > 0
      ? textBlocks.map((b: unknown) => (b as Record<string, string>).text || '').join('\n')
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function serializeDisplayContent(value: unknown, role?: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return serializeMessageContent(value, role);
}

// ============================================================
// IPC Handlers Registration
// ============================================================

// Local aliases for backward compatibility with existing handler code
import {
  resolveDatabasePath as _resolveDatabasePath,
  validateDatabasePath,
} from '../config/boot-config';

const dbLogger = getLogger();
const resolveDatabasePath = _resolveDatabasePath;

// Type-safe database access helper. Throws if database is not initialized.
function getDb(): NonNullable<ReturnType<typeof getDatabase>> {
  const database = getDatabase();
  if (!database) {
    throw new Error('Database not initialized');
  }
  return database;
}

export function registerDbHandlers(): void {
  // ==================== Safe Mode Handler ====================

  ipcMain.handle('db:safeModeStatus', () => {
    return {
      isSafeMode: isSafeMode(),
      reason: getSafeModeReason(),
      currentDbPath: getDatabasePath(),
    };
  });

  ipcMain.handle('db:relocateDatabase', async (_event, newDir: string) => {
    const database = getDb();
    const currentPath = database.name;
    const newDbPath = path.join(newDir, 'duya-main.db');

    if (newDbPath === currentPath) {
      return { success: false, error: 'Same path as current' };
    }

    if (fs.existsSync(newDbPath)) {
      return { success: false, error: 'Target database already exists' };
    }

    try {
      const targetDir = path.dirname(newDbPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      fs.copyFileSync(currentPath, newDbPath);

      const walPath = currentPath + '-wal';
      const shmPath = currentPath + '-shm';
      if (fs.existsSync(walPath)) fs.copyFileSync(walPath, newDbPath + '-wal');
      if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, newDbPath + '-shm');

      const bootUpdated = updateDatabasePath(newDbPath);
      if (!bootUpdated) {
        fs.unlinkSync(newDbPath);
        return { success: false, error: 'Failed to update boot.json' };
      }

      return { success: true, newPath: newDbPath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('db:resetToDefaultPath', () => {
    const { dbPath: defaultPath } = resolveDatabasePath();
    const validation = validateDatabasePath(defaultPath);
    if (!validation.valid) {
      return { success: false, error: validation.reason };
    }

    const updated = updateDatabasePath(defaultPath);
    return { success: updated, newPath: defaultPath };
  });

  // ==================== Session Handlers ====================

  ipcMain.handle('db:session:create', (_event, data) => {
    // 委托 query 层, 自动走 permission-resolver 完成 settings → profile 派生 / 父继承逻辑.
    return createSession(data);
  });

  ipcMain.handle('db:session:get', (_event, sessionId: string) => {
    return getDb().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  });

  ipcMain.handle('db:session:update', (_event, sessionId: string, data: Record<string, unknown>) => {
    const now = Date.now();
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { sessionId, updated_at: now };

    const fieldMap: Record<string, string> = {
      title: 'title',
      model: 'model',
      system_prompt: 'system_prompt',
      working_directory: 'working_directory',
      project_name: 'project_name',
      status: 'status',
      mode: 'mode',
      permission_profile: 'permission_profile',
      provider_id: 'provider_id',
      context_summary: 'context_summary',
      parent_id: 'parent_id',
      agent_profile_id: 'agent_profile_id',
      agent_type: 'agent_type',
      agent_name: 'agent_name',
      conductor_mode_enabled: 'conductor_mode_enabled',
      conductor_canvas_id: 'conductor_canvas_id',
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = @${key}`);
        params[key] = data[key];
      }
    }

    const database = getDb();
    database.prepare(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = @sessionId`).run(params);
    return database.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  });

  ipcMain.handle('db:session:delete', (_event, sessionId: string) => {
    const database = getDb();
    const txn = database.transaction(() => {
      // Break parent-child relationships first so the self-referencing FK on
      // chat_sessions.parent_id does not block deletion. Newer schemas use
      // ON DELETE SET NULL plus a trigger, but we keep this for compatibility.
      database.prepare('UPDATE chat_sessions SET parent_id = NULL WHERE parent_id = ?').run(sessionId);
      // Explicitly clean up dependent rows. Most of these tables declare
      // ON DELETE CASCADE, but being explicit makes the deletion order safe
      // and protects against future schema changes that might drop CASCADE.
      database.prepare('DELETE FROM message_attachments WHERE session_id = ?').run(sessionId);
      database.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      database.prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId);
      database.prepare('DELETE FROM research_sessions WHERE session_id = ?').run(sessionId);
      const result = database.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
      return result.changes > 0;
    });
    return txn();
  });

  ipcMain.handle('db:session:list', () => {
    return getDb().prepare("SELECT * FROM chat_sessions WHERE is_deleted = 0 AND mode != 'automation' ORDER BY updated_at DESC").all();
  });

  ipcMain.handle('db:session:listByWorkingDirectory', (_event, workingDirectory: string) => {
    const database = getDb();
    if (!workingDirectory) {
      return database.prepare(
        "SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = '' ORDER BY updated_at DESC"
      ).all();
    }
    return database.prepare(
      'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = ? ORDER BY updated_at DESC'
    ).all(workingDirectory);
  });

  ipcMain.handle('db:session:listByParentId', (_event, parentId: string) => {
    return getDb().prepare(
      'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND parent_id = ? ORDER BY created_at ASC'
    ).all(parentId);
  });

  ipcMain.handle('db:session:saveDraft', (_event, sessionId: string, draft: string) => {
    getDb().prepare('UPDATE chat_sessions SET draft_message = ?, updated_at = ? WHERE id = ?')
      .run(draft, Date.now(), sessionId);
  });

  ipcMain.handle('db:session:getDraft', (_event, sessionId: string) => {
    const row = getDb().prepare('SELECT draft_message FROM chat_sessions WHERE id = ?')
      .get(sessionId) as { draft_message: string } | undefined;
    return row?.draft_message ?? '';
  });

  // ==================== Message Handlers ====================

  ipcMain.handle('db:message:add', (_event, data: {
    id: string;
    session_id: string;
    role: string;
    content: string;
    display_content?: string | null;
    displayContent?: unknown;
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
  }) => {
    const now = Date.now();
    const database = getDb();
    const displayContent = data.display_content ?? serializeDisplayContent(data.displayContent, data.role);
    database.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, display_content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
      VALUES (@id, @session_id, @role, @content, @display_content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
    `).run({
      id: data.id,
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      display_content: displayContent,
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

    database.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id);

    return database.prepare('SELECT * FROM messages WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:message:getBySession', (_event, sessionId: string) => {
    const result = getDb().prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(sessionId);
    return result;
  });

  ipcMain.handle('db:message:getCount', (_event, sessionId: string) => {
    const result = getDb().prepare(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    return result.count;
  });

  ipcMain.handle('db:message:deleteBySession', (_event, sessionId: string) => {
    const result = getDb().prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    return result.changes;
  });

  ipcMain.handle('db:message:replace', (_event, sessionId: string, messages: unknown[], generation: number) => {
    const now = Date.now();
    const database = getDb();

    let sessionGen = database.prepare(
      'SELECT generation FROM chat_sessions WHERE id = ?'
    ).get(sessionId) as { generation: number } | undefined;

    if (!sessionGen) {
      // Auto-create session if it doesn't exist (happens when frontend creates session without DB entry)
      dbLogger.info('Session not found, auto-creating', { sessionId });
      database.prepare(`
        INSERT INTO chat_sessions (
          id, title, model, system_prompt, working_directory,
          project_name, status, mode, provider_id, generation,
          parent_id, agent_type, agent_name,
          created_at, updated_at, is_deleted
        ) VALUES (
          @id, @title, @model, @system_prompt, @working_directory,
          @project_name, @status, @mode, @provider_id, @generation,
          @parent_id, @agent_type, @agent_name,
          @created_at, @updated_at, 0
        )
      `).run({
        id: sessionId,
        title: 'New Chat',
        model: '',
        system_prompt: '',
        working_directory: '',
        project_name: '',
        status: 'active',
        mode: 'code',
        provider_id: 'env',
        generation: 0,
        parent_id: null,
        agent_type: 'main',
        agent_name: '',
        created_at: now,
        updated_at: now,
      });
      // Re-fetch to get the created session
      sessionGen = database.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as { generation: number } | undefined;
      if (!sessionGen) {
        return { success: false, reason: 'session_not_found' };
      }
    }

    if (generation < sessionGen.generation) {
      return { success: false, reason: 'stale_generation' };
    }

    const newGeneration = Math.max(generation, sessionGen.generation + 1);

    try {
      database.transaction(() => {
        database.prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?')
          .run(newGeneration, now, sessionId);

        database.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

        const stmt = database.prepare(`
          INSERT INTO messages (id, session_id, role, content, display_content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
          VALUES (@id, @session_id, @role, @content, @display_content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
        `);

        for (const rawMsg of messages) {
          const msg = rawMsg as Record<string, unknown>;
          let msgType = (msg.msg_type as string) || 'text';
          let thinking: string | null = (msg.thinking as string) || null;
          let toolName: string | null = (msg.tool_name as string) || null;
          let toolInput: string | null = (msg.tool_input as string) || null;
          let parentToolCallId: string | null = (msg.parent_tool_call_id as string) || null;
          let contentStr = serializeMessageContent(msg.content, msg.role);
          const displayContentStr = serializeDisplayContent(msg.displayContent ?? msg.display_content, msg.role);

          // For user messages with image content blocks,
          // extract only the text blocks for DB storage. Image data lives in
          // message_attachments table and should not be stored in content.
          // Assistant messages (thinking, tool_use) keep their full structure.
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            const textBlocks = msg.content.filter(
              (b: unknown) => (b as Record<string, unknown>).type === 'text'
            );
            if (textBlocks.length > 0) {
              contentStr = textBlocks
                .map((b: unknown) => (b as Record<string, string>).text || '')
                .join('\n');
            }
          }

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

          stmt.run({
            id: (msg.id as string) || randomUUID(),
            session_id: sessionId,
            role: msg.role as string,
            content: contentStr,
            display_content: displayContentStr,
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
        }
      })();

      return { success: true, newGeneration, messageCount: (messages as unknown[]).length };
    } catch (error) {
      dbLogger.error('replaceMessages failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.DB);
      return { success: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('db:message:truncateAfter', (_event, sessionId: string, messageId: string) => {
    const database = getDb();
    const result = database.prepare(
      'SELECT created_at FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { created_at: number } | undefined;

    if (!result) return { deletedCount: 0 };

    const deleteResult = database.prepare(
      'DELETE FROM messages WHERE session_id = ? AND created_at > ?'
    ).run(sessionId, result.created_at);

    database.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);

    return { deletedCount: deleteResult.changes };
  });

  // Edit-and-resend: delete the target message AND everything after it
  // (inclusive), so the edited version can be appended as a fresh message.
  ipcMain.handle('db:message:truncateFromInclusive', (_event, sessionId: string, messageId: string) => {
    const database = getDb();
    const target = database.prepare(
      'SELECT created_at, rowid FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { created_at: number; rowid: number } | undefined;

    if (!target) return { deletedCount: 0 };

    const deleteResult = database.prepare(
      'DELETE FROM messages WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND rowid >= ?))'
    ).run(sessionId, target.created_at, target.created_at, target.rowid);

    database.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);

    return { deletedCount: deleteResult.changes };
  });

  // ==================== Lock Handlers ====================

  ipcMain.handle('db:lock:acquire', (_event, sessionId: string, lockId: string, owner: string, ttlSec = 300) => {
    const now = Date.now();
    const expiresAt = now + ttlSec * 1000;
    const database = getDb();

    const txn = database.transaction(() => {
      database.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
      try {
        database.prepare(
          'INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at) VALUES (?, ?, ?, ?)'
        ).run(sessionId, lockId, owner, expiresAt);
        return true;
      } catch {
        return false;
      }
    });
    return txn();
  });

  ipcMain.handle('db:lock:renew', (_event, sessionId: string, lockId: string, ttlSec = 300) => {
    const now = Date.now();
    const expiresAt = now + ttlSec * 1000;
    const result = getDb().prepare(
      'UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ? AND lock_id = ?'
    ).run(expiresAt, sessionId, lockId);
    return result.changes > 0;
  });

  ipcMain.handle('db:lock:release', (_event, sessionId: string, lockId: string) => {
    const result = getDb().prepare(
      'DELETE FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?'
    ).run(sessionId, lockId);
    return result.changes > 0;
  });

  ipcMain.handle('db:lock:isLocked', (_event, sessionId: string) => {
    const now = Date.now();
    const database = getDb();
    database.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
    const stmt = database.prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?');
    return stmt.get(sessionId) !== undefined;
  });

  // ==================== Task Handlers ====================

  ipcMain.handle('db:task:create', (_event, data: {
    id: string;
    session_id: string;
    subject: string;
    description: string;
    active_form?: string;
    owner?: string;
  }) => {
    const now = Date.now();
    const database = getDb();
    database.prepare(`
      INSERT INTO tasks (id, session_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', '[]', '{}', ?, ?)
    `).run(data.id, data.session_id, data.subject, data.description, data.active_form ?? null, data.owner ?? null, now, now);
    return database.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:task:get', (_event, id: string) => {
    return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  ipcMain.handle('db:task:getBySession', (_event, sessionId: string) => {
    return getDb().prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
  });

  ipcMain.handle('db:task:update', (_event, id: string, data: Record<string, unknown>) => {
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    const fieldMap: Record<string, string> = {
      subject: 'subject',
      description: 'description',
      status: 'status',
      active_form: 'active_form',
      owner: 'owner',
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(data[key]);
      }
    }

    if (data.blocks !== undefined) {
      fields.push('blocks = ?');
      values.push(JSON.stringify(data.blocks));
    }
    if (data.blocked_by !== undefined) {
      fields.push('blocked_by = ?');
      values.push(JSON.stringify(data.blocked_by));
    }
    if (data.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(data.metadata));
    }

    const database = getDb();
    values.push(id);
    database.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  ipcMain.handle('db:task:delete', (_event, id: string) => {
    const result = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  });

  ipcMain.handle('db:task:deleteBySession', (_event, sessionId: string) => {
    getDb().prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId);
  });

  ipcMain.handle('db:task:claim', (_event, id: string, owner: string) => {
    const now = Date.now();
    const database = getDb();
    const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return { success: false, reason: 'task_not_found' };
    if (row.owner && row.owner !== owner) return { success: false, reason: 'already_claimed' };
    if (row.status === 'completed') return { success: false, reason: 'already_resolved' };

    const blockedBy = JSON.parse((row.blocked_by as string) || '[]') as string[];
    if (blockedBy.length > 0) {
      const unresolvedIds = database.prepare(
        `SELECT id FROM tasks WHERE id IN (${blockedBy.map(() => '?').join(',')}) AND status != 'completed'`
      ).all(...blockedBy) as { id: string }[];
      if (unresolvedIds.length > 0) {
        return { success: false, reason: 'blocked', blockedByTasks: unresolvedIds.map(r => r.id) };
      }
    }

    database.prepare(`UPDATE tasks SET owner = ?, status = 'in_progress', updated_at = ? WHERE id = ?`).run(owner, now, id);
    return { success: true, task: database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) };
  });

  ipcMain.handle('db:task:block', (_event, fromId: string, toId: string) => {
    const database = getDb();
    const from = database.prepare('SELECT * FROM tasks WHERE id = ?').get(fromId) as Record<string, unknown> | undefined;
    const to = database.prepare('SELECT * FROM tasks WHERE id = ?').get(toId) as Record<string, unknown> | undefined;
    if (!from || !to) return false;

    const fromBlocks: string[] = JSON.parse((from.blocks as string) || '[]');
    const toBlockedBy: string[] = JSON.parse((to.blocked_by as string) || '[]');

    if (!fromBlocks.includes(toId)) {
      fromBlocks.push(toId);
      database.prepare('UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(fromBlocks), Date.now(), fromId);
    }
    if (!toBlockedBy.includes(fromId)) {
      toBlockedBy.push(fromId);
      database.prepare('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(toBlockedBy), Date.now(), toId);
    }
    return true;
  });

  ipcMain.handle('db:task:unassignTeammate', (_event, sessionId: string, owner: string) => {
    const now = Date.now();
    const database = getDb();
    const tasks = database.prepare(
      `SELECT id, subject FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).all(sessionId, owner) as { id: string; subject: string }[];
    if (tasks.length === 0) return { unassignedTasks: [], notificationMessage: '' };

    database.prepare(
      `UPDATE tasks SET owner = NULL, status = 'pending', updated_at = ? WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).run(now, sessionId, owner);

    const taskList = tasks.map(t => `#${t.id} "${t.subject}"`).join(', ');
    return {
      unassignedTasks: tasks.map(t => ({ id: t.id, subject: t.subject })),
      notificationMessage: `${owner} was terminated. ${tasks.length} task(s) were unassigned: ${taskList}.`,
    };
  });

  ipcMain.handle('db:task:getByOwner', (_event, sessionId: string, owner: string) => {
    return getDb().prepare(
      `SELECT * FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
    ).all(sessionId, owner);
  });

  // ==================== Automation Handlers ====================

  ipcMain.handle('automation:cron:list', () => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.listCrons();
  });

  ipcMain.handle('automation:cron:create', (_event, data: {
    name: string;
    description?: string | null;
    workingDirectory?: string;
    schedule: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null; endAt?: string | null };
    prompt: string;
    model: string;
    inputParams?: Record<string, unknown>;
    concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
    maxRetries?: number;
    enabled?: boolean;
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.createCron(data);
  });

  ipcMain.handle('automation:cron:update', (_event, id: string, patch: {
    name?: string;
    description?: string | null;
    workingDirectory?: string;
    schedule?: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null; endAt?: string | null };
    prompt?: string;
    inputParams?: Record<string, unknown>;
    concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
    maxRetries?: number;
    status?: 'enabled' | 'disabled' | 'error';
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.updateCron(id, patch);
  });

  ipcMain.handle('automation:cron:delete', (_event, id: string) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.deleteCron(id);
  });

  ipcMain.handle('automation:cron:run', async (_event, id: string) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return await scheduler.runCronNow(id);
  });

  ipcMain.handle('automation:cron:runs', (_event, input: {
    cronId: string;
    limit?: number;
    offset?: number;
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.listCronRuns(input);
  });

  ipcMain.handle('automation:template:list', () => {
    const { loadTemplates } = require('../automation/template-loader');
    return loadTemplates();
  });

  // ==================== Settings Handlers ====================

  ipcMain.handle('db:setting:get', (_event, key: string) => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  });

  ipcMain.handle('db:setting:set', (_event, key: string, value: string) => {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
    if (isGatewayConfigKey(key)) {
      emitGatewayConfigChanged(`db:setting:set:${key}`);
    }
  });

  ipcMain.handle('db:setting:getAll', () => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;
    return settings;
  });

  ipcMain.handle('db:setting:getJson', (_event, key: string, defaultValue: unknown) => {
    const value = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!value) return defaultValue;
    try {
      return JSON.parse(value.value);
    } catch {
      return defaultValue;
    }
  });

  ipcMain.handle('db:setting:setJson', (_event, key: string, value: unknown) => {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now);
    if (isGatewayConfigKey(key)) {
      emitGatewayConfigChanged(`db:setting:setJson:${key}`);
    }
    // Plan 83b Phase 2: when the renderer writes the canonical MCP
    // server list through `useSettings().save({ mcpServers })`, the
    // GUI path lands here. Notify the agent server so the new
    // list propagates to the worker pool. Best-effort: a stopped
    // agent server is silently ignored by the helper.
    if (key === 'mcpServers') {
      void notifyMcpConfigChanged();
    }
  });

  // ==================== Permission Handlers ====================

  ipcMain.handle('db:permission:create', (_event, data: {
    id: string;
    sessionId?: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => {
    const now = Date.now();
    const database = getDb();
    database.prepare(`
      INSERT INTO permission_requests (id, session_id, tool_name, tool_input, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      data.id,
      data.sessionId || null,
      data.toolName,
      data.toolInput ? JSON.stringify(data.toolInput) : null,
      now
    );
    return database.prepare('SELECT * FROM permission_requests WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:permission:get', (_event, id: string) => {
    return getDb().prepare('SELECT * FROM permission_requests WHERE id = ?').get(id);
  });

  ipcMain.handle('db:permission:resolve', (_event, id: string, status: string, extra?: {
    message?: string;
    updatedPermissions?: unknown[];
    updatedInput?: Record<string, unknown>;
    sessionId?: string;
  }) => {
    const now = Date.now();
    const database = getDb();
    database.prepare(`
      UPDATE permission_requests SET
        status = ?,
        decision = ?,
        message = ?,
        updated_permissions = ?,
        updated_input = ?,
        resolved_at = ?
      WHERE id = ?
    `).run(
      status,
      status,
      extra?.message || null,
      extra?.updatedPermissions ? JSON.stringify(extra.updatedPermissions) : null,
      extra?.updatedInput ? JSON.stringify(extra.updatedInput) : null,
      now,
      id
    );

    // Forward permission resolution to agent process so it can continue tool execution
    const agentPool = getAgentProcessPool();
    const sessionId = extra?.sessionId;
    if (sessionId && agentPool.isRunning(sessionId)) {
      dbLogger.info('Forwarding permission:resolve to agent process', { id, status, sessionId }, LogComponent.DB);
      const sent = agentPool.send(sessionId, {
        type: 'permission:resolve',
        id,
        decision: status,
        ...(extra?.updatedInput ? { updatedInput: extra.updatedInput } : {}),
      });
      if (!sent) {
        dbLogger.error('Failed to send permission:resolve to agent process', new Error('Send failed'), { id, status, sessionId }, LogComponent.DB);
      }
    } else {
      dbLogger.warn('Agent process not available for permission:resolve forwarding', { sessionId, isRunning: sessionId ? agentPool.isRunning(sessionId) : false }, LogComponent.DB);
    }

    return database.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id);
  });

  // ==================== Search Handlers ====================

  ipcMain.handle('db:search:sessions', (_event, query: string, limit = 10) => {
    const database = getDb();
    try {
      const ftsAvailable = database.prepare(
        "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
      ).get();
      if (ftsAvailable) {
        return database.prepare(`
          SELECT s.*, substr(m.content, 1, 300) as snippet
          FROM messages_fts f
          JOIN messages m ON f.rowid = m.rowid
          JOIN chat_sessions s ON m.session_id = s.id
          WHERE messages_fts MATCH ? AND s.is_deleted = 0
          GROUP BY s.id
          ORDER BY s.updated_at DESC LIMIT ?
        `).all(query, limit);
      }
    } catch {}
    return database.prepare(`
      SELECT s.*, substr(m.content, 1, 300) as snippet
      FROM messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.content LIKE ? AND s.is_deleted = 0
      GROUP BY s.id
      ORDER BY s.updated_at DESC LIMIT ?
    `).all(`%${query}%`, limit);
  });

  // ==================== Channel Binding Handlers ====================

  ipcMain.handle('db:channel:getBindings', (_event, channelType?: string) => {
    const database = getDb();
    if (channelType) {
      return database.prepare(
        'SELECT * FROM channel_bindings WHERE channel_type = ? ORDER BY updated_at DESC'
      ).all(channelType);
    }
    return database.prepare('SELECT * FROM channel_bindings ORDER BY updated_at DESC').all();
  });

  ipcMain.handle('db:channel:getBinding', (_event, channelType: string, chatId: string) => {
    return getDb().prepare(
      'SELECT * FROM channel_bindings WHERE channel_type = ? AND chat_id = ?'
    ).get(channelType, chatId);
  });

  ipcMain.handle('db:channel:upsertBinding', (_event, data: {
    id: string;
    channel_type: string;
    chat_id: string;
    duya_session_id: string;
    sdk_session_id?: string;
    working_directory?: string;
    model?: string;
    mode?: string;
  }) => {
    const now = Date.now();
    const database = getDb();
    database.prepare(`
      INSERT INTO channel_bindings (id, channel_type, chat_id, duya_session_id, sdk_session_id, working_directory, model, mode, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        duya_session_id = excluded.duya_session_id,
        sdk_session_id = COALESCE(excluded.sdk_session_id, sdk_session_id),
        working_directory = COALESCE(excluded.working_directory, working_directory),
        model = COALESCE(excluded.model, model),
        mode = COALESCE(excluded.mode, mode),
        updated_at = excluded.updated_at
    `).run(
      data.id,
      data.channel_type,
      data.chat_id,
      data.duya_session_id,
      data.sdk_session_id || '',
      data.working_directory || '',
      data.model || '',
      data.mode || 'code',
      now,
      now
    );
    return database.prepare('SELECT * FROM channel_bindings WHERE id = ?').get(data.id);
  });

  ipcMain.handle('db:channel:getOffset', (_event, channelType: string, offsetKey: string) => {
    return getDb().prepare(
      'SELECT * FROM channel_offsets WHERE channel_type = ? AND offset_key = ?'
    ).get(channelType, offsetKey);
  });

  ipcMain.handle('db:channel:setOffset', (_event, channelType: string, offsetKey: string, offsetValue: string, offsetType = 'long_polling') => {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO channel_offsets (channel_type, offset_key, offset_value, offset_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_type, offset_key) DO UPDATE SET
        offset_value = excluded.offset_value,
        offset_type = COALESCE(excluded.offset_type, offset_type),
        updated_at = excluded.updated_at
    `).run(channelType, offsetKey, offsetValue, offsetType, now);
  });

  // ==================== Project Group Handlers ====================

  ipcMain.handle('db:project:getGroups', () => {
    return getDb().prepare(`
      SELECT
        working_directory,
        project_name,
        COUNT(*) as thread_count,
        MAX(updated_at) as last_activity
      FROM chat_sessions
      WHERE is_deleted = 0 AND working_directory != ''
      GROUP BY working_directory
      ORDER BY last_activity DESC
    `).all();
  });

  // ==================== Database Migration Handlers ====================

  ipcMain.handle('db:migration:getDefaultPath', () => {
    return getDatabasePath();
  });

  ipcMain.handle('db:migration:databaseExists', (_event, dbPath: string) => {
    return fs.existsSync(dbPath);
  });

  ipcMain.handle('db:migration:getDatabaseSize', (_event, dbPath: string) => {
    if (!fs.existsSync(dbPath)) {
      return '0 KB';
    }
    const stats = fs.statSync(dbPath);
    const sizeInKB = stats.size / 1024;
    if (sizeInKB < 1024) {
      return `${sizeInKB.toFixed(1)} KB`;
    } else {
      return `${(sizeInKB / 1024).toFixed(2)} MB`;
    }
  });

  ipcMain.handle('db:migration:checkNeeded', (_event, newDbPath: string) => {
    const database = getDb();
    const currentPath = database.name;
    const targetExists = fs.existsSync(newDbPath);
    const sourceExists = fs.existsSync(currentPath);
    const needed = sourceExists && currentPath !== newDbPath && !targetExists;

    return {
      needed,
      sourcePath: needed ? currentPath : null,
      targetExists,
    };
  });

  ipcMain.handle('db:migration:migrate', (_event, sourcePath: string, targetPath: string) => {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source database does not exist: ${sourcePath}`);
    }

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (fs.existsSync(targetPath)) {
      throw new Error('Target database already exists');
    }

    fs.copyFileSync(sourcePath, targetPath);

    const walPath = sourcePath + '-wal';
    const shmPath = sourcePath + '-shm';

    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, targetPath + '-wal');
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, targetPath + '-shm');
    }

    dbLogger.info('Successfully migrated database', { sourcePath, targetPath }, LogComponent.DBMigration);
    return { success: true };
  });

  ipcMain.handle('db:migration:updateBootAndRestart', (_event, newDbPath: string) => {
    const updated = updateDatabasePath(newDbPath);
    if (!updated) {
      return { success: false, error: 'Failed to update boot.json' };
    }

    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 500);

    return { success: true };
  });

  // ==================== Weixin Account Handlers ====================

  ipcMain.handle('db:weixin:getAccounts', () => {
    return getDb().prepare('SELECT * FROM weixin_accounts ORDER BY created_at DESC').all();
  });

  ipcMain.handle('db:weixin:upsertAccount', (_event, data: {
    accountId: string;
    userId?: string;
    name?: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
    token: string;
    enabled?: boolean;
  }) => {
    const now = Date.now();
    const database = getDb();
    database.prepare(`
      INSERT INTO weixin_accounts (account_id, user_id, name, base_url, cdn_base_url, token, enabled, last_login_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, user_id),
        name = COALESCE(excluded.name, name),
        base_url = COALESCE(excluded.base_url, base_url),
        cdn_base_url = COALESCE(excluded.cdn_base_url, cdn_base_url),
        token = excluded.token,
        enabled = COALESCE(excluded.enabled, enabled),
        last_login_at = excluded.last_login_at,
        created_at = COALESCE(weixin_accounts.created_at, excluded.created_at)
    `).run(
      data.accountId,
      data.userId || '',
      data.name || data.accountId,
      data.baseUrl || '',
      data.cdnBaseUrl || '',
      data.token,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
      now,
      now
    );
    emitGatewayConfigChanged(`db:weixin:upsertAccount:${data.accountId}`);
    return database.prepare('SELECT * FROM weixin_accounts WHERE account_id = ?').get(data.accountId);
  });

  ipcMain.handle('db:weixin:updateAccount', (_event, accountId: string, data: {
    enabled?: boolean;
    name?: string;
  }) => {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(data.enabled ? 1 : 0);
    }
    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }

    if (fields.length === 0) return null;

    const database = getDb();
    values.push(accountId);
    database.prepare(`UPDATE weixin_accounts SET ${fields.join(', ')} WHERE account_id = ?`).run(...values);
    emitGatewayConfigChanged(`db:weixin:updateAccount:${accountId}`);
    return database.prepare('SELECT * FROM weixin_accounts WHERE account_id = ?').get(accountId);
  });

  ipcMain.handle('db:weixin:deleteAccount', (_event, accountId: string) => {
    const database = getDb();
    database.prepare('DELETE FROM weixin_context_tokens WHERE account_id = ?').run(accountId);
    const result = database.prepare('DELETE FROM weixin_accounts WHERE account_id = ?').run(accountId);
    if (result.changes > 0) {
      emitGatewayConfigChanged(`db:weixin:deleteAccount:${accountId}`);
    }
    return result.changes > 0;
  });

  ipcMain.handle('db:weixin:getContextToken', (_event, accountId: string, peerUserId: string) => {
    const row = getDb().prepare(
      'SELECT context_token FROM weixin_context_tokens WHERE account_id = ? AND peer_user_id = ?'
    ).get(accountId, peerUserId) as { context_token: string } | undefined;
    return row?.context_token || null;
  });

  ipcMain.handle('db:weixin:setContextToken', (_event, accountId: string, peerUserId: string, contextToken: string) => {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO weixin_context_tokens (account_id, peer_user_id, context_token, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, peer_user_id) DO UPDATE SET
        context_token = excluded.context_token,
        updated_at = excluded.updated_at
    `).run(accountId, peerUserId, contextToken, now);
  });

  // ==================== Agent Profile Handlers ====================

  ipcMain.handle('db:agentProfile:list', () => {
    return getDb().prepare('SELECT * FROM agent_profiles ORDER BY is_preset DESC, name ASC').all();
  });

  ipcMain.handle('db:agentProfile:get', (_event, id: string) => {
    return getDb().prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id);
  });

  ipcMain.handle('db:agentProfile:create', (_event, data: Record<string, unknown>) => {
    const now = Date.now();
    const id = (data.id as string) || crypto.randomUUID();
    const database = getDb();
    database.prepare(`
      INSERT INTO agent_profiles (
        id, name, description, allowed_tools, disallowed_tools, prompt_system, default_model,
        user_visible, is_preset, is_enabled, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @allowed_tools, @disallowed_tools, @prompt_system, @default_model,
        @user_visible, @is_preset, @is_enabled, @created_at, @updated_at
      )
    `).run({
      id,
      name: data.name || 'New Agent',
      description: data.description ?? null,
      allowed_tools: data.allowed_tools ? JSON.stringify(data.allowed_tools) : null,
      disallowed_tools: data.disallowed_tools ? JSON.stringify(data.disallowed_tools) : null,
      prompt_system: (data.prompt_system as string) ?? null,
      default_model: data.default_model ?? null,
      user_visible: data.user_visible !== undefined ? (data.user_visible ? 1 : 0) : 1,
      is_preset: data.is_preset !== undefined ? (data.is_preset ? 1 : 0) : 0,
      is_enabled: data.is_enabled !== undefined ? (data.is_enabled ? 1 : 0) : 1,
      created_at: now,
      updated_at: now,
    });
    return database.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id);
  });

  ipcMain.handle('db:agentProfile:update', (_event, id: string, data: Record<string, unknown>) => {
    const now = Date.now();
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: now };

    const fieldMap: Record<string, [string, (v: unknown) => unknown]> = {
      name: ['name', v => v],
      description: ['description', v => v ?? null],
      allowed_tools: ['allowed_tools', v => v ? JSON.stringify(v) : null],
      disallowed_tools: ['disallowed_tools', v => v ? JSON.stringify(v) : null],
      prompt_system: ['prompt_system', v => (v as string) ?? null],
      default_model: ['default_model', v => v ?? null],
      is_enabled: ['is_enabled', v => v !== undefined ? (v ? 1 : 0) : 1],
    };

    for (const [key, [dbField, transform]] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = @${dbField}`);
        params[dbField] = transform(data[key]);
      }
    }

    const database = getDb();
    database.prepare(`UPDATE agent_profiles SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return database.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id);
  });

  ipcMain.handle('db:agentProfile:delete', (_event, id: string) => {
    const database = getDb();
    // Prevent deleting preset profiles
    const profile = database.prepare('SELECT is_preset FROM agent_profiles WHERE id = ?').get(id) as { is_preset: number } | undefined;
    if (!profile) return false;
    if (profile.is_preset === 1) {
      throw new Error('Cannot delete preset agent profiles');
    }
    const result = database.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
    return result.changes > 0;
  });

  // ==================== Session Agent Profile Binding ====================

  ipcMain.handle('db:session:setAgentProfile', (_event, sessionId: string, agentProfileId: string | null) => {
    const database = getDb();
    database.prepare('UPDATE chat_sessions SET agent_profile_id = ?, updated_at = ? WHERE id = ?')
      .run(agentProfileId, Date.now(), sessionId);
    return database.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
  });

  ipcMain.handle(
    'db:session:set_conductor_mode',
    (_event, payload: { sessionId: string; enabled: boolean; canvasId?: string | null }) => {
      const database = getDb();
      database.prepare(
        'UPDATE chat_sessions SET conductor_mode_enabled = ?, conductor_canvas_id = ?, updated_at = ? WHERE id = ?',
      ).run(payload.enabled ? 1 : 0, payload.canvasId ?? null, Date.now(), payload.sessionId);
      return database.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(payload.sessionId);
    },
  );

  // ==================== DB Stats Handler ====================

  ipcMain.handle('db:stats', () => {
    const stats = getDatabaseStats();
    if (!stats) {
      return { success: false, error: 'Database not initialized' };
    }
    const warning = checkDatabaseSizeWarning();
    return { success: true, stats, warning };
  });

  dbLogger.info('All database handlers registered', undefined, LogComponent.DB);
}

// ============================================================
// Conductor IPC Handlers
// ============================================================

export function registerConductorHandlers(): void {
  if (!getDatabase()) return;

  ipcMain.handle('conductor:canvas:list', () => {
    const rows = getDb().prepare(
      'SELECT * FROM conductor_canvases ORDER BY sort_order, created_at DESC'
    ).all() as any[];
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      layoutConfig: JSON.parse(r.layout_config),
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      projectPath: r.project_path ?? null,
    }));
  });

  ipcMain.handle('conductor:canvas:getByProjectPath', (_event, projectPath: string) => {
    const row = getDb().prepare(
      'SELECT * FROM conductor_canvases WHERE project_path = ?'
    ).get(projectPath) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      layoutConfig: JSON.parse(row.layout_config),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path ?? null,
    };
  });

  ipcMain.handle('conductor:canvas:create', (_event, data: { name: string; description?: string; projectPath?: string | null }) => {
    const canvas = createConductorCanvas(data);
    return {
      id: canvas.id,
      name: canvas.name,
      description: canvas.description,
      layoutConfig: canvas.layoutConfig,
      sortOrder: canvas.sortOrder,
      createdAt: canvas.createdAt,
      updatedAt: canvas.updatedAt,
      projectPath: canvas.projectPath,
    };
  });

  ipcMain.handle('conductor:canvas:update', (_event, id: string, data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }) => {
    const d = getDb();
    const now = Date.now();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      values.push(data.description);
    }
    if (data.layoutConfig !== undefined) {
      fields.push('layout_config = ?');
      values.push(JSON.stringify(data.layoutConfig));
    }
    if (data.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      values.push(data.sortOrder);
    }

    values.push(id);
    d.prepare(`UPDATE conductor_canvases SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = d.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      layoutConfig: JSON.parse(row.layout_config),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path ?? null,
    };
  });

  ipcMain.handle('conductor:canvas:delete', (_event, id: string) => {
    const d = getDb();
    const result = d.prepare('DELETE FROM conductor_canvases WHERE id = ?').run(id);
    return result.changes > 0;
  });

  ipcMain.handle('conductor:snapshot', (_event, canvasId: string) => {
    const d = getDb();
    const canvas = d.prepare('SELECT * FROM conductor_canvases WHERE id = ?').get(canvasId) as any;
    if (!canvas) return null;

    const elementRows = d.prepare('SELECT * FROM conductor_elements WHERE canvas_id = ?').all(canvasId) as any[];

    let elements: Array<{
      id: string;
      canvasId: string;
      elementKind: string;
      position: unknown;
      config: unknown;
      vizSpec: unknown | null;
      sourceCode: string | null;
      state: string;
      dataVersion: number;
      permissions: unknown;
      metadata: unknown;
      createdAt: number;
      updatedAt: number;
    }> = [];

    if (elementRows.length > 0) {
      elements = elementRows.map((e: any) => ({
        id: e.id,
        canvasId: e.canvas_id,
        elementKind: e.element_kind,
        position: JSON.parse(e.position),
        config: JSON.parse(e.config),
        vizSpec: e.viz_spec ? JSON.parse(e.viz_spec) : null,
        sourceCode: e.source_code,
        state: e.state,
        dataVersion: e.data_version,
        permissions: JSON.parse(e.permissions),
        metadata: JSON.parse(e.metadata),
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      }));
    } else {
      const widgetRows = d.prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
      elements = widgetRows.map((w: any) => ({
        id: w.id,
        canvasId: w.canvas_id,
        elementKind: `widget/${w.type}`,
        position: { ...JSON.parse(w.position), zIndex: 0, rotation: 0 },
        config: JSON.parse(w.config),
        vizSpec: null,
        sourceCode: w.source_code,
        state: w.state,
        dataVersion: w.data_version,
        permissions: JSON.parse(w.permissions),
        metadata: { label: `${w.kind}:${w.type}`, tags: [], createdBy: 'user' },
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      }));
    }

    const widgetRows = d.prepare('SELECT * FROM conductor_widgets WHERE canvas_id = ?').all(canvasId) as any[];
    const lastAction = d.prepare('SELECT MAX(id) as max_id FROM conductor_actions WHERE canvas_id = ?').get(canvasId) as { max_id: number | null };

    return {
      canvas: {
        id: canvas.id,
        name: canvas.name,
        description: canvas.description,
        layoutConfig: JSON.parse(canvas.layout_config),
        sortOrder: canvas.sort_order,
        createdAt: canvas.created_at,
        updatedAt: canvas.updated_at,
        projectPath: canvas.project_path ?? null,
      },
      elements,
      widgets: widgetRows.map((w: any) => ({
        id: w.id,
        canvasId: w.canvas_id,
        kind: w.kind,
        type: w.type,
        position: JSON.parse(w.position),
        config: JSON.parse(w.config),
        data: JSON.parse(w.data),
        dataVersion: w.data_version,
        sourceCode: w.source_code,
        state: w.state,
        permissions: JSON.parse(w.permissions),
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      })),
      actionCursor: lastAction?.max_id ?? 0,
    };
  });

  ipcMain.handle('conductor:action', (_event, request: Record<string, unknown>) => {
    const d = getDb();
    const action = request.action as string;
    const actor = (request.actor as string) || 'user';
    const canvasId = request.canvasId as string;
    const now = Date.now();

    if (!['user', 'agent', 'system'].includes(actor)) {
      throw new Error(`Invalid actor: ${actor}`);
    }

    const writeActionLog = (
      actionType: string,
      widgetId: string | null,
      payload: Record<string, unknown> | null,
      resultPatch: Record<string, unknown> | null,
      reversible: number = 1,
      mergedFrom: string | null = null
    ): number => {
      const result = d.prepare(
        `INSERT INTO conductor_actions (canvas_id, widget_id, actor, action_type, payload, result_patch, merged_from, reversible, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        canvasId,
        widgetId,
        actor,
        actionType,
        payload ? JSON.stringify(payload) : null,
        resultPatch ? JSON.stringify(resultPatch) : null,
        mergedFrom,
        reversible,
        now
      );
      return Number(result.lastInsertRowid);
    };

    const broadcastPatch = (patch: Record<string, unknown>) => {
      const channelManager = getChannelManager();
      channelManager?.sendToChannel('conductor', { type: 'conductor:state:patch', _v2: true, ...patch });
    };

    const txn = d.transaction(() => {
      switch (action) {
        case 'canvas.rename': {
          const name = request.name as string;
          d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(name, now, canvasId);
          const resultPatch = { name };
          const actionId = writeActionLog(action, null, { name }, resultPatch);
          broadcastPatch({ canvasId, actionId, resultPatch });
          return { success: true, actionId, resultPatch };
        }

        case 'widget.create': {
          const widgetId = randomUUID();
          const kind = request.kind as string;
          const type = request.type as string;
          const position = request.position as Record<string, unknown>;
          const config = (request.config as Record<string, unknown>) || {};
          const data = (request.data as Record<string, unknown>) || {};
          const permissions = (request.permissions as Record<string, unknown>) || {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: false,
          };

          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?, ?)`
          ).run(widgetId, canvasId, kind, type, JSON.stringify(position), JSON.stringify(config), JSON.stringify(data), JSON.stringify(permissions), now, now);

          const elementKind = `widget/${type}`;
          const canvasPosition = { x: (position as any).x ?? 0, y: (position as any).y ?? 0, w: (position as any).w ?? 4, h: (position as any).h ?? 3, zIndex: 0, rotation: 0 };
          const mergedConfig = { ...data, ...config };
          const metadata = { label: `${kind}:${type}`, tags: [] as string[], createdBy: actor as string };

          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', 1, ?, ?, ?, ?)`
          ).run(widgetId, canvasId, elementKind, JSON.stringify(canvasPosition), JSON.stringify(mergedConfig), JSON.stringify(permissions), JSON.stringify(metadata), now, now);

          const element = {
            id: widgetId,
            canvasId,
            elementKind,
            position: canvasPosition,
            config: mergedConfig,
            vizSpec: null,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            sourceCode: null,
            createdAt: now,
            updatedAt: now,
          };

          const resultPatch = {
            widget: {
              id: widgetId,
              canvasId,
              kind,
              type,
              position,
              config,
              data,
              dataVersion: 1,
              sourceCode: null,
              state: 'idle',
              permissions,
              createdAt: now,
              updatedAt: now,
            },
            element,
          };
          const actionId = writeActionLog(action, widgetId, { kind, type, position, config, data, permissions }, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.move':
        case 'widget.resize': {
          const widgetId = request.widgetId as string;
          const position = request.position as Record<string, unknown>;
          const prev = d.prepare('SELECT position FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!prev) throw new Error(`Widget ${widgetId} not found`);

          d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, widgetId);

          const canvasPosition = { x: (position as any).x ?? 0, y: (position as any).y ?? 0, w: (position as any).w ?? 4, h: (position as any).h ?? 3, zIndex: 0, rotation: 0 };
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(canvasPosition), now, widgetId);

          const resultPatch = { position, prevPosition: JSON.parse(prev.position) };
          const actionId = writeActionLog(action, widgetId, { position }, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.update_config': {
          const widgetId = request.widgetId as string;
          const config = request.config as Record<string, unknown>;
          const prev = d.prepare('SELECT config FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!prev) throw new Error(`Widget ${widgetId} not found`);

          d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, widgetId);

          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, widgetId);

          const resultPatch = { config, prevConfig: JSON.parse(prev.config) };
          const actionId = writeActionLog(action, widgetId, { config }, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.update_data': {
          const widgetId = request.widgetId as string;
          const data = request.data as Record<string, unknown>;
          const clientTs = request.clientTs as number | undefined;
          const widget = d.prepare('SELECT data, data_version FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!widget) throw new Error(`Widget ${widgetId} not found`);

          const serverData = JSON.parse(widget.data);
          const merged = mergeWidgetData(serverData, data, { actor, clientTs, serverVersion: widget.data_version });
          const newVersion = widget.data_version + 1;

          d.prepare('UPDATE conductor_widgets SET data = ?, data_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged.data), newVersion, now, widgetId);

          const element = d.prepare('SELECT config FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (element) {
            const existingElementConfig = JSON.parse(element.config);
            const mergedElementConfig = { ...existingElementConfig, ...merged.data };
            d.prepare('UPDATE conductor_elements SET config = ?, data_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mergedElementConfig), newVersion, now, widgetId);
          }

          const resultPatch = { data: merged.data, dataVersion: newVersion, prevData: serverData };
          const actionId = writeActionLog(action, widgetId, { data, clientTs }, resultPatch, 1, merged.mergedFrom ?? null);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch, merged: merged.mergedFrom !== null };
        }

        case 'widget.delete': {
          const widgetId = request.widgetId as string;
          const widget = d.prepare('SELECT * FROM conductor_widgets WHERE id = ? AND canvas_id = ?').get(widgetId, canvasId) as any;
          if (!widget) throw new Error(`Widget ${widgetId} not found`);

          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(widgetId);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(widgetId);

          const resultPatch = {
            deletedWidget: {
              id: widget.id,
              kind: widget.kind,
              type: widget.type,
              position: JSON.parse(widget.position),
              config: JSON.parse(widget.config),
              data: JSON.parse(widget.data),
              dataVersion: widget.data_version,
              permissions: JSON.parse(widget.permissions),
            },
          };
          const actionId = writeActionLog(action, widgetId, null, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'widget.restore': {
          const widgetId = request.widgetId as string;
          const lastAction = d.prepare(
            "SELECT * FROM conductor_actions WHERE widget_id = ? AND canvas_id = ? AND action_type = 'widget.delete' AND undone_at IS NULL ORDER BY ts DESC LIMIT 1"
          ).get(widgetId, canvasId) as any;
          if (!lastAction) throw new Error(`No delete action found for widget ${widgetId}`);

          const patch = JSON.parse(lastAction.result_patch);
          const delWidget = patch.deletedWidget;
          if (!delWidget) throw new Error('Restore data not found');

          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
          ).run(
            delWidget.id, canvasId, delWidget.kind, delWidget.type,
            JSON.stringify(delWidget.position), JSON.stringify(delWidget.config), JSON.stringify(delWidget.data),
            delWidget.dataVersion, JSON.stringify(delWidget.permissions), now, now
          );

          const elementKind = `widget/${delWidget.type}`;
          const canvasPosition = { x: delWidget.position.x ?? 0, y: delWidget.position.y ?? 0, w: delWidget.position.w ?? 4, h: delWidget.position.h ?? 3, zIndex: 0, rotation: 0 };
          const mergedConfig = { ...delWidget.data, ...delWidget.config };
          const metadata = { label: `${delWidget.kind}:${delWidget.type}`, tags: [] as string[], createdBy: 'user' };
          d.prepare(
            `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
          ).run(delWidget.id, canvasId, elementKind, JSON.stringify(canvasPosition), JSON.stringify(mergedConfig), delWidget.dataVersion, JSON.stringify(delWidget.permissions), JSON.stringify(metadata), now, now);

          const resultPatch = { restoredWidget: delWidget };
          const actionId = writeActionLog(action, widgetId, null, resultPatch);
          broadcastPatch({ canvasId, widgetId, elementId: widgetId, actionId, resultPatch });
          return { success: true, actionId, widgetId, resultPatch };
        }

        case 'element.create': {
          const elementId = randomUUID();
          const elementKind = request.elementKind as string;
          const position = request.position as Record<string, unknown>;
          const vizSpec = (request.vizSpec as Record<string, unknown>) || null;
          const config = (request.config as Record<string, unknown>) || {};
          const permissions = (request.permissions as Record<string, unknown>) || {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: false,
          };
          const metadata = {
            label: elementKind,
            tags: [] as string[],
            createdBy: actor as string,
          };

          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 'idle', 1, ?, ?, ?, ?)`
          ).run(elementId, canvasId, elementKind, JSON.stringify(position), JSON.stringify(config), vizSpec ? JSON.stringify(vizSpec) : null, JSON.stringify(permissions), JSON.stringify(metadata), now, now);

          const resultPatch = {
            element: { id: elementId, canvasId, elementKind, position, config, vizSpec, state: 'idle', dataVersion: 1, permissions, metadata, createdAt: now, updatedAt: now },
          };
          const actionId = writeActionLog(action, elementId, { elementKind, position, config, vizSpec, permissions }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.move': {
          const elementId = request.elementId as string;
          const position = request.position as Record<string, unknown>;
          const prev = d.prepare('SELECT position FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!prev) throw new Error(`Element ${elementId} not found`);

          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, elementId);
          const resultPatch = { position, prevPosition: JSON.parse(prev.position) };
          const actionId = writeActionLog(action, elementId, { position }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.update': {
          const elementId = request.elementId as string;
          const prev = d.prepare('SELECT config, viz_spec, position FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!prev) throw new Error(`Element ${elementId} not found`);

          const prevConfig = JSON.parse(prev.config);
          const prevVizSpec = prev.viz_spec ? JSON.parse(prev.viz_spec) : null;
          const prevPosition = JSON.parse(prev.position);

          const vizSpec = request.vizSpec !== undefined ? (request.vizSpec as Record<string, unknown> | null) : undefined;
          const config = request.config as Record<string, unknown> | undefined;
          const position = request.position as Record<string, unknown> | undefined;

          if (config !== undefined) {
            d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, elementId);
          }
          if (vizSpec !== undefined) {
            d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(vizSpec ? JSON.stringify(vizSpec) : null, now, elementId);
          }
          if (position !== undefined) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(position), now, elementId);
          }

          const resultPatch: Record<string, unknown> = {};
          if (config !== undefined) { resultPatch.config = config; resultPatch.prevConfig = prevConfig; }
          if (vizSpec !== undefined) { resultPatch.vizSpec = vizSpec; resultPatch.prevVizSpec = prevVizSpec; }
          if (position !== undefined) { resultPatch.position = position; resultPatch.prevPosition = prevPosition; }

          const actionId = writeActionLog(action, elementId, { config, vizSpec, position }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.delete': {
          const elementId = request.elementId as string;
          const element = d.prepare('SELECT * FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!element) throw new Error(`Element ${elementId} not found`);

          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(elementId);
          const resultPatch = {
            deletedElement: {
              id: element.id,
              elementKind: element.element_kind,
              position: JSON.parse(element.position),
              config: JSON.parse(element.config),
              vizSpec: element.viz_spec ? JSON.parse(element.viz_spec) : null,
              state: element.state,
              dataVersion: element.data_version,
              permissions: JSON.parse(element.permissions),
              metadata: JSON.parse(element.metadata),
            },
          };
          const actionId = writeActionLog(action, elementId, null, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.arrange': {
          const layout = request.layout as Array<{ elementId: string; position: Record<string, unknown> }>;
          const resultPatch: Record<string, unknown> = { layout: [] as Array<{ elementId: string; position: Record<string, unknown> }> };

          // Batch update using prepared statement
          const elementIds = layout.map(item => item.elementId);
          if (elementIds.length > 0) {
            const setClauses = layout.map(() => 'WHEN ? THEN ?').join(' ');
            const whenClause = layout.map(() => '?').join(', ');
            d.prepare(`UPDATE conductor_elements SET position = CASE id ${setClauses} END, updated_at = ? WHERE id IN (${whenClause}) AND canvas_id = ?`).run(
              ...layout.flatMap(item => [item.elementId, JSON.stringify(item.position)]),
              now,
              ...elementIds,
              canvasId
            );
          }
          (resultPatch.layout as Array<Record<string, unknown>>).push(...layout.map(item => ({ elementId: item.elementId, position: item.position })));

          const actionId = writeActionLog(action, null, { layout }, resultPatch);
          broadcastPatch({ canvasId, actionId, resultPatch });
          return { success: true, actionId, resultPatch };
        }

        case 'element.create_native': {
          const elementId = randomUUID();
          const nodeType = request.nodeType as string;
          const position = request.position as Record<string, unknown>;
          const content = (request.content as Record<string, unknown>) || {};
          const style = (request.style as Record<string, unknown>) || {};
          const nativeKind = nodeType;
          const elementKind = `native/${nodeType}`;
          const permissions = {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: true,
          };
          const config = nodeType === 'document'
            ? { ...prepareCanvasDocument(canvasId, elementId, content), style }
            : { ...content, style };
          const metadata = {
            label: (content.label as string) || nodeType,
            tags: [] as string[],
            createdBy: actor as string,
            parentId: null,
            childIds: [] as string[],
          };

          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, native_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'idle', 1, ?, ?, ?, ?)`
          ).run(elementId, canvasId, elementKind, nativeKind, JSON.stringify(position), JSON.stringify(config), JSON.stringify(permissions), JSON.stringify(metadata), now, now);

          const element = {
            id: elementId,
            canvasId,
            elementKind,
            position,
            config,
            vizSpec: null,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            sourceCode: null,
            createdAt: now,
            updatedAt: now,
          };

          const resultPatch = { element };
          const actionId = writeActionLog(action, elementId, { nodeType, position, content, style }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'connector.create': {
          const elementId = randomUUID();
          const source = request.source as Record<string, unknown>;
          const target = request.target as Record<string, unknown>;
          const curvature = (request.curvature as number) || 0.4;
          const style = (request.style as Record<string, unknown>) || {};
          const nativeKind = 'connector';
          const elementKind = 'native/connector';
          const position = { x: 0, y: 0, w: 0, h: 0, zIndex: 0, rotation: 0 };
          const permissions = {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: true,
          };
          const config = {
            source,
            target,
            curvature,
            routingMode: request.routingMode === 'curve' ? 'curve' : 'elbow',
            label: typeof request.label === 'string' ? request.label : undefined,
            strokeStyle: typeof request.strokeStyle === 'string' ? request.strokeStyle : undefined,
            lineWidth: typeof request.lineWidth === 'number' ? request.lineWidth : undefined,
            color: typeof request.color === 'string' ? request.color : undefined,
            startMarker: typeof request.startMarker === 'string' ? request.startMarker : undefined,
            endMarker: typeof request.endMarker === 'string' ? request.endMarker : undefined,
            style,
          };
          const metadata = {
            label: 'Connector',
            tags: [] as string[],
            createdBy: actor as string,
            parentId: null,
            childIds: [] as string[],
          };

          d.prepare(
            `INSERT INTO conductor_elements (id, canvas_id, element_kind, native_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'idle', 1, ?, ?, ?, ?)`
          ).run(elementId, canvasId, elementKind, nativeKind, JSON.stringify(position), JSON.stringify(config), JSON.stringify(permissions), JSON.stringify(metadata), now, now);

          const element = {
            id: elementId,
            canvasId,
            elementKind,
            position,
            config,
            vizSpec: null,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            sourceCode: null,
            createdAt: now,
            updatedAt: now,
          };

          const resultPatch = { element };
          const actionId = writeActionLog(action, elementId, { source, target, curvature, style }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.update_content': {
          const elementId = request.elementId as string;
          const content = (request.content as Record<string, unknown> | undefined) ?? {};
          const prev = d.prepare('SELECT config, element_kind FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!prev) throw new Error(`Element ${elementId} not found`);

          const prevConfig = JSON.parse(prev.config);
          const nextConfig = { ...prevConfig, ...content };
          if (prev.element_kind === 'native/document') syncCanvasDocument(canvasId, nextConfig);
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nextConfig), now, elementId);

          const resultPatch = { config: nextConfig, prevConfig };
          const actionId = writeActionLog(action, elementId, { content }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        case 'element.reparent': {
          const elementId = request.elementId as string;
          const parentId = request.parentId as string | null;
          const prev = d.prepare('SELECT metadata FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(elementId, canvasId) as any;
          if (!prev) throw new Error(`Element ${elementId} not found`);

          const prevMetadata = JSON.parse(prev.metadata);
          const prevParentId = prevMetadata.parentId || null;

          const newMetadata = { ...prevMetadata, parentId };
          if (prevParentId) {
            const oldParent = d.prepare('SELECT metadata FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(prevParentId, canvasId) as any;
            if (oldParent) {
              const oldParentMeta = JSON.parse(oldParent.metadata);
              oldParentMeta.childIds = (oldParentMeta.childIds || []).filter((id: string) => id !== elementId);
              d.prepare('UPDATE conductor_elements SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(oldParentMeta), now, prevParentId);
            }
          }
          if (parentId) {
            const newParent = d.prepare('SELECT metadata FROM conductor_elements WHERE id = ? AND canvas_id = ?').get(parentId, canvasId) as any;
            if (newParent) {
              const newParentMeta = JSON.parse(newParent.metadata);
              newParentMeta.childIds = [...(newParentMeta.childIds || []), elementId];
              d.prepare('UPDATE conductor_elements SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(newParentMeta), now, parentId);
            }
          }

          d.prepare('UPDATE conductor_elements SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(newMetadata), now, elementId);

          const resultPatch = { metadata: newMetadata, prevMetadata };
          const actionId = writeActionLog(action, elementId, { parentId }, resultPatch);
          broadcastPatch({ canvasId, elementId, actionId, resultPatch });
          return { success: true, actionId, elementId, resultPatch };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    });

    try {
      return txn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbLogger.error('Conductor action failed', error instanceof Error ? error : new Error(msg), { action, canvasId }, LogComponent.DB);
      throw error;
    }
  });

  ipcMain.handle('conductor:undo', (_event, canvasId: string) => {
    const d = getDb();
    const now = Date.now();

    const lastAction = d.prepare(
      "SELECT * FROM conductor_actions WHERE canvas_id = ? AND reversible = 1 AND undone_at IS NULL ORDER BY ts DESC LIMIT 1"
    ).get(canvasId) as any;
    if (!lastAction) return { success: false, reason: 'No reversible action to undo' };

    const patch = lastAction.result_patch ? JSON.parse(lastAction.result_patch) : null;
    if (!patch) return { success: false, reason: 'No result patch to invert' };

    const inverted = invertPatch(patch, lastAction.action_type);

    const txn = d.transaction(() => {
      d.prepare('UPDATE conductor_actions SET undone_at = ? WHERE id = ?').run(now, lastAction.id);

      switch (lastAction.action_type) {
        case 'canvas.rename': {
          d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(inverted.name, now, canvasId);
          break;
        }
        case 'widget.create': {
          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(lastAction.widget_id);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(lastAction.widget_id);
          break;
        }
        case 'widget.move':
        case 'widget.resize': {
          d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.position), now, lastAction.widget_id);
          const widgetPos = inverted.position as any;
          const canvasPos = { x: widgetPos.x ?? 0, y: widgetPos.y ?? 0, w: widgetPos.w ?? 4, h: widgetPos.h ?? 3, zIndex: 0, rotation: 0 };
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(canvasPos), now, lastAction.widget_id);
          break;
        }
        case 'widget.update_config': {
          d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.config), now, lastAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.config), now, lastAction.widget_id);
          break;
        }
        case 'widget.update_data': {
          d.prepare('UPDATE conductor_widgets SET data = ?, data_version = data_version - 1, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.data), now, lastAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, data_version = data_version - 1, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.data), now, lastAction.widget_id);
          break;
        }
        case 'widget.delete': {
          const delWidget = patch.deletedWidget;
          if (delWidget) {
            d.prepare(
              `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
            ).run(
              delWidget.id, canvasId, delWidget.kind, delWidget.type,
              JSON.stringify(delWidget.position), JSON.stringify(delWidget.config), JSON.stringify(delWidget.data),
              delWidget.dataVersion, JSON.stringify(delWidget.permissions), now, now
            );
            const dwPos = delWidget.position;
            const ecPos = { x: dwPos.x ?? 0, y: dwPos.y ?? 0, w: dwPos.w ?? 4, h: dwPos.h ?? 3, zIndex: 0, rotation: 0 };
            const mgConfig = { ...delWidget.data, ...delWidget.config };
            const ecMeta = { label: `${delWidget.kind}:${delWidget.type}`, tags: [], createdBy: 'user' };
            d.prepare(
              `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
            ).run(delWidget.id, canvasId, `widget/${delWidget.type}`, JSON.stringify(ecPos), JSON.stringify(mgConfig), delWidget.dataVersion, JSON.stringify(delWidget.permissions), JSON.stringify(ecMeta), now, now);
          }
          break;
        }
        case 'widget.restore': {
          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(lastAction.widget_id);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(lastAction.widget_id);
          break;
        }
        case 'element.create': {
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(lastAction.widget_id);
          break;
        }
        case 'element.move': {
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.position), now, lastAction.widget_id);
          break;
        }
        case 'element.update': {
          if (inverted.config !== undefined) {
            d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.config), now, lastAction.widget_id);
          }
          if (inverted.vizSpec !== undefined) {
            d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(inverted.vizSpec ? JSON.stringify(inverted.vizSpec) : null, now, lastAction.widget_id);
          }
          if (inverted.position !== undefined) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inverted.position), now, lastAction.widget_id);
          }
          break;
        }
        case 'element.delete': {
          const delElement = patch.deletedElement;
          if (delElement) {
            d.prepare(
              `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
            ).run(
              delElement.id, canvasId, delElement.elementKind,
              JSON.stringify(delElement.position), JSON.stringify(delElement.config),
              delElement.vizSpec ? JSON.stringify(delElement.vizSpec) : null,
              delElement.state, delElement.dataVersion,
              JSON.stringify(delElement.permissions), JSON.stringify(delElement.metadata),
              now, now
            );
          }
          break;
        }
        case 'element.arrange': {
          break;
        }
      }

      const channelManager = getChannelManager();
      channelManager?.sendToChannel('conductor', { type: 'conductor:state:patch', _v2: true, canvasId, undoActionId: lastAction.id, inverted });
    });

    txn();
    return { success: true, actionId: lastAction.id, inverted };
  });

  ipcMain.handle('conductor:redo', (_event, canvasId: string) => {
    const d = getDb();
    const now = Date.now();

    const undoneAction = d.prepare(
      "SELECT * FROM conductor_actions WHERE canvas_id = ? AND undone_at IS NOT NULL ORDER BY undone_at DESC LIMIT 1"
    ).get(canvasId) as any;
    if (!undoneAction) return { success: false, reason: 'No action to redo' };

    const patch = undoneAction.result_patch ? JSON.parse(undoneAction.result_patch) : null;
    if (!patch) return { success: false, reason: 'No result patch to redo' };

    const txn = d.transaction(() => {
      d.prepare('UPDATE conductor_actions SET undone_at = NULL WHERE id = ?').run(undoneAction.id);

      switch (undoneAction.action_type) {
        case 'canvas.rename': {
          d.prepare('UPDATE conductor_canvases SET name = ?, updated_at = ? WHERE id = ?').run(patch.name, now, canvasId);
          break;
        }
        case 'widget.create': {
          const widget = patch.widget;
          d.prepare(
            `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
          ).run(
            widget.id, canvasId, widget.kind, widget.type,
            JSON.stringify(widget.position), JSON.stringify(widget.config), JSON.stringify(widget.data),
            widget.dataVersion, JSON.stringify(widget.permissions), widget.createdAt, now
          );
          const element = patch.element;
          if (element) {
            d.prepare(
              `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
            ).run(
              element.id, canvasId, element.elementKind,
              JSON.stringify(element.position), JSON.stringify(element.config),
              element.dataVersion ?? 1,
              JSON.stringify(element.permissions), JSON.stringify(element.metadata),
              element.createdAt ?? now, now
            );
          }
          break;
        }
        case 'widget.move':
        case 'widget.resize': {
          d.prepare('UPDATE conductor_widgets SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.position), now, undoneAction.widget_id);
          const wPos = patch.position as any;
          const cPos = { x: wPos.x ?? 0, y: wPos.y ?? 0, w: wPos.w ?? 4, h: wPos.h ?? 3, zIndex: 0, rotation: 0 };
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(cPos), now, undoneAction.widget_id);
          break;
        }
        case 'widget.update_config': {
          d.prepare('UPDATE conductor_widgets SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.config), now, undoneAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.config), now, undoneAction.widget_id);
          break;
        }
        case 'widget.update_data': {
          d.prepare('UPDATE conductor_widgets SET data = ?, data_version = data_version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.data), now, undoneAction.widget_id);
          d.prepare('UPDATE conductor_elements SET config = ?, data_version = data_version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.data), now, undoneAction.widget_id);
          break;
        }
        case 'widget.delete': {
          d.prepare('DELETE FROM conductor_widgets WHERE id = ?').run(undoneAction.widget_id);
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(undoneAction.widget_id);
          break;
        }
        case 'widget.restore': {
          const restoredWidget = patch.restoredWidget;
          if (restoredWidget) {
            d.prepare(
              `INSERT INTO conductor_widgets (id, canvas_id, kind, type, position, config, data, data_version, source_code, state, permissions, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?)`
            ).run(
              restoredWidget.id, canvasId, restoredWidget.kind, restoredWidget.type,
              JSON.stringify(restoredWidget.position), JSON.stringify(restoredWidget.config), JSON.stringify(restoredWidget.data),
              restoredWidget.dataVersion, JSON.stringify(restoredWidget.permissions), now, now
            );
            const rsPos = restoredWidget.position;
            const rsCPos = { x: rsPos.x ?? 0, y: rsPos.y ?? 0, w: rsPos.w ?? 4, h: rsPos.h ?? 3, zIndex: 0, rotation: 0 };
            const rsConfig = { ...restoredWidget.data, ...restoredWidget.config };
            const rsMeta = { label: `${restoredWidget.kind}:${restoredWidget.type}`, tags: [], createdBy: 'user' };
            d.prepare(
              `INSERT OR IGNORE INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?, ?, ?)`
            ).run(restoredWidget.id, canvasId, `widget/${restoredWidget.type}`, JSON.stringify(rsCPos), JSON.stringify(rsConfig), restoredWidget.dataVersion, JSON.stringify(restoredWidget.permissions), JSON.stringify(rsMeta), now, now);
          }
          break;
        }
        case 'element.create': {
          const element = patch.element;
          if (element) {
            d.prepare(
              `INSERT INTO conductor_elements (id, canvas_id, element_kind, position, config, viz_spec, source_code, state, data_version, permissions, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
            ).run(
              element.id, canvasId, element.elementKind,
              JSON.stringify(element.position), JSON.stringify(element.config),
              element.vizSpec ? JSON.stringify(element.vizSpec) : null,
              element.state, element.dataVersion,
              JSON.stringify(element.permissions), JSON.stringify(element.metadata),
              element.createdAt, now
            );
          }
          break;
        }
        case 'element.move': {
          d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.position), now, undoneAction.widget_id);
          break;
        }
        case 'element.update': {
          if (patch.config !== undefined) {
            d.prepare('UPDATE conductor_elements SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.config), now, undoneAction.widget_id);
          }
          if (patch.vizSpec !== undefined) {
            d.prepare('UPDATE conductor_elements SET viz_spec = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.vizSpec), now, undoneAction.widget_id);
          }
          if (patch.position !== undefined) {
            d.prepare('UPDATE conductor_elements SET position = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.position), now, undoneAction.widget_id);
          }
          break;
        }
        case 'element.delete': {
          d.prepare('DELETE FROM conductor_elements WHERE id = ?').run(undoneAction.widget_id);
          break;
        }
        case 'element.arrange': {
          break;
        }
      }

      const channelManager = getChannelManager();
      channelManager?.sendToChannel('conductor', { type: 'conductor:state:patch', _v2: true, canvasId, redoActionId: undoneAction.id, patch });
    });

    txn();
    return { success: true, actionId: undoneAction.id, patch };
  });

  ipcMain.handle('conductor:asset:upload', (_event, payload: { canvasId: string; buffer: ArrayBuffer; fileName: string; mimeType?: string }) => {
    const { canvasId, buffer, fileName, mimeType } = payload;
    if (!canvasId || !buffer || !fileName) {
      throw new Error('canvasId, buffer, and fileName are required');
    }
    return conductorUploadAsset(canvasId, buffer, fileName, mimeType);
  });

  ipcMain.handle(
    'conductor:link:captureSnapshot',
    async (
      _event,
      payload: {
        canvasId: string;
        elementId: string;
        url: string;
        mode: import('../../packages/conductor/src/renderer/types/canvas-node').LinkSnapshotMode;
      },
    ) => {
      const { canvasId, elementId, url, mode } = payload;
      if (!canvasId || !elementId || !url || !mode) {
        throw new Error('canvasId, elementId, url, and mode are required');
      }
      if (mode === 'none') {
        throw new Error('Cannot capture snapshot for mode "none"');
      }

      const normalizedUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
      const canvasRow = getDb()
        .prepare('SELECT project_path FROM conductor_canvases WHERE id = ?')
        .get(canvasId) as {
        project_path: string | null;
      } | undefined;
      const projectPath = canvasRow?.project_path ?? null;

      const capture = await captureWebsiteSnapshot(normalizedUrl, mode);
      const asset = conductorUploadProjectAsset(
        canvasId,
        projectPath,
        capture.buffer,
        `snapshot-${mode}-${Date.now()}.png`,
        'image/png',
      );

      return {
        assetId: asset.assetId,
        url: asset.url,
        width: capture.width,
        height: capture.height,
      };
    },
  );

  dbLogger.info('Conductor handlers registered', undefined, LogComponent.DB);
}

// ============================================================
// Conductor OT Merge Logic
// ============================================================

interface MergeContext {
  actor: string;
  clientTs?: number;
  serverVersion: number;
}

interface MergeResult {
  data: Record<string, unknown>;
  mergedFrom: string | null;
}

function mergeWidgetData(server: Record<string, unknown>, patch: Record<string, unknown>, context: MergeContext): MergeResult {
  if (context.actor === 'user') {
    return { data: deepMerge(server, patch, 'user'), mergedFrom: null };
  }

  if (context.clientTs && Date.now() - context.clientTs > 30000) {
    dbLogger.warn('Conductor merge: clientTs > 30s old, replacing fully', { clientTs: context.clientTs, serverVersion: context.serverVersion }, LogComponent.DB);
    return { data: patch, mergedFrom: 'full_replace_stale' };
  }

  const merged = deepMerge(server, patch, 'server');
  const hasConflict = JSON.stringify(merged) !== JSON.stringify(patch);
  return {
    data: merged,
    mergedFrom: hasConflict ? 'agent_conflict' : null,
  };
}

function deepMerge(server: Record<string, unknown>, patch: Record<string, unknown>, priority: 'user' | 'server'): Record<string, unknown> {
  const result = { ...server };

  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const serverVal = server[key];

    if (patchVal === undefined) continue;

    if (serverVal === undefined) {
      result[key] = patchVal;
      continue;
    }

    if (Array.isArray(patchVal) && Array.isArray(serverVal)) {
      result[key] = mergeArrays(serverVal as Record<string, unknown>[], patchVal as Record<string, unknown>[]);
    } else if (isPlainObject(patchVal) && isPlainObject(serverVal)) {
      result[key] = deepMerge(serverVal as Record<string, unknown>, patchVal as Record<string, unknown>, priority);
    } else if (serverVal !== patchVal) {
      result[key] = priority === 'user' ? patchVal : serverVal;
    }
  }

  return result;
}

function mergeArrays(server: Record<string, unknown>[], patch: Record<string, unknown>[]): Record<string, unknown>[] {
  const idMap = new Map<string, Record<string, unknown>>();
  for (const item of server) {
    const id = item.id as string;
    if (id) idMap.set(id, { ...item });
  }
  for (const item of patch) {
    const id = item.id as string;
    if (id) {
      const existing = idMap.get(id);
      if (existing) {
        idMap.set(id, deepMerge(existing, item, 'server'));
      } else {
        idMap.set(id, { ...item });
      }
    }
  }
  return Array.from(idMap.values());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invertPatch(patch: Record<string, unknown>, actionType: string): Record<string, unknown> {
  switch (actionType) {
    case 'canvas.rename':
      return { name: patch.prevName || 'Untitled' };
    case 'widget.create':
      return {};
    case 'widget.move':
    case 'widget.resize':
      return { position: (patch as any).prevPosition || patch.position };
    case 'widget.update_config':
      return { config: (patch as any).prevConfig || patch.config };
    case 'widget.update_data':
      return { data: (patch as any).prevData || patch.data };
    case 'widget.delete':
      return {};
    case 'widget.restore':
      return {};
    case 'element.create':
      return {};
    case 'element.move':
      return { position: (patch as any).prevPosition || patch.position };
    case 'element.update':
      return {
        config: (patch as any).prevConfig || patch.config,
        vizSpec: (patch as any).prevVizSpec ?? patch.vizSpec,
        position: (patch as any).prevPosition || patch.position,
      };
    case 'element.delete':
      return {};
    case 'element.arrange':
      return {};
    default:
      return {};
  }
}

// ==================== Mailbox Handlers (Plan 202 — PR1) ====================

export function registerMailboxHandlers(): void {
  const KIND_PRIORITY: Record<string, number> = {
    abort_and_replace: 0,
    stop: 10,
    correction: 50,
    constraint: 50,
    followup: 100,
  };

  ipcMain.handle('mailbox:send', (_event, data: {
    id: string;
    sessionId: string;
    content: string;
    kind: string;
    submittedDuringRunId: string;
    attachments?: unknown[];
    clientMsgId?: string;
    source?: string;
    constraintsJson?: string;
  }) => {
    const database = getDb();
    const now = Date.now();
    const priority = KIND_PRIORITY[data.kind] ?? 100;

    // Idempotency check
    if (data.clientMsgId) {
      const existing = database.prepare(
        'SELECT * FROM agent_mailbox WHERE session_id = ? AND client_msg_id = ?'
      ).get(data.sessionId, data.clientMsgId);
      if (existing) return existing;
    }

    database.prepare(`
      INSERT INTO agent_mailbox (
        id, session_id, submitted_during_run_id, content, kind, status,
        priority, constraints_json, attachments_json, source,
        client_msg_id, created_at
      ) VALUES (
        @id, @session_id, @submitted_during_run_id, @content, @kind, 'pending',
        @priority, @constraints_json, @attachments_json, @source,
        @client_msg_id, @created_at
      )
    `).run({
      id: data.id,
      session_id: data.sessionId,
      submitted_during_run_id: data.submittedDuringRunId || '',
      content: data.content,
      kind: data.kind,
      priority,
      constraints_json: data.constraintsJson ?? null,
      attachments_json: data.attachments ? JSON.stringify(data.attachments) : null,
      source: data.source ?? 'ui',
      client_msg_id: data.clientMsgId ?? null,
      created_at: now,
    });

    const row = database.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(data.id);
    emitMailCreated(row as Record<string, unknown>);
    return row;
  });

  ipcMain.handle('mailbox:edit', (_event, data: { id: string; content?: string; kind?: string }) => {
    const database = getDb();
    const existing = database.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(data.id) as Record<string, unknown> | undefined;
    if (!existing) return null;
    // A previous renderer may have committed the row before its IPC response
    // failed. Returning the same row makes a retry enqueue it exactly once.
    if (existing.status === 'applied' && existing.applied_summary === 'queued_for_next_agent_turn') {
      return existing;
    }
    if (existing.status !== 'pending') return null;
    if (existing.edit_locked_at !== null) return null;

    const now = Date.now();
    const fields: string[] = [];
    const params: Record<string, unknown> = { id: data.id };

    const editHistory: Array<{ editedAt: number; prevContent: string; prevKind: string }> = [];
    if (existing.edit_history_json) {
      try { editHistory.push(...JSON.parse(existing.edit_history_json as string)); } catch { /* ignore */ }
    }

    if (data.content !== undefined) {
      editHistory.push({ editedAt: now, prevContent: existing.content as string, prevKind: existing.kind as string });
      fields.push('content = @content');
      params.content = data.content;
    }
    if (data.kind !== undefined) {
      if (!editHistory.some(e => e.prevKind === existing.kind && e.editedAt === now)) {
        editHistory.push({ editedAt: now, prevContent: existing.content as string, prevKind: existing.kind as string });
      }
      fields.push('kind = @kind');
      fields.push('priority = @priority');
      params.kind = data.kind;
      params.priority = KIND_PRIORITY[data.kind] ?? 100;
    }

    if (fields.length === 0) return existing;

    fields.push('edit_history_json = @edit_history_json');
    params.edit_history_json = JSON.stringify(editHistory);

    database.prepare(`UPDATE agent_mailbox SET ${fields.join(', ')} WHERE id = @id`).run(params);
    const row = database.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(data.id);
    emitMailEdited(row as Record<string, unknown>, existing.content as string);
    return row;
  });

  ipcMain.handle('mailbox:guide', (_event, data: { id: string }) => {
    const database = getDb();
    const guided = markMailboxForGuidance(database, data.id);
    if (!guided) return null;
    emitMailEdited(guided.row, guided.previousContent);
    return guided.row;
  });

  ipcMain.handle('mailbox:promoteQueued', (_event, data: { id: string }) => {
    const database = getDb();
    const row = promoteQueuedMailbox(database, data.id);
    if (!row) return null;
    emitMailApplied(row);
    return row;
  });

  ipcMain.handle('mailbox:cancel', (_event, data: { id: string; reason?: string }) => {
    const database = getDb();
    const now = Date.now();
    const result = database.prepare(`
      UPDATE agent_mailbox
      SET status = 'cancelled', cancelled_at = @now, cancelled_by = 'user', cancel_reason = @reason
      WHERE id = @id AND status = 'pending'
    `).run({ id: data.id, now, reason: data.reason ?? null });

    if (result.changes === 0) return null;
    const row = database.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(data.id);
    emitMailCancelled(row as Record<string, unknown>, data.reason);
    return row;
  });

  ipcMain.handle('mailbox:list', (_event, data: { sessionId: string; status?: string[]; limit?: number }) => {
    const database = getDb();
    const limit = data.limit ?? 50;
    const statuses = data.status;
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      return database.prepare(
        `SELECT * FROM agent_mailbox WHERE session_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`
      ).all(data.sessionId, ...statuses, limit);
    }
    return database.prepare(
      'SELECT * FROM agent_mailbox WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(data.sessionId, limit);
  });

  ipcMain.handle('mailbox:listForSession', (_event, data: { sessionId: string }) => {
    return getDb().prepare(
      'SELECT * FROM agent_mailbox WHERE session_id = ? ORDER BY created_at ASC'
    ).all(data.sessionId);
  });
}
