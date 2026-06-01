/**
 * db-bridge.ts - Database action dispatcher for Agent
 *
 * Handles database requests from the Agent process.
 * Extracted from former ipc/agent-communicator.ts.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from '../ipc/db-handlers';
import { getConfigManager, type ApiProvider } from '../config/manager';
import { getAutomationScheduler } from '../automation/Scheduler.js';
import { getLogger, LogComponent } from '../logging/logger';
import { testProviderConnection } from '../ipc/net-handlers';
import { getPairingStore } from '../gateway/pairing';
import { getPluginManager } from '../plugins/PluginManager';

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
  if (options) {
    const optModel = (options as Record<string, unknown>).defaultModel || (options as Record<string, unknown>).model;
    if (typeof optModel === 'string' && optModel.length > 0) {
      return optModel;
    }
  }

  switch (providerType) {
    case 'ollama':
      return 'llama3.2';
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
    case 'google':
    case 'gemini-image':
      return 'gpt-4o';
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'claude-sonnet-4-20250514';
    default:
      return '';
  }
}

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
      let providerType: ApiProvider['providerType'] = 'anthropic';
      let defaultModel: string | undefined;

      if (p.provider_id) {
        const configManager = getConfigManager();
        const provider = configManager.getAllProviders()[p.provider_id as string];
        if (provider) {
          providerType = provider.providerType;
          if (provider.options) {
            try {
              const options = provider.options as Record<string, unknown>;
              defaultModel = (options.defaultModel as string) || (options.model as string);
            } catch {
              // Ignore parse error
            }
          }
        }
      }

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

    case 'session:loadMessages': {
      const sessionId = p.sessionId as string;
      const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC').all(sessionId);
      const attachmentRows = db.prepare(
        "SELECT * FROM message_attachments WHERE session_id = ? AND attachment_type = 'parsed_document' ORDER BY created_at ASC"
      ).all(sessionId) as Array<{
        id: string;
        message_id: string;
        session_id: string;
        data: string;
        original_url: string | null;
        created_at: number;
      }>;

      const parsedDocuments = attachmentRows.map((row) => {
        const parsed = JSON.parse(row.data);
        return {
          id: row.id,
          message_id: row.message_id,
          session_id: row.session_id,
          filename: parsed.filename || '',
          filePath: parsed.filePath || row.original_url || '',
          charCount: parsed.charCount || 0,
          extractMethod: parsed.extractMethod || null,
          text: parsed.text || '',
          imageChunks: parsed.imageChunks ? JSON.stringify(parsed.imageChunks) : null,
          created_at: row.created_at,
        };
      });

      return { messages, parsedDocuments };
    }

    // ==================== Message actions ====================
    case 'message:add': {
      const attachments = p.attachments
        ? (typeof p.attachments === 'string' ? p.attachments : JSON.stringify(p.attachments))
        : null;

      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
        VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
      `).run({
        id: p.id,
        session_id: p.session_id,
        role: p.role,
        content: p.content,
        name: p.name ?? null,
        tool_call_id: p.tool_call_id ?? null,
        token_usage: p.token_usage ?? null,
        msg_type: p.msg_type ?? 'text',
        thinking: p.thinking ?? null,
        tool_name: p.tool_name ?? null,
        tool_input: p.tool_input ?? null,
        parent_tool_call_id: p.parent_tool_call_id ?? null,
        viz_spec: p.viz_spec ?? null,
        status: p.status ?? 'done',
        seq_index: p.seq_index ?? null,
        duration_ms: p.duration_ms ?? null,
        sub_agent_id: p.sub_agent_id ?? null,
        attachments,
        created_at: now,
      });
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, p.session_id);
      return db.prepare('SELECT * FROM messages WHERE id = ?').get(p.id);
    }

    case 'message:getBySession':
      return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC').all(p.sessionId);

    case 'message:getCount': {
      const result = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(p.sessionId) as { count: number };
      return result.count;
    }

    case 'message:deleteBySession':
      return db.prepare('DELETE FROM messages WHERE session_id = ?').run(p.sessionId).changes;

    case 'message:append': {
      const sessionId = p.sessionId as string;
      const messages = p.messages as Array<{
        id?: string;
        role?: string;
        content?: string | unknown[];
        name?: string;
        tool_call_id?: string;
        token_usage?: string | unknown;
        msg_type?: string;
        thinking?: string;
        tool_name?: string;
        tool_input?: string;
        attachments?: unknown;
        created_at?: number;
        timestamp?: number;
      }>;

      if (!messages || !Array.isArray(messages)) {
        return { success: false, reason: 'invalid_messages' };
      }

      const now = Date.now();
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO messages (
          id, session_id, role, content, name, tool_call_id,
          token_usage, msg_type, thinking, tool_name, tool_input,
          parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id,
          attachments, created_at
        ) VALUES (
          @id, @session_id, @role, @content, @name, @tool_call_id,
          @token_usage, @msg_type, @thinking, @tool_name, @tool_input,
          @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id,
          @attachments, @created_at
        )
      `);

      let count = 0;
      const txn = db.transaction(() => {
        for (const msg of messages) {
          if (!msg.role) {
            continue;
          }

          const effectiveContent = msg.content;
          let contentStr: string;
          let msgType = msg.msg_type || 'text';
          let thinking: string | null = msg.thinking || null;
          let toolName: string | null = msg.tool_name || null;
          let toolInput: string | null = msg.tool_input || null;

          // Auto-detect msg_type for tool messages
          if (!msgType && msg.role === 'tool') {
            msgType = 'tool_result';
            // For tool results, tool_call_id is the parent tool_use id
            // Copy it to parent_tool_call_id for frontend association
            if (msg.tool_call_id && !(msg as Record<string, unknown>).parent_tool_call_id) {
              (msg as Record<string, unknown>).parent_tool_call_id = msg.tool_call_id;
            }
          }

          if (typeof effectiveContent === 'string') {
            contentStr = effectiveContent;
          } else if (effectiveContent === null || effectiveContent === undefined) {
            contentStr = '';
          } else if (Array.isArray(effectiveContent) && msg.role === 'user') {
            const textBlocks = effectiveContent.filter(
              (b: unknown) => (b as Record<string, unknown>).type === 'text'
            );
            contentStr = textBlocks.length > 0
              ? textBlocks.map((b: unknown) => (b as Record<string, string>).text || '').join('\n')
              : JSON.stringify(effectiveContent);
          } else {
            contentStr = JSON.stringify(effectiveContent);
          }

          // Derive msg_type from content blocks for assistant messages
          if (!msgType && Array.isArray(effectiveContent) && msg.role === 'assistant') {
            const blocks = effectiveContent as Array<{ type: string; thinking?: string; name?: string; input?: unknown; tool_use_id?: string }>;
            const types = blocks.map(b => b.type);

            const toolUseBlock = blocks.find(b => b.type === 'tool_use' && b.name === 'show_widget');
            if (toolUseBlock) {
              msgType = 'viz';
              const widgetCode = (toolUseBlock.input as Record<string, unknown>)?.widget_code;
              if (typeof widgetCode === 'string' && widgetCode.trim()) {
                contentStr = widgetCode;
              }
            } else if (types.includes('thinking') && types.length === 1) {
              msgType = 'thinking';
              thinking = blocks[0].thinking || null;
              contentStr = thinking || '';
            } else if (types.includes('tool_use') && types.length === 1) {
              msgType = 'tool_use';
              toolName = (blocks[0].name as string) || null;
              toolInput = blocks[0].input ? JSON.stringify(blocks[0].input) : null;
            } else {
              msgType = 'text';
              // For mixed messages (e.g., thinking + text + tool_use), extract thinking if present
              const thinkingBlock = blocks.find(b => b.type === 'thinking');
              if (thinkingBlock) {
                thinking = thinkingBlock.thinking || null;
              }
            }
          }

          try {
            insertStmt.run({
              id: msg.id,
              session_id: sessionId,
              role: msg.role,
              content: contentStr,
              name: msg.name || null,
              tool_call_id: msg.tool_call_id || null,
              token_usage: msg.token_usage ? JSON.stringify(msg.token_usage) : null,
              msg_type: msgType,
              thinking,
              tool_name: toolName,
              tool_input: toolInput,
              parent_tool_call_id: (msg as Record<string, unknown>).parent_tool_call_id as string || null,
              viz_spec: (msg as Record<string, unknown>).viz_spec as string || null,
              status: (msg as Record<string, unknown>).status as string || 'done',
              seq_index: (msg as Record<string, unknown>).seq_index as number || null,
              duration_ms: (msg as Record<string, unknown>).duration_ms as number || null,
              sub_agent_id: (msg as Record<string, unknown>).sub_agent_id as string || null,
              attachments: msg.attachments ? JSON.stringify(msg.attachments) : null,
              created_at: msg.timestamp || msg.created_at || now,
            });
            count++;
          } catch (insertErr) {
            getLogger().error('message:append insert failed', insertErr instanceof Error ? insertErr : new Error(String(insertErr)), { msgId: msg.id, sessionId }, LogComponent.AgentCommunicator);
          }
        }
      });

      try {
        txn();
        return { success: true, count };
      } catch (err) {
        getLogger().error('message:append transaction failed', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.AgentCommunicator);
        return { success: false, count: 0, reason: 'transaction_failed' };
      }
    }

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
        let session = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as { generation: number } | undefined;
        if (!session) {
          return { success: false, reason: 'session_not_found' };
        }
        if (generation < session.generation) {
                    return { success: false, reason: 'stale_generation' };
        }

        let newGeneration = 0;

        const txn = db.transaction(() => {
          newGeneration = Math.max(generation, session.generation + 1);
          db.prepare('UPDATE chat_sessions SET generation = ?, updated_at = ? WHERE id = ?').run(newGeneration, now, sessionId);
          db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

          const stmt = db.prepare(`
            INSERT INTO messages (id, session_id, role, content, name, tool_call_id, token_usage, msg_type, thinking, tool_name, tool_input, parent_tool_call_id, viz_spec, status, seq_index, duration_ms, sub_agent_id, attachments, created_at)
            VALUES (@id, @session_id, @role, @content, @name, @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name, @tool_input, @parent_tool_call_id, @viz_spec, @status, @seq_index, @duration_ms, @sub_agent_id, @attachments, @created_at)
          `);

          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i] as Record<string, unknown>;

            let contentValue: string;
            // Use displayContent for DB when set (original prompt without synthetic doc context)
            const effectiveContent = msg.displayContent !== undefined ? msg.displayContent : msg.content;
            if (typeof effectiveContent === 'string') {
              contentValue = effectiveContent;
            } else if (effectiveContent === null || effectiveContent === undefined) {
              contentValue = '';
            } else if (Array.isArray(effectiveContent) && (msg as Record<string, unknown>).role === 'user') {
              const textBlocks = effectiveContent.filter(
                (b: unknown) => (b as Record<string, unknown>).type === 'text'
              );
              contentValue = textBlocks.length > 0
                ? textBlocks.map((b: unknown) => (b as Record<string, string>).text || '').join('\n')
                : JSON.stringify(effectiveContent);
            } else {
              contentValue = JSON.stringify(effectiveContent);
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

            const attachments = msg.attachments
              ? (typeof msg.attachments === 'string' ? msg.attachments : JSON.stringify(msg.attachments))
              : null;

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
              attachments,
              created_at: msg.timestamp || now,
            });
          }
        });

        try {
          txn();
          const result = { success: true, newGeneration, messageCount: messages.length };
                    debugLog('message:replace success', { sessionId, ...result });
          return result;
        } catch (txnError) {
                    getLogger().error('Transaction failed', txnError instanceof Error ? txnError : new Error(String(txnError)), { sessionId }, LogComponent.AgentCommunicator);
          throw txnError;
        }
      } catch (error) {
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
      return { success: true };

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

      if (!fromBlocks.includes(p.toId as string)) {
        fromBlocks.push(p.toId as string);
        db.prepare('UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(fromBlocks), now, p.fromId);
      }
      if (!toBlockedBy.includes(p.fromId as string)) {
        toBlockedBy.push(p.fromId as string);
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
      return scheduler.createCron(p as unknown as import('../automation/types').CreateAutomationCronInput);
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
      cm.upsertProvider(p as unknown as ApiProvider);
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
      const settings = cm.getAgentSettings();

      // If defaultModel is not set, resolve from active provider so duya_info
      // always reports the model that will actually be used.
      if (!settings.defaultModel || settings.defaultModel === '') {
        const activeProvider = cm.getActiveProvider();
        if (activeProvider) {
          const resolvedModel = getDefaultModelForProvider(
            activeProvider.providerType,
            activeProvider.options,
          );
          if (resolvedModel && resolvedModel.length > 0) {
            return { ...settings, defaultModel: resolvedModel };
          }
        }
      }

      return settings;
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
      const pObj = p as Record<string, unknown>;
      const merged = {
        ...current,
        ...pObj,
        baseUrl: (pObj.baseUrl || pObj.baseURL) ?? current.baseUrl,
      };
      delete merged.baseURL;
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
      const { getAgentProcessPool } = await import('./process-pool/agent-process-pool.js');
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
      const dbHealth = getDatabase();
      if (!dbHealth) throw new Error('Database not available');

      const bindings = dbHealth.prepare('SELECT channel_type, chat_id, active, updated_at FROM channel_bindings ORDER BY updated_at DESC').all() as Array<{
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

    // ==================== Attachment actions (parsed_document) ====================
    case 'attachment:store': {
      const messageId = p.messageId as string;
      const sessionId = p.sessionId as string;

      // Guard against null/undefined messageId
      if (!messageId) {
        log(`[DB-Bridge] attachment:store skipped - messageId is empty`);
        return { success: false, error: 'messageId is required' };
      }

      const filename = p.filename as string;
      const filePath = p.filePath as string;
      const charCount = p.charCount as number;
      const text = p.text as string;
      const extractMethod = p.extractMethod as string | undefined;
      const imageChunks = p.imageChunks as Array<{ base64: string; mediaType: string }> | undefined;

      const id = `${messageId}-parsed-doc`;
      const imageChunksJson = imageChunks ? JSON.stringify(imageChunks) : null;

      db.prepare(`
        INSERT OR REPLACE INTO message_attachments (id, message_id, session_id, attachment_type, mime_type, data, original_url, created_at)
        VALUES (@id, @message_id, @session_id, @attachment_type, @mime_type, @data, @original_url, @created_at)
      `).run({
        id,
        message_id: messageId,
        session_id: sessionId,
        attachment_type: 'parsed_document',
        mime_type: 'application/pdf',
        data: JSON.stringify({
          filename,
          filePath,
          charCount,
          text,
          extractMethod: extractMethod || null,
          imageChunks: imageChunks || [],
        }),
        original_url: filePath,
        created_at: now,
      });
      return { success: true };
    }

    case 'attachment:getForSession': {
      const sessionId = p.sessionId as string;
      const rows = db.prepare(`
        SELECT * FROM message_attachments
        WHERE session_id = ? AND attachment_type = 'parsed_document'
        ORDER BY created_at ASC
      `).all(sessionId) as Array<{
        id: string;
        message_id: string;
        session_id: string;
        data: string;
        original_url: string | null;
        created_at: number;
      }>;

      return rows.map((row) => {
        const parsed = JSON.parse(row.data);
        return {
          id: row.id,
          message_id: row.message_id,
          session_id: row.session_id,
          filename: parsed.filename || '',
          filePath: parsed.filePath || row.original_url || '',
          charCount: parsed.charCount || 0,
          extractMethod: parsed.extractMethod || null,
          text: parsed.text || '',
          imageChunks: parsed.imageChunks ? JSON.stringify(parsed.imageChunks) : null,
          created_at: row.created_at,
        };
      });
    }

    case 'attachment:getForMessage': {
      const messageId = p.messageId as string;
      const rows = db.prepare(`
        SELECT * FROM message_attachments
        WHERE message_id = ? AND attachment_type = 'parsed_document'
        ORDER BY created_at ASC
      `).all(messageId) as Array<{
        id: string;
        message_id: string;
        session_id: string;
        data: string;
        original_url: string | null;
        created_at: number;
      }>;

      return rows.map((row) => {
        const parsed = JSON.parse(row.data);
        return {
          id: row.id,
          message_id: row.message_id,
          session_id: row.session_id,
          filename: parsed.filename || '',
          filePath: parsed.filePath || row.original_url || '',
          charCount: parsed.charCount || 0,
          extractMethod: parsed.extractMethod || null,
          text: parsed.text || '',
          imageChunks: parsed.imageChunks ? JSON.stringify(parsed.imageChunks) : null,
          created_at: row.created_at,
        };
      });
    }

    // ==================== Research Session actions (Plan 60 - Research Mode) ====================
    case 'researchSession:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_sessions (
          id, session_id, original_query, clarification, context_json,
          status, current_phase, iterations, coverage, created_at, updated_at,
          title, run_status, plan_version, active_step_id, progress_summary, completed_at, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)
      `).run(
        p.id, p.session_id, p.original_query, p.clarification || null,
        p.context_json, p.status || 'active', now, now,
        p.title || null, p.run_status || null
      );
      return db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(p.id);
    }

    case 'researchSession:get': {
      return db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(p.id);
    }

    case 'researchSession:getBySessionId': {
      return db.prepare(
        'SELECT * FROM research_sessions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(p.sessionId);
    }

    case 'researchSession:update': {
      const id = p.id as string;
      const now = Date.now();
      const fields: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      if (p.clarification !== undefined) { fields.push('clarification = ?'); params.push(p.clarification); }
      if (p.context_json !== undefined) { fields.push('context_json = ?'); params.push(p.context_json); }
      if (p.status !== undefined) { fields.push('status = ?'); params.push(p.status); }
      if (p.current_phase !== undefined) { fields.push('current_phase = ?'); params.push(p.current_phase); }
      if (p.iterations !== undefined) { fields.push('iterations = ?'); params.push(p.iterations); }
      if (p.coverage !== undefined) { fields.push('coverage = ?'); params.push(p.coverage); }
      if (p.title !== undefined) { fields.push('title = ?'); params.push(p.title); }
      if (p.run_status !== undefined) { fields.push('run_status = ?'); params.push(p.run_status); }
      if (p.plan_version !== undefined) { fields.push('plan_version = ?'); params.push(p.plan_version); }
      if (p.active_step_id !== undefined) { fields.push('active_step_id = ?'); params.push(p.active_step_id); }
      if (p.progress_summary !== undefined) { fields.push('progress_summary = ?'); params.push(p.progress_summary); }
      if (p.completed_at !== undefined) { fields.push('completed_at = ?'); params.push(p.completed_at); }
      if (p.error_json !== undefined) { fields.push('error_json = ?'); params.push(p.error_json); }
      params.push(id);

      db.prepare(`UPDATE research_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(id);
    }

    case 'researchSession:delete': {
      const result = db.prepare('DELETE FROM research_sessions WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'researchSession:list': {
      const limit = (p.limit as number) || 100;
      return db.prepare('SELECT * FROM research_sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
    }

    case 'researchSession:listByStatus': {
      return db.prepare(
        'SELECT * FROM research_sessions WHERE status = ? ORDER BY updated_at DESC'
      ).all(p.status);
    }

    case 'researchSession:getActiveRun': {
      return db.prepare(
        `SELECT * FROM research_sessions
         WHERE session_id = ? AND run_status IN ('planning', 'awaiting_approval', 'running', 'paused', 'synthesizing')
         ORDER BY created_at DESC LIMIT 1`
      ).get(p.sessionId);
    }

    case 'researchSession:listActiveRuns': {
      return db.prepare(
        `SELECT * FROM research_sessions
         WHERE run_status IN ('planning', 'awaiting_approval', 'running', 'paused', 'synthesizing')
         ORDER BY updated_at DESC`
      ).all();
    }

    // ==================== Research Plan Steps ====================

    case 'researchPlanStep:createSteps': {
      const runId = p.runId as string;
      const steps = p.steps as Array<{
        id: string;
        order_num: number;
        user_facing_label: string;
        internal_question_ids: string[];
      }>;
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO research_plan_steps (id, run_id, order_num, user_facing_label, internal_question_ids, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `);
      const txn = db.transaction(() => {
        for (const step of steps) {
          stmt.run(step.id, runId, step.order_num, step.user_facing_label, JSON.stringify(step.internal_question_ids));
        }
      });
      txn();
      return db.prepare('SELECT * FROM research_plan_steps WHERE run_id = ? ORDER BY order_num ASC').all(runId);
    }

    case 'researchPlanStep:getByRunId': {
      return db.prepare('SELECT * FROM research_plan_steps WHERE run_id = ? ORDER BY order_num ASC').all(p.runId);
    }

    case 'researchPlanStep:update': {
      const stepId = p.stepId as string;
      const fields: string[] = [];
      const params: unknown[] = [];
      if (p.status !== undefined) { fields.push('status = ?'); params.push(p.status); }
      if (p.started_at !== undefined) { fields.push('started_at = ?'); params.push(p.started_at); }
      if (p.completed_at !== undefined) { fields.push('completed_at = ?'); params.push(p.completed_at); }
      if (fields.length === 0) return null;
      params.push(stepId);
      db.prepare(`UPDATE research_plan_steps SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return db.prepare('SELECT * FROM research_plan_steps WHERE id = ?').get(stepId);
    }

    case 'researchPlanStep:deleteByRunId': {
      return db.prepare('DELETE FROM research_plan_steps WHERE run_id = ?').run(p.runId);
    }

    // ==================== Research Activities ====================

    case 'researchActivity:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_activities (id, run_id, sequence, kind, title, detail, visibility, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.id, p.run_id, p.sequence, p.kind, p.title, p.detail || null, p.visibility || 'user', now);
      return db.prepare('SELECT * FROM research_activities WHERE id = ?').get(p.id);
    }

    case 'researchActivity:getByRunId': {
      const runId = p.runId as string;
      const visibility = p.visibility as string | undefined;
      const limit = (p.limit as number) || 200;
      const afterSequence = p.afterSequence as number | undefined;

      if (visibility) {
        if (afterSequence !== undefined) {
          return db.prepare(
            'SELECT * FROM research_activities WHERE run_id = ? AND visibility = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
          ).all(runId, visibility, afterSequence, limit);
        }
        return db.prepare(
          'SELECT * FROM research_activities WHERE run_id = ? AND visibility = ? ORDER BY sequence ASC LIMIT ?'
        ).all(runId, visibility, limit);
      }
      if (afterSequence !== undefined) {
        return db.prepare(
          'SELECT * FROM research_activities WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
        ).all(runId, afterSequence, limit);
      }
      return db.prepare(
        'SELECT * FROM research_activities WHERE run_id = ? ORDER BY sequence ASC LIMIT ?'
      ).all(runId, limit);
    }

    case 'researchActivity:getMaxSequence': {
      const result = db.prepare(
        'SELECT MAX(sequence) as max_seq FROM research_activities WHERE run_id = ?'
      ).get(p.runId) as { max_seq: number | null };
      return { max_seq: result?.max_seq ?? 0 };
    }

    case 'researchActivity:deleteByRunId': {
      return db.prepare('DELETE FROM research_activities WHERE run_id = ?').run(p.runId);
    }

    // ==================== Literature Plugin actions ====================

    case 'literature:source:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO literature_sources (
          id, kind, title, authors_json, year, venue, doi, arxiv_id,
          url, file_path, citation_key, bibtex, project_ids_json, tags_json,
          created_at, updated_at
        ) VALUES (
          @id, @kind, @title, @authors_json, @year, @venue, @doi, @arxiv_id,
          @url, @file_path, @citation_key, @bibtex, @project_ids_json, @tags_json,
          @created_at, @updated_at
        )
      `).run({
        id: p.id,
        kind: p.kind,
        title: p.title,
        authors_json: JSON.stringify(p.authors ?? []),
        year: p.year ?? null,
        venue: p.venue ?? null,
        doi: p.doi ?? null,
        arxiv_id: p.arxivId ?? null,
        url: p.url ?? null,
        file_path: p.filePath ?? null,
        citation_key: p.citationKey ?? null,
        bibtex: p.bibtex ?? null,
        project_ids_json: JSON.stringify(p.projectIds ?? []),
        tags_json: JSON.stringify(p.tags ?? []),
        created_at: now,
        updated_at: now,
      });
      return db.prepare('SELECT * FROM literature_sources WHERE id = ?').get(p.id);
    }

    case 'literature:source:get':
      return db.prepare('SELECT * FROM literature_sources WHERE id = ?').get(p.id);

    case 'literature:source:list': {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (p.kind) { conditions.push('kind = ?'); params.push(p.kind); }
      if (p.yearFrom) { conditions.push('year >= ?'); params.push(p.yearFrom); }
      if (p.yearTo) { conditions.push('year <= ?'); params.push(p.yearTo); }
      if (p.search) {
        conditions.push('(title LIKE ? OR doi LIKE ?)');
        const searchTerm = `%${p.search}%`;
        params.push(searchTerm, searchTerm);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = (p.limit as number) || 100;
      return db.prepare(`SELECT * FROM literature_sources ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
    }

    case 'literature:source:update': {
      const id = p.id as string;
      const now = Date.now();
      const fields: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      const stringFields = ['kind', 'title', 'venue', 'doi', 'url', 'citation_key', 'bibtex'];
      for (const field of stringFields) {
        if (p[field] !== undefined) {
          const dbField = field === 'citation_key' ? 'citation_key' : field === 'doi' ? 'doi' : field;
          fields.push(`${dbField} = ?`);
          params.push(p[field]);
        }
      }

      if (p.authors !== undefined) {
        fields.push('authors_json = ?');
        params.push(JSON.stringify(p.authors));
      }
      if (p.year !== undefined) {
        fields.push('year = ?');
        params.push(p.year);
      }
      if (p.filePath !== undefined) {
        fields.push('file_path = ?');
        params.push(p.filePath);
      }
      if (p.arxivId !== undefined) {
        fields.push('arxiv_id = ?');
        params.push(p.arxivId);
      }
      if (p.projectIds !== undefined) {
        fields.push('project_ids_json = ?');
        params.push(JSON.stringify(p.projectIds));
      }
      if (p.tags !== undefined) {
        fields.push('tags_json = ?');
        params.push(JSON.stringify(p.tags));
      }

      params.push(id);
      db.prepare(`UPDATE literature_sources SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return db.prepare('SELECT * FROM literature_sources WHERE id = ?').get(id);
    }

    case 'literature:source:delete': {
      const result = db.prepare('DELETE FROM literature_sources WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'literature:evidence:createMany': {
      const spans = p.spans as Array<Record<string, unknown>>;
      const now = Date.now();
      const insert = db.prepare(`
        INSERT INTO literature_evidence_spans (id, source_id, page, section, text, quote, bbox_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const txn = db.transaction(() => {
        for (const span of spans) {
          insert.run(
            span.id,
            span.sourceId,
            span.page ?? null,
            span.section ?? null,
            span.text,
            span.quote ?? null,
            span.bbox ? JSON.stringify(span.bbox) : null,
            now,
          );
        }
      });
      txn();
      return { success: true, count: spans.length };
    }

    case 'literature:evidence:search': {
      const conditions: string[] = ['text LIKE ?'];
      const params: unknown[] = [`%${p.query}%`];

      if (p.sourceId) {
        conditions.push('source_id = ?');
        params.push(p.sourceId);
      }
      if (p.page !== undefined) {
        conditions.push('page = ?');
        params.push(p.page);
      }
      if (p.section) {
        conditions.push('section = ?');
        params.push(p.section);
      }

      return db.prepare(`SELECT * FROM literature_evidence_spans WHERE ${conditions.join(' AND ')} ORDER BY page ASC`).all(...params);
    }

    case 'literature:evidence:deleteBySource':
      db.prepare('DELETE FROM literature_evidence_spans WHERE source_id = ?').run(p.sourceId);
      return { success: true };

    case 'literature:paperCard:upsert': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO literature_paper_cards (id, source_id, card_json, evidence_span_ids_json, created_at, updated_at)
        VALUES (@id, @source_id, @card_json, @evidence_span_ids_json, @created_at, @updated_at)
        ON CONFLICT(source_id) DO UPDATE SET
          card_json = @card_json,
          evidence_span_ids_json = @evidence_span_ids_json,
          updated_at = @updated_at
      `).run({
        id: p.id,
        source_id: p.sourceId,
        card_json: JSON.stringify(p.card),
        evidence_span_ids_json: JSON.stringify(p.evidenceSpanIds ?? []),
        created_at: now,
        updated_at: now,
      });
      return db.prepare('SELECT * FROM literature_paper_cards WHERE source_id = ?').get(p.sourceId);
    }

    case 'literature:paperCard:get':
      return db.prepare('SELECT * FROM literature_paper_cards WHERE source_id = ?').get(p.sourceId);

    case 'literature:paperCard:delete': {
      const result = db.prepare('DELETE FROM literature_paper_cards WHERE source_id = ?').run(p.sourceId);
      return { success: result.changes > 0 };
    }

    // ==================== Research Memory actions ====================

    case 'researchMemory:project:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_projects (id, name, description, created_at, updated_at)
        VALUES (@id, @name, @description, @created_at, @updated_at)
      `).run({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        created_at: now,
        updated_at: now,
      });
      return db.prepare('SELECT * FROM research_projects WHERE id = ?').get(p.id);
    }

    case 'researchMemory:project:get':
      return db.prepare('SELECT * FROM research_projects WHERE id = ?').get(p.id);

    case 'researchMemory:project:list':
      return db.prepare('SELECT * FROM research_projects ORDER BY updated_at DESC').all();

    case 'researchMemory:project:update': {
      const id = p.id as string;
      const now = Date.now();
      const fields: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      if (p.name !== undefined) { fields.push('name = ?'); params.push(p.name); }
      if (p.description !== undefined) { fields.push('description = ?'); params.push(p.description); }
      if (p.status !== undefined) { fields.push('status = ?'); params.push(p.status); }
      params.push(id);

      db.prepare(`UPDATE research_projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return db.prepare('SELECT * FROM research_projects WHERE id = ?').get(id);
    }

    case 'researchMemory:project:delete': {
      const result = db.prepare('DELETE FROM research_projects WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'researchMemory:projectState:get':
      return db.prepare('SELECT * FROM research_project_states WHERE project_id = ?').get(p.projectId);

    case 'researchMemory:projectState:upsert': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_project_states (project_id, state_json, updated_at)
        VALUES (@project_id, @state_json, @updated_at)
        ON CONFLICT(project_id) DO UPDATE SET state_json = @state_json, updated_at = @updated_at
      `).run({
        project_id: p.projectId,
        state_json: JSON.stringify(p.state),
        updated_at: now,
      });
      return db.prepare('SELECT * FROM research_project_states WHERE project_id = ?').get(p.projectId);
    }

    case 'researchMemory:object:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_memory_objects (
          id, project_id, type, content, summary, source_refs_json, relation_refs_json,
          valid_from, valid_to, status, confidence, importance, tags_json,
          embedding_json, created_at, updated_at
        ) VALUES (
          @id, @project_id, @type, @content, @summary, @source_refs_json, @relation_refs_json,
          @valid_from, @valid_to, @status, @confidence, @importance, @tags_json,
          @embedding_json, @created_at, @updated_at
        )
      `).run({
        id: p.id,
        project_id: p.projectId,
        type: p.type,
        content: p.content,
        summary: p.summary ?? null,
        source_refs_json: JSON.stringify(p.sourceRefs ?? []),
        relation_refs_json: JSON.stringify(p.relationRefs ?? []),
        valid_from: p.validFrom ?? null,
        valid_to: p.validTo ?? null,
        status: p.status ?? 'active',
        confidence: p.confidence ?? 0.5,
        importance: p.importance ?? 0.5,
        tags_json: JSON.stringify(p.tags ?? []),
        embedding_json: (p as Record<string, unknown>).embedding_json ?? null,
        created_at: now,
        updated_at: now,
      });
      return db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(p.id);
    }

    case 'researchMemory:object:get':
      return db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(p.id);

    case 'researchMemory:object:listByProject': {
      const conditions: string[] = ['project_id = ?'];
      const params: unknown[] = [p.projectId];

      if (p.type) { conditions.push('type = ?'); params.push(p.type); }
      if (p.status) { conditions.push('status = ?'); params.push(p.status); }

      const limit = (p.limit as number) || 100;
      return db.prepare(
        `SELECT * FROM research_memory_objects WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
      ).all(...params, limit);
    }

    case 'researchMemory:object:search': {
      const conditions: string[] = ['(content LIKE ? OR summary LIKE ?)'];
      const searchTerm = `%${p.query}%`;
      const params: unknown[] = [searchTerm, searchTerm];

      if (p.projectId) { conditions.push('project_id = ?'); params.push(p.projectId); }
      if (p.type) { conditions.push('type = ?'); params.push(p.type); }
      if (p.status) { conditions.push('status = ?'); params.push(p.status); }

      const limit = (p.limit as number) || 100;
      return db.prepare(
        `SELECT * FROM research_memory_objects WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
      ).all(...params, limit);
    }

    case 'researchMemory:object:update': {
      const id = p.id as string;
      const now = Date.now();
      const fields: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      const stringFields: Array<{ key: string; db: string }> = [
        { key: 'content', db: 'content' },
        { key: 'summary', db: 'summary' },
        { key: 'status', db: 'status' },
        { key: 'type', db: 'type' },
      ];
      for (const { key, db: dbField } of stringFields) {
        if (p[key] !== undefined) { fields.push(`${dbField} = ?`); params.push(p[key]); }
      }

      if (p.sourceRefs !== undefined) { fields.push('source_refs_json = ?'); params.push(JSON.stringify(p.sourceRefs)); }
      if (p.relationRefs !== undefined) { fields.push('relation_refs_json = ?'); params.push(JSON.stringify(p.relationRefs)); }
      if (p.validFrom !== undefined) { fields.push('valid_from = ?'); params.push(p.validFrom); }
      if (p.validTo !== undefined) { fields.push('valid_to = ?'); params.push(p.validTo); }
      if (p.confidence !== undefined) { fields.push('confidence = ?'); params.push(p.confidence); }
      if (p.importance !== undefined) { fields.push('importance = ?'); params.push(p.importance); }
      if (p.tags !== undefined) { fields.push('tags_json = ?'); params.push(JSON.stringify(p.tags)); }

      params.push(id);
      db.prepare(`UPDATE research_memory_objects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(id);
    }

    case 'researchMemory:object:delete': {
      const result = db.prepare('DELETE FROM research_memory_objects WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'researchMemory:hypothesis:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_hypotheses (
          id, project_id, statement, status, supporting_evidence_ids_json,
          contradicting_evidence_ids_json, related_source_ids_json, superseded_by,
          created_at, updated_at
        ) VALUES (
          @id, @project_id, @statement, @status, @supporting_evidence_ids_json,
          @contradicting_evidence_ids_json, @related_source_ids_json, @superseded_by,
          @created_at, @updated_at
        )
      `).run({
        id: p.id,
        project_id: p.projectId,
        statement: p.statement,
        status: p.status ?? 'proposed',
        supporting_evidence_ids_json: JSON.stringify(p.supportingEvidenceIds ?? []),
        contradicting_evidence_ids_json: JSON.stringify(p.contradictingEvidenceIds ?? []),
        related_source_ids_json: JSON.stringify(p.relatedSourceIds ?? []),
        superseded_by: null,
        created_at: now,
        updated_at: now,
      });
      return db.prepare('SELECT * FROM research_hypotheses WHERE id = ?').get(p.id);
    }

    case 'researchMemory:hypothesis:get':
      return db.prepare('SELECT * FROM research_hypotheses WHERE id = ?').get(p.id);

    case 'researchMemory:hypothesis:listByProject':
      return db.prepare('SELECT * FROM research_hypotheses WHERE project_id = ? ORDER BY updated_at DESC').all(p.projectId);

    case 'researchMemory:hypothesis:update': {
      const id = p.id as string;
      const now = Date.now();
      const fields: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      if (p.status !== undefined) { fields.push('status = ?'); params.push(p.status); }
      if (p.supersededBy !== undefined) { fields.push('superseded_by = ?'); params.push(p.supersededBy); }
      if (p.supportingEvidenceIds !== undefined) { fields.push('supporting_evidence_ids_json = ?'); params.push(JSON.stringify(p.supportingEvidenceIds)); }
      if (p.contradictingEvidenceIds !== undefined) { fields.push('contradicting_evidence_ids_json = ?'); params.push(JSON.stringify(p.contradictingEvidenceIds)); }
      if (p.relatedSourceIds !== undefined) { fields.push('related_source_ids_json = ?'); params.push(JSON.stringify(p.relatedSourceIds)); }

      params.push(id);
      db.prepare(`UPDATE research_hypotheses SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return db.prepare('SELECT * FROM research_hypotheses WHERE id = ?').get(id);
    }

    case 'researchMemory:hypothesis:delete': {
      const result = db.prepare('DELETE FROM research_hypotheses WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'researchMemory:candidate:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_memory_candidates (
          id, project_id, proposed_type, content, rationale, source_refs_json,
          confidence, status, created_by_session_id, created_at
        ) VALUES (
          @id, @project_id, @proposed_type, @content, @rationale, @source_refs_json,
          @confidence, 'pending', @created_by_session_id, @created_at
        )
      `).run({
        id: p.id,
        project_id: p.projectId,
        proposed_type: p.proposedType,
        content: p.content,
        rationale: p.rationale,
        source_refs_json: JSON.stringify(p.sourceRefs ?? []),
        confidence: p.confidence ?? 0.5,
        created_by_session_id: p.createdBySessionId ?? null,
        created_at: now,
      });
      return db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(p.id);
    }

    case 'researchMemory:candidate:get': {
      return db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(p.id);
    }

    case 'researchMemory:candidate:listByProject': {
      if (p.status) {
        return db.prepare(
          'SELECT * FROM research_memory_candidates WHERE project_id = ? AND status = ? ORDER BY created_at DESC'
        ).all(p.projectId, p.status);
      }
      return db.prepare(
        'SELECT * FROM research_memory_candidates WHERE project_id = ? ORDER BY created_at DESC'
      ).all(p.projectId);
    }

    case 'researchMemory:candidate:accept': {
      const now = Date.now();
      const txn = db.transaction(() => {
        const candidate = db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(p.id) as Record<string, unknown> | undefined;
        if (!candidate) throw new Error('Candidate not found');

        const memoryId = randomUUID();
        db.prepare(`
          INSERT INTO research_memory_objects (
            id, project_id, type, content, summary, source_refs_json, relation_refs_json,
            valid_from, valid_to, status, confidence, importance, tags_json,
            embedding_json, created_at, updated_at
          ) VALUES (
            @id, @project_id, @type, @content, @summary, @source_refs_json, @relation_refs_json,
            @valid_from, @valid_to, @status, @confidence, @importance, @tags_json,
            @embedding_json, @created_at, @updated_at
          )
        `).run({
          id: memoryId,
          project_id: candidate.project_id as string,
          type: candidate.proposed_type as string,
          content: candidate.content as string,
          summary: null,
          source_refs_json: candidate.source_refs_json as string,
          relation_refs_json: JSON.stringify([]),
          valid_from: null,
          valid_to: null,
          status: 'active',
          confidence: candidate.confidence ?? 0.5,
          importance: 0.7,
          tags_json: JSON.stringify(['accepted_candidate']),
          embedding_json: (p as Record<string, unknown>).embedding_json ?? null,
          created_at: now,
          updated_at: now,
        });

        db.prepare(
          'UPDATE research_memory_candidates SET status = ?, reviewed_at = ? WHERE id = ?'
        ).run('accepted', now, p.id);

        const acceptedCandidate = db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(p.id);
        const createdMemory = db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(memoryId);
        return { success: true, candidate: acceptedCandidate, memory: createdMemory };
      });
      return txn();
    }

    case 'researchMemory:candidate:reject': {
      const now = Date.now();
      db.prepare(
        'UPDATE research_memory_candidates SET status = ?, reviewed_at = ? WHERE id = ?'
      ).run('rejected', now, p.id);
      return db.prepare('SELECT * FROM research_memory_candidates WHERE id = ?').get(p.id);
    }

    case 'researchMemory:candidate:delete': {
      const result = db.prepare('DELETE FROM research_memory_candidates WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'researchMemory:object:updateEmbedding': {
      const id = p.id as string;
      const embeddingJson = (p as Record<string, unknown>).embedding_json;
      db.prepare(
        'UPDATE research_memory_objects SET embedding_json = ?, updated_at = ? WHERE id = ?'
      ).run(embeddingJson ?? null, Date.now(), id);
      return db.prepare('SELECT * FROM research_memory_objects WHERE id = ?').get(id);
    }

    case 'researchMemory:object:listWithEmbeddings': {
      const conditions: string[] = ['embedding_json IS NOT NULL'];
      const params: unknown[] = [];
      if (p.projectId) { conditions.push('project_id = ?'); params.push(p.projectId); }
      const limit = (p.limit as number) || 500;
      return db.prepare(
        `SELECT id, project_id, content, summary, embedding_json FROM research_memory_objects WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
      ).all(...params, limit);
    }

    case 'researchMemory:relation:create': {
      const now = Date.now();
      const id = randomUUID();
      db.prepare(`
        INSERT INTO research_memory_relations (id, project_id, from_memory_id, to_memory_id, relation_type, created_at)
        VALUES (@id, @project_id, @from_memory_id, @to_memory_id, @relation_type, @created_at)
      `).run({
        id,
        project_id: p.projectId,
        from_memory_id: p.fromMemoryId,
        to_memory_id: p.toMemoryId,
        relation_type: p.relationType,
        created_at: now,
      });
      return db.prepare('SELECT * FROM research_memory_relations WHERE id = ?').get(id);
    }

    case 'researchMemory:relation:listByMemory': {
      const memoryId = p.memoryId as string;
      return db.prepare(
        'SELECT * FROM research_memory_relations WHERE from_memory_id = ? OR to_memory_id = ? ORDER BY created_at DESC'
      ).all(memoryId, memoryId);
    }

    case 'researchMemory:relation:listByProject': {
      return db.prepare(
        'SELECT * FROM research_memory_relations WHERE project_id = ? ORDER BY created_at DESC'
      ).all(p.projectId);
    }

    case 'researchMemory:relation:delete': {
      const result = db.prepare('DELETE FROM research_memory_relations WHERE id = ?').run(p.id);
      return { success: result.changes > 0 };
    }

    case 'pairing:listPending': {
      const store = getPairingStore();
      return store.listAllPending();
    }

    case 'pairing:listApproved': {
      const store = getPairingStore();
      return store.listApproved();
    }

    case 'pairing:approve': {
      if (!p.platform || !p.code) throw new Error('Missing platform or code');
      const store = getPairingStore();
      return store.approve(p.platform as string, p.code as string);
    }

    case 'pairing:revoke': {
      if (!p.platform || !p.platformUserId) throw new Error('Missing platform or platformUserId');
      const store = getPairingStore();
      return store.revoke(p.platform as string, p.platformUserId as string);
    }

    case 'pairing:isApproved': {
      if (!p.platform || !p.platformUserId) throw new Error('Missing platform or platformUserId');
      const store = getPairingStore();
      return { approved: store.isApproved(p.platform as string, p.platformUserId as string) };
    }

    case 'plugin:registry:list': {
      const pluginManager = getPluginManager();
      return pluginManager.listInstalled();
    }

    case 'modelCapability:get': {
      const modelName = (p.modelName as string).trim().toLowerCase();
      return db.prepare('SELECT * FROM model_capabilities WHERE id = ?').get(modelName);
    }

    case 'modelCapability:set': {
      const modelName = (p.modelName as string).trim().toLowerCase();
      const isMultimodal = p.isMultimodal ? 1 : 0;
      const method = (p.method as string) || 'unknown';
      db.prepare(
        'INSERT OR REPLACE INTO model_capabilities (id, is_multimodal, detected_at, detection_method) VALUES (?, ?, ?, ?)'
      ).run(modelName, isMultimodal, Date.now(), method);
      return { success: true };
    }

    case 'modelCapability:delete': {
      const modelName = (p.modelName as string).trim().toLowerCase();
      const result = db.prepare('DELETE FROM model_capabilities WHERE id = ?').run(modelName);
      return { success: result.changes > 0 };
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
