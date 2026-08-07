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
import { readPluginManifest } from '../plugins/manifest';
import { resolvePermissionProfile } from '../db/permission-resolver';
import type { PermissionProfile } from '../lib/permission-profile';
import { getCoreStores } from '../db/core-connection';
import { type MailboxKind, type MailboxApplyMode, type MailboxStatus, type CheckpointType } from '../db/core';
import type { NewEvent } from '../db/core';
import {
  ipcSessionToCoreCreate,
  ipcSessionToUpdate,
  coreSessionToIpcRow,
  ipcMessageToNewEvent,
  storedEventToIpcMessage,
  storedEventsToIpcMessages,
  serializeMessageContent,
  serializeDisplayContent,
  ipcTaskToCoreCreate,
  ipcTaskToUpdate,
  coreTaskToIpcRow,
  ipcPermissionToCoreCreate,
  ipcPermissionToResolve,
  corePermissionToIpcRow,
  coreMailboxToIpcRow,
} from '../ipc/core-db-adapters';

const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    getLogger().debug(message, undefined, LogComponent.AgentCommunicator);
  }
}

function emitMailboxEvent(
  name: 'emitMailCreated' | 'emitMailEdited' | 'emitMailObserved' | 'emitMailApplied' | 'emitMailCancelled',
  row: unknown,
  extra?: string,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const broadcaster = require('../messaging/mailbox-broadcaster');
    broadcaster[name]?.(row as Record<string, unknown>, extra);
  } catch {
    // The agent DB bridge can run in test contexts without Electron windows.
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
    // ==================== Session actions (core store thin forward) ====================
    case 'session:create': {
      const { sessions } = getCoreStores();
      // Resolve model from provider config if not explicitly specified.
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
      const data = { ...p, model };
      const parentSessionId =
        (data.parent_session_id as string | undefined) ?? (data.parent_id as string | undefined) ?? null;
      const isTrusted = data.is_trusted_permission_override === true;
      const explicitProfile = typeof data.permission_profile === 'string' ? data.permission_profile : undefined;
      const permissionProfile: PermissionProfile = resolvePermissionProfile(explicitProfile, parentSessionId, { isTrustedOverride: isTrusted });

      // Upsert semantics: if the session already exists, update it (matches
      // the old ON CONFLICT(id) DO NOTHING + SELECT-back behavior).
      const existing = sessions.get(data.id as string);
      if (existing) {
        sessions.update(data.id as string, ipcSessionToUpdate(data));
        const extKeys = ['system_prompt', 'conductor_mode_enabled', 'conductor_canvas_id', 'context_summary', 'context_summary_updated_at', 'source'] as const;
        for (const key of extKeys) {
          if (data[key] !== undefined) {
            sessions.setExtension(data.id as string, key, data[key]);
          }
        }
        return coreSessionToIpcRow(sessions.get(data.id as string)!);
      }
      const session = sessions.create(ipcSessionToCoreCreate(data, permissionProfile));
      return coreSessionToIpcRow(session);
    }

    case 'session:get': {
      const { sessions } = getCoreStores();
      const session = sessions.get(p.id as string);
      return session ? coreSessionToIpcRow(session) : undefined;
    }

    case 'session:update': {
      const { sessions } = getCoreStores();
      const id = p.id as string;
      sessions.update(id, ipcSessionToUpdate(p));
      const extKeys = ['system_prompt', 'conductor_mode_enabled', 'conductor_canvas_id', 'context_summary', 'context_summary_updated_at', 'source'] as const;
      for (const key of extKeys) {
        if (p[key] !== undefined) {
          sessions.setExtension(id, key, p[key]);
        }
      }
      const updated = sessions.get(id);
      return updated ? coreSessionToIpcRow(updated) : undefined;
    }

    // Decision 5: session:delete is now soft delete (status='deleted'), no cascade.
    case 'session:delete': {
      const { sessions } = getCoreStores();
      const existing = sessions.get(p.id as string);
      if (!existing) return false;
      sessions.update(p.id as string, { status: 'deleted' });
      return true;
    }

    case 'session:list': {
      const { sessions } = getCoreStores();
      return sessions.list({ excludeModes: ['automation'] }).map(coreSessionToIpcRow);
    }

    case 'session:listByWorkingDirectory': {
      const { sessions } = getCoreStores();
      return sessions.list({ workingDirectory: (p.workingDirectory as string) || '' }).map(coreSessionToIpcRow);
    }

    case 'session:listByParentId': {
      const { sessions } = getCoreStores();
      return sessions.list({ parentSessionId: p.parentId as string }).map(coreSessionToIpcRow);
    }

    // Plan 328 Phase 6: session:search combines SessionStore.search (metadata
    // LIKE) with MessageLog.searchText (rollout content scan). Returns the old
    // `s.* + snippet` shape — same implementation as the `db:search:sessions`
    // IPC handler in electron/ipc/db-handlers.ts.
    case 'session:search': {
      const { sessions, messageLog } = getCoreStores();
      const opts = p.opts as { limit?: number } | undefined;
      const limit = opts?.limit ?? 10;
      // 1. Metadata matches (title / project_name / agent_name) — snippet empty.
      const metaHits = sessions.search(p.query as string, limit);
      const seenIds = new Set(metaHits.map((s) => s.id));
      const rows: Record<string, unknown>[] = metaHits.map((s) => ({
        ...coreSessionToIpcRow(s),
        snippet: '',
      }));

      // 2. Content matches (rollout scan) — fill in snippet for sessions not
      //    already in the metadata set, up to `limit` total.
      if (rows.length < limit) {
        const remaining = limit - rows.length;
        const contentHits = messageLog.searchText(p.query as string, { limit: remaining + 5 });
        for (const hit of contentHits) {
          if (rows.length >= limit) break;
          if (seenIds.has(hit.sessionId)) {
            // Attach snippet to existing metadata hit if not already set.
            const row = rows.find((r) => r.id === hit.sessionId);
            if (row && !row.snippet) row.snippet = hit.snippet;
            continue;
          }
          const session = sessions.get(hit.sessionId);
          if (!session || session.status === 'deleted') continue;
          seenIds.add(hit.sessionId);
          rows.push({
            ...coreSessionToIpcRow(session),
            snippet: hit.snippet,
          });
        }
      }

      // Sort by updated_at DESC (matches old ORDER BY).
      rows.sort((a, b) => ((b.updated_at as number) ?? 0) - ((a.updated_at as number) ?? 0));
      return rows.slice(0, limit);
    }

    case 'session:loadMessages': {
      const { messageLog } = getCoreStores();
      const sessionId = p.sessionId as string;
      const messages = storedEventsToIpcMessages(messageLog.listBySession(sessionId));
      // parsed_document attachments still live in the legacy DB (message_attachments
      // table) until a follow-up plan migrates them. Read from the legacy DB.
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

    // ==================== Message actions (core store thin forward) ====================
    // Decision 5: message:add uses INSERT OR IGNORE semantics via appendBatch
    // (same-id re-send is a no-op instead of overwriting).
    case 'message:add': {
      const { messageLog } = getCoreStores();
      const event = ipcMessageToNewEvent(p.session_id as string, p as unknown as Parameters<typeof ipcMessageToNewEvent>[1]);
      messageLog.appendBatch([event]);
      const events = messageLog.listBySession(p.session_id as string);
      const stored = events.find((e) => e.id === p.id);
      return stored ? storedEventToIpcMessage(stored) : null;
    }

    case 'message:getBySession': {
      const { messageLog } = getCoreStores();
      return storedEventsToIpcMessages(messageLog.listBySession(p.sessionId as string));
    }

    case 'message:getCount': {
      const { messageLog } = getCoreStores();
      return messageLog.getCount(p.sessionId as string);
    }

    case 'message:deleteBySession': {
      const { messageLog } = getCoreStores();
      const before = messageLog.getCount(p.sessionId as string);
      messageLog.deleteBySession(p.sessionId as string);
      return before;
    }

    // Decision 3: message:append maps to MessageLog.appendBatch (INSERT OR IGNORE
    // idempotency). turnId is forwarded to NewEvent.turnId for turn-scoped queries.
    case 'message:append': {
      const { messageLog } = getCoreStores();
      const sessionId = p.sessionId as string;
      const messages = p.messages as Array<Record<string, unknown>>;
      const turnId = p.turnId as string | null | undefined;

      if (!messages || !Array.isArray(messages)) {
        return { success: false, reason: 'invalid_messages' };
      }

      try {
        const events: NewEvent[] = messages.map((msg) =>
          ipcMessageToNewEvent(sessionId, msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1], turnId ?? null),
        );
        // Count actually-appended rows via getCount diff (INSERT OR IGNORE makes
        // duplicate IDs no-ops). Single-writer model ensures no concurrent inserts.
        const before = messageLog.getCount(sessionId);
        messageLog.appendBatch(events);
        const after = messageLog.getCount(sessionId);
        return { success: true, count: after - before };
      } catch (err) {
        getLogger().error('message:append failed', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.AgentCommunicator);
        return { success: false, count: 0, reason: 'transaction_failed' };
      }
    }

    // Decision 3: message:replace maps to MessageLog.appendBatch (INSERT OR IGNORE
    // idempotency). Generation optimistic lock is deprecated (append-only store).
    case 'message:replace': {
      const { sessions, messageLog } = getCoreStores();
      const sessionId = p.sessionId as string;
      const messages = p.messages as Array<Record<string, unknown>>;

      debugLog('message:replace request', {
        sessionId,
        generation: p.generation,
        hasMessages: Array.isArray(p.messages),
        messageCount: Array.isArray(p.messages) ? p.messages.length : -1,
      });

      if (!Array.isArray(messages)) {
        return { success: false, reason: 'messages_not_array' };
      }

      // Auto-create session if missing (old behavior: happens when the Worker
      // creates a session without a DB entry first).
      if (!sessions.get(sessionId)) {
        sessions.create({ id: sessionId, createdAt: Date.now(), updatedAt: Date.now() });
      }

      try {
        const events: NewEvent[] = messages.map((msg) => {
          const id = (msg.id as string) || randomUUID();
          msg.id = id;
          return ipcMessageToNewEvent(sessionId, msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1]);
        });
        messageLog.appendBatch(events);
        const result = { success: true, newGeneration: 0, messageCount: events.length };
        debugLog('message:replace success', { sessionId, ...result });
        return result;
      } catch (error) {
        getLogger().error('message:replace failed', error instanceof Error ? error : new Error(String(error)), { sessionId }, LogComponent.AgentCommunicator);
        return { success: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    // ==================== Lock actions (core store thin forward) ====================
    case 'lock:acquire': {
      const { locks } = getCoreStores();
      return locks.acquire(p.sessionId as string, p.lockId as string, p.owner as string, (p.ttlSec as number) || 300);
    }

    case 'lock:renew': {
      const { locks } = getCoreStores();
      return locks.renew(p.sessionId as string, p.lockId as string, (p.ttlSec as number) || 300);
    }

    case 'lock:release': {
      const { locks } = getCoreStores();
      return locks.release(p.sessionId as string, p.lockId as string);
    }

    case 'lock:isLocked': {
      const { locks } = getCoreStores();
      return locks.isLocked(p.sessionId as string);
    }

    // ==================== Task actions (core store thin forward) ====================
    case 'task:create': {
      const { tasks } = getCoreStores();
      const task = tasks.create(ipcTaskToCoreCreate(p as Parameters<typeof ipcTaskToCoreCreate>[0]));
      return coreTaskToIpcRow(task);
    }

    case 'task:get': {
      const { tasks } = getCoreStores();
      const task = tasks.get(p.id as string);
      return task ? coreTaskToIpcRow(task) : undefined;
    }

    case 'task:getBySession': {
      const { tasks } = getCoreStores();
      return tasks.getBySession(p.sessionId as string).map(coreTaskToIpcRow);
    }

    case 'task:update': {
      const { tasks } = getCoreStores();
      const task = tasks.update(p.id as string, ipcTaskToUpdate(p));
      return task ? coreTaskToIpcRow(task) : undefined;
    }

    case 'task:delete': {
      const { tasks } = getCoreStores();
      return tasks.delete(p.id as string);
    }

    case 'task:deleteBySession': {
      const { tasks } = getCoreStores();
      tasks.deleteBySession(p.sessionId as string);
      return { success: true };
    }

    case 'task:claim': {
      const { tasks } = getCoreStores();
      const result = tasks.claim(p.id as string, p.owner as string);
      if (result.success && result.task) {
        return { success: true, task: coreTaskToIpcRow(result.task) };
      }
      return result;
    }

    case 'task:block': {
      const { tasks } = getCoreStores();
      return tasks.block(p.fromId as string, p.toId as string);
    }

    case 'task:unassignTeammate': {
      const { tasks } = getCoreStores();
      return tasks.unassignTeammate(p.sessionId as string, p.owner as string);
    }

    case 'task:getByOwner': {
      const { tasks } = getCoreStores();
      return tasks.getByOwner(p.sessionId as string, p.owner as string).map(coreTaskToIpcRow);
    }

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
      return { success: true };
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
      return { success: true };
    }

    // ==================== Permission actions (core store thin forward) ====================
    case 'permission:create': {
      const { permissions } = getCoreStores();
      const perm = permissions.create(ipcPermissionToCoreCreate(p as Parameters<typeof ipcPermissionToCoreCreate>[0]));
      return corePermissionToIpcRow(perm);
    }

    case 'permission:get': {
      const { permissions } = getCoreStores();
      const perm = permissions.get(p.id as string);
      return perm ? corePermissionToIpcRow(perm) : undefined;
    }

    case 'permission:resolve': {
      const { permissions } = getCoreStores();
      const extra = p.extra as { message?: string; updatedPermissions?: unknown[]; updatedInput?: Record<string, unknown> } | undefined;
      permissions.resolve(p.id as string, {
        status: p.status as 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted',
        decision: p.status as string,
        ...ipcPermissionToResolve(extra),
      });
      const resolved = permissions.get(p.id as string);
      return resolved ? corePermissionToIpcRow(resolved) : undefined;
    }

    // ==================== Search actions (core store thin forward) ====================
    // Decision 7: combine SessionStore.search (metadata LIKE) with
    // MessageLog.searchText (rollout content scan). Returns the old
    // `s.* + snippet` shape so consumers have zero changes.
    case 'search:sessions': {
      const { sessions, messageLog } = getCoreStores();
      const limit = (p.limit as number) || 10;
      // 1. Metadata matches (title / project_name / agent_name) — snippet empty.
      const metaHits = sessions.search(p.query as string, limit);
      const seenIds = new Set(metaHits.map((s) => s.id));
      const rows: Record<string, unknown>[] = metaHits.map((s) => ({
        ...coreSessionToIpcRow(s),
        snippet: '',
      }));

      // 2. Content matches (rollout scan) — fill in snippet for sessions not
      //    already in the metadata set, up to `limit` total.
      if (rows.length < limit) {
        const remaining = limit - rows.length;
        const contentHits = messageLog.searchText(p.query as string, { limit: remaining + 5 });
        for (const hit of contentHits) {
          if (rows.length >= limit) break;
          if (seenIds.has(hit.sessionId)) {
            // Attach snippet to existing metadata hit if not already set.
            const row = rows.find((r) => r.id === hit.sessionId);
            if (row && !row.snippet) row.snippet = hit.snippet;
            continue;
          }
          const session = sessions.get(hit.sessionId);
          if (!session || session.status === 'deleted') continue;
          seenIds.add(hit.sessionId);
          rows.push({
            ...coreSessionToIpcRow(session),
            snippet: hit.snippet,
          });
        }
      }

      // Sort by updated_at DESC (matches old ORDER BY).
      rows.sort((a, b) => ((b.updated_at as number) ?? 0) - ((a.updated_at as number) ?? 0));
      return rows.slice(0, limit);
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
    case 'project:getGroups': {
      // Plan 328 Phase 5: aggregate from core SessionStore.
      const { sessions } = getCoreStores();
      const all = sessions.list();
      const groups = new Map<string, { working_directory: string; project_name: string; thread_count: number; last_activity: number }>();
      for (const s of all) {
        if (!s.workingDirectory) continue;
        const existing = groups.get(s.workingDirectory);
        if (existing) {
          existing.thread_count += 1;
          if (s.updatedAt > existing.last_activity) existing.last_activity = s.updatedAt;
        } else {
          groups.set(s.workingDirectory, {
            working_directory: s.workingDirectory,
            project_name: s.projectName,
            thread_count: 1,
            last_activity: s.updatedAt,
          });
        }
      }
      return Array.from(groups.values()).sort((a, b) => b.last_activity - a.last_activity);
    }

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
        schedule?: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null; endAt?: string | null };
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

    case 'config:provider:get': {
      const cm = getConfigManager();
      const id = p.id as string;
      if (!id) return null;
      return cm.getAllProviders()[id] || null;
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

    // ==================== Research Events / Sources / Citations / Reports ====================

    case 'researchEvent:create': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_events (id, run_id, sequence, event_type, payload_json, visibility, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(p.id, p.run_id, p.sequence, p.event_type, p.payload_json, p.visibility || 'user', now);
      return db.prepare('SELECT * FROM research_events WHERE run_id = ? AND sequence = ?').get(p.run_id, p.sequence);
    }

    case 'researchEvent:getByRunId': {
      const runId = p.runId as string;
      const limit = (p.limit as number) || 500;
      const afterSequence = (p.afterSequence as number | undefined) ?? -1;
      const visibility = p.visibility as string | undefined;
      if (visibility) {
        return db.prepare(
          'SELECT * FROM research_events WHERE run_id = ? AND visibility = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
        ).all(runId, visibility, afterSequence, limit);
      }
      return db.prepare(
        'SELECT * FROM research_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?'
      ).all(runId, afterSequence, limit);
    }

    case 'researchEvent:getMaxSequence': {
      const result = db.prepare(
        'SELECT MAX(sequence) as max_seq FROM research_events WHERE run_id = ?'
      ).get(p.runId) as { max_seq: number | null };
      return { max_seq: result?.max_seq ?? 0 };
    }

    case 'researchSource:upsert': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_sources (
          id, run_id, title, url, canonical_url, source_type, allowed_by_policy,
          reliability_json, dedupe_key, rejected_reason, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          canonical_url = excluded.canonical_url,
          source_type = excluded.source_type,
          allowed_by_policy = excluded.allowed_by_policy,
          reliability_json = excluded.reliability_json,
          dedupe_key = excluded.dedupe_key,
          rejected_reason = excluded.rejected_reason,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run(
        p.id,
        p.run_id,
        p.title,
        p.url ?? null,
        p.canonical_url ?? p.url ?? null,
        p.source_type ?? 'web',
        p.allowed_by_policy === false ? 0 : 1,
        p.reliability_json ?? null,
        p.dedupe_key ?? null,
        p.rejected_reason ?? null,
        p.metadata_json ?? null,
        now,
        now,
      );
      return db.prepare('SELECT * FROM research_sources WHERE id = ?').get(p.id);
    }

    case 'researchSource:getByRunId': {
      return db.prepare('SELECT * FROM research_sources WHERE run_id = ? ORDER BY created_at ASC').all(p.runId);
    }

    case 'researchCitation:create': {
      const now = Date.now();
      db.prepare(`
        INSERT OR REPLACE INTO research_citations (
          id, run_id, report_id, source_id, finding_id, claim, locator_json, quoted_evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        p.id,
        p.run_id,
        p.report_id ?? null,
        p.source_id,
        p.finding_id ?? null,
        p.claim,
        p.locator_json ?? null,
        p.quoted_evidence ?? null,
        now,
      );
      return db.prepare('SELECT * FROM research_citations WHERE id = ?').get(p.id);
    }

    case 'researchCitation:getByRunId': {
      if (p.reportId) {
        return db.prepare(
          'SELECT * FROM research_citations WHERE run_id = ? AND report_id = ? ORDER BY created_at ASC'
        ).all(p.runId, p.reportId);
      }
      return db.prepare('SELECT * FROM research_citations WHERE run_id = ? ORDER BY created_at ASC').all(p.runId);
    }

    case 'researchReport:upsert': {
      const now = Date.now();
      db.prepare(`
        INSERT INTO research_reports (
          id, run_id, title, markdown, outline_json, source_ids_json, citation_ids_json,
          activity_summary_json, export_metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          markdown = excluded.markdown,
          outline_json = excluded.outline_json,
          source_ids_json = excluded.source_ids_json,
          citation_ids_json = excluded.citation_ids_json,
          activity_summary_json = excluded.activity_summary_json,
          export_metadata_json = excluded.export_metadata_json,
          updated_at = excluded.updated_at
      `).run(
        p.id,
        p.run_id,
        p.title ?? null,
        p.markdown,
        p.outline_json ?? null,
        p.source_ids_json ?? '[]',
        p.citation_ids_json ?? '[]',
        p.activity_summary_json ?? null,
        p.export_metadata_json ?? null,
        now,
        now,
      );
      return db.prepare('SELECT * FROM research_reports WHERE id = ?').get(p.id);
    }

    case 'researchReport:getLatest': {
      return db.prepare(
        'SELECT * FROM research_reports WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1'
      ).get(p.runId);
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
      const items = pluginManager.listInstalled();
      // Attach manifest so the worker MCP collector can read
      // capabilities.mcpServers. Without this, the collector sees
      // manifest=undefined and never discovers plugin-declared MCP
      // servers. Mirrors collect-main.ts which reads from disk.
      return items.map((item) => {
        if (!item.installPath) return item;
        try {
          return { ...item, manifest: readPluginManifest(item.installPath) };
        } catch {
          return item;
        }
      });
    }

    case 'plugin:setup:list-all': {
      // Return all plugin setup values as `{ [pluginId]: { [key]: value } }`.
      // The MCP loader uses this map to expand `${setup.X}` references in
      // plugin manifests. Defensive: if the `plugin_setup_values` table does not
      // exist yet (setup-storage migration not applied), return an empty
      // object so `${setup.X}` references degrade to `missingKeys` issues
      // instead of crashing the MCP load.
      try {
        const tableExists = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_setup_values'",
        ).get() as { '1': number } | undefined;
        if (!tableExists) return {};
        const rows = db.prepare(
          'SELECT plugin_id, key, value FROM plugin_setup_values',
        ).all() as Array<{ plugin_id: string; key: string; value: string }>;
        const out: Record<string, Record<string, string>> = {};
        for (const row of rows) {
          if (!out[row.plugin_id]) out[row.plugin_id] = {};
          out[row.plugin_id][row.key] = row.value;
        }
        return out;
      } catch {
        return {};
      }
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

    // ==================== Mailbox actions (core store thin forward) ====================
    // Plan 328 Phase 3: all mailbox cases forward to the Mailbox core store via
    // core-db-adapters. DTO shape (snake_case flat row) is preserved so the
    // Worker code has zero changes. The apply matrix is enforced by
    // Mailbox.assertApplyAllowed (single source of truth, Plan 202 §5.2).
    case 'mailbox:send': {
      const { mailbox } = getCoreStores();
      const item = mailbox.enqueue({
        id: p.id as string,
        sessionId: p.sessionId as string,
        submittedRunId: (p.submittedDuringRunId as string) || '',
        content: p.content as string,
        kind: p.kind as MailboxKind,
        attachments: p.attachments as unknown[] | undefined,
        clientMsgId: (p.clientMsgId as string | null | undefined) ?? null,
        source: (p.source as string | undefined) ?? 'ui',
        meta: p.constraintsJson ? { constraints: JSON.parse(p.constraintsJson as string) } : undefined,
      });
      const row = coreMailboxToIpcRow(item);
      emitMailboxEvent('emitMailCreated', row);
      return row;
    }

    case 'mailbox:edit': {
      const { mailbox } = getCoreStores();
      const existing = mailbox.get(p.id as string);
      if (!existing) return null;
      // Retry-safe: if the row was already promoted as queued_for_next_agent_turn,
      // return it unchanged so the renderer's retry is idempotent.
      if (existing.status === 'applied' && existing.appliedSummary === 'queued_for_next_agent_turn') {
        return coreMailboxToIpcRow(existing);
      }
      const previousContent = existing.content;
      const edited = mailbox.edit(p.id as string, {
        content: p.content as string | undefined,
        kind: p.kind as MailboxKind | undefined,
      });
      if (!edited) return null;
      const row = coreMailboxToIpcRow(edited);
      emitMailboxEvent('emitMailEdited', row, previousContent);
      return row;
    }

    case 'mailbox:guide': {
      const { mailbox } = getCoreStores();
      const existing = mailbox.get(p.id as string);
      if (!existing) return null;
      const previousContent = existing.content;
      const guided = mailbox.guide(p.id as string);
      if (!guided) return null;
      const row = coreMailboxToIpcRow(guided);
      emitMailboxEvent('emitMailEdited', row, previousContent);
      return row;
    }

    case 'mailbox:promoteQueued': {
      const { mailbox } = getCoreStores();
      // promoteQueued requires sessionId — fetch the item first to get it.
      const existing = mailbox.get(p.id as string);
      if (!existing) return null;
      const row = mailbox.promoteQueued(existing.sessionId, p.id as string);
      if (!row) return null;
      emitMailboxEvent('emitMailApplied', coreMailboxToIpcRow(row));
      return coreMailboxToIpcRow(row);
    }

    case 'mailbox:cancel': {
      const { mailbox } = getCoreStores();
      const reason = p.reason as string | undefined;
      const cancelled = mailbox.cancel(p.id as string, reason, 'user');
      if (!cancelled) return null;
      const row = coreMailboxToIpcRow(cancelled);
      emitMailboxEvent('emitMailCancelled', row, reason);
      return row;
    }

    case 'mailbox:list': {
      const { mailbox } = getCoreStores();
      const limit = (p.limit as number) ?? 50;
      const statuses = p.status as MailboxStatus[] | undefined;
      return mailbox
        .list(p.sessionId as string, { status: statuses, limit })
        .map(coreMailboxToIpcRow);
    }

    case 'mailbox:listForSession': {
      const { mailbox } = getCoreStores();
      return mailbox.listForSession(p.sessionId as string).map(coreMailboxToIpcRow);
    }

    case 'mailbox:claimBatch': {
      const { mailbox } = getCoreStores();
      const result = mailbox.claimBatch({
        sessionId: p.sessionId as string,
        runId: p.runId as string,
        checkpoint: p.checkpoint as CheckpointType,
        limit: p.limit as number | undefined,
        leaseMs: p.leaseMs as number | undefined,
        coalesceWindowMs: p.coalesceWindowMs as number | undefined,
        maxClaimAttempts: p.maxClaimAttempts as number | undefined,
      });
      const rows = result.rows.map((item) => {
        const row = coreMailboxToIpcRow(item);
        emitMailboxEvent('emitMailObserved', row);
        return row;
      });
      return { rows, claimTokens: result.claimTokens };
    }

    case 'mailbox:apply': {
      const { mailbox } = getCoreStores();
      const item = mailbox.apply({
        id: p.id as string,
        claimToken: p.claimToken as string,
        mode: p.mode as MailboxApplyMode,
        checkpoint: p.checkpoint as CheckpointType,
        summary: p.summary as string | undefined,
        resultingEventId: (p.resultingUserMsgId as string | null | undefined) ?? null,
      });
      const row = coreMailboxToIpcRow(item);
      emitMailboxEvent('emitMailApplied', row);
      return row;
    }

    case 'mailbox:cancelByAgent': {
      const { mailbox } = getCoreStores();
      const reason = (p.reason as string | undefined) ?? 'cancelled_by_agent';
      const cancelled = mailbox.cancelByAgent({
        id: p.id as string,
        claimToken: p.claimToken as string,
        reason,
      });
      if (!cancelled) return null;
      const row = coreMailboxToIpcRow(cancelled);
      emitMailboxEvent('emitMailCancelled', row, reason);
      return row;
    }

    case 'turn-review:save': {
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
      const turnId = typeof p.turnId === 'string' ? p.turnId : '';
      const workingDirectory = typeof p.workingDirectory === 'string' ? p.workingDirectory : '';
      const patch = typeof p.patch === 'string' ? p.patch : '';
      const files = Array.isArray(p.files) ? p.files : [];
      if (!sessionId || !turnId || !workingDirectory) {
        throw new Error('Invalid turn review payload');
      }

      // Plan 328: chat_turn_reviews no longer has a FK to chat_sessions (migration 47
      // dropped it). working_directory is stored on chat_turn_reviews itself, so no
      // parent-row check or placeholder INSERT is needed — string association only.
      db.prepare(`
        INSERT INTO chat_turn_reviews (
          id, session_id, turn_id, working_directory, files_json, patch,
          additions, removals, truncated, binary, captured_at
        ) VALUES (
          @id, @session_id, @turn_id, @working_directory, @files_json, @patch,
          @additions, @removals, @truncated, @binary, @captured_at
        )
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
          files_json = excluded.files_json,
          patch = excluded.patch,
          additions = excluded.additions,
          removals = excluded.removals,
          truncated = excluded.truncated,
          binary = excluded.binary,
          captured_at = excluded.captured_at
      `).run({
        id: typeof p.id === 'string' ? p.id : randomUUID(),
        session_id: sessionId,
        turn_id: turnId,
        working_directory: workingDirectory,
        files_json: JSON.stringify(files),
        patch,
        additions: typeof p.additions === 'number' ? p.additions : 0,
        removals: typeof p.removals === 'number' ? p.removals : 0,
        truncated: p.truncated === true ? 1 : 0,
        binary: p.binary === true ? 1 : 0,
        captured_at: typeof p.capturedAt === 'number' ? p.capturedAt : now,
      });
      return true;
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
