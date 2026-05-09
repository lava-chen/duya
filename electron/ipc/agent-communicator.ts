/**
 * agent-communicator.ts - Database action dispatcher for Agent
 *
 * Handles database requests from the Agent via IPC.
 * Agent lifecycle is now managed by AgentProcessPool (multi-process architecture).
 */

import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { getDatabase } from '../db-handlers';
import { getAgentProcessPool } from '../agent-process-pool';
import { getConfigManager, ApiProvider, toLLMProvider } from '../config-manager';
import { getAutomationScheduler } from '../automation/Scheduler.js';
import { getLogger, LogComponent } from '../logger';
import { testProviderConnection } from '../net-handlers';
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    console.log('[Agent-IPC][DEBUG]', ...args);
  }
}

/**
 * Get default model name based on provider type
 */
function getDefaultModelForProvider(providerType: ApiProvider['providerType'], options?: Record<string, unknown>): string {
  // Try to get model from provider options first (highest priority)
  if (options) {
    const optModel = (options as Record<string, unknown>).defaultModel || (options as Record<string, unknown>).model;
    if (typeof optModel === 'string' && optModel.length > 0) {
      return optModel;
    }
  }

  // Fall back to provider type defaults (only for known types)
  switch (providerType) {
    case 'ollama':
      return 'llama3.2';
    case 'openai':
      return 'gpt-4o';
    case 'openai-compatible':
      // openai-compatible includes MiniMax, Kimi, etc. - use gpt-4o as safe default
      // only if no model is configured in options
      return '';
    case 'anthropic':
      return '';
    default:
      return '';
  }
}

// Re-export DB request/response types
export interface DbRequest {
  type: 'db:request';
  id: string;
  action: string;
  payload: unknown;
}

export interface DbResponse {
  type: 'db:response';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

// Dispatch DB action directly to database
export async function dispatchDbAction(action: string, payload: unknown): Promise<unknown> {
  const db = getDatabase();
  if (!db) {
    throw new Error('Database not initialized');
  }

  const p = payload as Record<string, unknown>;
  const now = Date.now();

  switch (action) {
    // ==================== Session actions ====================
    case 'session:create': {
      // Get provider type from provider_id to determine default model
      let providerType: ApiProvider['providerType'] = 'anthropic';
      let defaultModel: string | undefined;
      
      if (p.provider_id) {
        const configManager = getConfigManager();
        const provider = configManager.getAllProviders()[p.provider_id as string];
        if (provider) {
          providerType = provider.providerType;
          // Try to get default model from provider options
          if (provider.options) {
            try {
              const options = JSON.parse(provider.options);
              defaultModel = options.defaultModel || options.model;
            } catch {
              // Ignore parse error
            }
          }
        }
      }
      
      // Use provided model, or provider default, or fallback to type default
      const model = (p.model as string) || defaultModel || getDefaultModelForProvider(providerType);
      
      db.prepare(`
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
        id: p.id,
        title: p.title ?? 'New Chat',
        model,
        system_prompt: p.system_prompt ?? '',
        working_directory: p.working_directory ?? '',
        project_name: p.project_name ?? '',
        status: p.status ?? 'active',
        mode: p.mode ?? 'code',
        provider_id: p.provider_id ?? 'env',
        generation: p.generation ?? 0,
        parent_id: p.parent_session_id ?? null,
        agent_type: p.agent_type ?? 'main',
        agent_name: p.agent_name ?? '',
        created_at: now,
        updated_at: now,
      });
      return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(p.id);
    }

    case 'session:get':
      return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(p.id);

    case 'session:update': {
      const fields: string[] = ['updated_at = @updated_at'];
      const params: Record<string, unknown> = { id: p.id as string, updated_at: now };

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
        agent_type: 'agent_type',
        agent_name: 'agent_name',
      };

      for (const [key, dbField] of Object.entries(fieldMap)) {
        if (p[key] !== undefined) {
          fields.push(`${dbField} = @${key}`);
          params[key] = p[key];
        }
      }

      db.prepare(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = @id`).run(params);
      return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(p.id);
    }

    case 'session:delete': {
      const txn = db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(p.id);
        return db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(p.id).changes > 0;
      });
      return txn();
    }

    case 'session:list':
      return db.prepare('SELECT * FROM chat_sessions WHERE is_deleted = 0 ORDER BY updated_at DESC').all();

    case 'session:listByWorkingDirectory': {
      const wd = p.workingDirectory as string;
      if (!wd) {
        return db.prepare(
          "SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = '' ORDER BY updated_at DESC"
        ).all();
      }
      return db.prepare(
        'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND working_directory = ? ORDER BY updated_at DESC'
      ).all(wd);
    }

    case 'session:listByParentId':
      return db.prepare(
        'SELECT * FROM chat_sessions WHERE is_deleted = 0 AND parent_id = ? ORDER BY created_at ASC'
      ).all(p.parentId);

    // ==================== Message actions ====================
    case 'message:add': {
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, created_at)
        VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @created_at)
      `).run({
        id: p.id,
        session_id: p.session_id,
        role: p.role,
        content: p.content,
        name: p.name ?? null,
        tool_call_id: p.tool_call_id ?? null,
        token_usage: p.token_usage ?? null,
        created_at: now,
      });
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, p.session_id);
      return db.prepare('SELECT * FROM messages WHERE id = ?').get(p.id);
    }

    case 'message:getBySession':
      return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(p.sessionId);

    case 'message:getCount': {
      const result = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(p.sessionId) as { count: number };
      return result.count;
    }

    case 'message:deleteBySession':
      return db.prepare('DELETE FROM messages WHERE session_id = ?').run(p.sessionId).changes;

    case 'message:replace': {
      const sessionId = p.sessionId as string;
      let messages: Array<{
        id?: string;
        role: string;
        content: string;
        name?: string;
        tool_call_id?: string;
        timestamp?: number;
      }>;
      const generation = p.generation as number;
      console.log('[Agent-IPC] message:replace request for session:', sessionId, 'generation:', generation, 'messageCount:', Array.isArray(p.messages) ? p.messages.length : -1);
      debugLog('message:replace request', {
        sessionId,
        generation,
        hasMessages: Array.isArray(p.messages),
        messageCount: Array.isArray(p.messages) ? p.messages.length : -1,
      });

      if (!p.messages || typeof p.messages !== 'object') {
        getLogger().error('message:replace INVALID messages', undefined, { type: typeof p.messages, messages: p.messages }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'invalid_messages_format' };
      }
      if (!Array.isArray(p.messages)) {
        getLogger().error('message:replace messages is not array', undefined, { keys: Object.keys(p.messages) }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'messages_not_array' };
      }
      messages = p.messages as typeof messages;

      try {
        const session = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as { generation: number } | undefined;
        console.log('[Agent-IPC] message:replace session lookup:', sessionId, 'found:', !!session, 'session:', session);
        if (!session) {
          console.log('[Agent-IPC] message:replace session_not_found:', sessionId);
          return { success: false, reason: 'session_not_found' };
        }
        if (generation < session.generation) {
          console.log('[Agent-IPC] message:replace stale_generation:', sessionId, 'gen:', generation, 'current:', session.generation);
          return { success: false, reason: 'stale_generation' };
        }

        let newGeneration = 0;

        const txn = db.transaction(() => {
          newGeneration = Math.max(generation, session.generation + 1);
          db.prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?').run(newGeneration, now, sessionId);
          db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

          const stmt = db.prepare(`
            INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, created_at)
            VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @created_at)
          `);

          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i] as Record<string, unknown>;

            let contentValue: string;
            if (typeof msg.content === 'string') {
              contentValue = msg.content;
            } else if (msg.content === null || msg.content === undefined) {
              contentValue = '';
            } else {
              contentValue = JSON.stringify(msg.content);
            }

            const roleValue = typeof msg.role === 'string' && msg.role.length > 0 ? msg.role : 'assistant';
            const idValue = typeof msg.id === 'string' && msg.id.length > 0 ? msg.id : randomUUID();

            let msgType = (msg.msg_type as string) || 'text';
            let thinking: string | null = (msg.thinking as string) || null;
            let toolName: string | null = (msg.tool_name as string) || null;
            let toolInput: string | null = (msg.tool_input as string) || null;
            let parentToolCallId: string | null = (msg.parent_tool_call_id as string) || null;

            if (!msg.msg_type && Array.isArray(msg.content)) {
              const blocks = msg.content as Array<{ type: string; thinking?: string; name?: string; input?: unknown; tool_use_id?: string }>;
              const types = blocks.map(b => b.type);
              if (types.includes('thinking') && types.length === 1) {
                msgType = 'thinking';
                thinking = blocks[0].thinking || null;
                contentValue = thinking || '';
              } else if (types.includes('tool_use') && types.length === 1) {
                msgType = 'tool_use';
                toolName = blocks[0].name || null;
                toolInput = blocks[0].input ? JSON.stringify(blocks[0].input) : null;
                contentValue = toolInput || '';
              } else if (roleValue === 'tool') {
                msgType = 'tool_result';
                parentToolCallId = (msg.tool_call_id as string) || null;
              } else {
                const thinkingBlock = blocks.find(b => b.type === 'thinking');
                if (thinkingBlock) thinking = thinkingBlock.thinking || null;
              }
            } else if (!msg.msg_type && typeof msg.content === 'string') {
              if (roleValue === 'tool') {
                msgType = 'tool_result';
                parentToolCallId = (msg.tool_call_id as string) || null;
              }
            }

            if (!roleValue || roleValue.length === 0) {
              getLogger().error('message:replace SKIPPING invalid role', undefined, { role: msg.role, index: i }, LogComponent.AgentCommunicator);
              continue;
            }

            stmt.run({
              id: idValue,
              session_id: sessionId,
              role: roleValue,
              content: contentValue,
              name: msg.name || null,
              tool_call_id: msg.tool_call_id || null,
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
              created_at: msg.timestamp || now,
            });
          }
        });

        try {
          txn();
          const result = { success: true, newGeneration, messageCount: messages.length };
          console.log('[Agent-IPC] message:replace success:', sessionId, 'messageCount:', messages.length);
          debugLog('message:replace success', { sessionId, ...result });
          return result;
        } catch (txnError) {
          console.error('[Agent-IPC] message:replace transaction failed:', sessionId, txnError);
          getLogger().error('Transaction failed', txnError instanceof Error ? txnError : new Error(String(txnError)), { sessionId }, LogComponent.AgentCommunicator);
          throw txnError;
        }
      } catch (error) {
        console.error('[Agent-IPC] message:replace failed:', sessionId, error);
        getLogger().error('message:replace failed', error instanceof Error ? error : new Error(String(error)), { sessionId }, LogComponent.AgentCommunicator);
        debugLog('message:replace failed', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return { success: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    // ==================== Lock actions ====================
    case 'lock:acquire': {
      const sessionId = p.sessionId as string;
      const lockId = p.lockId as string;
      const owner = p.owner as string;
      const ttlSec = (p.ttlSec as number) || 300;
      const expiresAt = now + ttlSec * 1000;

      const txn = db.transaction(() => {
        db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
        try {
          db.prepare('INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at) VALUES (?, ?, ?, ?)').run(sessionId, lockId, owner, expiresAt);
          return true;
        } catch {
          return false;
        }
      });
      return txn();
    }

    case 'lock:renew': {
      const ttlSec = (p.ttlSec as number) || 300;
      const expiresAt = now + ttlSec * 1000;
      const result = db.prepare('UPDATE session_runtime_locks SET expires_at = ? WHERE session_id = ? AND lock_id = ?').run(expiresAt, p.sessionId, p.lockId);
      return result.changes > 0;
    }

    case 'lock:release': {
      const result = db.prepare('DELETE FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?').run(p.sessionId, p.lockId);
      return result.changes > 0;
    }

    case 'lock:isLocked': {
      db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
      return db.prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?').get(p.sessionId) !== undefined;
    }

    // ==================== Task actions ====================
    case 'task:create': {
      db.prepare(`
        INSERT INTO tasks (id, session_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', '[]', '{}', ?, ?)
      `).run(p.id, p.session_id, p.subject, p.description, p.active_form ?? null, p.owner ?? null, now, now);
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.id);
    }

    case 'task:get':
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.id);

    case 'task:getBySession':
      return db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC').all(p.sessionId);

    case 'task:update': {
      const id = p.id as string;
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
        if (p[key] !== undefined) {
          fields.push(`${dbField} = ?`);
          values.push(p[key]);
        }
      }

      if (p.blocks !== undefined) {
        fields.push('blocks = ?');
        values.push(JSON.stringify(p.blocks));
      }
      if (p.blocked_by !== undefined) {
        fields.push('blocked_by = ?');
        values.push(JSON.stringify(p.blocked_by));
      }
      if (p.metadata !== undefined) {
        fields.push('metadata = ?');
        values.push(JSON.stringify(p.metadata));
      }

      values.push(id);
      db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    }

    case 'task:delete':
      return db.prepare('DELETE FROM tasks WHERE id = ?').run(p.id).changes > 0;

    case 'task:deleteBySession':
      db.prepare('DELETE FROM tasks WHERE session_id = ?').run(p.sessionId);

    case 'task:claim': {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.id) as Record<string, unknown> | undefined;
      if (!row) return { success: false, reason: 'task_not_found' };
      if (row.owner && row.owner !== p.owner) return { success: false, reason: 'already_claimed' };
      if (row.status === 'completed') return { success: false, reason: 'already_resolved' };

      const blockedBy = JSON.parse((row.blocked_by as string) || '[]') as string[];
      if (blockedBy.length > 0) {
        const unresolvedIds = db.prepare(
          `SELECT id FROM tasks WHERE id IN (${blockedBy.map(() => '?').join(',')}) AND status != 'completed'`
        ).all(...blockedBy) as { id: string }[];
        if (unresolvedIds.length > 0) {
          return { success: false, reason: 'blocked', blockedByTasks: unresolvedIds.map(r => r.id) };
        }
      }

      db.prepare(`UPDATE tasks SET owner = ?, status = 'in_progress', updated_at = ? WHERE id = ?`).run(p.owner, now, p.id);
      return { success: true, task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.id) };
    }

    case 'task:block': {
      const from = db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.fromId) as Record<string, unknown> | undefined;
      const to = db.prepare('SELECT * FROM tasks WHERE id = ?').get(p.toId) as Record<string, unknown> | undefined;
      if (!from || !to) return false;

      const fromBlocks: string[] = JSON.parse((from.blocks as string) || '[]');
      const toBlockedBy: string[] = JSON.parse((to.blocked_by as string) || '[]');

      if (!fromBlocks.includes(p.toId)) {
        fromBlocks.push(p.toId);
        db.prepare('UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(fromBlocks), now, p.fromId);
      }
      if (!toBlockedBy.includes(p.fromId)) {
        toBlockedBy.push(p.fromId);
        db.prepare('UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(toBlockedBy), now, p.toId);
      }
      return true;
    }

    case 'task:unassignTeammate': {
      const tasks = db.prepare(
        `SELECT id, subject FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
      ).all(p.sessionId, p.owner) as { id: string; subject: string }[];
      if (tasks.length === 0) return { unassignedTasks: [], notificationMessage: '' };

      db.prepare(
        `UPDATE tasks SET owner = NULL, status = 'pending', updated_at = ? WHERE session_id = ? AND status != 'completed' AND owner = ?`
      ).run(now, p.sessionId, p.owner);

      const taskList = tasks.map(t => `#${t.id} "${t.subject}"`).join(', ');
      return {
        unassignedTasks: tasks.map(t => ({ id: t.id, subject: t.subject })),
        notificationMessage: `${p.owner} was terminated. ${tasks.length} task(s) were unassigned: ${taskList}.`,
      };
    }

    case 'task:getByOwner':
      return db.prepare(
        `SELECT * FROM tasks WHERE session_id = ? AND status != 'completed' AND owner = ?`
      ).all(p.sessionId, p.owner);

    // ==================== Settings actions ====================
    case 'setting:get': {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(p.key) as { value: string } | undefined;
      return row?.value ?? null;
    }

    case 'setting:set': {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(p.key, p.value, now);
    }

    case 'setting:getAll': {
      const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
      const settings: Record<string, string> = {};
      for (const row of rows) settings[row.key] = row.value;
      return settings;
    }

    case 'setting:getJson': {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(p.key) as { value: string } | undefined;
      if (!row) return p.defaultValue;
      try {
        return JSON.parse(row.value);
      } catch {
        return p.defaultValue;
      }
    }

    case 'setting:setJson': {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(p.key, JSON.stringify(p.value), now);
    }

    // Provider actions removed - now handled by ConfigManager via config:provider:* handlers

    // ==================== Permission actions ====================
    case 'permission:create': {
      db.prepare(`
        INSERT INTO permission_requests (id, session_id, tool_name, tool_input, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(
        p.id,
        p.sessionId || null,
        p.toolName,
        p.toolInput ? JSON.stringify(p.toolInput) : null,
        now
      );
      return db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(p.id);
    }

    case 'permission:get':
      return db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(p.id);

    case 'permission:resolve': {
      const extra = p.extra as { message?: string; updatedPermissions?: unknown[]; updatedInput?: Record<string, unknown> } | undefined;
      db.prepare(`
        UPDATE permission_requests SET
          status = ?,
          decision = ?,
          message = ?,
          updated_permissions = ?,
          updated_input = ?,
          resolved_at = ?
        WHERE id = ?
      `).run(
        p.status,
        p.status,
        extra?.message || null,
        extra?.updatedPermissions ? JSON.stringify(extra.updatedPermissions) : null,
        extra?.updatedInput ? JSON.stringify(extra.updatedInput) : null,
        now,
        p.id
      );
      return db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(p.id);
    }

    // ==================== Search actions ====================
    case 'search:sessions': {
      const limit = (p.limit as number) || 10;
      try {
        const ftsAvailable = db.prepare("SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'").get();
        if (ftsAvailable) {
          return db.prepare(`
            SELECT DISTINCT m.session_id, s.* FROM messages_fts f
            JOIN messages m ON f.rowid = m.rowid
            JOIN chat_sessions s ON m.session_id = s.id
            WHERE messages_fts MATCH ? AND s.is_deleted = 0
            ORDER BY s.updated_at DESC LIMIT ?
          `).all(p.query, limit);
        }
      } catch {}
      return db.prepare(`
        SELECT DISTINCT s.* FROM messages m
        JOIN chat_sessions s ON m.session_id = s.id
        WHERE m.content LIKE ? AND s.is_deleted = 0
        ORDER BY s.updated_at DESC LIMIT ?
      `).all(`%${p.query}%`, limit);
    }

    // ==================== Channel actions ====================
    case 'channel:getBindings': {
      const channelType = p.channelType as string | undefined;
      if (channelType) {
        return db.prepare('SELECT * FROM channel_bindings WHERE channel_type = ? ORDER BY updated_at DESC').all(channelType);
      }
      return db.prepare('SELECT * FROM channel_bindings ORDER BY updated_at DESC').all();
    }

    case 'channel:getBinding':
      return db.prepare('SELECT * FROM channel_bindings WHERE channel_type = ? AND chat_id = ?').get(p.channelType, p.chatId);

    case 'channel:upsertBinding': {
      db.prepare(`
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
        p.id,
        p.channel_type,
        p.chat_id,
        p.duya_session_id,
        p.sdk_session_id || '',
        p.working_directory || '',
        p.model || '',
        p.mode || 'code',
        now,
        now
      );
      return db.prepare('SELECT * FROM channel_bindings WHERE id = ?').get(p.id);
    }

    case 'channel:getOffset':
      return db.prepare('SELECT * FROM channel_offsets WHERE channel_type = ? AND offset_key = ?').get(p.channelType, p.offsetKey);

    case 'channel:setOffset': {
      db.prepare(`
        INSERT INTO channel_offsets (channel_type, offset_key, offset_value, offset_type, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel_type, offset_key) DO UPDATE SET
          offset_value = excluded.offset_value,
          offset_type = COALESCE(excluded.offset_type, offset_type),
          updated_at = excluded.updated_at
      `).run(p.channelType, p.offsetKey, p.offsetValue, p.offsetType || 'long_polling', now);
    }

    // ==================== Project actions ====================
    case 'project:getGroups':
      return db.prepare(`
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

    // ==================== Automation actions ====================
    case 'automation:cron:list': {
      const scheduler = getAutomationScheduler();
      if (!scheduler) {
        throw new Error('Automation scheduler is not initialized');
      }
      return scheduler.listCrons();
    }

    case 'automation:cron:create': {
      const scheduler = getAutomationScheduler();
      if (!scheduler) {
        throw new Error('Automation scheduler is not initialized');
      }
      return scheduler.createCron(p as {
        name: string;
        description?: string | null;
        schedule: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
        prompt: string;
        inputParams?: Record<string, unknown>;
        concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
        maxRetries?: number;
        enabled?: boolean;
      });
    }

    case 'automation:cron:update': {
      const scheduler = getAutomationScheduler();
      if (!scheduler) {
        throw new Error('Automation scheduler is not initialized');
      }
      const id = p.id as string;
      const patch = p.patch as {
        name?: string;
        description?: string | null;
        schedule?: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
        prompt?: string;
        inputParams?: Record<string, unknown>;
        concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
        maxRetries?: number;
        status?: 'enabled' | 'disabled' | 'error';
      };
      return scheduler.updateCron(id, patch);
    }

    case 'automation:cron:delete': {
      const scheduler = getAutomationScheduler();
      if (!scheduler) {
        throw new Error('Automation scheduler is not initialized');
      }
      return scheduler.deleteCron(p.id as string);
    }

    case 'automation:cron:run': {
      const scheduler = getAutomationScheduler();
      if (!scheduler) {
        throw new Error('Automation scheduler is not initialized');
      }
      return await scheduler.runCronNow(p.id as string);
    }

    case 'automation:cron:runs': {
      const scheduler = getAutomationScheduler();
      if (!scheduler) {
        throw new Error('Automation scheduler is not initialized');
      }
      return scheduler.listCronRuns(p as { cronId: string; limit?: number; offset?: number });
    }

    // ==================== Config Manager actions ====================
    case 'config:appInfo': {
      const version = (global as Record<string, unknown>).__APP_VERSION__ as string || process.env.DUYA_VERSION || 'dev';
      return {
        version,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron || 'unknown',
      };
    }

    case 'config:provider:getAll': {
      const cm = getConfigManager();
      return cm.getAllProviders();
    }

    case 'config:provider:getActive': {
      const cm = getConfigManager();
      return cm.getActiveProvider() || null;
    }

    case 'config:provider:upsert': {
      const cm = getConfigManager();
      cm.upsertProvider(p as ApiProvider);
      return { ok: true };
    }

    case 'config:provider:delete': {
      const cm = getConfigManager();
      const ok = cm.deleteProvider(p.id as string);
      return { ok };
    }

    case 'config:provider:activate': {
      const cm = getConfigManager();
      const ok = cm.activateProvider(p.id as string);
      return { ok };
    }

    case 'config:agent:getSettings': {
      const cm = getConfigManager();
      return cm.getAgentSettings();
    }

    case 'config:agent:setSettings': {
      const cm = getConfigManager();
      const current = cm.getAgentSettings();
      const merged = { ...current, ...p as Record<string, unknown> };
      cm.setConfig('agentSettings', merged, 'agent');
      return { ok: true };
    }

    case 'config:vision:get': {
      const cm = getConfigManager();
      return cm.getVisionSettings();
    }

    case 'config:vision:set': {
      const cm = getConfigManager();
      const current = cm.getVisionSettings();
      const merged = { ...current, ...p as Record<string, unknown> };
      cm.setConfig('visionSettings', merged, 'agent');
      return { ok: true };
    }

    case 'config:outputStyles:get': {
      const cm = getConfigManager();
      return cm.getOutputStyles();
    }

    case 'config:outputStyles:set': {
      const cm = getConfigManager();
      const styles = cm.getOutputStyles();
      const styleId = p.styleId as string;
      if (!styles[styleId]) {
        throw new Error(`Output style not found: ${styleId}`);
      }
      const updated = { ...styles[styleId] };
      for (const key of Object.keys(p as Record<string, unknown>)) {
        if (key !== 'styleId' && key !== 'action') {
          (updated as Record<string, unknown>)[key] = (p as Record<string, unknown>)[key];
        }
      }
      styles[styleId] = updated as typeof styles[string];
      cm.setConfig('outputStyles', styles, 'agent');
      return { ok: true, styleId };
    }

    // ==================== Agent lifecycle actions ====================
    case 'agent:restart': {
      const pool = getAgentProcessPool();
      if (pool) {
        const sessionId = (p as Record<string, unknown>).sessionId as string;
        const reason = (p as Record<string, unknown>).reason as string;
        getLogger().info(`Agent restart requested`, { sessionId, reason }, LogComponent.AgentCommunicator);
        pool.release(sessionId);
        return { ok: true, message: 'Restart initiated. A new agent process will start on the next message.' };
      }
      throw new Error('Agent process pool not available');
    }

    // ==================== Health check actions ====================
    case 'health:testProvider': {
      const providerId = p.providerId as string | undefined;
      const cm = getConfigManager();

      if (providerId) {
        const provider = cm.getAllProviders()[providerId];
        if (!provider) {
          throw new Error(`Provider not found: ${providerId}`);
        }
        return await testProviderConnection({
          provider_type: provider.providerType,
          base_url: provider.baseUrl || undefined,
          api_key: provider.apiKey,
        });
      }

      const activeProvider = cm.getActiveProvider();
      if (activeProvider) {
        return await testProviderConnection({
          provider_type: activeProvider.providerType,
          base_url: activeProvider.baseUrl || undefined,
          api_key: activeProvider.apiKey,
        });
      }

      throw new Error('No provider configured. Please add a provider first.');
    }

    case 'health:gatewayStatus': {
      const db = getDatabase();
      if (!db) throw new Error('Database not available');

      const bindings = db.prepare('SELECT channel_type, chat_id, active, updated_at FROM channel_bindings ORDER BY updated_at DESC').all() as Array<{
        channel_type: string;
        chat_id: string;
        active: number;
        updated_at: number;
      }>;

      const gateways: Record<string, { chatCount: number; active: boolean; lastActivity: string }> = {};
      for (const b of bindings) {
        if (!gateways[b.channel_type]) {
          gateways[b.channel_type] = {
            chatCount: 0,
            active: b.active === 1,
            lastActivity: new Date(b.updated_at).toISOString(),
          };
        }
        gateways[b.channel_type].chatCount++;
        if (b.updated_at > new Date(gateways[b.channel_type].lastActivity).getTime()) {
          gateways[b.channel_type].lastActivity = new Date(b.updated_at).toISOString();
        }
        if (b.active === 1) gateways[b.channel_type].active = true;
      }

      return {
        gateways,
        total: Object.keys(gateways).length,
        types: Object.keys(gateways),
      };
    }

    // ==================== Logs actions ====================
    case 'logs:tail': {
      const logger = getLogger();
      const logPath = logger.getLogPath();
      const lines = Math.min((p.lines as number) || 50, 100);

      if (!fs.existsSync(logPath)) {
        return { lines: 0, entries: [], message: 'No log file found' };
      }

      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const tail = allLines.slice(-lines);

      return {
        lines: tail.length,
        totalLines: allLines.length,
        entries: tail,
      };
    }

    case 'logs:errors': {
      const logger = getLogger();
      const logPath = logger.getLogPath();
      const lines = Math.min((p.lines as number) || 50, 100);

      if (!fs.existsSync(logPath)) {
        return { lines: 0, entries: [], message: 'No log file found' };
      }

      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const errorLines = allLines.filter((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.level === 'ERROR' || entry.level === 'FATAL';
        } catch {
          return line.includes('ERROR') || line.includes('FATAL');
        }
      });

      const tail = errorLines.slice(-lines);
      return {
        lines: tail.length,
        totalErrorLines: errorLines.length,
        entries: tail,
      };
    }

    default:
      throw new Error(`Unknown DB action: ${action}`);
  }
}

// Handle DB request from Agent
export async function handleDbRequest(msg: DbRequest): Promise<DbResponse> {
  const { id, action, payload } = msg;

  try {
    const result = await dispatchDbAction(action, payload);
    return { type: 'db:response', id, success: true, result };
  } catch (error) {
    getLogger().error(`DB request failed: ${action}`, error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.AgentCommunicator);
    return {
      type: 'db:response',
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Broadcast event to all renderer windows
function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  }
}

function sendToRendererForSession(channel: string, sessionId: string, data: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, { sessionId, ...data as Record<string, unknown> });
    }
  }
}

// Register Agent-specific IPC handlers
export function registerAgentHandlers(): void {
  // Handler for agent to send notifications to renderer
  ipcMain.handle('agent:notify', (_event, data: { type: string; payload: unknown }) => {
    getLogger().info('Notification', { type: data.type, payload: data.payload }, LogComponent.AgentCommunicator);
    broadcastToRenderers('agent:event', data);
  });

  // Handler to check if agent is running
  ipcMain.handle('agent:isRunning', () => {
    // Just check if process pool exists and has any running processes
    const pool = getAgentProcessPool();
    return pool.isRunning('');
  });

  // Handler to get agent provider config for initializing agent subprocess
  ipcMain.handle('agent:getProviderConfig', (_event, sessionId: string) => {
    const configManager = getConfigManager();
    const db = getDatabase();

    // Get session to find its provider_id and model
    const session = db?.prepare('SELECT provider_id, model FROM chat_sessions WHERE id = ?').get(sessionId) as { provider_id: string | null; model: string | null } | undefined;

    console.log('[agent:getProviderConfig] session:', { provider_id: session?.provider_id, model: session?.model });

    // Try to use session's provider_id first, fall back to active provider
    let provider = session?.provider_id
      ? configManager.getAllProviders()[session.provider_id]
      : null;

    console.log('[agent:getProviderConfig] provider from session:', provider?.id, provider?.providerType);

    // Fall back to active provider if session provider doesn't exist
    if (!provider) {
      provider = configManager.getActiveProvider();
      console.log('[agent:getProviderConfig] fallback to active provider:', provider?.id, provider?.providerType);
    }

    if (!provider) return null;

    // Get default model based on provider type
    const defaultModel = getDefaultModelForProvider(provider.providerType, provider.options);

    const result = {
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl || undefined,
      model: session?.model || defaultModel,
      provider: toLLMProvider(provider.providerType),
    };

    console.log('[agent:getProviderConfig] result:', result);

    return result;
  });

  // Handler to get masked provider config for renderer (no API key exposure)
  ipcMain.handle('agent:getMaskedProviderConfig', (_event, sessionId: string) => {
    const configManager = getConfigManager();
    const db = getDatabase();

    // Get session to find its provider_id and model
    const session = db?.prepare('SELECT provider_id, model FROM chat_sessions WHERE id = ?').get(sessionId) as { provider_id: string | null; model: string | null } | undefined;

    // Try to use session's provider_id first, fall back to active provider
    let provider = session?.provider_id
      ? configManager.getAllProviders()[session.provider_id]
      : null;

    // Fall back to active provider if session provider doesn't exist
    if (!provider) {
      provider = configManager.getActiveProvider();
    }

    if (!provider) return null;

    const key = provider.apiKey;
    const maskedKey = key.length <= 8 ? '***' : key.slice(0, 4) + '***' + key.slice(-4);

    return {
      apiKey: maskedKey,
      baseURL: provider.baseUrl || undefined,
      model: session?.model || '',
      provider: provider.providerType,
    };
  });

  // ==================== ConfigManager-based Provider handlers ====================
  // These use ConfigManager instead of database for provider storage

  // Helper to mask API key in provider for renderer
  // Returns fields matching frontend Provider interface (camelCase) in ipc-client.ts
  // Note: Electron IPC auto-converts field names (e.g., optionsJson -> options)
  function maskProvider(provider: ApiProvider): Record<string, unknown> {
    const key = provider.apiKey;
    const hasKey = !!key && key.length > 0;
    const maskedKey = hasKey && key.length > 8 ? key.slice(0, 4) + '***' + key.slice(-4) : (hasKey ? '***' : '');
    return {
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl ?? '',
      apiKey: maskedKey,
      isActive: provider.isActive,
      hasApiKey: hasKey,
      sortOrder: provider.sortOrder ?? 0,
      extraEnv: JSON.stringify(provider.extraEnv ?? {}),
      protocol: provider.providerType,
      headers: JSON.stringify(provider.headers ?? {}),
      options: JSON.stringify(provider.options ?? {}),
      notes: provider.notes ?? '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // Get all providers (masked)
  ipcMain.handle('config:provider:getAll', () => {
    const configManager = getConfigManager();
    const providers = configManager.getAllProviders();
    const masked = Object.values(providers).map(maskProvider);
    getLogger().info('config:provider:getAll', { count: masked.length }, LogComponent.AgentCommunicator);
    if (masked.length > 0) {
      getLogger().info('First provider', { id: masked[0].id, hasApiKey: (masked[0] as Record<string, unknown>).hasApiKey }, LogComponent.AgentCommunicator);
    }
    return masked;
  });

  // Get provider by ID (masked)
  ipcMain.handle('config:provider:get', (_event, id: string) => {
    const configManager = getConfigManager();
    const provider = configManager.getAllProviders()[id];
    return provider ? maskProvider(provider) : null;
  });

  // Get active provider (masked)
  ipcMain.handle('config:provider:getActive', () => {
    const configManager = getConfigManager();
    const provider = configManager.getActiveProvider();
    return provider ? maskProvider(provider) : null;
  });

  // Upsert provider
  ipcMain.handle('config:provider:upsert', (_event, data: ApiProvider) => {
    const configManager = getConfigManager();
    configManager.upsertProvider(data);
    return maskProvider(data);
  });

  // Update provider (partial update)
  ipcMain.handle('config:provider:update', (_event, id: string, data: Partial<ApiProvider>) => {
    const configManager = getConfigManager();
    const existing = configManager.getAllProviders()[id];
    if (!existing) return null;
    const updated = { ...existing, ...data, id }; // Ensure ID doesn't change
    configManager.upsertProvider(updated);
    return maskProvider(updated);
  });

  // Delete provider
  ipcMain.handle('config:provider:delete', (_event, id: string) => {
    const configManager = getConfigManager();
    return configManager.deleteProvider(id);
  });

  // Activate provider
  ipcMain.handle('config:provider:activate', (_event, id: string) => {
    const configManager = getConfigManager();
    configManager.activateProvider(id);
    const provider = configManager.getAllProviders()[id];
    return provider ? maskProvider(provider) : null;
  });

  // ==================== Output Style handlers ====================

  ipcMain.handle('config:style:getAll', () => {
    const configManager = getConfigManager();
    const styles = configManager.getOutputStyles();
    return Object.values(styles);
  });

  ipcMain.handle('config:style:get', (_event, id: string) => {
    const configManager = getConfigManager();
    const styles = configManager.getOutputStyles();
    return styles[id] || null;
  });

  ipcMain.handle('config:style:upsert', (_event, data: { id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean }) => {
    const configManager = getConfigManager();
    const result = configManager.upsertOutputStyle({
      id: data.id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      keepCodingInstructions: data.keepCodingInstructions,
    });
    return result ? configManager.getOutputStyles()[data.id] : null;
  });

  ipcMain.handle('config:style:delete', (_event, id: string) => {
    const configManager = getConfigManager();
    return configManager.deleteOutputStyle(id);
  });

  getLogger().info('Agent handlers registered', undefined, LogComponent.AgentCommunicator);
}
