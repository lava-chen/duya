/**
 * worker-db-bridge.ts — the Host-side dispatcher for worker `db:request` frames.
 *
 * The worker never opens the application databases (plan 12's standing
 * invariant). In the Desktop topology its `db:request` frames are relayed to
 * Electron Main and served by `dispatchDbAction`. When the HOST owns
 * execution, the Host must serve them itself, from the same Host-owned stores
 * and APIs the HTTP surface serves — this module is that dispatcher.
 *
 * Scope discipline: each action implemented here must be the SAME semantic
 * the Desktop bridge serves (same store, same conversion — the message and
 * row converters are literally the same Host-owned functions), minus
 * Desktop-only side effects (renderer broadcasts, wake scheduling). Domains
 * not yet served here fail FAST with a typed error: a silent empty result
 * would masquerade as "no data" and corrupt a run, while a fast failure is
 * discovered in one round trip instead of a 30-second worker timeout.
 */

import { randomUUID } from 'node:crypto';
import { toolApprovalInputHash } from '@duya/data/tool-approval-state';
import { ModelCapabilityStore } from '@duya/data/model-capability-store';
import { createHostLocalModelCapabilityApi } from './local-model-capability-api.js';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { CoreSession } from '@duya/data/session-store';
import type {
  HostGoalApiV1,
  HostLocalImageAttachment,
  HostMessageItem,
  HostLockApiV1,
  HostModeStateApiV1,
  HostSessionApiV1,
  HostTaskApiV1,
  HostToolApprovalApiV1,
  HostToolApprovalInput,
  HostToolApprovalScopeType,
  JsonObject,
} from '@duya/agent-protocol';
import type { RunRepository } from './repository-port.js';
import { createRunControlPlaneActions, type RunControlPlaneLogger } from './run-control-plane.js';
import { createHostToolApprovalApi } from './tool-approval-api.js';
import type { WorkerDbBridge } from './run-execution.js';
import type { createHostSessionService, SessionServiceCaller } from './session-service.js';
import type { HostPluginAppInvocationInternalApi } from './local-plugin-app-invocation-api.js';
import {
  hostMessageItemsToIpcMessages,
  ipcMessageToNewEvent,
} from './ipc-message-adapters.js';
import {
  coreGoalToIpcRow,
  coreSessionToIpcRow,
  hostTaskToIpcRow,
  ipcTaskToHostCreate,
  ipcTaskToHostUpdate,
} from './ipc-row-adapters.js';

export class WorkerDbBridgeError extends Error {
  constructor(
    readonly code: 'unimplemented_domain' | 'invalid_payload',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerDbBridgeError';
  }
}

/** Timeline-facing subset of the Host session API the bridge serves. */
export type WorkerBridgeSessionApi = Pick<
  HostSessionApiV1,
  'get' | 'create' | 'update' | 'countTimeline' | 'readMessages' | 'appendTimeline' | 'deleteTimeline'
>;

/** Local-session subset used to emit legacy row shapes for `session:get`. */
export interface WorkerBridgeLocalSessions {
  readLocalSession(
    sessionId: string,
    options?: { includeAllSessions?: boolean },
  ): Promise<CoreSession | null>;
}

export interface HostWorkerDbBridgeOptions {
  readonly sessionService?: ReturnType<typeof createHostSessionService>;
  /** Durable run ledger — serves `run:*` exactly like the ledger API. */
  readonly runs: RunRepository;
  /** Session store — serves worker session reads. */
  readonly sessions: SessionStore;
  /** Legacy main-DB settings (worker reads via setting:*). */
  readonly settings: MainSettingsStore;
  /** Tool approval state in the legacy main DB. */
  readonly mainDatabase: MainDatabase;
  /** Host timeline APIs — serve the message domain. */
  readonly timeline?: WorkerBridgeSessionApi;
  /** Host local-session reads — legacy row shapes for `session:get`. */
  readonly localSessions?: WorkerBridgeLocalSessions;
  readonly goalApi?: HostGoalApiV1;
  readonly lockApi?: HostLockApiV1;
  readonly modeStateApi?: HostModeStateApiV1;
  readonly taskApi?: HostTaskApiV1;
  readonly pluginAppInvocationApi?: HostPluginAppInvocationInternalApi;
  /**
   * Parsed-document attachments for `session:loadMessages`. Desktop serves
   * this from its attachment store; a standalone Host returns an empty list
   * unless it composes the attachment API.
   */
  readonly parsedDocumentsForSession?: (sessionId: string) => Promise<unknown[]>;
  /** Image payload rows for provider CDN rehydration in worker message history. */
  readonly imageAttachmentsForSession?: (sessionId: string) => Promise<readonly HostLocalImageAttachment[]>;
  readonly logger?: RunControlPlaneLogger;
}

/** Page through the Host timeline read API into one flat item list. */
async function readAllHostMessageItems(
  timeline: NonNullable<HostWorkerDbBridgeOptions['timeline']>,
  sessionId: string,
): Promise<readonly HostMessageItem[]> {
  const items: HostMessageItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await timeline.readMessages(sessionId, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.messages);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

function requireString(payload: Record<string, unknown>, key: string, action: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    throw new WorkerDbBridgeError('invalid_payload', `${action} requires ${key}`);
  }
  return value;
}

/**
 * The Host worker bridge: run ledger, sessions, settings, tool approvals, and
 * the message/session/lock/task/mode/goal domains the worker touches during a
 * conversation. Everything else rejects with
 * `WorkerDbBridgeError('unimplemented_domain')` naming the action, so a run
 * that needs an unmigrated domain fails fast and names it.
 */
export function createHostWorkerDbBridge(options: HostWorkerDbBridgeOptions): WorkerDbBridge {
  const controlPlane = createRunControlPlaneActions({
    runs: options.runs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const toolApprovals = (): HostToolApprovalApiV1 => createHostToolApprovalApi(options.mainDatabase.db);
  const modelCapabilities = createHostLocalModelCapabilityApi(new ModelCapabilityStore(options.mainDatabase.db));
  const timeline = options.timeline;
  const requireTimeline = (): NonNullable<HostWorkerDbBridgeOptions['timeline']> => {
    if (timeline === undefined) {
      throw new WorkerDbBridgeError(
        'unimplemented_domain',
        'message domain requires the Host timeline API (options.timeline)',
      );
    }
    return timeline;
  };
  const requireGoal = (): HostGoalApiV1 => {
    if (options.goalApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'goal domain requires options.goalApi');
    }
    return options.goalApi;
  };
  const requireLock = (): HostLockApiV1 => {
    if (options.lockApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'lock domain requires options.lockApi');
    }
    return options.lockApi;
  };
  const requireModeState = (): HostModeStateApiV1 => {
    if (options.modeStateApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'mode-state domain requires options.modeStateApi');
    }
    return options.modeStateApi;
  };
  const requireTask = (): HostTaskApiV1 => {
    if (options.taskApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'task domain requires options.taskApi');
    }
    return options.taskApi;
  };
  const legacySessionRow = async (sessionId: string): Promise<Record<string, unknown> | undefined> => {
    if (options.localSessions === undefined) return undefined;
    const session = await options.localSessions.readLocalSession(sessionId, {
      includeAllSessions: true,
    });
    return session ? coreSessionToIpcRow(session) : undefined;
  };

  return {
    async dispatch(action: string, payload: Record<string, unknown>, caller?: SessionServiceCaller): Promise<unknown> {
      const handled = await controlPlane.dispatchControlPlaneAction(action, payload);
      if (handled !== undefined) return handled;

      switch (action) {
        case 'plugin-app:binding-current': {
          if (!caller || options.pluginAppInvocationApi === undefined) return false;
          const bindingId = requireString(payload, 'bindingId', action);
          const nonce = requireString(payload, 'nonce', action);
          const toolId = requireString(payload, 'toolId', action);
          if (Object.keys(payload).some((key) => !['bindingId', 'nonce', 'toolId'].includes(key))) {
            throw new WorkerDbBridgeError('invalid_payload', 'plugin-app:binding-current accepts only bindingId, nonce, and toolId.');
          }
          return options.pluginAppInvocationApi.isBindingCurrent(bindingId, nonce, toolId, caller);
        }
        case 'session:spawn':
        case 'session:spawnList':
        case 'session:spawnGet':
        case 'session:spawnReply':
        case 'session:spawnCancel':
        case 'session:spawnRename': {
          if (!options.sessionService) throw new WorkerDbBridgeError('unimplemented_domain', 'Session delegation requires the Host session service.');
          if (!caller) throw new WorkerDbBridgeError('invalid_payload', 'Session delegation requires trusted worker context.');
          return options.sessionService.dispatch(action, payload, caller);
        }
        case 'modelCapability:get':
          return modelCapabilities.getModelCapability(requireString(payload, 'modelName', action));
        case 'modelCapability:set':
          return modelCapabilities.setModelCapability({
            modelName: requireString(payload, 'modelName', action),
            isMultimodal: Boolean(payload.isMultimodal),
            method: typeof payload.method === 'string' ? payload.method : 'unknown',
          });
        case 'modelCapability:delete':
          return modelCapabilities.deleteModelCapability(requireString(payload, 'modelName', action));
        // ==================== Sessions ====================
        case 'session:get': {
          const id = requireString(payload, 'id', 'session:get');
          return legacySessionRow(id);
        }
        case 'session:list': {
          return options.sessions.list();
        }
        case 'session:update': {
          const api = requireTimeline();
          const id = requireString(payload, 'id', 'session:update');
          const extensions: Record<string, unknown> = {};
          if (payload.system_prompt !== undefined) extensions.system_prompt = payload.system_prompt;
          const result = await api.update(id, undefined, {
            ...(payload.title !== undefined ? { title: payload.title as string } : {}),
            ...(payload.status !== undefined ? { status: payload.status as string } : {}),
            ...(payload.model !== undefined ? { model: payload.model as string } : {}),
            ...(payload.provider_id !== undefined ? { providerId: payload.provider_id as string } : {}),
            ...(payload.mode !== undefined ? { mode: payload.mode as string } : {}),
            ...(payload.draft_message !== undefined
              ? { draft: payload.draft_message as string | null }
              : {}),
            ...(Object.keys(extensions).length > 0
              ? { extensions: extensions as unknown as JsonObject }
              : {}),
          });
          if ((result as { updated?: boolean }).updated === true) {
            return legacySessionRow(id);
          }
          return { ok: false, reason: 'not_updated' };
        }
        case 'session:loadMessages': {
          const api = requireTimeline();
          const sessionId = requireString(payload, 'sessionId', 'session:loadMessages');
          const items = await readAllHostMessageItems(api, sessionId);
          const messages = hostMessageItemsToIpcMessages(sessionId, items);
          const parsedDocuments = options.parsedDocumentsForSession
            ? await options.parsedDocumentsForSession(sessionId)
            : [];
          return { messages, parsedDocuments };
        }
        case 'attachment:getImagesForSession': {
          const sessionId = requireString(payload, 'sessionId', 'attachment:getImagesForSession');
          if (options.imageAttachmentsForSession === undefined) {
            throw new WorkerDbBridgeError(
              'unimplemented_domain',
              'image attachment history requires options.imageAttachmentsForSession',
            );
          }
          return options.imageAttachmentsForSession(sessionId);
        }

        // ==================== Messages (Host timeline; same converters as Desktop) ===
        // Decision 5: message:add uses INSERT OR IGNORE semantics via appendTimeline
        // (same-id re-send is a no-op instead of overwriting).
        case 'message:add': {
          const api = requireTimeline();
          const sessionId = requireString(payload, 'session_id', 'message:add');
          const event = ipcMessageToNewEvent(
            sessionId,
            payload as unknown as Parameters<typeof ipcMessageToNewEvent>[1],
          );
          await api.appendTimeline(event.sessionId, { entries: [event.payload] });
          const items = await readAllHostMessageItems(api, event.sessionId);
          const rows = hostMessageItemsToIpcMessages(event.sessionId, items);
          return rows.find((row) => row.id === event.id) ?? null;
        }
        case 'message:getBySession': {
          const api = requireTimeline();
          const sessionId = requireString(payload, 'sessionId', 'message:getBySession');
          const items = await readAllHostMessageItems(api, sessionId);
          return hostMessageItemsToIpcMessages(sessionId, items);
        }
        case 'message:getCount': {
          const api = requireTimeline();
          return api.countTimeline(requireString(payload, 'sessionId', 'message:getCount'));
        }
        case 'message:deleteBySession': {
          const api = requireTimeline();
          return api.deleteTimeline(requireString(payload, 'sessionId', 'message:deleteBySession'));
        }
        // Decision 3: message:append maps to the timeline append (INSERT OR IGNORE
        // idempotency). turnId is forwarded for turn-scoped queries.
        // Desktop-only side effects (renderer broadcast, group-turn scheduling)
        // deliberately do not exist here — a Host process has no renderers.
        case 'message:append': {
          const api = requireTimeline();
          const sessionId = requireString(payload, 'sessionId', 'message:append');
          const messages = payload.messages as Array<Record<string, unknown>> | undefined;
          const turnId = payload.turnId as string | null | undefined;
          // The worker payload is not authority for run identity. Capture the
          // run from the Host caller only when it owns this target session.
          const runId = caller?.sessionId === sessionId ? caller.runId : undefined;
          if (!messages || !Array.isArray(messages)) {
            return { success: false, reason: 'invalid_messages' };
          }
          try {
            const events = messages.map((msg) =>
              ipcMessageToNewEvent(
                sessionId,
                msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1],
                turnId ?? null,
              ),
            );
            const receipt = await api.appendTimeline(sessionId, {
              entries: events.map((event) => runId === undefined || event.payload.type !== 'message'
                ? event.payload
                : { ...event.payload, runId }),
              ...(turnId !== undefined ? { turnId } : {}),
            });
            return { success: true, count: (receipt as { writtenCount?: number }).writtenCount ?? events.length };
          } catch {
            return { success: false, count: 0, reason: 'transaction_failed' };
          }
        }
        // Decision 3: message:replace maps to the timeline append (INSERT OR IGNORE
        // idempotency). Generation optimistic lock is deprecated (append-only store).
        case 'message:replace': {
          const api = requireTimeline();
          const sessionId = requireString(payload, 'sessionId', 'message:replace');
          const messages = payload.messages as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(messages)) {
            return { success: false, reason: 'messages_not_array' };
          }
          // Auto-create session if missing (worker may address a session before
          // a metadata row exists).
          if (!(await api.get(sessionId, { includeAllSessions: true }))) {
            await api.create({ id: sessionId, createdAt: Date.now() });
          }
          try {
            const events = messages.map((msg) => {
              const id = (msg.id as string) || randomUUID();
              msg.id = id;
              return ipcMessageToNewEvent(
                sessionId,
                msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1],
              );
            });
            await api.appendTimeline(sessionId, {
              entries: events.map((event) => event.payload),
            });
            return { success: true, newGeneration: 0, messageCount: events.length };
          } catch (error) {
            return {
              success: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }
        // Plan 441: journal:emit accepts a typed RolloutEvent payload (rebase,
        // hook_invoked) and appends it with the event's own `type` discriminator.
        case 'journal:emit': {
          const api = requireTimeline();
          const sessionId = requireString(payload, 'sessionId', 'journal:emit');
          const event = payload.event as Record<string, unknown> | undefined;
          const turnId = payload.turnId as string | null | undefined;
          if (!event || typeof event !== 'object') {
            return { success: false, reason: 'invalid_event' };
          }
          const eventId = typeof event.id === 'string' ? event.id : null;
          if (!eventId) {
            return { success: false, reason: 'event_missing_id' };
          }
          try {
            const createdAt =
              typeof event.createdAt === 'number' ? (event.createdAt as number) : Date.now();
            const receipt = await api.appendTimeline(sessionId, {
              entries: [event as unknown as Parameters<typeof api.appendTimeline>[1]['entries'][number]],
              turnId: turnId ?? null,
            });
            void createdAt;
            return { success: true, count: (receipt as { writtenCount?: number }).writtenCount ?? 1 };
          } catch {
            return { success: false, count: 0, reason: 'transaction_failed' };
          }
        }

        // ==================== Locks ====================
        case 'lock:acquire': {
          const lock = requireLock();
          const origin =
            payload.origin === 'user' || payload.origin === 'agent' || payload.origin === 'background'
              ? (payload.origin as 'user' | 'agent' | 'background')
              : undefined;
          return lock.acquireLock({
            sessionId: payload.sessionId as string,
            lockId: payload.lockId as string,
            owner: payload.owner as string,
            ttlSec: (payload.ttlSec as number) || 300,
            ...(origin === undefined ? {} : { origin }),
          });
        }
        case 'lock:renew': {
          return requireLock().renewLock({
            sessionId: payload.sessionId as string,
            lockId: payload.lockId as string,
            ttlSec: (payload.ttlSec as number) || 300,
          });
        }
        case 'lock:release': {
          // Desktop additionally re-kicks its wake dispatcher here; a Host
          // process has no wake scheduler.
          return requireLock().releaseLock({
            sessionId: payload.sessionId as string,
            lockId: payload.lockId as string,
          });
        }
        case 'lock:isLocked': {
          return requireLock().isSessionLocked(requireString(payload, 'sessionId', 'lock:isLocked'));
        }
        case 'lock:origin': {
          return requireLock().getSessionLockOrigin(requireString(payload, 'sessionId', 'lock:origin'));
        }

        // ==================== Goals (plan 331) ====================
        case 'goal:get': {
          const goal = await requireGoal().getGoal(requireString(payload, 'sessionId', 'goal:get'));
          return goal ? coreGoalToIpcRow(goal) : undefined;
        }
        case 'goal:create': {
          const goal = await requireGoal().getOrCreateGoal({
            id: payload.id as string,
            sessionId: payload.session_id as string,
            goalText: (payload.goal_text as string | null | undefined) ?? null,
            tokenBudget: (payload.token_budget as number | null | undefined) ?? null,
          });
          return coreGoalToIpcRow(goal);
        }
        case 'goal:updateBudget': {
          const goal = await requireGoal().updateBudget(requireString(payload, 'sessionId', 'goal:updateBudget'), {
            ...(payload.tokensUsedDelta === undefined
              ? {}
              : { tokensUsedDelta: payload.tokensUsedDelta as number }),
            ...(payload.timeUsedDelta === undefined
              ? {}
              : { timeUsedDelta: payload.timeUsedDelta as number }),
          });
          return goal ? coreGoalToIpcRow(goal) : undefined;
        }
        case 'goal:setStatus': {
          const goal = await requireGoal().setStatus(
            requireString(payload, 'sessionId', 'goal:setStatus'),
            payload.status as 'active' | 'paused' | 'usage_limited' | 'complete',
          );
          return goal ? coreGoalToIpcRow(goal) : undefined;
        }
        case 'goal:listByStatus': {
          const goals = await requireGoal().listByStatus(
            payload.status as 'active' | 'paused' | 'usage_limited' | 'complete',
          );
          return goals.map(coreGoalToIpcRow);
        }

        // ==================== Mode state (plan 413c) ====================
        case 'modeState:get': {
          return requireModeState().getModeState(
            requireString(payload, 'sessionId', 'modeState:get'),
            requireString(payload, 'mode', 'modeState:get'),
          );
        }
        case 'modeState:upsert': {
          return requireModeState().upsertModeState({
            sessionId: requireString(payload, 'sessionId', 'modeState:upsert'),
            mode: requireString(payload, 'mode', 'modeState:upsert'),
            status: requireString(payload, 'status', 'modeState:upsert'),
            snapshotJson: requireString(payload, 'snapshotJson', 'modeState:upsert'),
            reminderCount: (payload.reminderCount as number | undefined) ?? 0,
          });
        }
        case 'modeState:setStatus': {
          return requireModeState().setModeStateStatus(
            requireString(payload, 'sessionId', 'modeState:setStatus'),
            requireString(payload, 'mode', 'modeState:setStatus'),
            requireString(payload, 'status', 'modeState:setStatus'),
          );
        }
        case 'modeState:listBySession': {
          return requireModeState().listModeStateBySession(
            requireString(payload, 'sessionId', 'modeState:listBySession'),
          );
        }

        // ==================== Tasks ====================
        case 'task:create': {
          const task = await requireTask().createTask(
            payload.session_id as string,
            ipcTaskToHostCreate(payload as unknown as Parameters<typeof ipcTaskToHostCreate>[0]),
          );
          return hostTaskToIpcRow(task);
        }
        case 'task:get': {
          const task = await requireTask().getTask(payload.id as string);
          return task ? hostTaskToIpcRow(task) : undefined;
        }
        case 'task:getBySession': {
          const tasks = await requireTask().listTasks(payload.sessionId as string);
          return tasks.map(hostTaskToIpcRow);
        }
        case 'task:update': {
          const task = await requireTask().updateTask(payload.id as string, ipcTaskToHostUpdate(payload));
          return task ? hostTaskToIpcRow(task) : undefined;
        }
        case 'task:delete': {
          return requireTask().deleteTask(payload.id as string);
        }
        case 'task:deleteBySession': {
          await requireTask().deleteTasksBySession(payload.sessionId as string);
          return { success: true };
        }
        case 'task:claim': {
          const result = await requireTask().claimTask(payload.id as string, payload.owner as string);
          if (result.success && result.task) {
            return { success: true, task: hostTaskToIpcRow(result.task) };
          }
          return result;
        }
        case 'task:block': {
          return requireTask().blockTasks(payload.fromId as string, payload.toId as string);
        }
        case 'task:unassignTeammate': {
          return requireTask().unassignTeammateTasks(payload.sessionId as string, payload.owner as string);
        }
        case 'task:getByOwner': {
          const tasks = await requireTask().listTasksByOwner(payload.sessionId as string, payload.owner as string);
          return tasks.map(hostTaskToIpcRow);
        }

        // ==================== Settings ====================
        case 'setting:get': {
          const key = payload.key;
          if (typeof key !== 'string') {
            throw new WorkerDbBridgeError('invalid_payload', 'setting:get requires key');
          }
          return options.settings.getString(key);
        }
        case 'setting:getAll': {
          return options.settings.getAllStrings();
        }
        case 'setting:getJson': {
          const key = payload.key;
          const fallback = payload.defaultValue;
          if (typeof key !== 'string') {
            throw new WorkerDbBridgeError('invalid_payload', 'setting:getJson requires key');
          }
          const raw = options.settings.getString(key);
          if (raw === null) return fallback;
          try {
            return JSON.parse(raw);
          } catch {
            return fallback;
          }
        }

        // ==================== Tool approvals ====================
        case 'toolApproval:create': {
          return toolApprovals().createToolApproval({
            id: payload.id as string,
            messageId: payload.messageId as string,
            sessionId: payload.sessionId as string,
            scopeType: (payload.scopeType as HostToolApprovalScopeType) ?? 'session',
            scopeId: payload.scopeId as string,
            toolName: payload.toolName as string,
            ...(payload.toolInput === undefined
              ? {}
              : { toolInput: payload.toolInput as Record<string, unknown> }),
          } satisfies HostToolApprovalInput);
        }
        case 'toolApproval:consumeApproved': {
          return toolApprovals().consumeApprovedToolApproval({
            sessionId: payload.sessionId as string,
            toolName: payload.toolName as string,
            inputHash: toolApprovalInputHash(payload.toolInput as Record<string, unknown> | undefined),
          });
        }
        case 'toolApproval:listRules': {
          return toolApprovals().listToolApprovalRules({
            scopeType: (payload.scopeType as HostToolApprovalScopeType) ?? 'session',
            scopeId: payload.scopeId as string,
          });
        }
        case 'toolApproval:upsertRule': {
          const scopeId = payload.scopeId as string;
          const toolName = payload.toolName as string;
          if (scopeId === '' || toolName === '') {
            throw new WorkerDbBridgeError('invalid_payload', 'toolApproval:upsertRule requires scopeId and toolName');
          }
          await toolApprovals().upsertToolApprovalRule({
            scopeType: (payload.scopeType as HostToolApprovalScopeType) ?? 'session',
            scopeId,
            toolName,
          });
          return { ok: true };
        }
        default:
          throw new WorkerDbBridgeError(
            'unimplemented_domain',
            `worker db action '${action}' has no Host implementation yet ` +
              '(plan 12 gate 1: migrate this domain to a typed Host service, then add it here)',
          );
      }
    },
  };
}
