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
import type { HostLocalMailboxApiV1 } from '@duya/agent-protocol/mailbox';
import type {
  HostMailboxApplyMode,
  HostMailboxCheckpoint,
  HostMailboxKind,
  HostMailboxStatus,
} from '@duya/agent-protocol/mailbox';
import type { HostLocalPluginSetupApiV1 } from '@duya/agent-protocol/plugin-setup';
import type {
  HostLocalSendMessageStateApiV1,
  CreateWidgetPendingInput,
  CreateSecretPendingInput,
  CursorAgentRunInput,
} from '@duya/agent-protocol/send-message-state';
import type {
  HostLocalTurnReviewApiV1,
  TurnReviewFile,
  TurnReviewWriteInput,
} from '@duya/agent-protocol/turn-review';
import type {
  HostLocalAttachmentApiV1,
  HostLocalParsedDocumentInput,
  HostWorkspaceRegistrationApiV1,
  SessionPermissionProfile,
} from '@duya/agent-protocol/session-api';
import type { HostLocalSessionApiV1 } from './local-session-api.js';
import type {
  WorkflowRunApiV1,
  WorkflowArtifactRef,
  WorkflowRunOrigin,
  WorkflowRunScope,
  WorkflowRunStatus,
  WorkflowRunSnapshot,
  WorkflowTriggerKind,
} from '@duya/agent-protocol/workflow-runs';
import {
  createHostLocalPluginRegistryApi,
  type HostLocalPluginRegistryApiV1,
} from './local-plugin-registry-api.js';
import {
  createConfigAgent,
  updateConfigAgentIdentity,
} from './config-agents/config-agents-api.js';
import {
  hostMessageItemsToIpcMessages,
  ipcMessageToNewEvent,
} from './ipc-message-adapters.js';
import {
  coreGoalToIpcRow,
  coreMailboxToIpcRow,
  coreSessionToIpcRow,
  hostTaskToIpcRow,
  ipcSessionToCoreCreate,
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
  | 'get'
  | 'create'
  | 'update'
  | 'countTimeline'
  | 'readMessages'
  | 'appendTimeline'
  | 'deleteTimeline'
  | 'searchSessions'
  | 'resolveSessionPermissionProfile'
>;

/**
 * Local-session subset used to emit legacy row shapes for the session domain.
 *
 * `listLocalSessions` is what makes `session:list` answer in the legacy row
 * shape: the worker's session-search tool reads `parent_id` and
 * `working_directory` from these rows, which the raw core rows do not have.
 */
export type WorkerBridgeLocalSessions = Pick<
  HostLocalSessionApiV1,
  'readLocalSession' | 'listLocalSessions'
>;

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
  /**
   * Host local-session reads — legacy row shapes for the session domain.
   *
   * `session:list` used to answer with the raw core rows, which have no
   * `parent_id` / `working_directory`; the worker's session-search tool read
   * those legacy names and found nothing.
   */
  readonly localSessions?: WorkerBridgeLocalSessions;
  /**
   * Loopback-only workspace registration — serves the working directory of a
   * session the worker creates.
   */
  readonly workspaceRegistration?: HostWorkspaceRegistrationApiV1;
  readonly goalApi?: HostGoalApiV1;
  readonly lockApi?: HostLockApiV1;
  readonly modeStateApi?: HostModeStateApiV1;
  readonly taskApi?: HostTaskApiV1;
  readonly pluginAppInvocationApi?: HostPluginAppInvocationInternalApi;
  /**
   * Host mailbox API — serves the `mailbox:*` domain.
   *
   * The worker claims and applies mailbox rows on every model turn, and
   * writes background notifications through the same domain. Without this the
   * standalone Host answered `unimplemented_domain`, so every claim failed
   * and every notification was lost.
   */
  readonly mailboxApi?: HostLocalMailboxApiV1;
  /**
   * Host plugin setup API — serves `plugin:setup:list-all`.
   *
   * The MCP loader expands `${setup.X}` references in plugin manifests from
   * these values; without them every reference expanded to nothing.
   */
  readonly pluginSetupApi?: HostLocalPluginSetupApiV1;
  /**
   * Host plugin registry — serves `plugin:registry:list`.
   *
   * The worker asks for the installed-plugin list to decide which plugin
   * tools are enabled and which plugin skill directories to load. The
   * standalone Host answers from `config.toml`'s `[plugins]` block; the
   * install paths and manifests belong to the Desktop's install
   * directory, so they are not part of this answer.
   */
  readonly pluginRegistryApi?: HostLocalPluginRegistryApiV1;
  /**
   * Durable workflow runs — serves the `workflowRun:*` domain.
   *
   * The workflow runner creates a run, drives it, and journals it from the
   * worker. Without this the whole workflow feature failed at its first
   * write in the standalone Host.
   */
  readonly workflowRunApi?: WorkflowRunApiV1;
  /**
   * Host turn review store — serves `turn-review:save`.
   *
   * The worker snapshots the turn's file changes after every turn. The
   * Desktop renders them in the code-review panel; the standalone Host
   * keeps them for its own review surface.
   */
  readonly turnReviewApi?: HostLocalTurnReviewApiV1;
  /**
   * Host attachment store — serves `attachment:store`.
   *
   * The worker persists the parsed-document context it attaches to a
   * message. Without this the parsed document was dropped on the floor.
   */
  readonly attachmentApi?: HostLocalAttachmentApiV1;
  /**
   * Host message-card state store — serves the `sendMessageState:*` domain.
   *
   * The interactive card shapes (widget / cursor-agent / secret request)
   * persist their pending state here so a later turn can resolve it.
   */
  readonly sendMessageStateApi?: HostLocalSendMessageStateApiV1;
  /**
   * Parsed-document attachments for `session:loadMessages`. Desktop serves
   * this from its attachment store; a standalone Host returns an empty list
   * unless it composes the attachment API.
   */
  readonly parsedDocumentsForSession?: (sessionId: string) => Promise<unknown[]>;
  /** Image payload rows for provider CDN rehydration in worker message history. */
  readonly imageAttachmentsForSession?: (sessionId: string) => Promise<readonly HostLocalImageAttachment[]>;
  /**
   * Directory holding `config.toml` for the config write side.
   *
   * Defaults to the shared data root — the same directory the Desktop config
   * store writes, so the two writers address one config file.
   */
  readonly configRoot?: string;
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

function requirePositiveInteger(payload: Record<string, unknown>, key: string, action: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new WorkerDbBridgeError('invalid_payload', `${action} requires ${key} to be an integer >= 1`);
  }
  return value;
}

/** An optional payload string: absent stays absent, a present value is text. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parse a JSON object carried as a string (the mailbox constraint blob). */
function parseJsonObject(value: unknown, action: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new WorkerDbBridgeError('invalid_payload', `${action} requires a JSON object string`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new WorkerDbBridgeError('invalid_payload', `${action} requires a JSON object string`);
  }
}

/**
 * The plugin registry the bridge serves when the Host composes no override.
 *
 * It reads `config.toml`'s `[plugins]` block on every call, so a plugin
 * the user enables between two runs is visible to the next one without a
 * restart.
 */
const defaultPluginRegistryApi = createHostLocalPluginRegistryApi();

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
  const requireMailbox = (): HostLocalMailboxApiV1 => {
    if (options.mailboxApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'mailbox domain requires options.mailboxApi');
    }
    return options.mailboxApi;
  };
  const requirePluginSetup = (): HostLocalPluginSetupApiV1 => {
    if (options.pluginSetupApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'plugin setup domain requires options.pluginSetupApi');
    }
    return options.pluginSetupApi;
  };
  const requireWorkflowRun = (): WorkflowRunApiV1 => {
    if (options.workflowRunApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'workflow run domain requires options.workflowRunApi');
    }
    return options.workflowRunApi;
  };
  const requireTurnReview = (): HostLocalTurnReviewApiV1 => {
    if (options.turnReviewApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'turn review domain requires options.turnReviewApi');
    }
    return options.turnReviewApi;
  };
  const requireAttachment = (): HostLocalAttachmentApiV1 => {
    if (options.attachmentApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'attachment domain requires options.attachmentApi');
    }
    return options.attachmentApi;
  };
  const requireSendMessageState = (): HostLocalSendMessageStateApiV1 => {
    if (options.sendMessageStateApi === undefined) {
      throw new WorkerDbBridgeError('unimplemented_domain', 'send message state domain requires options.sendMessageStateApi');
    }
    return options.sendMessageStateApi;
  };
  const requireSessionApi = (): NonNullable<HostWorkerDbBridgeOptions['timeline']> => {
    if (timeline === undefined) {
      throw new WorkerDbBridgeError(
        'unimplemented_domain',
        'session domain requires the Host session API (options.timeline)',
      );
    }
    return timeline;
  };
  const requireLocalSessions = (): NonNullable<HostWorkerDbBridgeOptions['localSessions']> => {
    if (options.localSessions === undefined) {
      throw new WorkerDbBridgeError(
        'unimplemented_domain',
        'session domain requires the Host local-session API (options.localSessions)',
      );
    }
    return options.localSessions;
  };
  const requireWorkspaceRegistration = (): HostWorkspaceRegistrationApiV1 => {
    if (options.workspaceRegistration === undefined) {
      throw new WorkerDbBridgeError(
        'unimplemented_domain',
        'session creation requires the Host workspace registration (options.workspaceRegistration)',
      );
    }
    return options.workspaceRegistration;
  };
  const legacySessionRow = async (sessionId: string): Promise<Record<string, unknown> | undefined> => {
    if (options.localSessions === undefined) return undefined;
    const session = await options.localSessions.readLocalSession(sessionId, {
      includeAllSessions: true,
    });
    return session ? coreSessionToIpcRow(session) : undefined;
  };
  /**
   * Every visible session as a legacy row, one page at a time.
   *
   * The legacy shape is the contract at the worker boundary: the worker's
   * session-search tool reads `parent_id`, `working_directory` and
   * `project_name` from these rows, and the core rows carry none of them.
   */
  const legacySessionRows = async (): Promise<Array<Record<string, unknown>>> => {
    const localSessions = requireLocalSessions();
    const rows: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const page = await localSessions.listLocalSessions({
        includeAllSessions: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const session of page.sessions) rows.push(coreSessionToIpcRow(session));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
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
        case 'session:create': {
          // The worker creates the child session row when it spawns a
          // sub-agent, so this write is the only thing that makes the child
          // visible in the session list afterwards.
          const api = requireSessionApi();
          const localSessions = requireLocalSessions();
          const parentSessionId =
            (payload.parent_session_id as string | undefined) ?? (payload.parent_id as string | undefined) ?? null;
          const permissionProfile = await api.resolveSessionPermissionProfile({
            explicit: typeof payload.permission_profile === 'string' ? payload.permission_profile : null,
            parentSessionId,
            trustedOverride: payload.is_trusted_permission_override === true,
          });
          const input = ipcSessionToCoreCreate(payload, permissionProfile);
          const requestedCwd = typeof input.workingDirectory === 'string' ? input.workingDirectory.trim() : '';
          const workspace = requestedCwd === ''
            ? undefined
            : await requireWorkspaceRegistration().registerLocalDirectory(requestedCwd);
          const created = await api.create({
            id: input.id,
            ...(workspace === undefined
              ? {}
              : {
                  workspaceId: workspace.workspaceId,
                  workspaceRootId: workspace.rootId,
                  workspaceRelativePath: workspace.relativePath,
                }),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
            ...(input.mode !== undefined ? { mode: input.mode } : {}),
            ...(input.permissionMode !== undefined
              ? { permissionMode: input.permissionMode as SessionPermissionProfile }
              : {}),
            ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
            ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
            ...(input.parentSessionId === undefined || input.parentSessionId === null
              ? {}
              : {
                  spawn: {
                    type: (payload.spawn_type as string | undefined) ?? 'subagent',
                    ...(typeof payload.spawn_reason === 'string' ? { reason: payload.spawn_reason } : {}),
                    ...(typeof payload.spawn_turn_id === 'string' ? { turnId: payload.spawn_turn_id } : {}),
                  },
                }),
            ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
            ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
            ...(input.draft !== undefined ? { draft: input.draft } : {}),
            ...(input.extensions !== undefined ? { extensions: input.extensions as JsonObject } : {}),
            ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
          });
          const persisted = await localSessions.readLocalSession(created.id, {
            includeAllSessions: true,
          });
          if (persisted === null) {
            throw new WorkerDbBridgeError(
              'unimplemented_domain',
              `session:create could not read the session back: ${created.id}`,
            );
          }
          return coreSessionToIpcRow(persisted);
        }
        case 'session:search': {
          // The worker asks for sessions by title and by content; the answer
          // carries a snippet so the tool can show what matched.
          const api = requireSessionApi();
          const localSessions = requireLocalSessions();
          const query = requireString(payload, 'query', 'session:search');
          const opts = payload.opts as { limit?: number } | undefined;
          const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? opts.limit : 10;
          const results = await api.searchSessions(query, { limit, includeContent: true });
          const rows: Array<Record<string, unknown> | null> = await Promise.all(results.map(async (result) => {
            const session = await localSessions.readLocalSession(result.session.id, {
              includeAllSessions: true,
            });
            return session === null
              ? null
              : { ...coreSessionToIpcRow(session), snippet: result.snippet };
          }));
          return rows.filter((row): row is Record<string, unknown> => row !== null);
        }
        case 'session:list': {
          return legacySessionRows();
        }
        case 'session:listByWorkingDirectory': {
          const workingDirectory = typeof payload.workingDirectory === 'string' ? payload.workingDirectory : '';
          const rows = await legacySessionRows();
          return rows.filter((row) => row.working_directory === workingDirectory);
        }
        case 'session:setExtension': {
          // Plan 621 D: key-level extension write, served by the same
          // SessionStore the HTTP surface reads — `setExtension` preserves
          // every other key, so concurrent extension writers cannot clobber
          // each other.
          const id = requireString(payload, 'id', 'session:setExtension');
          const key = requireString(payload, 'key', 'session:setExtension');
          options.sessions.setExtension(id, key, payload.value);
          return { ok: true };
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
        // ==================== Mailbox ====================
        // The same actions the Desktop bridge serves, from the same
        // Host-owned API and the same row converter. The Desktop's renderer
        // broadcasts and wake scheduling are deliberately NOT repeated here:
        // a standalone Host has no renderer, and the worker picks the row up
        // at its next checkpoint either way.
        case 'mailbox:send': {
          const item = await requireMailbox().enqueue({
            id: requireString(payload, 'id', action),
            sessionId: requireString(payload, 'sessionId', action),
            submittedRunId: optionalString(payload.submittedDuringRunId) ?? '',
            content: requireString(payload, 'content', action),
            kind: requireString(payload, 'kind', action) as HostMailboxKind,
            ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments } : {}),
            ...(payload.clientMsgId === null
              ? { clientMsgId: null }
              : (optionalString(payload.clientMsgId) === undefined ? {} : { clientMsgId: optionalString(payload.clientMsgId)! })),
            ...(optionalString(payload.source) === undefined ? {} : { source: optionalString(payload.source)! }),
            ...(payload.constraintsJson === undefined
              ? {}
              : { meta: { constraints: parseJsonObject(payload.constraintsJson, action) } }),
          });
          return coreMailboxToIpcRow(item);
        }
        case 'mailbox:edit': {
          const api = requireMailbox();
          const id = requireString(payload, 'id', action);
          const existing = await api.getItem(id);
          if (!existing) return null;
          // Retry-safe: a row already promoted for the next agent turn comes
          // back unchanged, so the caller's retry is idempotent.
          if (existing.status === 'applied' && existing.appliedSummary === 'queued_for_next_agent_turn') {
            return coreMailboxToIpcRow(existing);
          }
          const edited = await api.edit(id, {
            ...(optionalString(payload.content) === undefined ? {} : { content: optionalString(payload.content)! }),
            ...(optionalString(payload.kind) === undefined ? {} : { kind: optionalString(payload.kind)! as HostMailboxKind }),
          });
          return edited === null ? null : coreMailboxToIpcRow(edited);
        }
        case 'mailbox:guide': {
          const guided = await requireMailbox().guide(requireString(payload, 'id', action));
          return guided === null ? null : coreMailboxToIpcRow(guided);
        }
        case 'mailbox:promoteQueued': {
          const promoted = await requireMailbox().promoteQueued(requireString(payload, 'id', action));
          return promoted === null ? null : coreMailboxToIpcRow(promoted);
        }
        case 'mailbox:cancel': {
          const cancelled = await requireMailbox().cancel(
            requireString(payload, 'id', action),
            optionalString(payload.reason),
          );
          return cancelled === null ? null : coreMailboxToIpcRow(cancelled);
        }
        case 'mailbox:list': {
          const items = await requireMailbox().listMailboxItems(
            requireString(payload, 'sessionId', action),
            {
              ...(Array.isArray(payload.status)
                ? { status: payload.status.map((status) => String(status) as HostMailboxStatus) }
                : {}),
              limit: typeof payload.limit === 'number' ? payload.limit : 50,
            },
          );
          return items.map(coreMailboxToIpcRow);
        }
        case 'mailbox:listForSession': {
          const items = await requireMailbox().listMailboxItemsForSession(
            requireString(payload, 'sessionId', action),
          );
          return items.map(coreMailboxToIpcRow);
        }
        case 'mailbox:claimBatch': {
          const result = await requireMailbox().claimBatch({
            sessionId: requireString(payload, 'sessionId', action),
            runId: requireString(payload, 'runId', action),
            checkpoint: requireString(payload, 'checkpoint', action) as HostMailboxCheckpoint,
            ...(typeof payload.limit === 'number' ? { limit: payload.limit } : {}),
            ...(typeof payload.leaseMs === 'number' ? { leaseMs: payload.leaseMs } : {}),
            ...(typeof payload.coalesceWindowMs === 'number' ? { coalesceWindowMs: payload.coalesceWindowMs } : {}),
            ...(typeof payload.maxClaimAttempts === 'number' ? { maxClaimAttempts: payload.maxClaimAttempts } : {}),
          });
          return { rows: result.rows.map(coreMailboxToIpcRow), claimTokens: [...result.claimTokens] };
        }
        case 'mailbox:apply': {
          const item = await requireMailbox().apply({
            id: requireString(payload, 'id', action),
            claimToken: requireString(payload, 'claimToken', action),
            mode: requireString(payload, 'mode', action) as HostMailboxApplyMode,
            checkpoint: requireString(payload, 'checkpoint', action) as HostMailboxCheckpoint,
            ...(optionalString(payload.summary) === undefined ? {} : { summary: optionalString(payload.summary)! }),
            ...(payload.resultingUserMsgId === undefined
              ? {}
              : { resultingEventId: payload.resultingUserMsgId === null ? null : String(payload.resultingUserMsgId) }),
          });
          return coreMailboxToIpcRow(item);
        }
        case 'mailbox:cancelByAgent': {
          const cancelled = await requireMailbox().cancelByAgent({
            id: requireString(payload, 'id', action),
            claimToken: requireString(payload, 'claimToken', action),
            reason: optionalString(payload.reason) ?? 'cancelled_by_agent',
          });
          return cancelled === null ? null : coreMailboxToIpcRow(cancelled);
        }

        // ==================== Plugin setup ====================
        case 'plugin:setup:list-all':
          // The MCP loader expands `${setup.X}` references in plugin
          // manifests from these values.
          return requirePluginSetup().listPluginSetupValues();

        // ==================== Plugin registry ====================
        case 'plugin:registry:list':
          // The installed-plugin list the worker gates on. The standalone
          // Host reports the config-backed entries; an entry carries no
          // install path because the package files live under the
          // Desktop's Electron userData, not under the shared data root.
          return (options.pluginRegistryApi ?? defaultPluginRegistryApi).listPlugins();

        // ==================== Workflow runs ====================
        // The same actions the Desktop bridge serves, from the same Host-owned
        // workflow run API. The workflow runner creates a run, drives it, and
        // journals it from the worker; without these the whole feature
        // failed at its first write in the standalone Host.
        case 'workflowRun:create':
          return requireWorkflowRun().createRun({
            ...(optionalString(payload.id) === undefined ? {} : { id: optionalString(payload.id)! }),
            workflowName: requireString(payload, 'workflowName', action),
            workflowVersionId: optionalString(payload.workflowVersionId) ?? null,
            ...(optionalString(payload.status) === undefined
              ? {}
              : { status: optionalString(payload.status)! as WorkflowRunStatus }),
            ...(payload.triggerKind === undefined || payload.triggerKind === null
              ? {}
              : { triggerKind: payload.triggerKind as WorkflowTriggerKind }),
            dedupKey: optionalString(payload.dedupKey) ?? null,
            params: (payload.params as Record<string, unknown> | undefined) ?? {},
            retryOf: optionalString(payload.retryOf) ?? null,
            // Plan 560: run anchoring always crosses the bridge explicitly.
            // The session-anchored runner sends 'session' — relying on the
            // column default would label it 'library' and corrupt the
            // origin filter.
            ...(payload.origin === undefined
              ? {}
              : { origin: payload.origin as WorkflowRunOrigin }),
            scope: (payload.scope as WorkflowRunScope | null | undefined) ?? null,
            projectDir: optionalString(payload.projectDir) ?? null,
            parentSessionId: optionalString(payload.parentSessionId) ?? null,
            agentModel: optionalString(payload.agentModel) ?? null,
          });
        case 'workflowRun:updateStatus':
          return requireWorkflowRun().updateStatus(
            requireString(payload, 'id', action),
            requireString(payload, 'status', action) as WorkflowRunStatus,
            (payload.pauseMessage as string | null | undefined) ?? undefined,
          );
        case 'workflowRun:finish':
          // Plan 560 terminal write. The optional keys are forwarded only
          // when the caller sent them, so a partial outcome never clobbers
          // an earlier summary / artifact list.
          return requireWorkflowRun().finishRun(requireString(payload, 'id', action), {
            status: requireString(payload, 'status', action) as WorkflowRunStatus,
            ...(payload.summary === undefined ? {} : { summary: payload.summary as string | null }),
            ...(payload.artifacts === undefined
              ? {}
              : { artifacts: payload.artifacts as WorkflowArtifactRef[] }),
            ...(payload.spentTokens === undefined
              ? {}
              : { spentTokens: payload.spentTokens as number | null }),
          });
        case 'workflowRun:saveSnapshot':
          return requireWorkflowRun().saveSnapshot({
            runId: requireString(payload, 'runId', action),
            definition: payload.definition,
            ...(payload.maxConcurrency === undefined
              ? {}
              : { maxConcurrency: requirePositiveInteger(payload, 'maxConcurrency', action) }),
            nodeStack: (payload.nodeStack as WorkflowRunSnapshot['nodeStack']) ?? [],
            journal: (payload.journal as WorkflowRunSnapshot['journal']) ?? [],
          });
        case 'workflowRun:loadSnapshot':
          return requireWorkflowRun().loadSnapshot(requireString(payload, 'runId', action));
        case 'workflowRun:appendJournal':
          return requireWorkflowRun().appendJournalRecord(
            requireString(payload, 'runId', action),
            payload.record as WorkflowRunSnapshot['journal'][number],
          );
        case 'workflowRun:loadJournal':
          return requireWorkflowRun().loadJournal(requireString(payload, 'runId', action));

        // ==================== Turn review ====================
        case 'turn-review:save': {
          const sessionId = optionalString(payload.sessionId) ?? '';
          const turnId = optionalString(payload.turnId) ?? '';
          const workingDirectory = optionalString(payload.workingDirectory) ?? '';
          if (!sessionId || !turnId || !workingDirectory) {
            throw new WorkerDbBridgeError('invalid_payload', `${action} requires sessionId, turnId and workingDirectory`);
          }
          const input: TurnReviewWriteInput = {
            id: optionalString(payload.id) ?? randomUUID(),
            sessionId,
            turnId,
            workingDirectory,
            files: (Array.isArray(payload.files) ? payload.files : []) as TurnReviewFile[],
            patch: optionalString(payload.patch) ?? '',
            additions: typeof payload.additions === 'number' ? payload.additions : 0,
            removals: typeof payload.removals === 'number' ? payload.removals : 0,
            truncated: payload.truncated === true,
            binary: payload.binary === true,
            capturedAt: typeof payload.capturedAt === 'number' ? payload.capturedAt : Date.now(),
          };
          await requireTurnReview().saveTurnReview(input);
          return true;
        }

        // ==================== Attachments ====================
        case 'attachment:store': {
          const messageId = optionalString(payload.messageId) ?? '';
          if (!messageId) {
            // The Desktop bridge answers with a soft failure here rather than
            // throwing: the worker has no message to attach the document to.
            return { success: false, error: 'messageId is required' };
          }
          const input: HostLocalParsedDocumentInput = {
            messageId,
            sessionId: optionalString(payload.sessionId) ?? '',
            filename: optionalString(payload.filename) ?? '',
            filePath: optionalString(payload.filePath) ?? '',
            charCount: typeof payload.charCount === 'number' ? payload.charCount : 0,
            text: optionalString(payload.text) ?? '',
            ...(payload.extractMethod === undefined
              ? {}
              : { extractMethod: optionalString(payload.extractMethod)! }),
            ...(payload.imageChunks === undefined
              ? {}
              : { imageChunks: payload.imageChunks as NonNullable<HostLocalParsedDocumentInput['imageChunks']> }),
          };
          return requireAttachment().storeParsedDocument(input);
        }

        // ==================== SendMessage side state ====================
        // The Desktop bridge swallows the store error and answers with a
        // soft failure, so the worker never sees an unhandled rejection
        // from a best-effort side-state write. The same holds here — but
        // the "the Host has not composed this API" failure stays OUTSIDE
        // the catch: a misconfigured Host must fail fast and name the
        // missing domain, not look like a store hiccup.
        case 'sendMessageState:createWidgetPending': {
          const api = requireSendMessageState();
          try {
            await api.createWidgetPending(payload as unknown as CreateWidgetPendingInput);
            return { success: true, messageId: optionalString(payload.messageId) ?? '' };
          } catch {
            return { success: false, reason: 'transaction_failed' };
          }
        }
        case 'sendMessageState:createSecretPending': {
          const api = requireSendMessageState();
          try {
            await api.createSecretPending(payload as unknown as CreateSecretPendingInput);
            return { success: true, messageId: optionalString(payload.messageId) ?? '' };
          } catch {
            return { success: false, reason: 'transaction_failed' };
          }
        }
        case 'sendMessageState:upsertCursorAgentRun': {
          const api = requireSendMessageState();
          try {
            await api.upsertCursorAgentRun(payload as unknown as CursorAgentRunInput);
            return { success: true, messageId: optionalString(payload.messageId) ?? '' };
          } catch {
            return { success: false, reason: 'transaction_failed' };
          }
        }

        // ==================== Config agents ====================
        // The worker never writes config.toml itself — the process that owns
        // the file does. These two actions are the agent-side CreateAgent /
        // UpdateAgent tools; without them a model in the standalone Host
        // could not spin up a teammate at all.
        case 'config:agents:create': {
          const name = payload.name;
          if (typeof name !== 'string' || !name.trim()) {
            throw new WorkerDbBridgeError('invalid_payload', 'agent name is required');
          }
          return createConfigAgent(name, optionalString(payload.description), {
            ...(options.configRoot === undefined ? {} : { root: options.configRoot }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
          });
        }
        case 'config:agents:update': {
          const agentId = payload.agentId;
          if (typeof agentId !== 'string' || !agentId.trim()) {
            throw new WorkerDbBridgeError('invalid_payload', 'agentId is required');
          }
          return updateConfigAgentIdentity(
            agentId,
            {
              name: optionalString(payload.name),
              description: optionalString(payload.description),
            },
            {
              ...(options.configRoot === undefined ? {} : { root: options.configRoot }),
              ...(options.logger === undefined ? {} : { logger: options.logger }),
            },
          );
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
