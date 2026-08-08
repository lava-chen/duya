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
import {
  createCanvas as createConductorCanvas,
  getMaxZIndex,
} from '../db/queries/conductors';
import { getChannelManager } from '../messaging/port-manager';
import { updateDatabasePath, readBootConfig } from '../config/boot-config';
import { emitGatewayConfigChanged, isGatewayConfigKey } from '../gateway/config-events';
import { notifyMcpConfigChanged } from '../services/mcp-write-reload';
import { readUserMcpToml, writeUserMcpToml } from '../services/mcp-toml-config';
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
import { getCoreStores } from '../db/core-connection';
import { resolvePermissionProfile } from '../db/permission-resolver';
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
  ipcToUpdate,
  coreTaskToIpcRow,
  coreGoalToIpcRow,
  ipcPermissionToCoreCreate,
  ipcPermissionToResolve,
  corePermissionToIpcRow,
  coreMailboxToIpcRow,
} from './core-db-adapters';
import type { NewEvent, MailboxKind, MailboxStatus } from '../db/core';

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

/**
 * Allocate the next z-index for a newly created element. Later-created
 * elements stack above earlier ones. Connectors start at 10 so relationship
 * lines sit above the default node layer.
 */
function getNextZIndex(canvasId: string, minZ = 1): number {
  return Math.max(getMaxZIndex(canvasId) + 1, minZ);
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
        return { success: false, error: 'Failed to update config.toml' };
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

  // ==================== Session Handlers (core store thin forward) ====================
  // Plan 328 Phase 2: all session IPC handlers forward to SessionStore via
  // core-db-adapters. DTO shape (snake_case flat row) is preserved so the
  // renderer and Worker code have zero changes.

  ipcMain.handle('db:session:create', (_event, data: Record<string, unknown>) => {
    const { sessions } = getCoreStores();
    // Resolve permission profile BEFORE insert (single-phase write, see
    // permission-resolver.ts). Trusted override only for internal callers.
    const parentSessionId =
      (data.parent_session_id as string | undefined) ?? (data.parent_id as string | undefined) ?? null;
    const permissionMode = resolvePermissionProfile(
      data.permission_profile as string | null | undefined,
      parentSessionId,
      { isTrustedOverride: data.is_trusted_permission_override === true },
    );
    // Upsert semantics: if the session already exists, update it.
    const existing = sessions.get(data.id as string);
    if (existing) {
      const patch = ipcSessionToUpdate(data);
      sessions.update(data.id as string, patch);
      const extKeys = ['system_prompt', 'conductor_mode_enabled', 'conductor_canvas_id', 'context_summary', 'source'] as const;
      for (const key of extKeys) {
        if (data[key] !== undefined) {
          sessions.setExtension(data.id as string, key, data[key]);
        }
      }
      return coreSessionToIpcRow(sessions.get(data.id as string)!);
    }
    const input = ipcSessionToCoreCreate(data, permissionMode);
    const session = sessions.create(input);
    // Plan 332 Phase 1: record the sub-agent lineage edge. Only fires when a
    // NEW session is created with a parent (a spawn). `sessions.parent_session_id`
    // is the fast direct-parent shortcut; the spawn edge is the full lineage truth
    // source (turn / reason / type). Idempotent — re-create is a no-op.
    if (input.parentSessionId) {
      try {
        getCoreStores().spawnEdges.record({
          parentSessionId: input.parentSessionId,
          childSessionId: input.id,
          spawnType: (data.spawn_type as string | undefined) ?? 'subagent',
          spawnReason: data.spawn_reason as string | undefined,
          spawnTurnId: data.spawn_turn_id as string | undefined,
        });
      } catch (error) {
        // Spawn edge is best-effort — parent_session_id still preserves lineage.
        getLogger().warn(
          'Failed to record spawn edge',
          {
            error: error instanceof Error ? error.message : String(error),
            parent: input.parentSessionId,
            child: input.id,
          },
          LogComponent.DB,
        );
      }
    }
    return coreSessionToIpcRow(session);
  });

  ipcMain.handle('db:session:get', (_event, sessionId: string) => {
    const { sessions } = getCoreStores();
    const session = sessions.get(sessionId);
    return session ? coreSessionToIpcRow(session) : undefined;
  });

  ipcMain.handle('db:session:update', (_event, sessionId: string, data: Record<string, unknown>) => {
    const { sessions } = getCoreStores();
    const patch = ipcSessionToUpdate(data);
    sessions.update(sessionId, patch);
    // Extension-bound fields — write via setExtension.
    const extKeys = ['system_prompt', 'conductor_mode_enabled', 'conductor_canvas_id', 'context_summary', 'context_summary_updated_at', 'source'] as const;
    for (const key of extKeys) {
      if (data[key] !== undefined) {
        sessions.setExtension(sessionId, key, data[key]);
      }
    }
    const updated = sessions.get(sessionId);
    return updated ? coreSessionToIpcRow(updated) : undefined;
  });

  // Decision 5: session:delete is now soft delete (status='deleted'), no cascade.
  // Old behavior was hard DELETE with cascade to messages/tasks/etc.
  ipcMain.handle('db:session:delete', (_event, sessionId: string) => {
    const { sessions } = getCoreStores();
    const existing = sessions.get(sessionId);
    if (!existing) return false;
    sessions.update(sessionId, { status: 'deleted' });
    return true;
  });

  ipcMain.handle('db:session:list', () => {
    const { sessions } = getCoreStores();
    // Decision 5: preserve renderer's mode != 'automation' filter.
    const list = sessions.list({ excludeModes: ['automation'] });
    return list.map(coreSessionToIpcRow);
  });

  ipcMain.handle('db:session:listByWorkingDirectory', (_event, workingDirectory: string) => {
    const { sessions } = getCoreStores();
    const list = sessions.list({ workingDirectory: workingDirectory || '' });
    return list.map(coreSessionToIpcRow);
  });

  ipcMain.handle('db:session:listByParentId', (_event, parentId: string) => {
    const { sessions } = getCoreStores();
    const list = sessions.list({ parentSessionId: parentId });
    return list.map(coreSessionToIpcRow);
  });

  ipcMain.handle('db:session:saveDraft', (_event, sessionId: string, draft: string) => {
    const { sessions } = getCoreStores();
    sessions.saveDraft(sessionId, draft);
  });

  ipcMain.handle('db:session:getDraft', (_event, sessionId: string) => {
    const { sessions } = getCoreStores();
    return sessions.getDraft(sessionId);
  });

  // ==================== Message Handlers (core store thin forward) ====================
  // Plan 328 Phase 2: all message IPC handlers forward to MessageLog via
  // core-db-adapters. Decision 3: message:replace → appendBatch (INSERT OR
  // IGNORE idempotency); truncate* → rewriteSession (only append-only
  // exception). Decision 5: message:add changed from INSERT OR REPLACE to
  // INSERT OR IGNORE (same-id re-send no longer overwrites).

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
    const { messageLog } = getCoreStores();
    // Decision 5: INSERT OR IGNORE semantics via appendBatch — same-id re-send
    // is a no-op instead of overwriting (append-only discipline).
    const event = ipcMessageToNewEvent(data.session_id, data);
    messageLog.appendBatch([event]);
    // Read back through the adapter to return the canonical row shape.
    const events = messageLog.listBySession(data.session_id);
    const stored = events.find((e) => e.id === data.id);
    return stored ? storedEventToIpcMessage(stored) : null;
  });

  ipcMain.handle('db:message:getBySession', (_event, sessionId: string) => {
    const { messageLog } = getCoreStores();
    const events = messageLog.listBySession(sessionId);
    return storedEventsToIpcMessages(events);
  });

  ipcMain.handle('db:message:getCount', (_event, sessionId: string) => {
    const { messageLog } = getCoreStores();
    return messageLog.getCount(sessionId);
  });

  ipcMain.handle('db:message:deleteBySession', (_event, sessionId: string) => {
    const { messageLog } = getCoreStores();
    const before = messageLog.getCount(sessionId);
    messageLog.deleteBySession(sessionId);
    return before;
  });

  // Decision 3: message:replace maps to MessageLog.appendBatch (INSERT OR IGNORE
  // idempotency). Generation optimistic lock is deprecated (append-only store).
  // If the session does not exist, auto-create it (matches old behavior).
  ipcMain.handle('db:message:replace', (_event, sessionId: string, messages: unknown[], _generation: number) => {
    const { sessions, messageLog } = getCoreStores();

    // Auto-create session if missing (old behavior: happens when frontend
    // creates a session without a DB entry first).
    if (!sessions.get(sessionId)) {
      dbLogger.info('Session not found, auto-creating', { sessionId }, LogComponent.DB);
      sessions.create({ id: sessionId, createdAt: Date.now(), updatedAt: Date.now() });
    }

    try {
      // Build NewEvents via the adapter. Deterministic IDs are preserved
      // (no randomUUID fallback) so re-sending the same batch is idempotent.
      const events: NewEvent[] = (messages as Record<string, unknown>[]).map((msg) => {
        const id = (msg.id as string) || randomUUID();
        msg.id = id;
        return ipcMessageToNewEvent(sessionId, msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1]);
      });
      messageLog.appendBatch(events);
      return { success: true, newGeneration: 0, messageCount: events.length };
    } catch (error) {
      dbLogger.error('replaceMessages failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.DB);
      return { success: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  // Decision 3: truncate* maps to rewriteSession (the only append-only
  // exception). The adapter computes the kept events via project() and
  // rewrites the whole rollout file + index.
  ipcMain.handle('db:message:truncateAfter', (_event, sessionId: string, messageId: string) => {
    const { messageLog } = getCoreStores();
    const events = messageLog.listBySession(sessionId);
    const cutIdx = events.findIndex((e) => e.id === messageId);
    if (cutIdx < 0) return { deletedCount: 0 };
    // Keep [0, cutIdx] (inclusive of the target — truncateAfter keeps target).
    const keptEvents: NewEvent[] = events.slice(0, cutIdx + 1).map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      turnId: e.turnId,
      payload: JSON.parse(e.payload),
      createdAt: e.createdAt,
    }));
    const deletedCount = events.length - keptEvents.length;
    messageLog.rewriteSession(sessionId, keptEvents);
    return { deletedCount };
  });

  // Edit-and-resend: supersede the target message and everything after it
  // (inclusive), so the edited version can be appended as a fresh message.
  ipcMain.handle('db:message:truncateFromInclusive', (_event, sessionId: string, messageId: string) => {
    const { messageLog } = getCoreStores();
    const events = messageLog.listBySession(sessionId);
    const cutIdx = events.findIndex((e) => e.id === messageId);
    if (cutIdx < 0) return { deletedCount: 0 };
    // Keep [0, cutIdx) (exclusive of the target — truncateFromInclusive removes target).
    const keptEvents: NewEvent[] = events.slice(0, cutIdx).map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      turnId: e.turnId,
      payload: JSON.parse(e.payload),
      createdAt: e.createdAt,
    }));
    const deletedCount = events.length - keptEvents.length;
    messageLog.rewriteSession(sessionId, keptEvents);
    return { deletedCount };
  });

  // ==================== Lock Handlers (core store thin forward) ====================
  // Plan 328 Phase 2: all lock IPC handlers forward to LockStore.

  ipcMain.handle('db:lock:acquire', (_event, sessionId: string, lockId: string, owner: string, ttlSec = 300) => {
    const { locks } = getCoreStores();
    return locks.acquire(sessionId, lockId, owner, ttlSec);
  });

  ipcMain.handle('db:lock:renew', (_event, sessionId: string, lockId: string, ttlSec = 300) => {
    const { locks } = getCoreStores();
    return locks.renew(sessionId, lockId, ttlSec);
  });

  ipcMain.handle('db:lock:release', (_event, sessionId: string, lockId: string) => {
    const { locks } = getCoreStores();
    return locks.release(sessionId, lockId);
  });

  ipcMain.handle('db:lock:isLocked', (_event, sessionId: string) => {
    const { locks } = getCoreStores();
    return locks.isLocked(sessionId);
  });

  // ==================== Goal Handlers (core store thin forward) ====================
  // Plan 331 Phase 2: session_goals table — per-session goal + token budget
  // mirror. The agent calls these to persist token/time deltas after each
  // turn and to transition the goal status. On session resume the persisted
  // counters are read back into the in-memory TokenBudgetManager.

  ipcMain.handle('db:goal:get', (_event, payload: { sessionId: string }) => {
    const { goals } = getCoreStores();
    const goal = goals.get(payload.sessionId);
    return goal ? coreGoalToIpcRow(goal) : undefined;
  });

  ipcMain.handle('db:goal:create', (_event, data: {
    id: string;
    session_id: string;
    goal_text?: string | null;
    token_budget?: number | null;
  }) => {
    const { goals } = getCoreStores();
    const goal = goals.create({
      id: data.id,
      sessionId: data.session_id,
      goalText: data.goal_text ?? null,
      tokenBudget: data.token_budget ?? null,
    });
    return coreGoalToIpcRow(goal);
  });

  ipcMain.handle('db:goal:updateBudget', (_event, payload: {
    sessionId: string;
    tokensUsedDelta?: number;
    timeUsedDelta?: number;
  }) => {
    const { goals } = getCoreStores();
    const goal = goals.updateBudget(payload.sessionId, {
      tokensUsedDelta: payload.tokensUsedDelta,
      timeUsedDelta: payload.timeUsedDelta,
    });
    return goal ? coreGoalToIpcRow(goal) : undefined;
  });

  ipcMain.handle('db:goal:setStatus', (_event, payload: {
    sessionId: string;
    status: 'active' | 'paused' | 'usage_limited' | 'complete';
  }) => {
    const { goals } = getCoreStores();
    const goal = goals.setStatus(payload.sessionId, payload.status);
    return goal ? coreGoalToIpcRow(goal) : undefined;
  });

  ipcMain.handle('db:goal:listByStatus', (_event, status: 'active' | 'paused' | 'usage_limited' | 'complete') => {
    const { goals } = getCoreStores();
    return goals.listByStatus(status).map(coreGoalToIpcRow);
  });

  // ==================== Task Handlers (core store thin forward) ====================
  // Plan 328 Phase 2: all task IPC handlers forward to TaskStore via
  // core-db-adapters. DTO shape (snake_case flat row) is preserved.

  ipcMain.handle('db:task:create', (_event, data: {
    id: string;
    session_id: string;
    subject: string;
    description: string;
    active_form?: string;
    owner?: string;
  }) => {
    const { tasks } = getCoreStores();
    const task = tasks.create(ipcTaskToCoreCreate(data));
    return coreTaskToIpcRow(task);
  });

  ipcMain.handle('db:task:get', (_event, id: string) => {
    const { tasks } = getCoreStores();
    const task = tasks.get(id);
    return task ? coreTaskToIpcRow(task) : undefined;
  });

  ipcMain.handle('db:task:getBySession', (_event, sessionId: string) => {
    const { tasks } = getCoreStores();
    return tasks.getBySession(sessionId).map(coreTaskToIpcRow);
  });

  ipcMain.handle('db:task:update', (_event, id: string, data: Record<string, unknown>) => {
    const { tasks } = getCoreStores();
    const task = tasks.update(id, ipcTaskToUpdate(data));
    return task ? coreTaskToIpcRow(task) : undefined;
  });

  ipcMain.handle('db:task:delete', (_event, id: string) => {
    const { tasks } = getCoreStores();
    return tasks.delete(id);
  });

  ipcMain.handle('db:task:deleteBySession', (_event, sessionId: string) => {
    const { tasks } = getCoreStores();
    tasks.deleteBySession(sessionId);
  });

  ipcMain.handle('db:task:claim', (_event, id: string, owner: string) => {
    const { tasks } = getCoreStores();
    const result = tasks.claim(id, owner);
    if (result.success && result.task) {
      return { success: true, task: coreTaskToIpcRow(result.task) };
    }
    return result;
  });

  ipcMain.handle('db:task:block', (_event, fromId: string, toId: string) => {
    const { tasks } = getCoreStores();
    return tasks.block(fromId, toId);
  });

  ipcMain.handle('db:task:unassignTeammate', (_event, sessionId: string, owner: string) => {
    const { tasks } = getCoreStores();
    return tasks.unassignTeammate(sessionId, owner);
  });

  ipcMain.handle('db:task:getByOwner', (_event, sessionId: string, owner: string) => {
    const { tasks } = getCoreStores();
    return tasks.getByOwner(sessionId, owner).map(coreTaskToIpcRow);
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

  // User-managed MCP configuration has a dedicated TOML-backed contract.
  // Do not route it through the generic SQLite settings table.
  ipcMain.handle('mcp:config:list', async () => readUserMcpToml());
  ipcMain.handle('mcp:config:replace', async (_event, servers: unknown) => {
    if (!Array.isArray(servers)) throw new Error('MCP server list must be an array');
    await writeUserMcpToml(servers as Awaited<ReturnType<typeof readUserMcpToml>>);
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

  // ==================== Permission Handlers (core store thin forward) ====================
  // Plan 328 Phase 2: all permission IPC handlers forward to PermissionLedger
  // via core-db-adapters. DTO shape (snake_case flat row) is preserved.

  ipcMain.handle('db:permission:create', (_event, data: {
    id: string;
    sessionId?: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => {
    const { permissions } = getCoreStores();
    const perm = permissions.create(ipcPermissionToCoreCreate(data));
    return corePermissionToIpcRow(perm);
  });

  ipcMain.handle('db:permission:get', (_event, id: string) => {
    const { permissions } = getCoreStores();
    const perm = permissions.get(id);
    return perm ? corePermissionToIpcRow(perm) : undefined;
  });

  ipcMain.handle('db:permission:resolve', (_event, id: string, status: string, extra?: {
    message?: string;
    updatedPermissions?: unknown[];
    updatedInput?: Record<string, unknown>;
    sessionId?: string;
  }) => {
    const { permissions } = getCoreStores();
    permissions.resolve(id, {
      status: status as 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted',
      decision: status,
      ...ipcPermissionToResolve(extra),
    });

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

    const resolved = permissions.get(id);
    return resolved ? corePermissionToIpcRow(resolved) : undefined;
  });

  // ==================== Search Handlers (core store thin forward) ====================
  // Plan 328 Phase 2 decision 7: combine SessionStore.search (metadata LIKE)
  // with MessageLog.searchText (rollout content scan). Returns the old
  // `s.* + snippet` shape so the renderer has zero changes. LIKE on CJK
  // titles beats unicode61 FTS (326 decision 3); messages_fts/sessions_fts
  // virtual tables are no longer referenced.

  ipcMain.handle('db:search:sessions', (_event, query: string, limit = 10) => {
    const { sessions, messageLog } = getCoreStores();
    // 1. Metadata matches (title / project_name / agent_name) — snippet empty.
    const metaHits = sessions.search(query, limit);
    const seenIds = new Set(metaHits.map((s) => s.id));
    const rows: Record<string, unknown>[] = metaHits.map((s) => ({
      ...coreSessionToIpcRow(s),
      snippet: '',
    }));

    // 2. Content matches (rollout scan) — fill in snippet for sessions not
    //    already in the metadata set, up to `limit` total.
    if (rows.length < limit) {
      const remaining = limit - rows.length;
      const contentHits = messageLog.searchText(query, { limit: remaining + 5 });
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
    // Plan 328 Phase 5: aggregate from core SessionStore instead of legacy
    // chat_sessions table. Group by working_directory in JS (small N).
    const { sessions } = getCoreStores();
    const all = sessions.list(); // excludes status='deleted' by default
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
      return { success: false, error: 'Failed to update config.toml' };
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

  // ==================== Session Agent Profile Binding (core store thin forward) ====================

  ipcMain.handle('db:session:setAgentProfile', (_event, sessionId: string, agentProfileId: string | null) => {
    const { sessions } = getCoreStores();
    sessions.update(sessionId, { agentProfileId });
    const updated = sessions.get(sessionId);
    return updated ? coreSessionToIpcRow(updated) : undefined;
  });

  ipcMain.handle(
    'db:session:set_conductor_mode',
    (_event, payload: { sessionId: string; enabled: boolean; canvasId?: string | null }) => {
      const { sessions } = getCoreStores();
      // conductor_mode_enabled / conductor_canvas_id live in extensions.
      sessions.setExtension(payload.sessionId, 'conductor_mode_enabled', payload.enabled ? 1 : 0);
      sessions.setExtension(payload.sessionId, 'conductor_canvas_id', payload.canvasId ?? null);
      const updated = sessions.get(payload.sessionId);
      return updated ? coreSessionToIpcRow(updated) : undefined;
    },
  );

  // Plan 331 Phase 4: pin/unpin a session via the extensions JSON column.
  // Mirrors the set_conductor_mode pattern — no schema change, just a
  // key-level write. Pinned sessions surface to the top of the sidebar.
  ipcMain.handle(
    'db:session:set_pinned',
    (_event, payload: { sessionId: string; pinned: boolean }) => {
      const { sessions } = getCoreStores();
      sessions.setExtension(payload.sessionId, 'pinned', payload.pinned ? 1 : 0);
      const updated = sessions.get(payload.sessionId);
      return updated ? coreSessionToIpcRow(updated) : undefined;
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
          const rawPosition = request.position as Record<string, unknown>;
          const position =
            typeof rawPosition.zIndex === 'number' && Number.isFinite(rawPosition.zIndex)
              ? rawPosition
              : { ...rawPosition, zIndex: getNextZIndex(canvasId) };
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
          const position = { x: 0, y: 0, w: 0, h: 0, zIndex: getNextZIndex(canvasId, 10), rotation: 0 };
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

// ==================== Mailbox Handlers (core store thin forward) ====================
// Plan 328 Phase 3: all mailbox IPC handlers forward to the Mailbox core store
// via core-db-adapters. DTO shape (snake_case flat row) is preserved so the
// renderer has zero changes. The apply matrix is enforced by Mailbox.assertApplyAllowed
// (single source of truth, Plan 202 §5.2).

export function registerMailboxHandlers(): void {
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
    const { mailbox } = getCoreStores();
    const item = mailbox.enqueue({
      id: data.id,
      sessionId: data.sessionId,
      submittedRunId: data.submittedDuringRunId || '',
      content: data.content,
      kind: data.kind as MailboxKind,
      attachments: data.attachments,
      clientMsgId: data.clientMsgId ?? null,
      source: data.source ?? 'ui',
      meta: data.constraintsJson ? { constraints: JSON.parse(data.constraintsJson) } : undefined,
    });
    const row = coreMailboxToIpcRow(item);
    emitMailCreated(row);
    return row;
  });

  ipcMain.handle('mailbox:edit', (_event, data: { id: string; content?: string; kind?: string }) => {
    const { mailbox } = getCoreStores();
    const existing = mailbox.get(data.id);
    if (!existing) return null;
    // A previous renderer may have committed the row before its IPC response
    // failed. Returning the same row makes a retry enqueue it exactly once.
    if (existing.status === 'applied' && existing.appliedSummary === 'queued_for_next_agent_turn') {
      return coreMailboxToIpcRow(existing);
    }
    const previousContent = existing.content;
    const edited = mailbox.edit(data.id, {
      content: data.content,
      kind: data.kind as MailboxKind | undefined,
    });
    if (!edited) return null;
    const row = coreMailboxToIpcRow(edited);
    emitMailEdited(row, previousContent);
    return row;
  });

  ipcMain.handle('mailbox:guide', (_event, data: { id: string }) => {
    const { mailbox } = getCoreStores();
    const existing = mailbox.get(data.id);
    if (!existing) return null;
    const previousContent = existing.content;
    const guided = mailbox.guide(data.id);
    if (!guided) return null;
    const row = coreMailboxToIpcRow(guided);
    emitMailEdited(row, previousContent);
    return row;
  });

  ipcMain.handle('mailbox:promoteQueued', (_event, data: { id: string }) => {
    const { mailbox } = getCoreStores();
    // promoteQueued requires sessionId — fetch the item first to get it.
    const existing = mailbox.get(data.id);
    if (!existing) return null;
    const item = mailbox.promoteQueued(existing.sessionId, data.id);
    if (!item) return null;
    const row = coreMailboxToIpcRow(item);
    emitMailApplied(row);
    return row;
  });

  ipcMain.handle('mailbox:cancel', (_event, data: { id: string; reason?: string }) => {
    const { mailbox } = getCoreStores();
    const cancelled = mailbox.cancel(data.id, data.reason, 'user');
    if (!cancelled) return null;
    const row = coreMailboxToIpcRow(cancelled);
    emitMailCancelled(row, data.reason);
    return row;
  });

  ipcMain.handle('mailbox:list', (_event, data: { sessionId: string; status?: string[]; limit?: number }) => {
    const { mailbox } = getCoreStores();
    const limit = data.limit ?? 50;
    const statuses = data.status as MailboxStatus[] | undefined;
    return mailbox
      .list(data.sessionId, { status: statuses, limit })
      .map(coreMailboxToIpcRow);
  });

  ipcMain.handle('mailbox:listForSession', (_event, data: { sessionId: string }) => {
    const { mailbox } = getCoreStores();
    return mailbox.listForSession(data.sessionId).map(coreMailboxToIpcRow);
  });
}
