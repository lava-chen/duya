/**
 * db-bridge.ts - Database action dispatcher for Agent
 *
 * Handles database requests from the Agent process.
 * Extracted from former ipc/agent-communicator.ts.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { getDatabase } from '../ipc/db-handlers';
import {
  consumeApprovedToolApproval,
  createToolApproval,
  listToolApprovalRules,
  toolApprovalInputHash,
} from '../db/toolApprovalState';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { getConfigStore } from '../config/store-instance';
import { createConfigAgentFromName, patchConfigAgentIdentity } from '../config/agents';
import { readConfigAgents } from '../../packages/agent/src/agent-profile/config-agents.js';
import { toLegacyApiProvider, migrateLegacyApiProvider } from '../../src/lib/providers/legacy';
import { toRuntimeConfig } from '@duya/ai';
import type { ApiProvider } from '../config/provider-types';
import { getAutomationScheduler } from '../automation/Scheduler.js';
import { runPromptInSession, interruptCronSession } from '../automation/agent-run';
import { buildCronProviderConfig } from '../automation/provider-config';
import { getLogger, LogComponent } from '../logging/logger';
import { testProviderConnection } from '../ipc/net-handlers';
import { getPluginManager } from '../plugins/PluginManager';
import { readPluginManifest } from '../plugins/manifest';
import { resolvePermissionProfile } from '../db/permission-resolver';
import type { PermissionProfile } from '../lib/permission-profile';
import { getCoreStores } from '../db/core-connection';
import type { WorkflowRunSnapshot, WorkflowRunStatus, WorkflowTriggerKind } from '../db/core/workflow-store';
import {
  createWidgetPending,
  updateWidgetResponse,
  upsertCursorAgentRun,
  updateCursorAgentRun,
  createSecretPending,
  markSecretProvided,
} from '../db/sendMessageState';
import { notifySessionIdle, advanceUserTurn } from '../wake/wake-dispatcher';

/**
 * Resolve a bot's configured provider (store id) + model from its
 * `[agents.<id>]` entry so the persisted bot session row carries the agent's
 * own LLM config instead of the defaults — the single source the foreground
 * chat path derives its providerConfig from.
 */
async function botAgentConfigFor(agentId: string): Promise<{ providerId?: string; model?: string }> {
  try {
    const agents = await readConfigAgents();
    const cfg = agents[agentId];
    if (!cfg) return {};
    return { providerId: cfg.provider, model: cfg.model };
  } catch {
    return {};
  }
}
import { maybeDispatchAgentDm } from '../wake/agent-dm-dispatcher';
import { maybeDispatchIdleWake } from '../wake/idle-dispatcher';
import { maybeScheduleGroupTurnFromAppend } from '../wake/group-turn-dispatcher';
import { getSessionManager } from './session-manager.js';
import { getChannelBackgroundWakes } from '../wake/channels';
import { parseAgentIdFromBotSession } from '../wake/bot-session-id';
import { type MailboxKind, type MailboxApplyMode, type MailboxStatus, type CheckpointType } from '../db/core';
import type { NewEvent, AttachmentWithData } from '../db/core';
import {
  ipcSessionToCoreCreate,
  ipcSessionToUpdate,
  coreSessionToIpcRow,
  ipcMessageToNewEvent,
  newEventToIpcMessage,
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
  coreGoalToIpcRow,
} from '../ipc/core-db-adapters';

const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    getLogger().debug(message, undefined, LogComponent.AgentCommunicator);
  }
}

/**
 * Plan 536 L4: resolve a session's working directory to the project that
 * owns it, plus the canonical list of paths registered against that
 * project. Returns `null` when no project matches (cwd outside any
 * registered project, memory-state DB unavailable, or cwd unparseable).
 *
 * Used by both `projects:resolveAdditionalRoots` (writable-roots fan-out
 * for session cwd) and `projects:resolveProject` (lightweight
 * cwd → projectId reverse-lookup for runtime injection).
 */
async function resolveProjectByCwd(
  cwd: string
): Promise<{ projectId: string; paths: string[]; cwdNormalized: string } | null> {
  let memoryState: typeof import('../memory-state');
  try {
    memoryState = await import('../memory-state');
  } catch {
    return null;
  }
  let rows = memoryState.listProjects();
  if (rows.length === 0) {
    try {
      const { getDatabasePath } = await import('../config/boot-config');
      memoryState.bootstrap({ bootJsonDatabaseDir: path.dirname(getDatabasePath()) });
      rows = memoryState.listProjects();
    } catch {
      // no database dir available — treat as no project
      return null;
    }
  }
  const cwdNorm = memoryState.normalizePath(cwd).absolute_normalized_path;
  const hit = rows.find((row) =>
    memoryState.projectPaths(row).some((entry) => entry.path === cwdNorm)
  );
  if (!hit) return null;
  const paths = memoryState.projectPaths(hit).map((entry) => entry.path);
  return { projectId: hit.project_id, paths, cwdNormalized: cwdNorm };
}

/**
 * Map a file-backed parsed_document attachment to the legacy `message_attachments`
 * row shape so the Agent / renderer contract stays unchanged. The payload `data`
 * string is the JSON body written by `attachment:store` (plan 332 Phase 2).
 */
function parsedDocToRow(att: AttachmentWithData): Record<string, unknown> {
  let parsed: { filename?: string; filePath?: string; charCount?: number; extractMethod?: string | null; text?: string; imageChunks?: unknown[] } = {};
  try {
    parsed = JSON.parse(att.data) as typeof parsed;
  } catch {
    // unparseable payload — return empty fields
  }
  return {
    id: att.id,
    message_id: att.messageId,
    session_id: att.sessionId,
    filename: parsed.filename || '',
    filePath: parsed.filePath || att.originalUrl || '',
    charCount: parsed.charCount || 0,
    extractMethod: parsed.extractMethod || null,
    text: parsed.text || '',
    imageChunks: parsed.imageChunks ? JSON.stringify(parsed.imageChunks) : null,
    created_at: att.createdAt,
  };
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
 * Notify a parent session that a spawned child session finished (Plan 504).
 * Writes a `background_notification` mailbox row into the parent — the same
 * "background work completed, wake me" contract the cron/background-task path
 * uses — then pokes the idle wake dispatcher exactly like `mailbox:send` does.
 * The parent is woken now if idle; if busy, the existing lock-release → idle
 * re-kick and slot-checkpoint mailbox claim deliver it on the next available
 * turn. Best-effort: a wake failure must not surface to the spawn path.
 */
function notifySpawnCompletion(
  parentSessionId: string,
  childSessionId: string,
  status: 'completed' | 'failed',
  summary: string,
): void {
  try {
    const { mailbox } = getCoreStores();
    const item = mailbox.enqueue({
      id: randomUUID(),
      sessionId: parentSessionId,
      submittedRunId: '',
      content: `[session:${status}] spawned session ${childSessionId} finished:\n${summary}`,
      kind: 'background_notification',
      clientMsgId: null,
      source: 'session-tool',
    });
    const row = coreMailboxToIpcRow(item);
    void maybeDispatchIdleWake({
      id: row.id as string,
      sessionId: row.session_id as string,
      kind: row.kind as string,
      content: row.content as string | undefined,
      clientMsgId: row.client_msg_id as string | null | undefined,
    }).catch(() => {});
  } catch (err) {
    getLogger().error(
      'notifySpawnCompletion failed',
      err instanceof Error ? err : new Error(String(err)),
      { parentSessionId, childSessionId },
      LogComponent.AgentCommunicator,
    );
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
  const { research } = getCoreStores();

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
        const providerLlm = getProviderStore().getLlmProvider(p.provider_id as string);
        const provider = providerLlm ? toLegacyApiProvider(providerLlm) : undefined;
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

    case 'session:ensureBot': {
      // Plan 477 P3.1 / 491 P1.2 — lazily materialize a bot's persistent
      // session (`bot:<agentId>`) on first user chat. Mirrors the exact
      // get-or-create shape of agent-dm-dispatcher's defaultBotSessionCreator
      // so wake-created and chat-created rows converge on the same canonical
      // row (idempotent, no config validation — a misconfigured bot surfaces
      // as a profile-resolution error in the worker, same as wake runs).
      const { sessions } = getCoreStores();
      const sessionId = p.sessionId as string;
      const agentId = parseAgentIdFromBotSession(sessionId);
      if (!agentId) {
        return { ok: false, reason: 'not-a-bot-session' };
      }
      const existing = sessions.get(sessionId);
      if (existing) {
        // Backfill the agent's configured provider/model when an older row was
        // created before per-agent config landed (it stored the defaults).
        const cfg = await botAgentConfigFor(agentId);
        if (cfg.model && !existing.model) {
          sessions.update(sessionId, { model: cfg.model, providerId: cfg.providerId ?? existing.providerId });
          const backfilled = sessions.get(sessionId);
          return { ok: true, created: false, session: coreSessionToIpcRow(backfilled ?? existing) };
        }
        return { ok: true, created: false, session: coreSessionToIpcRow(existing) };
      }
      const cfg = await botAgentConfigFor(agentId);
      const created = sessions.create({
        id: sessionId,
        title: agentId,
        status: 'active',
        mode: 'chat',
        permissionMode: 'auto',
        agentType: 'bot',
        agentName: agentId,
        agentProfileId: agentId,
        model: cfg.model,
        providerId: cfg.providerId,
        extensions: { source: 'bot' },
      });
      // The row was created outside any renderer action (the agent-server
      // fork asked for it), so the normal renderer→main sync path never
      // fires. Broadcast so the session list picks the thread up without a
      // manual refresh — same rationale as createCronSessionRow.
      try {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send('sync:threads-changed');
          }
        }
      } catch {
        // Headless boot / CLI bootstrap has no windows — best-effort.
      }
      return { ok: true, created: true, session: coreSessionToIpcRow(created) };
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
      return sessions.list().map(coreSessionToIpcRow);
    }

    case 'session:listByWorkingDirectory': {
      const { sessions } = getCoreStores();
      return sessions.list({ workingDirectory: (p.workingDirectory as string) || '' }).map(coreSessionToIpcRow);
    }

    case 'session:listByParentId': {
      const { sessions } = getCoreStores();
      return sessions.list({ parentSessionId: p.parentId as string }).map(coreSessionToIpcRow);
    }

    // Plan 504 — session tool minimal loop. The worker calls
    // sessionDb.spawn; MAIN creates a real project-scoped child session row,
    // records parent→child lineage, and fires an ASYNC ordinary agent run via
    // runPromptInSession (the same POST /sessions/:id/chat cron uses). Returns
    // immediately with the child session id; the child's completion/failure
    // wakes the parent through a background_notification mailbox row.
    case 'session:spawn': {
      const workingDirectory = p.workingDirectory as string | undefined;
      const prompt = p.prompt as string | undefined;
      const parentSessionId = p.parentSessionId as string | undefined;
      if (!workingDirectory || !prompt || !parentSessionId) {
        return { ok: false, reason: 'missing_required_fields' };
      }

      // Resolve the active provider + model for the child run.
      const activeLlm = getProviderStore().getDefaultLlmProvider();
      const activeProvider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
      if (!activeLlm || !activeProvider) {
        return { ok: false, reason: 'no_active_provider' };
      }
      const options = (activeProvider.options ?? {}) as Record<string, unknown>;
      const model =
        (p.model as string | undefined) ||
        (options.defaultModel as string) ||
        (options.model as string) ||
        getDefaultModelForProvider(activeProvider.providerType, options);
      const providerConfig = buildCronProviderConfig({ provider: activeProvider, model });

      const childId = `spawn:${Date.now()}:${randomUUID().slice(0, 8)}`;
      const { sessions, spawnEdges } = getCoreStores();
      const permissionMode = resolvePermissionProfile(undefined, parentSessionId, {
        isTrustedOverride: false,
      });
      sessions.create(
        ipcSessionToCoreCreate(
          {
            id: childId,
            title: `[Spawn] ${prompt.split('\n')[0]?.slice(0, 60) || 'task'}`,
            working_directory: workingDirectory,
            status: 'active',
            mode: 'chat',
            model,
            provider_id: activeLlm.id,
            parent_session_id: parentSessionId,
            agent_type: 'spawn',
          },
          permissionMode,
        ),
      );
      spawnEdges.record({
        parentSessionId,
        childSessionId: childId,
        spawnReason: 'session-tool',
        spawnType: 'session',
      });

      // Surface in the sidebar without a manual refresh (same as session:ensureBot).
      try {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send('sync:threads-changed');
          }
        }
      } catch {
        // Headless boot / CLI has no windows — best-effort.
      }

      // Fire the child run asynchronously. Do NOT await — the tool returns the
      // child id immediately and is woken via notifySpawnCompletion later.
      setImmediate(() => {
        runPromptInSession({
          sessionId: childId,
          prompt,
          workingDirectory,
          providerConfig,
        })
          .then((r) => notifySpawnCompletion(parentSessionId, childId, 'completed', r.output))
          .catch((err) =>
            notifySpawnCompletion(
              parentSessionId,
              childId,
              'failed',
              err instanceof Error ? err.message : String(err),
            ),
          );
      });

      return { ok: true, sessionId: childId, parentId: parentSessionId };
    }

    // Plan 504 Phase 2 — continuous session management. All `session:spawn*`
    // actions scope to sessions the caller spawned (child.parentSessionId ===
    // caller), matching grok's launchedIds ownership gate so one session cannot
    // prod another session's children.

    case 'session:spawnList': {
      const parentSessionId = p.parentSessionId as string | undefined;
      if (!parentSessionId) return { ok: false, reason: 'missing_parentSessionId' };
      const { sessions } = getCoreStores();
      const children = sessions.list({ parentSessionId }).map(coreSessionToIpcRow);
      return { ok: true, sessions: children };
    }

    case 'session:spawnGet': {
      const sessionId = p.sessionId as string | undefined;
      const callerSessionId = p.callerSessionId as string | undefined;
      if (!sessionId || !callerSessionId) return { ok: false, reason: 'missing_ids' };
      const { sessions } = getCoreStores();
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parentSessionId !== callerSessionId) {
        return { ok: false, reason: 'not_owned' };
      }
      // Diff statistics come from the latest turn review (duya's own +N/-M
      // capture; aggregate across all saved reviews as a cumulative total).
      let linesAdded = 0;
      let linesRemoved = 0;
      let filesChanged = 0;
      try {
        const reviews = getDatabase().prepare(
          'SELECT additions, removals, files_json FROM chat_turn_reviews WHERE session_id = ?',
        ).all(sessionId) as Array<{ additions: number; removals: number; files_json: string }>;
        const fileSet = new Set<string>();
        for (const r of reviews) {
          linesAdded += Number(r.additions) || 0;
          linesRemoved += Number(r.removals) || 0;
          try {
            for (const f of JSON.parse(r.files_json) as { path?: string }[]) {
              if (f?.path) fileSet.add(f.path);
            }
          } catch {
            // files_json unparseable — ignore for stats
          }
        }
        filesChanged = fileSet.size;
      } catch {
        // chat_turn_reviews absent / unreadable — stats default to zero.
      }
      return {
        ok: true,
        session: {
          id: sessionId,
          title: session.title ?? '',
          status: session.status ?? '',
          workingDirectory: session.workingDirectory ?? '',
          parentId: session.parentSessionId,
          filesChanged,
          linesAdded,
          linesRemoved,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
        },
      };
    }

    case 'session:spawnReply': {
      const sessionId = p.sessionId as string | undefined;
      const callerSessionId = p.callerSessionId as string | undefined;
      const prompt = p.prompt as string | undefined;
      if (!sessionId || !callerSessionId || !prompt) {
        return { ok: false, reason: 'missing_required_fields' };
      }
      const { sessions } = getCoreStores();
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parentSessionId !== callerSessionId) {
        return { ok: false, reason: 'not_owned' };
      }
      const parentSessionId = session.parentSessionId;
      const workingDirectory = session.workingDirectory;
      if (!workingDirectory) return { ok: false, reason: 'no_working_directory' };

      // Reuse the same provider/model the child was created with.
      const activeLlm = getProviderStore().getDefaultLlmProvider();
      const activeProvider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
      if (!activeLlm || !activeProvider) return { ok: false, reason: 'no_active_provider' };
      const options = (activeProvider.options ?? {}) as Record<string, unknown>;
      const model =
        session.model ??
        (options.defaultModel as string) ??
        (options.model as string) ??
        getDefaultModelForProvider(activeProvider.providerType, options);
      const providerConfig = buildCronProviderConfig({ provider: activeProvider, model });

      // A follow-up is another async run on the child; the child's parent is
      // woken again on completion.
      setImmediate(() => {
        runPromptInSession({ sessionId, prompt, workingDirectory, providerConfig })
          .then((r) => notifySpawnCompletion(parentSessionId, sessionId, 'completed', r.output))
          .catch((err) =>
            notifySpawnCompletion(
              parentSessionId,
              sessionId,
              'failed',
              err instanceof Error ? err.message : String(err),
            ),
          );
      });
      return { ok: true, sessionId };
    }

    case 'session:spawnCancel': {
      const sessionId = p.sessionId as string | undefined;
      const callerSessionId = p.callerSessionId as string | undefined;
      if (!sessionId || !callerSessionId) return { ok: false, reason: 'missing_ids' };
      const { sessions } = getCoreStores();
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parentSessionId !== callerSessionId) return { ok: false, reason: 'not_owned' };
      interruptCronSession(sessionId);
      return { ok: true, sessionId };
    }

    case 'session:spawnRename': {
      const sessionId = p.sessionId as string | undefined;
      const callerSessionId = p.callerSessionId as string | undefined;
      const title = p.title as string | undefined;
      if (!sessionId || !callerSessionId || !title?.trim()) {
        return { ok: false, reason: 'missing_required_fields' };
      }
      const { sessions } = getCoreStores();
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parentSessionId !== callerSessionId) return { ok: false, reason: 'not_owned' };
      sessions.update(sessionId, { title: title.trim() });
      return { ok: true, sessionId };
    }

    // ==================== Goal actions (core store thin forward) ====================
    // Plan 331: session_goals — per-session goal + token budget mirror. The
    // Agent persists token/time deltas after each turn via these actions.
    case 'goal:get': {
      const { goals } = getCoreStores();
      const goal = goals.get(p.sessionId as string);
      return goal ? coreGoalToIpcRow(goal) : undefined;
    }

    case 'goal:create': {
      const { goals } = getCoreStores();
      // Idempotent upsert: each session may have at most one goal row
      // (UNIQUE(session_id)), and workers re-initialize a session after a
      // restart with no message history but a persisted goal row. Return
      // the existing row instead of letting the INSERT violate the
      // constraint (which surfaced as noisy ERROR spam in the worker).
      const existing = goals.get(p.sessionId as string);
      if (existing) return coreGoalToIpcRow(existing);
      const goal = goals.create({
        id: p.id as string,
        sessionId: p.session_id as string,
        goalText: (p.goal_text as string | null | undefined) ?? null,
        tokenBudget: (p.token_budget as number | null | undefined) ?? null,
      });
      return coreGoalToIpcRow(goal);
    }

    case 'goal:updateBudget': {
      const { goals } = getCoreStores();
      const goal = goals.updateBudget(p.sessionId as string, {
        tokensUsedDelta: p.tokensUsedDelta as number | undefined,
        timeUsedDelta: p.timeUsedDelta as number | undefined,
      });
      return goal ? coreGoalToIpcRow(goal) : undefined;
    }

    case 'goal:setStatus': {
      const { goals } = getCoreStores();
      const goal = goals.setStatus(p.sessionId as string, p.status as 'active' | 'paused' | 'usage_limited' | 'complete');
      return goal ? coreGoalToIpcRow(goal) : undefined;
    }

    case 'goal:listByStatus': {
      const { goals } = getCoreStores();
      return goals.listByStatus(p.status as 'active' | 'paused' | 'usage_limited' | 'complete').map(coreGoalToIpcRow);
    }

    // ==================== Mode state actions (core store thin forward) ====================
    // Plan 413c: mode_state_snapshots — per (session, mode) ModeTracker snapshot.
    // The Agent persists tracker snapshots after state transitions and restores
    // them on session resume via these actions.
    case 'modeState:get': {
      const { modeState } = getCoreStores();
      return modeState.get(p.sessionId as string, p.mode as string);
    }

    case 'modeState:upsert': {
      const { modeState } = getCoreStores();
      modeState.upsert(
        p.sessionId as string,
        p.mode as string,
        p.status as string,
        p.snapshotJson as string,
        (p.reminderCount as number | undefined) ?? 0,
      );
      return undefined;
    }

    case 'modeState:setStatus': {
      const { modeState } = getCoreStores();
      modeState.setStatus(p.sessionId as string, p.mode as string, p.status as string);
      return undefined;
    }

    case 'modeState:listBySession': {
      const { modeState } = getCoreStores();
      return modeState.listBySession(p.sessionId as string);
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

    // ==================== Tool approval side state (plan 498) ====================
    // Worker-side writes for durable approval cards: row creation, one-shot
    // ledger consume (from canUseTool), and always-allow rule reads.
    case 'toolApproval:create': {
      const db = getDatabase();
      if (!db) return null;
      return createToolApproval(db, {
        id: p.id as string,
        messageId: p.messageId as string,
        sessionId: p.sessionId as string,
        scopeType: (p.scopeType as 'bot' | 'session') ?? 'session',
        scopeId: p.scopeId as string,
        toolName: p.toolName as string,
        toolInput: p.toolInput as Record<string, unknown> | undefined,
      });
    }

    case 'toolApproval:consumeApproved': {
      const db = getDatabase();
      if (!db) return false;
      return consumeApprovedToolApproval(
        db,
        p.sessionId as string,
        p.toolName as string,
        toolApprovalInputHash(p.toolInput as Record<string, unknown> | undefined),
      );
    }

    case 'toolApproval:listRules': {
      const db = getDatabase();
      if (!db) return [];
      return listToolApprovalRules(
        db,
        (p.scopeType as 'bot' | 'session') ?? 'session',
        p.scopeId as string,
      );
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

        // Broadcast to all renderer windows (Plan 483 P2)
        // Each renderer checks if the sessionId matches its active session and refreshes
        // newEventToIpcMessage: these events are in-memory (object payload, no seq
        // yet) — storedEventToIpcMessage expects rollout-file rows and would
        // JSON.parse("[object Object]") into null, silencing the realtime merge.
        const broadcastMessages = events
          .map((e) => newEventToIpcMessage(e))
          .filter((m) => m !== null);
        getSessionManager().broadcastSessionEvent('message:new', {
          sessionId,
          messages: broadcastMessages,
        });

        // Plan 478 P2.2: an authored bot entry (metadata.groupPost) in a room
        // transcript session (`room:<roomId>`) schedules the room's group
        // turn. The post_to_room tool wrote this entry from the worker; the
        // room turn runs from the chained queue (stale epochs no-op).
        maybeScheduleGroupTurnFromAppend(sessionId, messages);

        return { success: true, count: after - before };
      } catch (err) {
        getLogger().error('message:append failed', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.AgentCommunicator);
        return { success: false, count: 0, reason: 'transaction_failed' };
      }
    }

    // Plan 488 P2.1: channel:deliver routes a SendMessage with input.channel
    // through ChannelBackgroundWakes.deliverToChannel (handles failure wake).
    case 'channel:deliver': {
      const sessionId = p.sessionId as string;
      const channelAddress = p.channelAddress as string;
      const outbound = p.outbound as {
        content: string;
        url?: string;
        caption?: string;
      };

      if (!sessionId || !channelAddress || !outbound) {
        return { success: false, reason: 'invalid_channel_deliver_payload' };
      }
      // Validate the address token shape (`platform:chatId`) here so the
      // downstream ChannelBackgroundWakes.deliverToChannel failure path
      // never has to fall back to a defensive null-check on
      // parseChannelAddress. channelDelivery validates the same shape, but
      // surfacing it as an explicit IPC error keeps the failure reason
      // honest instead of bubbling up an `Invalid channel address token`
      // thrown from deep inside the connector stack.
      {
        const probe = channelAddress;
        if (
          typeof probe !== 'string' ||
          probe.indexOf(':') <= 0 ||
          probe.indexOf(':') === probe.length - 1
        ) {
          return {
            success: false,
            reason: 'invalid_channel_address',
            detail: `channelAddress must be "platform:chatId"; got: ${JSON.stringify(channelAddress)}`,
          };
        }
      }

      try {
        const kind: 'text' | 'attachment' = outbound.url ? 'attachment' : 'text';
        // Strip the `bot:` prefix: channelDelivery keys the live-outbound
        // registry and the connector secret store by the bare agent id, so
        // passing the full `bot:<agentId>` session id misses both lookups.
        const agentId = parseAgentIdFromBotSession(sessionId) ?? sessionId;
        await getChannelBackgroundWakes().deliverToChannel(
          agentId,
          sessionId,
          channelAddress,
          {
            kind,
            content: outbound.content,
            url: outbound.url,
            caption: outbound.caption,
          },
        );
        return { success: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        getLogger().error(
          'channel:deliver failed',
          err instanceof Error ? err : new Error(reason),
          { sessionId, channelAddress },
          LogComponent.AgentCommunicator,
        );
        return { success: false, reason };
      }
    }

    // Plan 441: journal:emit accepts a typed RolloutEvent payload (rebase,
    // hook_invoked) and appends it as a NewEvent with the event's own `type`
    // discriminator preserved in the payload. The MessageLog.appendBatch
    // path widens NewEvent.payload to include RolloutEvent — see
    // electron/db/core/rollout-events.ts.
    case 'journal:emit': {
      const { messageLog } = getCoreStores();
      const sessionId = p.sessionId as string;
      const event = p.event as Record<string, unknown>;
      const turnId = p.turnId as string | null | undefined;

      if (!event || typeof event !== 'object') {
        return { success: false, reason: 'invalid_event' };
      }
      const eventId = typeof event.id === 'string' ? event.id : null;
      if (!eventId) {
        return { success: false, reason: 'event_missing_id' };
      }
      try {
        const newEvent: NewEvent = {
          id: eventId,
          sessionId,
          turnId: turnId ?? null,
          payload: event as unknown as NewEvent['payload'],
          createdAt: typeof event.createdAt === 'number' ? (event.createdAt as number) : Date.now(),
        };
        const before = messageLog.getCount(sessionId);
        messageLog.appendBatch([newEvent]);
        const after = messageLog.getCount(sessionId);
        return { success: true, count: after - before };
      } catch (err) {
        getLogger().error('journal:emit failed', err instanceof Error ? err : new Error(String(err)), { sessionId }, LogComponent.AgentCommunicator);
        return { success: false, count: 0, reason: 'transaction_failed' };
      }
    }

    // ==================== SendMessage side-state actions ====================
    // Plan 489 P0.2: persist interaction state for card-shaped SendMessage
    // (widget / cursor-agent / secret-request) into the three side tables in the
    // legacy main DB. `messageId` is the id assigned by messageDb.append. These
    // mirrors helper.ts directly; errors are logged and returned so the Agent
    // sub-process never sees an unhandled rejection (best-effort).
    case 'sendMessageState:createWidgetPending': {
      const msgId = p.messageId as string;
      try {
        createWidgetPending(db, p as never);
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:createWidgetPending failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:updateWidgetResponse': {
      const msgId = p.messageId as string;
      try {
        updateWidgetResponse(db, { messageId: msgId, status: p.status as never, customAnswer: p.customAnswer as string | null | undefined, answeredAt: p.answeredAt as number | null | undefined });
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:updateWidgetResponse failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:upsertCursorAgentRun': {
      const msgId = p.messageId as string;
      try {
        upsertCursorAgentRun(db, p as never);
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:upsertCursorAgentRun failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:updateCursorAgentRun': {
      const msgId = p.messageId as string;
      try {
        updateCursorAgentRun(db, { messageId: msgId, status: p.status as never, updatedAt: p.updatedAt as number });
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:updateCursorAgentRun failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:createSecretPending': {
      const msgId = p.messageId as string;
      try {
        createSecretPending(db, p as never);
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:createSecretPending failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:markSecretProvided': {
      const msgId = p.messageId as string;
      try {
        markSecretProvided(db, { messageId: msgId, status: p.status as 'provided' | 'dismissed', providedAt: p.providedAt as number | null | undefined });
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:markSecretProvided failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
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
      // Plan 500 P1: origin attributes the run (user chat / agent wake /
      // background automation) so the bot run scheduler can classify any
      // in-flight run before deciding to preempt it.
      const origin =
        p.origin === 'user' || p.origin === 'agent' || p.origin === 'background'
          ? p.origin
          : undefined;
      const result = locks.acquire(
        p.sessionId as string,
        p.lockId as string,
        p.owner as string,
        (p.ttlSec as number) || 300,
        origin,
      );
      // Plan 476 P2.5: a user-initiated turn starts here (router marks
      // wake/automation runs with wakeRun/effort:off and omits userTurn).
      // Advance the turn epoch so older parked background wakes are
      // superseded and never interrupt the user's new conversation.
      if (p.userTurn === true) {
        advanceUserTurn(p.sessionId as string);
      }
      return result;
    }

    case 'lock:renew': {
      const { locks } = getCoreStores();
      return locks.renew(p.sessionId as string, p.lockId as string, (p.ttlSec as number) || 300);
    }

    case 'lock:release': {
      const { locks } = getCoreStores();
      const result = locks.release(p.sessionId as string, p.lockId as string);
      // Plan 476 P2.1: a released runtime lock means "this session's run
      // ended" — re-kick the wake dispatcher so background wakes that were
      // parked behind a user turn can drain now. Harmless when the session
      // has nothing queued or is still busy.
      notifySessionIdle(p.sessionId as string);
      return result;
    }

    case 'lock:isLocked': {
      const { locks } = getCoreStores();
      return locks.isLocked(p.sessionId as string);
    }

    // Plan 500 P1: run attribution of the current lock holder (null = idle
    // or unattributed legacy row).
    case 'lock:origin': {
      const { locks } = getCoreStores();
      return locks.lockOrigin(p.sessionId as string);
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
      // Plan 525: sessions of one multi-path project entity merge into a
      // single group whose working_directory is the entity's canonical
      // root (paths[0]); sessions in projects without an entity keep the
      // per-path grouping.
      const { sessions } = getCoreStores();
      const all = sessions.list();
      const normalizeForMatch = (value: string): string =>
        value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

      // Best-effort entity lookup: memory DB may be unbootstrapped.
      let entityByPath: Map<string, { projectId: string; canonicalRoot: string; name: string }>;
      try {
        const memoryState = await import('../memory-state');
        entityByPath = new Map();
        for (const row of memoryState.listProjects()) {
          const entries = memoryState.projectPaths(row);
          for (const entry of entries) {
            entityByPath.set(normalizeForMatch(entry.path), {
              projectId: row.project_id,
              canonicalRoot: entries[0]?.path ?? entry.path,
              name: row.name,
            });
          }
        }
      } catch {
        entityByPath = new Map();
      }

      const groups = new Map<string, { working_directory: string; project_name: string; thread_count: number; last_activity: number }>();
      for (const s of all) {
        if (!s.workingDirectory) continue;
        const entity = entityByPath.get(normalizeForMatch(s.workingDirectory));
        const groupKey = entity ? entity.projectId : s.workingDirectory;
        const groupPath = entity ? entity.canonicalRoot : s.workingDirectory;
        const groupName = entity ? (entity.name || s.projectName) : s.projectName;
        const existing = groups.get(groupKey);
        if (existing) {
          existing.thread_count += 1;
          if (s.updatedAt > existing.last_activity) existing.last_activity = s.updatedAt;
        } else {
          groups.set(groupKey, {
            working_directory: groupPath,
            project_name: groupName,
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
      const patch = p.patch as import('../automation/types').UpdateAutomationCronInput;
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
      const input = p as { cronId: string; limit?: number; offset?: number };
      const { sessions } = getCoreStores();
      const rows = sessions.listByPrefix(`cron:${input.cronId}:`, { limit: input.limit, offset: input.offset });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        model: r.model,
        messageCount: r.message_count,
      }));
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
      return Object.fromEntries(
        getProviderStore().listLlmProviders().map((p) => [p.id, toLegacyApiProvider(p)]),
      );
    }

    case 'config:provider:get': {
      const id = p.id as string;
      if (!id) return null;
      const llm = getProviderStore().getLlmProvider(id);
      return llm ? toLegacyApiProvider(llm) : null;
    }

    case 'config:provider:getActive': {
      const activeLlm = getProviderStore().getDefaultLlmProvider();
      return activeLlm ? toLegacyApiProvider(activeLlm) : null;
    }

    // Resolve the full ProviderRuntimeConfig (capability merge + compat
    // flags) for a provider/model pair on behalf of the agent server, which
    // cannot reach the provider store directly (it runs as a plain Node
    // child process). Mirrors the construction in agent-communicator.ts
    // (`agent:getProviderConfig` / `config:provider:getConfig`). The worker
    // reads `runtimeConfig.modelCapabilities.contextWindow` from this for
    // its compaction budget — without it every init falls back to 200k even
    // for 1M-window models.
    case 'config:provider:resolveRuntime': {
      const store = getProviderStore();
      store.migrateAllLegacyProviders();
      const runtimeProviderId = typeof p.providerId === 'string' ? p.providerId.trim() : '';
      const runtimeModel = typeof p.model === 'string' ? p.model.trim() : '';
      const runtimeLlm = runtimeProviderId
        ? store.getLlmProvider(runtimeProviderId)
        : store.getDefaultLlmProvider();
      if (!runtimeLlm) return null;
      const runtimeLegacy = toLegacyApiProvider(runtimeLlm);
      const runtimeExplicit =
        (runtimeLegacy.options?.defaultModel as string) ||
        (runtimeLegacy.options?.model as string) ||
        (Array.isArray(runtimeLegacy.options?.enabled_models) &&
          (runtimeLegacy.options?.enabled_models as string[])[0]) ||
        '';
      const resolvedModelId =
        runtimeModel || runtimeExplicit || getDefaultModelForProvider(runtimeLegacy.providerType, runtimeLegacy.options);
      if (!resolvedModelId) return null;
      const capability = store.resolveRuntimeCapability(runtimeLlm.id, resolvedModelId);
      const cfg = toRuntimeConfig(runtimeLlm, {
        modelId: resolvedModelId,
        capabilities: capability,
      });
      return {
        providerId: cfg.providerId,
        providerName: cfg.providerName,
        apiFormat: cfg.apiFormat,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        accessToken: cfg.accessToken,
        headers: cfg.headers,
        model: cfg.model,
        modelCapabilities: cfg.modelCapabilities,
        modelCompat: cfg.modelCompat,
        requestOptions: cfg.requestOptions,
      };
    }

    // Plan 525: resolve the multi-path project entity a session's working
    // directory belongs to. Returns every OTHER path of the project — the
    // agent server injects them as additionalDirectories so the permission
    // boundary covers all of the project's folders (codex-style
    // workspace_roots: cwd is the primary, the rest are writable roots).
    //
    // L3 hardening: match the same `normalizePath` algorithm used by
    // `projectService` on the storage side (realpath + posix + win32
    // drive-letter lowercasing). The previous local `normalizeForMatch`
    // (string-lower + slash-strip) diverged from pathUtils: `..`
    // segments, symlinks, and case mismatches all fell through silently,
    // which let an attacker register a project whose `paths[0]` was the
    // lexical form of a sensitive directory and have it survive the
    // cwd match against a `..`-laden additional path.
    case 'projects:resolveAdditionalRoots': {
      const sessionCwd = typeof p.workingDirectory === 'string' ? p.workingDirectory.trim() : '';
      if (!sessionCwd) return { projectId: null, additionalRoots: [] };
      try {
        // listProjects throws when the memory-state DB is not bootstrapped
        // (memory worker disabled) — bootstrap lazily once and retry, so
        // project root injection works regardless of the memory toggle.
        let memoryState: typeof import('../memory-state');
        try {
          memoryState = await import('../memory-state');
        } catch {
          return { projectId: null, additionalRoots: [] };
        }
        let rows = memoryState.listProjects();
        if (rows.length === 0) {
          try {
            const { getDatabasePath } = await import('../config/boot-config');
            memoryState.bootstrap({ bootJsonDatabaseDir: path.dirname(getDatabasePath()) });
            rows = memoryState.listProjects();
          } catch {
            // no database dir available — treat as no project
          }
        }
        // Normalize the cwd through the same algorithm as the stored
        // path entries. `normalizePath` swallows realpath failures
        // (ELOOP / ENOENT / EACCES) and falls back to lexical resolve,
        // so cwd for a fresh chat on a not-yet-created directory still
        // matches a stored entry created from the same lexical form.
        const cwdNorm = memoryState.normalizePath(sessionCwd).absolute_normalized_path;
        const hit = rows.find((row) =>
          memoryState.projectPaths(row).some((entry) => entry.path === cwdNorm)
        );
        if (!hit) return { projectId: null, additionalRoots: [] };
        // L2 hardening: only inject roots that the project actually
        // owns. `projectPaths(row)` is the canonical list stored in
        // `projects.paths` (already normalized by `createProject` /
        // `updateProject` since the L1 fix). Filter against the cwd
        // (already excluded) and dedupe — we never trust any extra
        // root passed in by the IPC caller (the bridge contract is
        // rooted solely in DB state).
        const cwdNormLower = cwdNorm.toLowerCase();
        const seen = new Set<string>([cwdNormLower]);
        const additionalRoots: string[] = [];
        for (const entry of memoryState.projectPaths(hit)) {
          const lower = entry.path.toLowerCase();
          if (seen.has(lower)) continue;
          seen.add(lower);
          additionalRoots.push(entry.path);
        }
        return { projectId: hit.project_id, additionalRoots };
      } catch (error) {
        getLogger().warn(
          'projects:resolveAdditionalRoots failed',
          { error: error instanceof Error ? error.message : String(error) },
          LogComponent.AgentCommunicator
        );
        return { projectId: null, additionalRoots: [] };
      }
    }

    // Plan 525 / 408 follow-up: lightweight cwd -> projectId reverse-lookup that also returns the project's entity home directory (~/.duya/projects/<projectId>/). The agent subprocess consumes projectHome from this response to feed the agentsmd loader as the 'Project entity' source. Best-effort - null on miss.
    case 'projects:resolveProject': {
      const sessionCwd = typeof p.workingDirectory === 'string' ? p.workingDirectory.trim() : '';
      if (!sessionCwd) return { projectId: null, paths: null };
      try {
        const hit = await resolveProjectByCwd(sessionCwd);
        if (!hit) return { projectId: null, paths: null };
        // paths is the canonical list of registered working paths; the agent server derives the writable-roots fan-out from it. projectHome is the per-project duya-internal storage root that owns the project's AGENTS.md and plans/. The agent subprocess uses projectHome independently of paths because the entity home lives outside any user code subtree.
        // Resolve the duya projects base via the same path the storage side uses (Plan 536 L3); the per-project entity home lives at `<base>/<projectId>/` and is the directory the agentsmd loader reads `<home>/AGENTS.md` from. The base honors DUYA_TEST and DUYA_TEST_NAMESPACE so unit tests get isolated roots.
        const memoryStateMod = await import('../memory-state');
        const projectHome = path.join(memoryStateMod.resolveProjectsRoot(), hit.projectId);
        return {
          projectId: hit.projectId,
          paths: hit.paths,
          projectHome,
        };
      } catch (error) {
        getLogger().warn(
          'projects:resolveProject failed',
          { error: error instanceof Error ? error.message : String(error) },
          LogComponent.AgentCommunicator
        );
        return { projectId: null, paths: null };
      }
    }

    case 'config:provider:upsert': {
      getProviderStore().upsertLlmProvider(migrateLegacyApiProvider(p as unknown as ApiProvider));
      return { ok: true };
    }
    case 'config:provider:delete': {
      const ok = getProviderStore().deleteLlmProvider(p.id as string);
      return { ok };
    }

    case 'config:provider:activate': {
      const ok = getProviderStore().setDefaultLlmProvider(p.id as string);
      return { ok };
    }

    case 'config:agent:getSettings': {
      const settings = getConfigStore().getByPath('agent') as Record<string, unknown>;

      // If defaultModel is not set, resolve from active provider so duya_info
      // always reports the model that will actually be used.
      if (!settings.defaultModel || settings.defaultModel === '') {
        const activeLlm = getProviderStore().getDefaultLlmProvider();
        const activeProvider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
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
      const current = getConfigStore().getByPath('agent') as Record<string, unknown>;
      const merged = { ...current, ...p as Record<string, unknown> };
      getConfigStore().set('agent', merged);
      return { ok: true };
    }

    // Plan 492 P4.2: agent-side CreateAgent/UpdateAgent tools (bot self-
    // management, grok sand-agent-management-tools parity). The agent
    // subprocess never writes config.toml itself — the main process owns
    // the config store, so these cases serialize every bot's writes.
    // Audit (D1 default): each mutation logs an INFO line.
    case 'config:agents:create': {
      const input = p as { name?: string; description?: string };
      if (!input.name || !input.name.trim()) {
        throw new Error('agent name is required');
      }
      const created = createConfigAgentFromName(input.name, input.description);
      getLogger().info(
        `Agent created via CreateAgent tool: '${created.id}' (${input.name.trim()})`,
        { agentId: created.id },
        LogComponent.AgentProcess,
      );
      return { id: created.id, name: created.config.name ?? created.id };
    }

    case 'config:agents:update': {
      const input = p as { agentId?: string; name?: string; description?: string };
      if (!input.agentId) {
        throw new Error('agentId is required');
      }
      const updated = patchConfigAgentIdentity(input.agentId, {
        name: input.name,
        description: input.description,
      });
      getLogger().info(
        `Agent updated via UpdateAgent tool: '${input.agentId}'`,
        { agentId: input.agentId },
        LogComponent.AgentProcess,
      );
      return { id: input.agentId, name: updated.name ?? input.agentId };
    }

    case 'config:vision:get': {
      const vision = getConfigStore().getByPath('auxiliary.vision') as Record<string, unknown> | undefined;
      // Vision creds come from the provider, not a per-feature key.
      if (vision) delete vision.apiKey;
      return vision;
    }

    case 'config:vision:set': {
      const current = getConfigStore().getByPath('auxiliary.vision') as Record<string, unknown>;
      const pObj = p as Record<string, unknown>;
      const merged = {
        ...current,
        ...pObj,
        baseUrl: (pObj.baseUrl || pObj.baseURL) ?? current.baseUrl,
      };
      delete merged.baseURL;
      // Vision creds come from the provider, not a per-feature key.
      delete merged.apiKey;
      getConfigStore().set('auxiliary.vision', merged);
      return { ok: true };
    }

    case 'config:compact:get': {
      return getConfigStore().getByPath('auxiliary.compact');
    }

    case 'config:compact:set': {
      const current = getConfigStore().getByPath('auxiliary.compact') as Record<string, unknown>;
      const pObj = p as Record<string, unknown>;
      const merged = {
        ...current,
        ...pObj,
        baseUrl: (pObj.baseUrl || pObj.baseURL) ?? current.baseUrl,
      };
      delete merged.baseURL;
      getConfigStore().set('auxiliary.compact', merged);
      return { ok: true };
    }

    case 'config:outputStyles:get': {
      return getConfigStore().getByPath('auxiliary.output_styles');
    }

    case 'config:outputStyles:set': {
      const styles = getConfigStore().getByPath('auxiliary.output_styles') as Record<string, Record<string, unknown>>;
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
      styles[styleId] = updated;
      getConfigStore().set('auxiliary.output_styles', styles);
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

      if (providerId) {
        const llm = getProviderStore().getLlmProvider(providerId);
        const provider = llm ? toLegacyApiProvider(llm) : undefined;
        if (!provider) {
          throw new Error(`Provider not found: ${providerId}`);
        }
        return await testProviderConnection({
          provider_type: provider.providerType,
          base_url: provider.baseUrl || undefined,
          api_key: provider.apiKey,
        });
      }

      const activeLlm = getProviderStore().getDefaultLlmProvider();
      const activeProvider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
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
    // Plan 332 Phase 2: payloads moved from the legacy `message_attachments.data`
    // TEXT column to file-backed `AttachmentStore` (core DB index + ~/.duya/attachments).
    case 'attachment:store': {
      const messageId = p.messageId as string;
      const sessionId = p.sessionId as string;

      // Guard against null/undefined messageId
      if (!messageId) {
        getLogger().info(`[DB-Bridge] attachment:store skipped - messageId is empty`, undefined, LogComponent.AgentCommunicator);
        return { success: false, error: 'messageId is required' };
      }

      const filename = p.filename as string;
      const filePath = p.filePath as string;
      const charCount = p.charCount as number;
      const text = p.text as string;
      const extractMethod = p.extractMethod as string | undefined;
      const imageChunks = p.imageChunks as Array<{ base64: string; mediaType: string }> | undefined;

      const id = `${messageId}-parsed-doc`;
      getCoreStores().attachments.save({
        id,
        messageId,
        sessionId,
        type: 'parsed_document',
        mimeType: 'application/pdf',
        filename,
        originalUrl: filePath,
        data: JSON.stringify({
          filename,
          filePath,
          charCount,
          text,
          extractMethod: extractMethod || null,
          imageChunks: imageChunks || [],
        }),
      });
      return { success: true };
    }

    case 'attachment:getForSession': {
      const sessionId = p.sessionId as string;
      return getCoreStores()
        .attachments.getForSession(sessionId)
        .filter((a) => a.attachmentType === 'parsed_document')
        .map(parsedDocToRow);
    }

    case 'attachment:getForMessage': {
      const messageId = p.messageId as string;
      return getCoreStores()
        .attachments.getForMessage(messageId)
        .filter((a) => a.attachmentType === 'parsed_document')
        .map(parsedDocToRow);
    }

    // ==================== Research Session actions (Plan 60 - Research Mode) ====================
    case 'researchSession:create': {
      return research.createSession({
        id: p.id as string,
        sessionId: p.session_id as string,
        originalQuery: p.original_query as string,
        clarification: p.clarification as string | null,
        contextJson: p.context_json as string,
        status: p.status as string,
        title: p.title as string | null,
        runStatus: p.run_status as string | null,
      });
    }

    case 'researchSession:get': {
      return research.getSession(p.id as string);
    }

    case 'researchSession:getBySessionId': {
      return research.getSessionBySessionId(p.sessionId as string);
    }

    case 'researchSession:update': {
      const id = p.id as string;
      const patch: Parameters<typeof research.updateSession>[1] = {};
      if (p.clarification !== undefined) patch.clarification = p.clarification as string | null;
      if (p.context_json !== undefined) patch.contextJson = p.context_json as string;
      if (p.status !== undefined) patch.status = p.status as string;
      if (p.current_phase !== undefined) patch.currentPhase = p.current_phase as string;
      if (p.iterations !== undefined) patch.iterations = p.iterations as number;
      if (p.coverage !== undefined) patch.coverage = p.coverage as number;
      if (p.title !== undefined) patch.title = p.title as string | null;
      if (p.run_status !== undefined) patch.runStatus = p.run_status as string | null;
      if (p.plan_version !== undefined) patch.planVersion = p.plan_version as number;
      if (p.active_step_id !== undefined) patch.activeStepId = p.active_step_id as string | null;
      if (p.progress_summary !== undefined) patch.progressSummary = p.progress_summary as string | null;
      if (p.completed_at !== undefined) patch.completedAt = p.completed_at as number | null;
      if (p.error_json !== undefined) patch.errorJson = p.error_json as string | null;
      return research.updateSession(id, patch);
    }

    case 'researchSession:delete': {
      return { success: research.deleteSession(p.id as string) };
    }

    case 'researchSession:list': {
      return research.listSessions(p.limit as number);
    }

    case 'researchSession:listByStatus': {
      return research.listSessionsByStatus(p.status as string);
    }

    case 'researchSession:getActiveRun': {
      return research.getActiveRun(p.sessionId as string);
    }

    case 'researchSession:listActiveRuns': {
      return research.listActiveRuns();
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
      return research.createSteps(runId, steps.map(s => ({
        id: s.id,
        orderNum: s.order_num,
        userFacingLabel: s.user_facing_label,
        internalQuestionIds: s.internal_question_ids,
      })));
    }

    case 'researchPlanStep:getByRunId': {
      return research.getPlanStepsByRunId(p.runId as string);
    }

    case 'researchPlanStep:update': {
      const stepId = p.stepId as string;
      const patch: Parameters<typeof research.updatePlanStep>[1] = {};
      if (p.status !== undefined) patch.status = p.status as string;
      if (p.started_at !== undefined) patch.startedAt = p.started_at as number | null;
      if (p.completed_at !== undefined) patch.completedAt = p.completed_at as number | null;
      return research.updatePlanStep(stepId, patch);
    }

    case 'researchPlanStep:deleteByRunId': {
      research.deletePlanStepsByRunId(p.runId as string);
      return undefined;
    }

    // ==================== Research Activities ====================

    case 'researchActivity:create': {
      return research.createActivity({
        id: p.id as string,
        runId: p.run_id as string,
        sequence: p.sequence as number,
        kind: p.kind as string,
        title: p.title as string,
        detail: p.detail as string | null,
        visibility: p.visibility as string,
      });
    }

    case 'researchActivity:getByRunId': {
      return research.getActivitiesByRunId(p.runId as string, {
        visibility: p.visibility as string | undefined,
        limit: p.limit as number | undefined,
        afterSequence: p.afterSequence as number | undefined,
      });
    }

    case 'researchActivity:getMaxSequence': {
      return { max_seq: research.getMaxActivitySequence(p.runId as string) };
    }

    case 'researchActivity:deleteByRunId': {
      research.deleteActivitiesByRunId(p.runId as string);
      return undefined;
    }

    // ==================== Research Events / Sources / Citations / Reports ====================

    case 'researchEvent:create': {
      return research.createEvent({
        id: p.id as string,
        runId: p.run_id as string,
        sequence: p.sequence as number,
        eventType: p.event_type as string,
        payloadJson: p.payload_json as string,
        visibility: p.visibility as string,
      });
    }

    case 'researchEvent:getByRunId': {
      return research.getEventsByRunId(p.runId as string, {
        limit: p.limit as number | undefined,
        afterSequence: p.afterSequence as number | undefined,
        visibility: p.visibility as string | undefined,
      });
    }

    case 'researchEvent:getMaxSequence': {
      return { max_seq: research.getMaxEventSequence(p.runId as string) };
    }

    case 'researchSource:upsert': {
      return research.upsertSource({
        id: p.id as string,
        runId: p.run_id as string,
        title: p.title as string,
        url: p.url as string | null,
        canonicalUrl: (p.canonical_url ?? p.url) as string | null,
        sourceType: p.source_type as string,
        allowedByPolicy: p.allowed_by_policy !== false,
        reliabilityJson: p.reliability_json as string | null,
        dedupeKey: p.dedupe_key as string | null,
        rejectedReason: p.rejected_reason as string | null,
        metadataJson: p.metadata_json as string | null,
      });
    }

    case 'researchSource:getByRunId': {
      return research.getSourcesByRunId(p.runId as string);
    }

    case 'researchCitation:create': {
      return research.createCitation({
        id: p.id as string,
        runId: p.run_id as string,
        reportId: p.report_id as string | null,
        sourceId: p.source_id as string,
        findingId: p.finding_id as string | null,
        claim: p.claim as string,
        locatorJson: p.locator_json as string | null,
        quotedEvidence: p.quoted_evidence as string | null,
      });
    }

    case 'researchCitation:getByRunId': {
      return research.getCitationsByRunId(p.runId as string, p.reportId as string | undefined);
    }

    case 'researchReport:upsert': {
      return research.upsertReport({
        id: p.id as string,
        runId: p.run_id as string,
        title: p.title as string | null,
        markdown: p.markdown as string,
        outlineJson: p.outline_json as string | null,
        sourceIdsJson: p.source_ids_json as string,
        citationIdsJson: p.citation_ids_json as string,
        activitySummaryJson: p.activity_summary_json as string | null,
        exportMetadataJson: p.export_metadata_json as string | null,
      });
    }

    case 'researchReport:getLatest': {
      return research.getLatestReport(p.runId as string);
    }

    // ==================== Research Memory actions ====================

    case 'researchMemory:project:create': {
      return research.createProject({
        id: p.id as string,
        name: p.name as string,
        description: p.description as string | null,
      });
    }

    case 'researchMemory:project:get': {
      return research.getProject(p.id as string);
    }

    case 'researchMemory:project:list': {
      return research.listProjects();
    }

    case 'researchMemory:project:update': {
      const id = p.id as string;
      const patch: Parameters<typeof research.updateProject>[1] = {};
      if (p.name !== undefined) patch.name = p.name as string;
      if (p.description !== undefined) patch.description = p.description as string | null;
      if (p.status !== undefined) patch.status = p.status as string;
      return research.updateProject(id, patch);
    }

    case 'researchMemory:project:delete': {
      return { success: research.deleteProject(p.id as string) };
    }

    case 'researchMemory:projectState:get': {
      return research.getProjectState(p.projectId as string);
    }

    case 'researchMemory:projectState:upsert': {
      const stateJson = typeof p.state === 'string' ? p.state : JSON.stringify(p.state);
      return research.upsertProjectState(p.projectId as string, stateJson);
    }

    case 'researchMemory:object:create': {
      return research.createMemoryObject({
        id: p.id as string,
        projectId: p.projectId as string,
        type: p.type as string,
        content: p.content as string,
        summary: p.summary as string | null,
        sourceRefs: p.sourceRefs as string[] | undefined,
        relationRefs: p.relationRefs as string[] | undefined,
        validFrom: p.validFrom as number | null,
        validTo: p.validTo as number | null,
        status: p.status as string,
        confidence: p.confidence as number,
        importance: p.importance as number,
        tags: p.tags as string[] | undefined,
        embeddingJson: (p as Record<string, unknown>).embedding_json as string | null,
      });
    }

    case 'researchMemory:object:get': {
      return research.getMemoryObject(p.id as string);
    }

    case 'researchMemory:object:listByProject': {
      return research.listMemoryObjectsByProject(p.projectId as string, {
        type: p.type as string | undefined,
        status: p.status as string | undefined,
        limit: p.limit as number | undefined,
      });
    }

    case 'researchMemory:object:search': {
      return research.searchMemoryObjects(p.query as string, {
        projectId: p.projectId as string | undefined,
        type: p.type as string | undefined,
        status: p.status as string | undefined,
        limit: p.limit as number | undefined,
      });
    }

    case 'researchMemory:object:update': {
      const id = p.id as string;
      const patch: Parameters<typeof research.updateMemoryObject>[1] = {};
      if (p.content !== undefined) patch.content = p.content as string;
      if (p.summary !== undefined) patch.summary = p.summary as string | null;
      if (p.status !== undefined) patch.status = p.status as string;
      if (p.type !== undefined) patch.type = p.type as string;
      if (p.sourceRefs !== undefined) patch.sourceRefs = p.sourceRefs as string[];
      if (p.relationRefs !== undefined) patch.relationRefs = p.relationRefs as string[];
      if (p.validFrom !== undefined) patch.validFrom = p.validFrom as number | null;
      if (p.validTo !== undefined) patch.validTo = p.validTo as number | null;
      if (p.confidence !== undefined) patch.confidence = p.confidence as number;
      if (p.importance !== undefined) patch.importance = p.importance as number;
      if (p.tags !== undefined) patch.tags = p.tags as string[];
      return research.updateMemoryObject(id, patch);
    }

    case 'researchMemory:object:delete': {
      return { success: research.deleteMemoryObject(p.id as string) };
    }

    case 'researchMemory:hypothesis:create': {
      return research.createHypothesis({
        id: p.id as string,
        projectId: p.projectId as string,
        statement: p.statement as string,
        status: p.status as string,
        supportingEvidenceIds: p.supportingEvidenceIds as string[] | undefined,
        contradictingEvidenceIds: p.contradictingEvidenceIds as string[] | undefined,
        relatedSourceIds: p.relatedSourceIds as string[] | undefined,
      });
    }

    case 'researchMemory:hypothesis:get': {
      return research.getHypothesis(p.id as string);
    }

    case 'researchMemory:hypothesis:listByProject': {
      return research.listHypothesesByProject(p.projectId as string);
    }

    case 'researchMemory:hypothesis:update': {
      const id = p.id as string;
      const patch: Parameters<typeof research.updateHypothesis>[1] = {};
      if (p.status !== undefined) patch.status = p.status as string;
      if (p.supersededBy !== undefined) patch.supersededBy = p.supersededBy as string | null;
      if (p.supportingEvidenceIds !== undefined) patch.supportingEvidenceIds = p.supportingEvidenceIds as string[];
      if (p.contradictingEvidenceIds !== undefined) patch.contradictingEvidenceIds = p.contradictingEvidenceIds as string[];
      if (p.relatedSourceIds !== undefined) patch.relatedSourceIds = p.relatedSourceIds as string[];
      return research.updateHypothesis(id, patch);
    }

    case 'researchMemory:hypothesis:delete': {
      return { success: research.deleteHypothesis(p.id as string) };
    }

    case 'researchMemory:candidate:create': {
      return research.createCandidate({
        id: p.id as string,
        projectId: p.projectId as string,
        proposedType: p.proposedType as string,
        content: p.content as string,
        rationale: p.rationale as string,
        sourceRefs: p.sourceRefs as string[] | undefined,
        confidence: p.confidence as number,
        createdBySessionId: p.createdBySessionId as string | null,
      });
    }

    case 'researchMemory:candidate:get': {
      return research.getCandidate(p.id as string);
    }

    case 'researchMemory:candidate:listByProject': {
      return research.listCandidatesByProject(p.projectId as string, p.status as string | undefined);
    }

    case 'researchMemory:candidate:accept': {
      return research.acceptCandidate(p.id as string, (p as Record<string, unknown>).embedding_json as string | null);
    }

    case 'researchMemory:candidate:reject': {
      return research.rejectCandidate(p.id as string);
    }

    case 'researchMemory:candidate:delete': {
      return { success: research.deleteCandidate(p.id as string) };
    }

    case 'researchMemory:object:updateEmbedding': {
      return research.updateEmbedding(p.id as string, (p as Record<string, unknown>).embedding_json as string | null);
    }

    case 'researchMemory:object:listWithEmbeddings': {
      return research.listWithEmbeddings({
        projectId: p.projectId as string | undefined,
        limit: p.limit as number | undefined,
      });
    }

    case 'researchMemory:relation:create': {
      return research.createRelation({
        projectId: p.projectId as string,
        fromMemoryId: p.fromMemoryId as string,
        toMemoryId: p.toMemoryId as string,
        relationType: p.relationType as string,
      });
    }

    case 'researchMemory:relation:listByMemory': {
      return research.listRelationsByMemory(p.memoryId as string);
    }

    case 'researchMemory:relation:listByProject': {
      return research.listRelationsByProject(p.projectId as string);
    }

    case 'researchMemory:relation:delete': {
      return { success: research.deleteRelation(p.id as string) };
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
      // Plan 476 P0-B/P2.1 + Plan 477 P3.1: workers reach the mailbox through
      // this bridge, not the renderer-facing `mailbox:send` handler in
      // db-handlers.ts — so the main-process wake hooks must fire here too,
      // or a background notification / bot→bot DM written by a worker is
      // persisted but never wakes anyone (observed: SendToAgent rows stayed
      // pending with no dispatch, no receiver marker, no wake run).
      // `row` is the snake_case IPC DTO — map the fields the dispatchers read
      // (they take camelCase rows) explicitly instead of casting.
      if (row.kind === 'background_notification' && row.session_id) {
        void maybeDispatchIdleWake({
          id: row.id as string,
          sessionId: row.session_id as string,
          kind: row.kind as string,
          content: row.content as string | undefined,
          clientMsgId: row.client_msg_id as string | null | undefined,
        }).catch(() => {});
      }
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

    // ─── Workflow runs (plan 552 Phase 4) ───
    case 'workflowRun:create': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.createRun({
        id: p.id as string | undefined,
        workflowName: p.workflowName as string,
        workflowVersionId: (p.workflowVersionId as string | undefined) ?? null,
        status: p.status as WorkflowRunStatus | undefined,
        triggerKind: p.triggerKind as WorkflowTriggerKind | null | undefined,
        dedupKey: (p.dedupKey as string | undefined) ?? null,
        params: (p.params as Record<string, unknown> | undefined) ?? {},
        retryOf: (p.retryOf as string | undefined) ?? null,
        // Plan 560: run anchoring always crosses the bridge explicitly. The
        // session-anchored runner sends 'session' — relying on the column
        // default would label it 'library' and corrupt the origin filter.
        ...(p.origin !== undefined
          ? { origin: p.origin as 'library' | 'session' | 'agent' | 'cron' }
          : {}),
        scope: (p.scope as 'project' | 'global' | null | undefined) ?? null,
        projectDir: (p.projectDir as string | null | undefined) ?? null,
        parentSessionId: (p.parentSessionId as string | null | undefined) ?? null,
        agentModel: (p.agentModel as string | null | undefined) ?? null,
      });
    }
    case 'workflowRun:get': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.getRun(p.id as string);
    }
    case 'workflowRun:getByDedupKey': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.getRunByDedupKey(p.dedupKey as string);
    }
    case 'workflowRun:list': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.listRuns({
        status: p.status as WorkflowRunStatus | undefined,
        workflowName: p.workflowName as string | undefined,
        origin: p.origin as 'library' | 'session' | 'agent' | 'cron' | undefined,
        parentSessionId: p.parentSessionId as string | undefined,
        limit: p.limit as number | undefined,
        offset: p.offset as number | undefined,
      });
    }
    case 'workflowRun:updateStatus': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.updateStatus(
        p.id as string,
        p.status as WorkflowRunStatus,
        p.pauseMessage as string | null | undefined,
      );
    }
    case 'workflowRun:finish': {
      // Plan 560 terminal write. Optional keys are only forwarded when the
      // caller actually sent them, so a partial outcome never clobbers an
      // earlier summary / artifact list.
      const { workflowRuns } = getCoreStores();
      return workflowRuns.finishRun(p.id as string, {
        status: p.status as WorkflowRunStatus,
        ...(p.summary !== undefined ? { summary: p.summary as string | null } : {}),
        ...(p.artifacts !== undefined
          ? {
              artifacts: p.artifacts as Array<{
                id: string;
                name: string;
                contentType: string;
                bytes: number;
                relPath: string;
              }>,
            }
          : {}),
        ...(p.spentTokens !== undefined ? { spentTokens: p.spentTokens as number | null } : {}),
      });
    }
    case 'workflowRun:latestEventSeq': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.latestEventSeq(p.runId as string);
    }
    case 'workflowRun:listEvents': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.listEvents(p.runId as string, (p.afterSeq as number | undefined) ?? -1);
    }
    case 'workflowRun:setWaitTill': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.setWaitTill(p.id as string, (p.waitTill as number | null | undefined) ?? null);
    }
    case 'workflowRun:setVersionId': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.setVersionId(p.id as string, p.versionId as string);
    }
    case 'workflowRun:listWaitingPast': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.listWaitingPast(p.now as number);
    }
    case 'workflowRun:reconcileStale': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.reconcileStaleRuns(new Set((p.activeRunIds as string[]) ?? []));
    }
    case 'workflowRun:saveSnapshot': {
      const { workflowRuns } = getCoreStores();
      workflowRuns.saveSnapshot({
        runId: p.runId as string,
        definition: p.definition,
        nodeStack: (p.nodeStack as WorkflowRunSnapshot['nodeStack']) ?? [],
        journal: (p.journal as WorkflowRunSnapshot['journal']) ?? [],
      });
      return true;
    }
    case 'workflowRun:loadSnapshot': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.loadSnapshot(p.runId as string);
    }
    case 'workflowRun:appendJournal': {
      const { workflowRuns } = getCoreStores();
      workflowRuns.appendJournalRecord(p.runId as string, p.record as WorkflowRunSnapshot['journal'][number]);
      return true;
    }
    case 'workflowRun:loadJournal': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.loadJournal(p.runId as string);
    }
    case 'workflowRun:delete': {
      const { workflowRuns } = getCoreStores();
      return workflowRuns.deleteRun(p.id as string);
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
