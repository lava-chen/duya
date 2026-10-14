/**
 * db-handlers.ts - Database IPC Handlers (thin proxy layer)
 *
 * Database lifecycle, schema, and migration have moved to apps/desktop/src/main/db/.
 * This file now only contains IPC handler registration and delegates
 * lifecycle functions from db/ for backward compatibility.
 */

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool';
import type {
  HostMessageItem,
  HostSessionArchiveResult,
  HostTimelineItem,
  RebaseEvent,
} from '@duya/agent-protocol';
import type { CoreSession } from '@duya/data/session-store';
import { getAutomationScheduler } from '../automation/Scheduler';
import type { CreateAutomationCronInput, UpdateAutomationCronInput } from '../automation/types';
import { getLogger, LogComponent } from '../logging/logger';
import { AgentProfileCreateSchema, AgentProfileUpdateSchema, parseIpcPayload, RecordIdSchema } from './contracts';
import { setBrowserMaxTabs } from '../services/browser/daemon';
import { setBrowserDownloadPathSetting } from '../services/browser/cookie-writer';
import type { HostLocalRolloutImportInput } from '@duya/agent-protocol/session-api';
import type { SidebarSectionCreateInput, SidebarSectionPatch } from '@duya/agent-protocol/sidebar-sections';
import {
  getDesktopHostLocalSessionApi,
  getDesktopHostLocalRolloutApi,
  getDesktopHostLocalSettingsApi,
  getDesktopHostLocalMailboxApi,
  getDesktopHostLocalChannelPersistenceApi,
  getDesktopHostLocalAgentProfileApi,
  getDesktopHostSessionApi,
  getDesktopHostTaskApi,
  getDesktopHostGoalApi,
  getDesktopHostModeStateApi,
  getDesktopHostPermissionRequestApi,
  getDesktopHostToolApprovalApi,
  getDesktopHostLockApi,
  getDesktopHostLocalSidebarSectionsApi,
  getDesktopHostLocalUsageApi,
} from '../cli/desktop-host-api';
import { getChannelManager } from '../messaging/port-manager';
import { invertPatch } from '../db/core/conductors/invert-patch';
import { createConductorUndoRedoHandlers } from './conductor-handlers/conductor-undo-redo-handlers';
import { createConductorCaptureHandlers } from '../conductor/capture-bridge';
import { workbenchService } from '../conductor/workbench-service';
import {
  listCanvases,
  getCanvasByProjectPath,
  createCanvas,
  updateCanvas,
  deleteCanvas,
  listCanvasGroups,
  createCanvasGroup,
  updateCanvasGroup,
  deleteCanvasGroup,
  getCanvasSnapshot,
  // `getNextZIndex` below calls this. It was never imported, so every
  // `element.create_native` / connector creation without an explicit
  // zIndex threw `ReferenceError: getMaxZIndex is not defined`. The same
  // call in `conductor/db-service.ts` imports it from here.
  getMaxZIndex,
} from '../db/queries/conductors';
import { updateDatabasePath, readBootConfig } from '../config/boot-config';
import { emitGatewayConfigChanged, isGatewayConfigKey } from '../gateway/config-events';
import { notifyMcpConfigChanged } from '../services/mcp-write-reload';
import { readUserMcpToml, writeUserMcpToml } from '../services/mcp-config';
import {
  applyGatewaySettingToStore,
  readAllGatewaySettings,
  readGatewaySettingFromStore,
} from '../config/gateway-setting-adapter';
import { getConfigStore } from '../config/store-instance';
import { listConfigAgents, listBots, upsertConfigAgent, deleteConfigAgent, createConfigAgentUnique, updateBotProfileIdentity, slugifyBotIdFromName } from '../config/agents';
import { notifyBotsChanged } from '../config/bot-change-notifier';
import {
  getWeixinAccounts,
  upsertWeixinAccount,
  updateWeixinAccount,
  deleteWeixinAccount,
} from '../services/weixin-account-store';
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
import { maybeDispatchIdleWake } from '../wake/idle-dispatcher';
import { maybeDispatchAgentDm } from '../wake/agent-dm-dispatcher';
import { uploadAsset as conductorUploadAsset, uploadProjectAsset as conductorUploadProjectAsset } from '../conductor/asset-service';
import { captureWebsiteSnapshot } from '../conductor/link-snapshot-service';
import { prepareCanvasDocument, syncCanvasDocument } from '../conductor/document-service';
import { newEventToIpcMessage } from './core-db-adapters';
import { getSessionManager } from '../agents/session-manager';
import { CronFileStore } from '../automation/cron-file';
import { getConnectorCredential, storeConnectorCredential } from '../channels/agent-session-channels';
import { getAppConnectionService } from '../services/app-connections/app-connection-service';

/**
 * Bridge: when a bot collects a QQ Mail credential via SendMessage secret-request
 * (stored under platform "qq-mail"), auto-connect once both the email address and
 * the 16-digit authorization code are available. Values come from the connector
 * secret store — the raw auth code never enters the agent context or transcript.
 */
async function maybeConnectQqMail(agentId: string): Promise<void> {
  const email = getConnectorCredential(agentId, 'qq-mail', 'email');
  const authCode = getConnectorCredential(agentId, 'qq-mail', 'authCode');
  if (!email || !authCode) return;
  try {
    await getAppConnectionService().connectQqMail({ email, authCode });
    getLogger().info('[secret:store] connected qq-mail from collected credentials', { agentId }, LogComponent.AgentProcess);
  } catch (error) {
    getLogger().error(
      '[secret:store] qq-mail connect failed after credential collection',
      error instanceof Error ? error : new Error(String(error)),
      { agentId },
      LogComponent.AgentProcess,
    );
  }
}
import { restoreFilesForEvents } from '../services/file-snapshot-restore';
import {
  broadcastToolApprovalUpdate,
  resolveApprovalCardAsync,
  syncApprovalCardAsync,
  type ToolApprovalDecisionInput,
} from '../db/tool-approval-resolver';
import { enqueueWakeItemForSession } from '../wake/wake-dispatcher';
import type { WakeItem } from '@duya/agent-protocol';
import {
  aggregateUsageFromFacts,
  extractSessionFacts,
  UsageFactsCache,
  type SessionFactsInput,
} from './usage-aggregator';
import {
  ipcSessionToCoreCreate,
  ipcSessionToUpdate,
  coreSessionToIpcRow,
  ipcMessageToNewEvent,
  storedEventToIpcMessage,
  storedEventsToIpcMessages,
  serializeMessageContent,
  serializeDisplayContent,
  ipcTaskToHostCreate,
  ipcTaskToHostUpdate,
  hostTaskToIpcRow,
  coreGoalToIpcRow,
  ipcPermissionToCoreCreate,
  ipcPermissionToResolve,
  corePermissionToIpcRow,
  coreMailboxToIpcRow,
  hostMessageItemsToIpcMessages,
} from './core-db-adapters';
import { BOT_DIRECT_VISIBLE_SOURCES } from '@duya/agent-protocol/message-timeline';
import type { NewEvent, MailboxKind, MailboxStatus } from '../db/core';

/** Per-session usage facts cache behind append-only Host timeline versions. */
const usageFactsCache = new UsageFactsCache();

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
 * Realpath the deepest *existing* ancestor of `targetPath`, then re-append
 * the remaining (not-yet-existing) tail. Unlike a plain realpathSync this
 * works when the leaf does not exist yet (e.g. a DB file about to be
 * created), and it resolves any symlinked directory chain above the leaf
 * so callers can compare against a symlink-free root.
 */
function realPathThroughExistingAncestors(targetPath: string): string {
  let existing = targetPath;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...tail);
  } catch {
    return path.resolve(targetPath);
  }
}

/** True when `candidate` equals `dir` or lives strictly underneath it. */
function isPathInside(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir + path.sep);
}

/**
 * Allocate the next z-index for a newly created element. Later-created
 * elements stack above earlier ones. Connectors start at 10 so relationship
 * lines sit above the default node layer.
 */
function getNextZIndex(canvasId: string, minZ = 1): number {
  return Math.max(getMaxZIndex(canvasId) + 1, minZ);
}

export type ArchiveFailureReason = Extract<HostSessionArchiveResult, { readonly ok: false }>['reason'];
export type ArchiveResult = HostSessionArchiveResult;

type HostSessionListQuery = NonNullable<Parameters<ReturnType<typeof getDesktopHostSessionApi>['list']>[0]>;

async function readHostSessionRow(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const session = await getDesktopHostLocalSessionApi().readLocalSession(sessionId, {
    includeAllSessions: true,
  });
  return session ? coreSessionToIpcRow(session) : undefined;
}

async function updateHostSessionRow(
  sessionId: string,
  patch: Parameters<ReturnType<typeof getDesktopHostSessionApi>['update']>[2],
): Promise<Record<string, unknown> | undefined> {
  const result = await getDesktopHostSessionApi().update(sessionId, undefined, patch);
  return result.updated ? readHostSessionRow(sessionId) : undefined;
}

async function listHostSessionRows(
  query: HostSessionListQuery = {},
): Promise<Array<Record<string, unknown>>> {
  const hostApi = getDesktopHostLocalSessionApi();
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await hostApi.listLocalSessions({
      ...query,
      includeAllSessions: true,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    // This local-only projection rehydrates legacy fields inside Host; the
    // public session API remains path-free for remote clients.
    for (const session of page.sessions) rows.push(coreSessionToIpcRow(session));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

async function listHostMessageItems(
  sessionId: string,
  includeSuperseded: boolean,
  sources?: readonly string[],
): Promise<HostMessageItem[]> {
  const api = getDesktopHostSessionApi();
  const items: HostMessageItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.readMessages(sessionId, {
      includeSuperseded,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
      ...(sources === undefined ? {} : { sources }),
    });
    items.push(...page.messages);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

async function listHostProjectedTimelineItems(sessionId: string): Promise<HostTimelineItem[]> {
  const api = getDesktopHostSessionApi();
  const items: HostTimelineItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.readProjectedTimeline(sessionId, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

function editResendRebase(sessionId: string, keptItems: readonly HostTimelineItem[]): RebaseEvent {
  const createdAt = Date.now();
  const newMessages = keptItems
    .map(({ entry }) => entry)
    .filter((entry) => entry.type === 'message' || entry.type === 'compaction');
  return {
    type: 'rebase',
    id: `rebase:${sessionId}:all:${createdAt}`,
    turnId: null,
    supersededUpToSeq: null,
    reason: 'edit_resend',
    // Rebase payloads historically carry compaction entries as well as messages.
    newMessages: newMessages as unknown as RebaseEvent['newMessages'],
    createdAt,
  };
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
    if (!newDir || typeof newDir !== 'string') {
      return { success: false, error: 'Invalid destination directory' };
    }
    const newDbPath = path.join(newDir, 'duya-main.db');

    // plan 413 (path-safety): the DB holds all chats + stored
    // credentials, so the destination must stay inside the user's real
    // home directory. Reject writes to /etc, /var, system dirs, or any
    // path that resolves outside app.getPath('home'). Symlinked parents
    // cannot redirect the write either — the deepest existing ancestor
    // is realpath'd before the containment check.
    const realHome = realPathThroughExistingAncestors(app.getPath('home'));
    const realDest = realPathThroughExistingAncestors(newDbPath);
    if (!isPathInside(realDest, realHome)) {
      return { success: false, error: 'Relocate destination must be inside the user home directory' };
    }

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

  // ==================== Session handlers / Host compatibility adapter ====================
  // Keep the legacy snake_case IPC row for renderer and Worker callers. CRUD
  // mutations use HostSessionApiV1. Desktop registers local directories through
  // Host before sending their opaque Workspace references; legacy projections
  // are produced by the local-only Host adapter.

  ipcMain.handle('db:session:create', async (_event, data: Record<string, unknown>) => {
    // Host resolves permission inheritance and the user default before the
    // single session write. Trusted override is reserved for internal callers.
    const parentSessionId =
      (data.parent_session_id as string | undefined) ?? (data.parent_id as string | undefined) ?? null;
    const hostApi = getDesktopHostSessionApi();
    const permissionMode = await hostApi.resolveSessionPermissionProfile({
      explicit: data.permission_profile as string | null | undefined,
      parentSessionId,
      trustedOverride: data.is_trusted_permission_override === true,
    });
    const input = ipcSessionToCoreCreate(data, permissionMode);
    const requestedCwd = typeof data.working_directory === 'string' ? data.working_directory.trim() : '';
    const existing = await hostApi.get(input.id, { includeAllSessions: true });
    // Desktop is the local user-facing boundary: register the selected folder
    // through Host, then persist only its opaque Workspace reference.
    const workspace = requestedCwd
      ? await hostApi.registerLocalDirectory(requestedCwd)
      : null;
    // Preserve the legacy explicit-empty-path upsert by clearing the workspace
    // through Host before the create-as-upsert writes the remaining metadata.
    if (existing && data.working_directory !== undefined && requestedCwd.length === 0) {
      await hostApi.update(input.id, undefined, { workspace: { state: 'legacy_unbound' } });
    }
    const hostCreate: Parameters<typeof hostApi.create>[0] = {
        id: input.id,
        ...(workspace?.state === 'bound'
          ? {
              workspaceId: workspace.workspaceId,
              workspaceRootId: workspace.rootId,
              workspaceRelativePath: workspace.relativePath,
            }
          : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.permissionMode !== undefined
          ? { permissionMode: input.permissionMode as NonNullable<Parameters<typeof hostApi.create>[0]['permissionMode']> }
          : {}),
        ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.parentSessionId
          ? {
              spawn: {
                type: (data.spawn_type as string | undefined) ?? 'subagent',
                ...(typeof data.spawn_reason === 'string' ? { reason: data.spawn_reason } : {}),
                ...(typeof data.spawn_turn_id === 'string' ? { turnId: data.spawn_turn_id } : {}),
              },
            }
          : {}),
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
        ...(input.extensions !== undefined
          ? { extensions: input.extensions as NonNullable<Parameters<typeof hostApi.create>[0]['extensions']> }
          : {}),
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    };
    const created = await hostApi.create(hostCreate);
    const persisted = await readHostSessionRow(created.id);
    if (!persisted) throw new Error(`Host created session but it could not be read back: ${created.id}`);
    return persisted;
  });

  ipcMain.handle('db:session:get', async (_event, sessionId: string) => {
    return readHostSessionRow(sessionId);
  });

  ipcMain.handle('db:session:update', async (_event, sessionId: string, data: Record<string, unknown>) => {
    const patch = ipcSessionToUpdate(data);
    const extKeys = [
      'system_prompt',
      'conductor_mode_enabled',
      'conductor_canvas_id',
      'context_summary',
      'context_summary_updated_at',
      'plan_mode_enabled',
      'goal_mode_enabled',
      'source',
    ] as const;

    // Host resolves local paths into granted Workspace references. Raw paths
    // never become part of the session API write contract.
    const hostApi = getDesktopHostSessionApi();
    const workspace = patch.workingDirectory === undefined
      ? undefined
      : patch.workingDirectory.trim()
        ? await hostApi.registerLocalDirectory(patch.workingDirectory)
        : { state: 'legacy_unbound' as const };
    const extensions = Object.fromEntries(
      extKeys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
    );
    type HostPatch = Parameters<typeof hostApi.update>[2];
    const hostPatch: HostPatch = {
      ...(workspace === undefined ? {} : { workspace }),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.projectName !== undefined ? { projectName: patch.projectName } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.permissionMode !== undefined
        ? { permissionMode: patch.permissionMode as HostPatch['permissionMode'] }
        : {}),
      ...(patch.parentSessionId !== undefined ? { parentSessionId: patch.parentSessionId } : {}),
      ...(patch.agentProfileId !== undefined ? { agentProfileId: patch.agentProfileId } : {}),
      ...(patch.agentType !== undefined ? { agentType: patch.agentType } : {}),
      ...(patch.agentName !== undefined ? { agentName: patch.agentName } : {}),
      ...(data.draft_message !== undefined ? { draft: data.draft_message as string | null } : {}),
      ...(Object.keys(extensions).length > 0
        ? { extensions: extensions as NonNullable<HostPatch['extensions']> }
        : {}),
    };
    const result = await hostApi.update(sessionId, undefined, hostPatch);
    if (!result.updated) return undefined;

    return readHostSessionRow(sessionId);
  });

  // Decision 5: session:delete is now soft delete (status='deleted'), no cascade.
  // Old behavior was hard DELETE with cascade to messages/tasks/etc.
  ipcMain.handle('db:session:delete', async (_event, sessionId: string) => {
    const hostApi = getDesktopHostSessionApi();
    const result = await hostApi.delete(sessionId);
    return result.deleted;
  });

  ipcMain.handle('db:session:list', async () => {
    // Cron sessions are fully ordinary (mode='chat'); no exclusion here.
    return listHostSessionRows();
  });

  ipcMain.handle('db:session:listByWorkingDirectory', async (_event, workingDirectory: string) => {
    const path = workingDirectory || '';
    const rows = await listHostSessionRows();
    return rows.filter((row) => row.working_directory === path);
  });

  ipcMain.handle('db:session:listByParentId', async (_event, parentId: string) => {
    return listHostSessionRows({ parentSessionId: parentId });
  });

  // ─── Plan 506: rollout portability + session fork + session archive ───

  /**
   * Plan 506 (A1): export one session's complete rollout as a single
   * portable JSONL file (bot/non-bot multi-generation sessions are
   * concatenated in generation order). Returns
   * `{ absolutePath, lines, bytes }`.
   */
  ipcMain.handle('db:rollout:export', (_event, sessionId: string, destDir?: string) => {
    return getDesktopHostLocalRolloutApi().exportRollout(sessionId, destDir);
  });

  /**
   * Plan 506 (A3): explicit whole-store reconcile — rebuilds message_index
   * from the rollout files (the source of truth), reporting missing and
   * orphan files. Returns `ReconcileStats`.
   *
   * Keep the IPC name aligned with preload. The Host performs the rebuild from
   * its own rollout root; this IPC handler no longer calls MessageLog directly.
   */
  ipcMain.handle('db:rollout:reconcile', () => {
    return getDesktopHostSessionApi().reconcileRollouts();
  });

  /**
   * Plan 506 (A2): import an external rollout .jsonl.
   * - mode='restore': create a NEW session from the file. The session row
   *   is created first so the import lands on a listable session.
   * - mode='continue': append the file's lines onto `targetSessionId`.
   * Throws `ImportValidationError` (message carries the 1-based line
   * number) on invalid input — all-or-nothing, no partial import.
   *
   * Keep the IPC name aligned with preload; the local Host resolves the path
   * and performs the import. Remote APIs accept uploaded data instead.
   */
  ipcMain.handle('db:rollout:import', (_event, input: {
    sourcePath: string;
    mode: 'restore' | 'continue';
    targetSessionId?: string;
    title?: string;
  }) => {
    if (!input || typeof input.sourcePath !== 'string' || input.sourcePath.length === 0) {
      throw new Error('rollout:import: sourcePath is required');
    }
    let hostInput: HostLocalRolloutImportInput;
    if (input.mode === 'continue') {
      if (!input.targetSessionId) {
        throw new Error('rollout:import: targetSessionId is required for continue mode');
      }
      hostInput = {
        mode: 'continue',
        targetSessionId: input.targetSessionId,
        sourcePath: input.sourcePath,
      };
    } else if (input.mode === 'restore') {
      hostInput = {
        mode: 'restore',
        sourcePath: input.sourcePath,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
      };
    } else {
      throw new Error('rollout:import: mode must be restore or continue');
    }
    return getDesktopHostLocalRolloutApi().importRollout(hostInput);
  });

  /**
   * Plan 506 (B1): fork a NEW session from a historical checkpoint message
   * of a source session. The seed is the source's projected (rebase-applied)
   * message timeline up to and including `throughMessageId`; the new
   * session records `parent_session_id` + a `fork` spawn edge.
   *
   * Keep the IPC name aligned with preload; the Host owns the fork write.
   */
  ipcMain.handle('db:session:forkAt', async (_event, input: {
    sourceSessionId: string;
    throughMessageId: string;
    title?: string;
  }) => {
    const result = await getDesktopHostSessionApi().forkAt(input.sourceSessionId, {
      newSessionId: `fork-${randomUUID()}`,
      throughMessageId: input.throughMessageId,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    if (!result.ok) return result;
    const created = await getDesktopHostLocalSessionApi().readLocalSession(result.sessionId, {
      includeAllSessions: true,
    });
    return {
      ok: true as const,
      sessionId: result.sessionId,
      seedCount: result.seedCount,
      session: created ? coreSessionToIpcRow(created) : null,
    };
  });

  /**
   * Plan 549 (Track A): archive a session — moves its rollout files under
   * `<rolloutRoot>/archived/<YYYY-MM-DD>/<full rel path>` AND flips
   * status='archived'. Status-only fallback when the session has no rollout
   * file at all (created without a chat history).
   *
   * Plan 582 (G1) widened the unit of work from one file to every file the
   * session owns, so a rotated session keeps its history.
   *
   * Plan 582 (G2) widened it again, from one session to its whole spawn
   * subtree, and made the batch a two-phase commit:
   *
   *   PHASE 1 (no disk, no SQL): every session in the subtree must be idle.
   *     Archiving a session with a turn in flight renames the file the agent
   *     process still holds open; its next append recreates the old path and
   *     the turn's output is split across two files with no natural order.
   *     `LockStore` already tracks who is running, so a running session is
   *     refused outright rather than archived underneath the turn.
   *   PHASE 2: move every file, journalling each success.
   *   PHASE 3: update every row; any failure restores the rows already
   *     written and then the file journal.
   *
   * Splitting it this way is what makes "one member of the subtree is busy"
   * a total no-op instead of a half-archived tree — the same batch semantics
   * codex gets from `archive_threads`, where the first session must succeed
   * or the whole call fails.
   *
   * Unarchive deliberately does NOT recurse: restoring a parent while its
   * children stay archived is the reversible half of this, and codex agrees.
   */
  ipcMain.handle('db:session:archive', async (_event, sessionId: string): Promise<ArchiveResult> => {
    return getDesktopHostSessionApi().archive(sessionId);
  });

  ipcMain.handle('db:session:unarchive', async (_event, sessionId: string): Promise<boolean> => {
    return getDesktopHostSessionApi().unarchive(sessionId);
  });
  /** Keep the legacy IPC row shape while Host selects the archived sessions. */
  ipcMain.handle('db:session:listArchived', async () => {
    const rows = await listHostSessionRows({ includeArchived: true });
    return rows.filter((row) => row.status === 'archived');
  });

  ipcMain.handle('db:session:saveDraft', async (_event, sessionId: string, draft: string) => {
    await getDesktopHostSessionApi().update(sessionId, undefined, { draft });
  });

  ipcMain.handle('db:session:getDraft', async (_event, sessionId: string) => {
    const session = await getDesktopHostSessionApi().get(sessionId, { includeAllSessions: true });
    return session?.draft ?? '';
  });

  // Read a mode tracker snapshot (mode_state_snapshots) back for a session so
  // the renderer can restore goal/plan state on cold load via the same core
  // store the agent persistence layer writes to.
  ipcMain.handle('db:session:get_mode_state', async (_event, sessionId: string, mode: string) => {
    return getDesktopHostModeStateApi().getModeState(sessionId, mode);
  });

  // ==================== Message Handlers (core store thin forward) ====================
  // Plan 328 Phase 2: all message IPC handlers forward to MessageLog via
  // core-db-adapters. Decision 3: message:replace → appendBatch (INSERT OR
  // IGNORE idempotency); truncate* → rewriteSession (only append-only
  // exception). Decision 5: message:add changed from INSERT OR REPLACE to
  // INSERT OR IGNORE (same-id re-send no longer overwrites).

  ipcMain.handle('db:message:add', async (_event, data: {
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
    // Decision 5: INSERT OR IGNORE semantics via appendBatch — same-id re-send
    // is a no-op instead of overwriting (append-only discipline).
    const event = ipcMessageToNewEvent(data.session_id, data);
    await getDesktopHostSessionApi().appendTimeline(data.session_id, { entries: [event.payload] });
    // Read back through Host too so this IPC stays inside the Host contract
    // after the append has completed.
    const items = await listHostMessageItems(data.session_id, true);
    return hostMessageItemsToIpcMessages(data.session_id, items).find((row) => row.id === data.id) ?? null;
  });

  // Plan 548: `includeSuperseded` (default `true`) plumbs the chat-UI history
  // view down to `MessageLog.listBySession`. When `true`, the projection
  // keeps every raw message row plus a CompactSummary card at each
  // compaction point. When `false`, the projection falls back to the
  // historical LLM-visible view (folded superseded rows). The default
  // is `true` here so any caller that hasn't been updated still sees
  // the full history — the renderer reads from this handler and there
  // is no caller today that wants the folded view from this endpoint.
  ipcMain.handle(
    'db:message:getBySession',
    async (
      _event,
      sessionId: string,
      options?: { includeSuperseded?: boolean },
    ) => {
      const items = await listHostMessageItems(sessionId, options?.includeSuperseded ?? true);
      return hostMessageItemsToIpcMessages(sessionId, items);
    },
  );

  // Plan 489 P0.3: bot-direct transcript — the Host applies the source
  // allowlist inside MessageLog before rows leave Main; private tool,
  // thinking, scratchpad, and system messages stay bot-private.
  ipcMain.handle('db:message:botDirectGetTranscript', async (_event, sessionId: string) => {
    const items = await listHostMessageItems(
      sessionId,
      true,
      [...BOT_DIRECT_VISIBLE_SOURCES],
    );
    return hostMessageItemsToIpcMessages(sessionId, items);
  });

  ipcMain.handle('db:message:getCount', async (_event, sessionId: string) => {
    return getDesktopHostSessionApi().countTimeline(sessionId);
  });

  ipcMain.handle('db:message:deleteBySession', async (_event, sessionId: string) => {
    return getDesktopHostSessionApi().deleteTimeline(sessionId);
  });

  // Decision 3: message:replace maps to MessageLog.appendBatch (INSERT OR IGNORE
  // idempotency). Generation optimistic lock is deprecated (append-only store).
  // If the session does not exist, auto-create it (matches old behavior).
  ipcMain.handle('db:message:replace', async (_event, sessionId: string, messages: unknown[], _generation: number) => {
    const hostApi = getDesktopHostSessionApi();

    // Auto-create session if missing (old behavior: happens when frontend
    // creates a session without a DB entry first).
    if (!await hostApi.get(sessionId, { includeAllSessions: true })) {
      dbLogger.info('Session not found, auto-creating', { sessionId }, LogComponent.DB);
      await hostApi.create({ id: sessionId, createdAt: Date.now() });
    }

    try {
      // Build NewEvents via the adapter. Deterministic IDs are preserved
      // (no randomUUID fallback) so re-sending the same batch is idempotent.
      const events: NewEvent[] = (messages as Record<string, unknown>[]).map((msg) => {
        const id = (msg.id as string) || randomUUID();
        msg.id = id;
        return ipcMessageToNewEvent(sessionId, msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1]);
      });
      await getDesktopHostSessionApi().appendTimeline(sessionId, {
        entries: events.map((event) => event.payload),
      });
      return { success: true, newGeneration: 0, messageCount: events.length };
    } catch (error) {
      dbLogger.error('replaceMessages failed', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.DB);
      return { success: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  // Decision 3: truncate* maps to rewriteSession (the only append-only
  // exception). The adapter computes the kept events via project() and
  // rewrites the whole rollout file + index.
  //
  // Plan 429 #3 rewind linkage: before the timeline shrinks, pre-image
  // snapshots referenced by the removed tool calls are written back to disk
  // so files roll back with the conversation. Best-effort — a failed restore
  // never blocks the rewind itself. The timeline projection and rebase write
  // both go through Host; Main retains only the local file restore side effect.
  ipcMain.handle('db:message:truncateAfter', async (_event, sessionId: string, messageId: string) => {
    const events = await listHostProjectedTimelineItems(sessionId);
    const cutIdx = events.findIndex((e) => e.id === messageId);
    if (cutIdx < 0) return { deletedCount: 0, restoredFiles: [] as string[] };
    // Keep [0, cutIdx] (inclusive of the target — truncateAfter keeps target).
    const removedEvents = events.slice(cutIdx + 1).map(({ entry }) => ({ payload: JSON.stringify(entry) }));
    const restored = await restoreFilesForEvents(removedEvents);
    const keptEvents = events
      .slice(0, cutIdx + 1)
      .filter(({ entry }) => entry.type === 'message' || entry.type === 'compaction');
    const deletedCount = events.length - keptEvents.length;
    await getDesktopHostSessionApi().appendTimeline(sessionId, {
      entries: [editResendRebase(sessionId, keptEvents)],
    });
    return { deletedCount, restoredFiles: restored.restoredFiles };
  });

  // Edit-and-resend: supersede the target message and everything after it
  // (inclusive), so the edited version can be appended as a fresh message.
  ipcMain.handle('db:message:truncateFromInclusive', async (_event, sessionId: string, messageId: string) => {
    const events = await listHostProjectedTimelineItems(sessionId);
    const cutIdx = events.findIndex((e) => e.id === messageId);
    if (cutIdx < 0) return { deletedCount: 0, restoredFiles: [] as string[] };
    // Keep [0, cutIdx) (exclusive of the target — truncateFromInclusive removes target).
    const removedEvents = events.slice(cutIdx).map(({ entry }) => ({ payload: JSON.stringify(entry) }));
    const restored = await restoreFilesForEvents(removedEvents);
    const keptEvents = events
      .slice(0, cutIdx)
      .filter(({ entry }) => entry.type === 'message' || entry.type === 'compaction');
    const deletedCount = events.length - keptEvents.length;
    await getDesktopHostSessionApi().appendTimeline(sessionId, {
      entries: [editResendRebase(sessionId, keptEvents)],
    });
    return { deletedCount, restoredFiles: restored.restoredFiles };
  });

  // Plan 429 #3: standalone file-restore endpoint ({sessionId, cutMessageId}).
  // Restores pre-images referenced by all events AFTER cutMessageId WITHOUT
  // truncating the timeline — usable for manual recovery when the renderer
  // wants to roll files back independently of message deletion.
  ipcMain.handle('db:files:restore', async (_event, sessionId: string, cutMessageId: string) => {
    const events = await listHostProjectedTimelineItems(sessionId);
    const cutIdx = events.findIndex((e) => e.id === cutMessageId);
    if (cutIdx < 0) return { restoredFiles: [] as string[], failedCount: 0 };
    return restoreFilesForEvents(
      events.slice(cutIdx + 1).map(({ entry }) => ({ payload: JSON.stringify(entry) })),
    );
  });

  // ==================== Usage Summary (settings dashboard) ====================
  // Aggregates token usage / cost / activity across ALL sessions through the
  // Host Session API — the renderer's in-memory conversation store only
  // holds transcripts of sessions opened during the current app run, so
  // renderer-side aggregation was wildly incomplete (plan: usage-stats fix).
  //
  // Per-session facts are cached by append-only timeline version: unchanged
  // sessions skip Host message paging + row conversion entirely.
  ipcMain.handle('db:usage:summary', async () => {
    const hostSessionApi = getDesktopHostSessionApi();
    const index = await getDesktopHostLocalUsageApi().getUsageIndex();
    const inputs: SessionFactsInput[] = [];
    const sessionIds = new Set(index.sessions.map((session) => session.id));

    // Keep HTTP history reads bounded so a large session list does not create
    // unbounded Main-process memory or request concurrency.
    for (let offset = 0; offset < index.sessions.length; offset += 4) {
      const batch = await Promise.all(index.sessions.slice(offset, offset + 4).map(async (session) => {
        const stamp = String(session.timelineVersion);
        let facts = usageFactsCache.get(session.id, stamp);
        if (!facts) {
          const items: HostMessageItem[] = [];
          let cursor: string | undefined;
          for (;;) {
            const page = await hostSessionApi.readMessages(session.id, {
              ...(cursor === undefined ? {} : { cursor }),
              limit: 200,
              includeSuperseded: true,
            });
            items.push(...page.messages);
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
          }
          facts = extractSessionFacts(hostMessageItemsToIpcMessages(session.id, items));
          usageFactsCache.set(session.id, stamp, facts);
        }
        return {
          id: session.id,
          title: session.title,
          model: session.model,
          providerId: session.providerId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          facts,
        };
      }));
      inputs.push(...batch);
    }
    usageFactsCache.prune(sessionIds);

    const pricingByProviderModel = new Map(
      index.pricing.map((pricing) => [JSON.stringify([pricing.providerId, pricing.modelId]), pricing]),
    );
    return aggregateUsageFromFacts(inputs, (providerId, model) => {
      if (!model) return undefined;
      return pricingByProviderModel.get(JSON.stringify([providerId, model]));
    }, Date.now(), index.pricingVersion);
  });

  // ==================== Lock Handlers (Host API adapter) ====================
  // The renderer-facing IPC contract stays stable while storage calls cross the Host boundary.

  ipcMain.handle('db:lock:acquire', (_event, sessionId: string, lockId: string, owner: string, ttlSec = 300) => {
    return getDesktopHostLockApi().acquireLock({ sessionId, lockId, owner, ttlSec });
  });

  ipcMain.handle('db:lock:renew', (_event, sessionId: string, lockId: string, ttlSec = 300) => {
    return getDesktopHostLockApi().renewLock({ sessionId, lockId, ttlSec });
  });

  ipcMain.handle('db:lock:release', (_event, sessionId: string, lockId: string) => {
    return getDesktopHostLockApi().releaseLock({ sessionId, lockId });
  });

  ipcMain.handle('db:lock:isLocked', (_event, sessionId: string) => {
    return getDesktopHostLockApi().isSessionLocked(sessionId);
  });

  // ==================== Goal Handlers (core store thin forward) ====================
  // Plan 331 Phase 2: session_goals table — per-session goal + token budget
  // mirror. The agent calls these to persist token/time deltas after each
  // turn and to transition the goal status. On session resume the persisted
  // counters are read back into the in-memory TokenBudgetManager.

  ipcMain.handle('db:goal:get', async (_event, payload: { sessionId: string }) => {
    const goal = await getDesktopHostGoalApi().getGoal(payload.sessionId);
    return goal ? coreGoalToIpcRow(goal) : undefined;
  });

  ipcMain.handle('db:goal:create', async (_event, data: {
    id: string;
    session_id: string;
    goal_text?: string | null;
    token_budget?: number | null;
  }) => {
    const goal = await getDesktopHostGoalApi().getOrCreateGoal({
      id: data.id,
      sessionId: data.session_id,
      goalText: data.goal_text ?? null,
      tokenBudget: data.token_budget ?? null,
    });
    return coreGoalToIpcRow(goal);
  });

  ipcMain.handle('db:goal:updateBudget', async (_event, payload: {
    sessionId: string;
    tokensUsedDelta?: number;
    timeUsedDelta?: number;
  }) => {
    const goal = await getDesktopHostGoalApi().updateBudget(payload.sessionId, {
      tokensUsedDelta: payload.tokensUsedDelta,
      timeUsedDelta: payload.timeUsedDelta,
    });
    return goal ? coreGoalToIpcRow(goal) : undefined;
  });

  ipcMain.handle('db:goal:setStatus', async (_event, payload: {
    sessionId: string;
    status: 'active' | 'paused' | 'usage_limited' | 'complete';
  }) => {
    const goal = await getDesktopHostGoalApi().setStatus(payload.sessionId, payload.status);
    return goal ? coreGoalToIpcRow(goal) : undefined;
  });

  ipcMain.handle('db:goal:listByStatus', async (_event, status: 'active' | 'paused' | 'usage_limited' | 'complete') => {
    return (await getDesktopHostGoalApi().listByStatus(status)).map(coreGoalToIpcRow);
  });

  // ==================== Task Handlers (Host API adapter) ====================
  // Keep the renderer's flat row contract at this boundary; persistence goes
  // through the same Host task service used by CLI and Agent Server.

  ipcMain.handle('db:task:create', async (_event, data: {
    id: string;
    session_id: string;
    subject: string;
    description: string;
    status?: string;
    active_form?: string;
    owner?: string;
  }) => {
    const task = await getDesktopHostTaskApi().createTask(data.session_id, ipcTaskToHostCreate(data));
    return hostTaskToIpcRow(task);
  });

  ipcMain.handle('db:task:get', async (_event, id: string) => {
    const task = await getDesktopHostTaskApi().getTask(id);
    return task ? hostTaskToIpcRow(task) : undefined;
  });

  ipcMain.handle('db:task:getBySession', async (_event, sessionId: string) => {
    const tasks = await getDesktopHostTaskApi().listTasks(sessionId);
    return tasks.map(hostTaskToIpcRow);
  });

  ipcMain.handle('db:task:update', async (_event, id: string, data: Record<string, unknown>) => {
    const task = await getDesktopHostTaskApi().updateTask(id, ipcTaskToHostUpdate(data));
    return task ? hostTaskToIpcRow(task) : undefined;
  });

  ipcMain.handle('db:task:delete', async (_event, id: string) => {
    return getDesktopHostTaskApi().deleteTask(id);
  });

  ipcMain.handle('db:task:deleteBySession', async (_event, sessionId: string) => {
    await getDesktopHostTaskApi().deleteTasksBySession(sessionId);
  });

  ipcMain.handle('db:task:claim', async (_event, id: string, owner: string) => {
    const result = await getDesktopHostTaskApi().claimTask(id, owner);
    if (result.success && result.task) {
      return { success: true, task: hostTaskToIpcRow(result.task) };
    }
    return result;
  });

  ipcMain.handle('db:task:block', async (_event, fromId: string, toId: string) => {
    return getDesktopHostTaskApi().blockTasks(fromId, toId);
  });

  ipcMain.handle('db:task:unassignTeammate', async (_event, sessionId: string, owner: string) => {
    return getDesktopHostTaskApi().unassignTeammateTasks(sessionId, owner);
  });

  ipcMain.handle('db:task:getByOwner', async (_event, sessionId: string, owner: string) => {
    const tasks = await getDesktopHostTaskApi().listTasksByOwner(sessionId, owner);
    return tasks.map(hostTaskToIpcRow);
  });

  // ==================== Automation Handlers ====================

  ipcMain.handle('automation:cron:list', () => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return scheduler.listCrons();
  });

  // Routine lifecycle marker (bot-direct chat chip). User-side routine
  // mutations (automation page) land the same chip in the bot's chat that
  // ManageRoutineTool persists for agent-side mutations. agent=null (a
  // project cron, not bot-bound) writes nothing. Best-effort.
  const appendRoutineMarker = async (
    agent: string | null | undefined,
    action: 'created' | 'updated' | 'deleted' | 'paused' | 'resumed',
    routineId: string,
    name: string,
  ): Promise<void> => {
    if (!agent) return;
    try {
      const sessionId = `bot:${agent}`;
      const message = {
        id: `routine-marker-${randomUUID()}`,
        session_id: sessionId,
        role: 'assistant',
        content: `${action} routine "${name}"`,
        status: 'complete',
        msg_type: 'text',
        source: 'routine_activity',
        metadata: {
          source: 'routine_activity',
          routine: {
            action,
            name,
            ...(routineId ? { routineId } : {}),
          },
        },
        created_at: Date.now(),
      };
      const event = ipcMessageToNewEvent(
        sessionId,
        message as unknown as Parameters<typeof ipcMessageToNewEvent>[1],
        null,
      );
      const receipt = await getDesktopHostSessionApi().appendTimeline(sessionId, {
        entries: [event.payload],
      });
      if (receipt.writtenCount === 0) return;
      const broadcast = newEventToIpcMessage(event);
      if (broadcast) {
        getSessionManager().broadcastSessionEvent('message:new', {
          sessionId,
          messages: [broadcast],
        });
      }
    } catch {
      // Marker persistence is cosmetic — swallow.
    }
  };

  ipcMain.handle('automation:cron:create', async (_event, data: CreateAutomationCronInput) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    const created = scheduler.createCron(data);
    await appendRoutineMarker(created.agent, 'created', created.id, created.name);
    return created;
  });

  ipcMain.handle('automation:cron:update', async (_event, id: string, patch: UpdateAutomationCronInput) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    const before = scheduler.getCron(id);
    const updated = scheduler.updateCron(id, patch);
    // A user-side enable flip surfaces as pause/resume, every other patch as
    // a plain update (mirrors ManageRoutineTool's action set).
    if (before && typeof patch.enabled === 'boolean' && before.enabled !== patch.enabled) {
      await appendRoutineMarker(updated.agent, patch.enabled ? 'resumed' : 'paused', updated.id, updated.name);
    } else {
      await appendRoutineMarker(updated.agent, 'updated', updated.id, updated.name);
    }
    return updated;
  });

  ipcMain.handle('automation:cron:delete', async (_event, id: string) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    // Fetch before delete: the marker needs the job's bot binding + name.
    const existing = scheduler.getCron(id);
    const result = scheduler.deleteCron(id);
    if (existing) {
      await appendRoutineMarker(existing.agent, 'deleted', id, existing.name);
    }
    return result;
  });

  ipcMain.handle('automation:cron:run', async (_event, id: string) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return await scheduler.runCronNow(id);
  });

  // Cron run history = the job's ordinary sessions (id prefix `cron:<jobId>:`).
  ipcMain.handle('automation:cron:sessions', async (_event, input: {
    cronId: string;
    limit?: number;
    offset?: number;
  }) => {
    const scheduler = getAutomationScheduler();
    if (!scheduler) {
      throw new Error('Automation scheduler is not initialized');
    }
    return getDesktopHostLocalSessionApi().listLocalSessionSummariesByPrefix({
      idPrefix: `cron:${input.cronId}:`,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    });
  });

  ipcMain.handle('automation:template:list', () => {
    const { loadTemplates } = require('../automation/template-loader');
    return loadTemplates();
  });

  // ==================== Settings Handlers ====================

  ipcMain.handle('db:setting:get', async (_event, key: string) => {
    if (isGatewayConfigKey(key)) {
      const v = readGatewaySettingFromStore(getConfigStore(), key);
      return v;
    }
    return getDesktopHostLocalSettingsApi().getSetting(key);
  });

  ipcMain.handle('db:setting:set', async (_event, key: string, value: string) => {
    if (isGatewayConfigKey(key)) {
      const store = getConfigStore();
      if (applyGatewaySettingToStore(store, key, value)) {
        emitGatewayConfigChanged(`db:setting:set:${key}`);
        return;
      }
      // not a channel-scoped key after all: fall through to Host settings
    }
    await getDesktopHostLocalSettingsApi().setSetting(key, value);
    if (key === 'browserDownloadPath') setBrowserDownloadPathSetting(value);
    if (isGatewayConfigKey(key)) {
      emitGatewayConfigChanged(`db:setting:set:${key}`);
    }
    if (key === 'browserMaxTabs') {
      setBrowserMaxTabs(Number(value));
    }
  });

  ipcMain.handle('db:setting:getAll', async () => {
    const settings = { ...await getDesktopHostLocalSettingsApi().getSettings() };
    // Channel/gateway config now lives in ConfigStore (plan 335). Overlay the
    // legacy keys the renderer still reads so the SQLite settings table is not a
    // second source of truth for channels.
    Object.assign(settings, readAllGatewaySettings(getConfigStore()));
    return settings;
  });

  ipcMain.handle('db:setting:getJson', async (_event, key: string, defaultValue: unknown) => {
    if (isGatewayConfigKey(key)) {
      const v = readGatewaySettingFromStore(getConfigStore(), key);
      if (v === null) return defaultValue;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    const value = await getDesktopHostLocalSettingsApi().getSetting(key);
    if (value === null) return defaultValue;
    try {
      return JSON.parse(value);
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

  ipcMain.handle('db:setting:setJson', async (_event, key: string, value: unknown) => {
    if (isGatewayConfigKey(key)) {
      const store = getConfigStore();
      if (applyGatewaySettingToStore(store, key, value)) {
        emitGatewayConfigChanged(`db:setting:setJson:${key}`);
        return;
      }
      // not a channel-scoped key after all: fall through to Host settings
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Setting value is not JSON serializable');
    await getDesktopHostLocalSettingsApi().setSetting(key, serialized);
    if (key === 'browserDownloadPath') setBrowserDownloadPathSetting(serialized);
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
    // Live-propagate the browser page cap to the daemon (built-in webview
    // backend + Chrome extension) so the user's settings take effect
    // immediately on running agents.
    if (key === 'browserMaxTabs') {
      setBrowserMaxTabs(typeof value === 'number' ? value : Number(value));
    }
  });

  // ==================== Permission Handlers (Host API adapter) ====================
  // The permission request DTO stays in its legacy snake_case IPC shape.

  ipcMain.handle('db:permission:create', async (_event, data: {
    id: string;
    sessionId?: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => {
    const perm = await getDesktopHostPermissionRequestApi().createPermissionRequest(
      ipcPermissionToCoreCreate(data),
    );
    return corePermissionToIpcRow(perm);
  });

  ipcMain.handle('db:permission:get', async (_event, id: string) => {
    const perm = await getDesktopHostPermissionRequestApi().getPermissionRequest(id);
    return perm ? corePermissionToIpcRow(perm) : undefined;
  });

  ipcMain.handle('db:permission:resolve', async (_event, id: string, status: string, extra?: {
    message?: string;
    updatedPermissions?: unknown[];
    updatedInput?: Record<string, unknown>;
    sessionId?: string;
  }) => {
    const resolved = await getDesktopHostPermissionRequestApi().resolvePermissionRequest(id, {
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

    // Plan 498: keep any durable approval card in sync with the interactive
    // fast path — the worker executes right away via its in-memory promise,
    // so the card must transition and its one-shot ledger entry must burn.
    if (status === 'allow' || status === 'deny') {
      await syncApprovalCardAsync(
        {
          resolve: async (approvalId, decision) => {
            const result = await getDesktopHostToolApprovalApi().resolveToolApproval(approvalId, decision);
            return result ?? undefined;
          },
          markConsumed: async (approvalId) => {
            const row = await getDesktopHostToolApprovalApi().consumeToolApprovalById(approvalId);
            return row ?? undefined;
          },
          enqueueContinuation: () => {
            // Fast path: the worker is executing now — never queue a replay.
          },
          broadcast: broadcastToolApprovalUpdate,
        },
        id,
        status as ToolApprovalDecisionInput,
      );
    }
    return resolved ? corePermissionToIpcRow(resolved) : undefined;
  });

  // ==================== Tool approval cards (plan 498) ====================

  ipcMain.handle('db:toolApproval:listBySession', async (_event, sessionId: string) => {
    return getDesktopHostToolApprovalApi().listToolApprovalsBySession(sessionId);
  });

  ipcMain.handle('db:toolApproval:get', async (_event, id: string) => {
    return (await getDesktopHostToolApprovalApi().getToolApproval(id)) ?? undefined;
  });

  ipcMain.handle('db:toolApproval:resolve', async (_event, id: string, decision: string) => {
    if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
      return { ok: false, reason: 'invalid_decision' };
    }
    return resolveApprovalCardAsync(
      {
        resolve: async (approvalId, d) => {
          const result = await getDesktopHostToolApprovalApi().resolveToolApproval(approvalId, d);
          return result ?? undefined;
        },
        enqueueContinuation: (row, d) => {
          const item: WakeItem = {
            id: `approval:${row.id}`,
            source: 'approval.resume',
            lane: 'agent',
            agentId: row.session_id,
            enqueuedAtMs: Date.now(),
            payload: {
              kind: 'approval',
              approvalId: row.id,
              toolName: row.tool_name,
              decision: d,
              text: '',
            },
          };
          const outcome = enqueueWakeItemForSession(row.session_id, item);
          dbLogger.info('Tool approval continuation enqueued', { approvalId: row.id, sessionId: row.session_id, decision: d, outcome }, LogComponent.DB);
        },
        broadcast: broadcastToolApprovalUpdate,
      },
      id,
      decision,
    );
  });

  // ==================== Search Handlers (core store thin forward) ====================
  // Plan 328 Phase 2 decision 7: combine SessionStore.search (metadata LIKE)
  // with MessageLog.searchText (rollout content scan). Returns the old
  // `s.* + snippet` shape so the renderer has zero changes. LIKE on CJK
  // titles beats unicode61 FTS (326 decision 3); messages_fts/sessions_fts
  // virtual tables are no longer referenced.

  ipcMain.handle('db:search:sessions', async (_event, query: string, limit = 10) => {
    const results = await getDesktopHostSessionApi().searchSessions(query, { limit });
    const rows: Array<Record<string, unknown> | null> = await Promise.all(results.map(async (result) => {
      const session = await getDesktopHostLocalSessionApi().readLocalSession(result.session.id, {
        includeAllSessions: true,
      });
      return session ? { ...coreSessionToIpcRow(session), snippet: result.snippet } : null;
    }));
    return rows.filter((row): row is Record<string, unknown> => row !== null);
  });

  // ==================== Unified Search (rakazo-inspired space search) ====================
  // Cross-entity aggregation over SQLite (sessions) + config.toml (bots, routines) +
  // rollout content (messages/links). Nav-type hits (session/bot) are capped so content
  // hits keep most of the budget. Returns a flat, kind-tagged list the Cmd+K panel renders.

  const SEARCH_NAV_CAP = 8;
  const SEARCH_KIND_ORDER: Record<string, number> = {
    session: 0,
    bot: 1,
    message: 2,
    link: 3,
    routine: 4,
  };

  const hitContains = (query: string, ...fields: Array<string | undefined | null>): boolean => {
    const q = query.toLowerCase();
    return fields.some((f) => !!f && f.toLowerCase().includes(q));
  };

  const SEARCH_URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
  const extractLinks = (text: string): string[] => {
    const matches = text.match(SEARCH_URL_RE) ?? [];
    return [...new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, '')))];
  };

  ipcMain.handle('db:search:query', async (_event, rawQuery: string, limit = 25) => {
    const TOTAL = Math.max(limit, 1);
    const query = String(rawQuery ?? '').trim();
    if (!query) return [] as unknown[];

    const hits: Array<Record<string, unknown>> = [];
    const navCount = (): number => hits.filter((h) => h.kind === 'session' || h.kind === 'bot').length;
    const seenKey = (kind: string, key: string): boolean =>
      hits.some((h) => h.kind === kind && h.key === key);

    // 1. Navigation: sessions (metadata LIKE).
    const sessionResults = await getDesktopHostSessionApi().searchSessions(query, {
      limit: SEARCH_NAV_CAP,
      includeContent: false,
    });
    for (const { session: s } of sessionResults) {
      if (navCount() >= SEARCH_NAV_CAP) break;
      if (seenKey('session', s.id)) continue;
      hits.push({
        key: s.id,
        kind: 'session',
        sessionId: s.id,
        title: s.title || s.agentName || s.id,
        snippet: s.projectName || '',
        updatedAt: s.updatedAt,
      });
    }

    // 2. Navigation: bots (config.toml [agents.<id>]).
    for (const b of listBots()) {
      if (navCount() >= SEARCH_NAV_CAP) break;
      if (seenKey('bot', b.id)) continue;
      if (!hitContains(query, b.name, b.title, b.description)) continue;
      hits.push({
        key: b.id,
        kind: 'bot',
        botId: b.id,
        botName: b.name,
        title: b.name || b.id,
        snippet: b.description || b.title || '',
      });
    }

    // 3. Content: messages + links (rollout content scan).
    const contentBudget = Math.max(0, TOTAL - navCount());
    if (contentBudget > 0) {
      const msgHits = await getDesktopHostSessionApi().searchMessages(query, contentBudget + 5);
      for (const m of msgHits) {
        if (hits.length >= TOTAL) break;
        if (seenKey('message', m.messageId)) continue;
        const title = m.session.title || m.session.id;
        hits.push({
          key: m.messageId,
          kind: 'message',
          sessionId: m.session.id,
          title,
          snippet: m.snippet,
          messageId: m.messageId,
          seq: m.sequence,
        });
        // Link hits ride the same matched message text (best-effort: the snippet
        // window, not the full message — fine for v1 navigation).
        for (const url of extractLinks(m.snippet)) {
          if (hits.length >= TOTAL || seenKey('link', url)) continue;
          hits.push({
            key: url,
            kind: 'link',
            sessionId: m.session.id,
            title: url,
            snippet: m.snippet,
            messageId: m.messageId,
            seq: m.sequence,
          });
        }
      }
    }

    // 4. Content: routines (cronjob.toml).
    if (hits.length >= TOTAL) return hits.slice(0, TOTAL);
    try {
      for (const job of new CronFileStore().listCrons()) {
        if (hits.length >= TOTAL) break;
        if (seenKey('routine', job.id)) continue;
        if (!hitContains(query, job.name, job.prompt)) continue;
        hits.push({
          key: job.id,
          kind: 'routine',
          routineId: job.id,
          title: job.name,
          snippet: job.prompt,
        });
      }
    } catch (err) {
      // A malformed cronjob.toml must not break the whole search.
      dbLogger.warn('db:search:query: cron read failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // 5. Stable ordering: nav kinds first, then content; within kind by recency.
    hits.sort((a, b) => {
      const ka = (SEARCH_KIND_ORDER[a.kind as string] ?? 9) - (SEARCH_KIND_ORDER[b.kind as string] ?? 9);
      if (ka !== 0) return ka;
      return ((b.updatedAt as number) ?? 0) - ((a.updatedAt as number) ?? 0);
    });
    return hits.slice(0, TOTAL);
  });

  // ==================== Channel Binding Handlers ====================

  ipcMain.handle('db:channel:getBindings', async (_event, channelType?: string) => {
    return getDesktopHostLocalChannelPersistenceApi().listChannelBindings(channelType);
  });

  ipcMain.handle('db:channel:getBinding', async (_event, channelType: string, chatId: string) => {
    return getDesktopHostLocalChannelPersistenceApi().getChannelBinding(channelType, chatId);
  });

  ipcMain.handle('db:channel:upsertBinding', async (_event, data: {
    id: string;
    channel_type: string;
    chat_id: string;
    duya_session_id: string;
    sdk_session_id?: string;
    working_directory?: string;
    model?: string;
    mode?: string;
  }) => {
    return getDesktopHostLocalChannelPersistenceApi().upsertChannelBinding(data);
  });

  ipcMain.handle('db:channel:getOffset', async (_event, channelType: string, offsetKey: string) => {
    return getDesktopHostLocalChannelPersistenceApi().getChannelOffset(channelType, offsetKey);
  });

  ipcMain.handle('db:channel:setOffset', async (_event, channelType: string, offsetKey: string, offsetValue: string, offsetType = 'long_polling') => {
    await getDesktopHostLocalChannelPersistenceApi().setChannelOffset({
      channelType,
      offsetKey,
      offsetValue,
      offsetType,
    });
  });

  // ==================== Secret Store Handlers (Plan 488 P3.1) ====================
  // Handles secret-request from bot: UI collects the secret and stores it via this IPC.

  ipcMain.handle('secret:store', async (_event, agentId: string, platform: string, field: string, value: string) => {
    try {
      storeConnectorCredential(agentId, platform, field, value);
      getLogger().info('[secret:store] stored credential', {
        agentId,
        platform,
        field,
      }, LogComponent.AgentProcess);
      await maybeConnectQqMail(agentId);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().error('[secret:store] failed', new Error(message), { agentId, platform, field }, LogComponent.AgentProcess);
      return { ok: false, error: message };
    }
  });

  // ==================== Project Group Handlers ====================

  ipcMain.handle('db:project:getGroups', async () => {
    // Plan 328 Phase 5: aggregate from core SessionStore instead of legacy
    // chat_sessions table. Read through Host and group by working_directory.
    const host = getDesktopHostLocalSessionApi();
    const all: CoreSession[] = [];
    let cursor: string | undefined;
    do {
      const page = await host.listLocalSessions({
        includeAllSessions: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.sessions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

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
    return getWeixinAccounts();
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
    const row = upsertWeixinAccount({
      accountId: data.accountId,
      userId: data.userId,
      name: data.name,
      baseUrl: data.baseUrl,
      cdnBaseUrl: data.cdnBaseUrl,
      token: data.token,
      enabled: data.enabled,
    });
    emitGatewayConfigChanged(`db:weixin:upsertAccount:${data.accountId}`);
    return row;
  });

  ipcMain.handle('db:weixin:updateAccount', (_event, accountId: string, data: {
    enabled?: boolean;
    name?: string;
  }) => {
    const row = updateWeixinAccount(accountId, {
      enabled: data.enabled,
      name: data.name,
    });
    if (row) {
      emitGatewayConfigChanged(`db:weixin:updateAccount:${accountId}`);
    }
    return row;
  });

  ipcMain.handle('db:weixin:deleteAccount', async (_event, accountId: string) => {
    await getDesktopHostLocalChannelPersistenceApi().deleteWeixinContextTokens(accountId);
    const deleted = deleteWeixinAccount(accountId);
    if (deleted) {
      emitGatewayConfigChanged(`db:weixin:deleteAccount:${accountId}`);
    }
    return deleted;
  });

  ipcMain.handle('db:weixin:getContextToken', async (_event, accountId: string, peerUserId: string) => {
    return getDesktopHostLocalChannelPersistenceApi().getWeixinContextToken(accountId, peerUserId);
  });

  ipcMain.handle('db:weixin:setContextToken', async (_event, accountId: string, peerUserId: string, contextToken: string) => {
    await getDesktopHostLocalChannelPersistenceApi().setWeixinContextToken({
      accountId,
      peerUserId,
      contextToken,
    });
  });

  // ==================== Agent Profile Handlers ====================

  ipcMain.handle('db:agentProfile:list', async () => {
    return getDesktopHostLocalAgentProfileApi().listAgentProfiles();
  });

  ipcMain.handle('db:agentProfile:get', async (_event, id: string) => {
    return getDesktopHostLocalAgentProfileApi().getAgentProfile(id);
  });

  ipcMain.handle('db:agentProfile:create', async (_event, payload: unknown) => {
    const data = parseIpcPayload(AgentProfileCreateSchema, payload, 'db:agentProfile:create');
    return getDesktopHostLocalAgentProfileApi().createAgentProfile(data);
  });

  // Plan 424: expose config-driven custom agent profiles to the renderer.
  ipcMain.handle('config:agents:list', () => {
    const store = getConfigStore();
    return store.getByPath('agents') ?? {};
  });
  ipcMain.handle('config:agents:listBots', () => {
    return listBots();
  });
  ipcMain.handle('config:agents:create', (_event, id: string, input: unknown) => {
    // Single minting point (grok agent-session.ts parity: ids are never
    // user-authored). An empty id mints one from the display name via
    // slugifyBotIdFromName; createConfigAgentUnique then allocates a
    // collision-free id (config + disk + tombstones) and returns the
    // ACTUAL id.
    const upsertInput = input as Parameters<typeof upsertConfigAgent>[1];
    const desiredId =
      typeof id === 'string' && id.trim()
        ? id.trim()
        : slugifyBotIdFromName(upsertInput?.name ?? '');
    const result = createConfigAgentUnique(desiredId, upsertInput);
    notifyBotsChanged();
    return result;
  });
  ipcMain.handle('config:agents:update', (_event, id: string, input: unknown) => {
    if (!(id in listConfigAgents())) throw new Error(`agent '${id}' not found`);
    const result = upsertConfigAgent(id, input as Parameters<typeof upsertConfigAgent>[1]);
    notifyBotsChanged();
    return result;
  });
  ipcMain.handle('config:agents:delete', (_event, id: string) => {
    const deleted = deleteConfigAgent(id);
    if (deleted) notifyBotsChanged();
    return deleted;
  });
  // Plan 483 P2: sidebar "Edit Bot" — writes the runtime identity
  // (profile.json), never config.toml.
  ipcMain.handle('config:agents:updateBotProfile', (_event, id: string, input: unknown) => {
    const updated = updateBotProfileIdentity(id, input as Parameters<typeof updateBotProfileIdentity>[1]);
    notifyBotsChanged();
    return updated;
  });

  ipcMain.handle('db:agentProfile:update', async (_event, id: string, payload: unknown) => {
    const data = parseIpcPayload(AgentProfileUpdateSchema, payload, 'db:agentProfile:update');
    const profileId = parseIpcPayload(RecordIdSchema, id, 'db:agentProfile:update');
    return getDesktopHostLocalAgentProfileApi().updateAgentProfile(profileId, {
      name: data.name,
      description: data.description,
      allowed_tools: data.allowed_tools,
      disallowed_tools: data.disallowed_tools,
      prompt_system: data.prompt_system,
      prompt_profile: data.prompt_profile,
      default_model: data.default_model,
      profile_kind: data.profile_kind,
      is_enabled: data.is_enabled,
    });
  });

  ipcMain.handle('db:agentProfile:delete', async (_event, id: string) => {
    return getDesktopHostLocalAgentProfileApi().deleteAgentProfile(id);
  });

  // ==================== Session Agent Profile Binding (core store thin forward) ====================

  ipcMain.handle('db:session:setAgentProfile', async (_event, sessionId: string, agentProfileId: string | null) => {
    return updateHostSessionRow(sessionId, { agentProfileId });
  });

  ipcMain.handle(
    'db:session:set_conductor_mode',
    async (_event, payload: { sessionId: string; enabled: boolean; canvasId?: string | null }) => {
      // conductor_mode_enabled / conductor_canvas_id live in extensions.
      return updateHostSessionRow(payload.sessionId, {
        extensions: {
          conductor_mode_enabled: payload.enabled ? 1 : 0,
          conductor_canvas_id: payload.canvasId ?? null,
        },
      });
    },
  );

  // Plan 331 Phase 4: pin/unpin a session via the extensions JSON column.
  // Mirrors the set_conductor_mode pattern — no schema change, just a
  // key-level write. Pinned sessions surface to the top of the sidebar.
  ipcMain.handle(
    'db:session:set_pinned',
    async (_event, payload: { sessionId: string; pinned: boolean }) => {
      return updateHostSessionRow(payload.sessionId, {
        extensions: { pinned: payload.pinned ? 1 : 0 },
      });
    },
  );

  // Plan 413e: persist the plan-task session toggle. Mirrors the
  // set_conductor_mode pattern — plan_mode_enabled lives in extensions.
  ipcMain.handle(
    'db:session:set_plan_mode',
    async (_event, payload: { sessionId: string; enabled: boolean }) => {
      return updateHostSessionRow(payload.sessionId, {
        extensions: { plan_mode_enabled: payload.enabled ? 1 : 0 },
      });
    },
  );

  // Plan 413e: persist the goal mode session toggle. Mirrors the
  // set_conductor_mode pattern — goal_mode_enabled lives in extensions.
  ipcMain.handle(
    'db:session:set_goal_mode',
    async (_event, payload: { sessionId: string; enabled: boolean }) => {
      return updateHostSessionRow(payload.sessionId, {
        extensions: { goal_mode_enabled: payload.enabled ? 1 : 0 },
      });
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

  // Plan 534 Phase 3.7.d: undo/redo are thin delegators over runConductorUndo/Redo.
  const conductorUndoRedoHandlers = createConductorUndoRedoHandlers({
    getDb,
    getChannelManager,
  });

  // Plan 534 Phase 3.7.e: capture handlers (asset upload, link snapshot) live in
  // apps/desktop/src/main/conductor/capture-bridge.ts. They share getDb() access but do not
  // need the channel manager.
  const conductorCaptureHandlers = createConductorCaptureHandlers({ getDb });

  // Canvas identity + snapshot handlers. These MUST stay on the same
  // database as conductor:action / undo / redo (the main database) —
  // conductor_elements carries a FOREIGN KEY to conductor_canvases, so a
  // canvas that only exists in the core database cannot take any element
  // writes (SqliteError: FOREIGN KEY constraint failed on shape creation).
  // Plan 534 will migrate the whole conductor surface to core in one move;
  // until then identity follows the write path.
  ipcMain.handle('conductor:canvas:list', () => {
    return listCanvases();
  });

  ipcMain.handle('conductor:canvas:getByProjectPath', (_event, projectPath: string) => {
    return getCanvasByProjectPath(projectPath);
  });

  ipcMain.handle('conductor:canvas:create', (_event, data: { name: string; description?: string; projectPath?: string | null }) => {
    return createCanvas(data);
  });

  ipcMain.handle('conductor:canvas:update', (_event, id: string, data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number; isFavorite?: boolean; groupId?: string | null; tags?: string[] }) => {
    try {
      return updateCanvas(id, data);
    } catch {
      // queries/conductors.updateCanvas throws when the canvas is gone;
      // the previous core-store contract returned null.
      return null;
    }
  });

  ipcMain.handle('conductor:canvas:delete', (_event, id: string) => {
    return deleteCanvas(id);
  });

  // --- Canvas group (asset library collection) handlers ---

  ipcMain.handle('conductor:canvas:group:list', (_event, projectPath?: string | null) => {
    return listCanvasGroups(projectPath);
  });

  ipcMain.handle('conductor:canvas:group:create', (_event, data: { name: string; projectPath?: string | null }) => {
    return createCanvasGroup(data);
  });

  ipcMain.handle('conductor:canvas:group:update', (_event, id: string, data: { name?: string; sortOrder?: number }) => {
    return updateCanvasGroup(id, data);
  });

  ipcMain.handle('conductor:canvas:group:delete', (_event, id: string) => {
    return deleteCanvasGroup(id);
  });

  ipcMain.handle('conductor:snapshot', (_event, canvasId: string) => {
    return getCanvasSnapshot(canvasId);
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
    return conductorUndoRedoHandlers.undo(_event, canvasId);
  });

  ipcMain.handle('conductor:redo', (_event, canvasId: string) => {
    return conductorUndoRedoHandlers.redo(_event, canvasId);
  });

  // Plan 570: widget iframe actions (strategy buttons) routed into the
  // main-process workbench runtime. The service validates element→canvas
  // ownership and rate-limits per element.
  ipcMain.handle(
    'conductor:widget:action',
    async (
      _event,
      request: { canvasId: string; elementId: string; action: { kind: 'refresh'; sourceId?: string } },
    ) => {
      try {
        return await workbenchService.handleWidgetAction({
          canvasId: request?.canvasId,
          elementId: request?.elementId,
          action: request?.action,
        });
      } catch (error) {
        dbLogger.warn(
          'conductor:widget:action failed',
          { error: error instanceof Error ? error.message : String(error) },
          LogComponent.Conductor,
        );
        return { success: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } };
      }
    },
  );

  ipcMain.handle('conductor:asset:upload', conductorCaptureHandlers.upload);

  ipcMain.handle(
    'conductor:link:captureSnapshot',
    conductorCaptureHandlers.captureLinkSnapshot,
  );

  dbLogger.info('Conductor handlers registered', undefined, LogComponent.DB);
}

// ============================================================
// Sidebar Sections IPC Handlers (Plan 471)
// ============================================================
//
// User-defined section metadata for the sidebar. Each section wraps a
// list of projects (`workingDirectory`) at the same level as the
// built-in system sections (cron, gateway, wakeup, …). Sessions
// themselves are NOT moved across sessions — this only changes the
// sidebar render group.

export function registerSidebarSectionsHandlers(): void {
  ipcMain.handle('sidebar-sections:list', () => getDesktopHostLocalSidebarSectionsApi().listSidebarSections());

  ipcMain.handle('sidebar-sections:create', (_event, input: SidebarSectionCreateInput) => {
    return getDesktopHostLocalSidebarSectionsApi().createSidebarSection(input);
  });

  ipcMain.handle(
    'sidebar-sections:update',
    (_event, id: string, patch: SidebarSectionPatch) => {
      return getDesktopHostLocalSidebarSectionsApi().updateSidebarSection(id, patch);
    },
  );

  ipcMain.handle('sidebar-sections:remove', (_event, id: string) => {
    return getDesktopHostLocalSidebarSectionsApi().deleteSidebarSection(id);
  });

  ipcMain.handle(
    'sidebar-sections:assignProject',
    (_event, sectionId: string, workingDirectory: string) => {
      return getDesktopHostLocalSidebarSectionsApi().assignSidebarProject(sectionId, workingDirectory);
    },
  );

  ipcMain.handle('sidebar-sections:unassignProject', (_event, workingDirectory: string) => {
    return getDesktopHostLocalSidebarSectionsApi().unassignSidebarProject(workingDirectory);
  });

  ipcMain.handle('sidebar-sections:reorder', (_event, orderedIds: string[]) => {
    return getDesktopHostLocalSidebarSectionsApi().reorderSidebarSections(orderedIds);
  });

  ipcMain.handle(
    'sidebar-sections:reorderProjects',
    (_event, sectionId: string, orderedDirs: string[]) => {
      return getDesktopHostLocalSidebarSectionsApi().reorderSidebarProjects(sectionId, orderedDirs);
    },
  );

  ipcMain.handle(
    'sidebar-sections:findSectionForProject',
    (_event, workingDirectory: string) => {
      return getDesktopHostLocalSidebarSectionsApi().findSidebarSectionForProject(workingDirectory);
    },
  );

  dbLogger.info('Sidebar sections handlers registered', undefined, LogComponent.DB);
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

// Local invertPatch replaced by the extracted pure function — see
// apps/desktop/src/main/db/core/conductors/invert-patch.ts (plan 534 Phase 3.7.a).
// Kept no local copy here so the action handler, undo handler, and redo
// handler all consume one shared, unit-tested implementation.

// ==================== Mailbox Handlers (core store thin forward) ====================
// Plan 328 Phase 3: all mailbox IPC handlers forward to the Mailbox core store
// via core-db-adapters. DTO shape (snake_case flat row) is preserved so the
// renderer has zero changes. The apply matrix is enforced by Mailbox.assertApplyAllowed
// (single source of truth, Plan 202 §5.2).

export function registerMailboxHandlers(): void {
  ipcMain.handle('mailbox:send', async (_event, data: {
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
    const item = await getDesktopHostLocalMailboxApi().enqueue({
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
    // Plan 476 P0-B/P2.1: give the main process its own idle-wake path for
    // background notifications (CLI/headless no longer depend on the
    // renderer to resume an idle session). Gate is `wake.idleDispatch`;
    // busy sessions park the wake until `lock:release` (P0-A mirror +
    // wake-dispatcher queue); taskId dedupes (P0-D).
    // `row` is the snake_case IPC DTO — the dispatchers read camelCase
    // fields (`sessionId`/`clientMsgId`), so map explicitly instead of
    // casting (a cast silently passed undefined and never dispatched).
    if (row.kind === 'background_notification' && row.session_id) {
      void maybeDispatchIdleWake({
        id: row.id as string,
        sessionId: row.session_id as string,
        kind: row.kind as string,
        content: row.content as string | undefined,
        clientMsgId: row.client_msg_id as string | null | undefined,
      }).catch(() => {});
    }
    // Plan 477 P3.1: a bot→bot DM row wakes the target bot's persistent
    // session through the same queue (agent lane). Best-effort like the
    // idle wake; the mailbox row is durable so a failed dispatch retries
    // via wake-rearm on restart.
    if (row.kind === 'agent_dm' && row.session_id) {
      // maybeDispatchAgentDm is sync (boolean) — Promise.resolve gives the
      // fire-and-forget catch without letting a sync throw escape.
      void Promise.resolve(
        maybeDispatchAgentDm({
          id: row.id as string,
          sessionId: row.session_id as string,
          kind: row.kind as string,
          content: row.content as string | undefined,
          clientMsgId: row.client_msg_id as string | null | undefined,
          source: row.source as string | null | undefined,
        }),
      ).catch(() => {});
    }
    return row;
  });

  ipcMain.handle('mailbox:edit', async (_event, data: { id: string; content?: string; kind?: string }) => {
    const mailbox = getDesktopHostLocalMailboxApi();
    const existing = await mailbox.getItem(data.id);
    if (!existing) return null;
    // A previous renderer may have committed the row before its IPC response
    // failed. Returning the same row makes a retry enqueue it exactly once.
    if (existing.status === 'applied' && existing.appliedSummary === 'queued_for_next_agent_turn') {
      return coreMailboxToIpcRow(existing);
    }
    const previousContent = existing.content;
    const edited = await mailbox.edit(data.id, {
      content: data.content,
      kind: data.kind as MailboxKind | undefined,
    });
    if (!edited) return null;
    const row = coreMailboxToIpcRow(edited);
    emitMailEdited(row, previousContent);
    return row;
  });

  ipcMain.handle('mailbox:guide', async (_event, data: { id: string }) => {
    const mailbox = getDesktopHostLocalMailboxApi();
    const existing = await mailbox.getItem(data.id);
    if (!existing) return null;
    const previousContent = existing.content;
    const guided = await mailbox.guide(data.id);
    if (!guided) return null;
    const row = coreMailboxToIpcRow(guided);
    emitMailEdited(row, previousContent);
    return row;
  });

  ipcMain.handle('mailbox:promoteQueued', async (_event, data: { id: string }) => {
    const item = await getDesktopHostLocalMailboxApi().promoteQueued(data.id);
    if (!item) return null;
    const row = coreMailboxToIpcRow(item);
    emitMailApplied(row);
    return row;
  });

  ipcMain.handle('mailbox:cancel', async (_event, data: { id: string; reason?: string }) => {
    const cancelled = await getDesktopHostLocalMailboxApi().cancel(data.id, data.reason);
    if (!cancelled) return null;
    const row = coreMailboxToIpcRow(cancelled);
    emitMailCancelled(row, data.reason);
    return row;
  });

  ipcMain.handle('mailbox:list', async (_event, data: { sessionId: string; status?: string[]; limit?: number }) => {
    const limit = data.limit ?? 50;
    const statuses = data.status as MailboxStatus[] | undefined;
    const items = await getDesktopHostLocalMailboxApi().listMailboxItems(data.sessionId, { status: statuses, limit });
    return items.map(coreMailboxToIpcRow);
  });

  ipcMain.handle('mailbox:listForSession', async (_event, data: { sessionId: string }) => {
    const items = await getDesktopHostLocalMailboxApi().listMailboxItemsForSession(data.sessionId);
    return items.map(coreMailboxToIpcRow);
  });
}
