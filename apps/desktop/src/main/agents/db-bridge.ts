/**
 * db-bridge.ts - Database action dispatcher for Agent
 *
 * Handles database requests from the Agent process.
 * Extracted from former ipc/agent-communicator.ts.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import { toolApprovalInputHash } from '@duya/data/tool-approval-state';
import type { CoreSession } from '@duya/data/session-store';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { getConfigStore } from '../config/store-instance';
import { getDesktopBotService } from '../config/bot-application';
import { BotServiceError } from '@duya/host/bot';
import { readConfigAgents } from '@duya/host/agent-profile-config';
import { toLegacyApiProvider, migrateLegacyApiProvider } from '../../renderer/lib/providers/legacy';
import { toRuntimeConfig } from '@duya/ai';
import type {
  CreateSecretPendingInput,
  CreateWidgetPendingInput,
  CursorAgentRunInput,
  HostMessageItem,
  TurnReviewFile,
  TurnReviewWriteInput,
  BotDispatchTicket,
} from '@duya/agent-protocol';
import type { TurnSuggestionWriteInput } from '@duya/agent-protocol/turn-suggestion';
import { isHostResearchAction } from '@duya/agent-protocol/research-api';
import { isJsonValue } from '@duya/agent-protocol';
import type { ApiProvider } from '../config/provider-types';
import { getAutomationScheduler } from '../automation/Scheduler.js';
import { runPromptInSession, interruptCronSession } from '../automation/agent-run';
import { buildCronProviderConfig } from '../automation/provider-config';
import { getLogger, LogComponent } from '../logging/logger';
import { testProviderConnection } from '../ipc/net-handlers';
import { getPluginManager } from '../plugins/PluginManager';
import { readPluginManifest } from '../plugins/manifest';
import {
  getDesktopHostLocalAttachmentApi,
  getDesktopHostLocalSettingsApi,
  getDesktopHostLocalMailboxApi,
  getDesktopHostLocalSessionApi,
  getDesktopHostSessionApi,
  getDesktopHostTaskApi,
  getDesktopHostGoalApi,
  getDesktopHostModeStateApi,
  getDesktopHostWorkflowRunApi,
  getDesktopHostPermissionRequestApi,
  getDesktopHostToolApprovalApi,
  getDesktopHostLockApi,
  getDesktopHostResearchApi,
  getDesktopHostLocalSendMessageStateApi,
  getDesktopHostLocalModelCapabilityApi,
  getDesktopHostLocalPluginSetupApi,
  getDesktopHostLocalTurnReviewApi,
  getDesktopHostLocalTurnSuggestionApi,
  getDesktopHostLocalChannelPersistenceApi,
  getDesktopHostProjectApi,
  getDesktopHostPluginAppInvocationApi,
  getDesktopCheckoutService,
  lookupDesktopBotDispatch,
  reserveDesktopBotDispatch,
  isDesktopBotDispatchCurrent,
} from '../cli/desktop-host-api';
import { resolveDataRoot } from '@duya/data/data-paths';
import { normalizePath } from '@duya/data/path-utils';
import { getControlPlane } from '@duya/host/control-plane-service';
import { COMMAND_SCHEMA_VERSION, type CommandSenderFacts } from '@duya/host/command-receipt';
import { writeRunReceiptOnWire } from '@duya/host/run-receipt';
import { authorizePluginAppBindingCheck } from './plugin-app-binding-check';
import type { WorkflowRunSnapshot, WorkflowRunStatus, WorkflowTriggerKind } from '@duya/agent-protocol/workflow-runs';

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { BrowserWindow } from 'electron'` is evaluated when the module is
 * and throws THERE, taking the whole graph with it, so the class is resolved
 * through a guarded require at each broadcast site below. The `import type`
 * above is erased by the compiler and can never throw.
 *
 * An absent host yields no windows, which is the same answer the existing
 * `catch` around each broadcast already produced: there is no renderer to
 * notify, and the DB row is still the authoritative result.
 */
function allBrowserWindows(): BrowserWindow[] {
  try {
    const { BrowserWindow } = require('electron') as {
      BrowserWindow?: { getAllWindows(): BrowserWindow[] };
    };
    return BrowserWindow && typeof BrowserWindow.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [];
  } catch {
    return [];
  }
}
import { notifySessionIdle, advanceUserTurn } from '../wake/wake-dispatcher';

async function readHostMessageItems(sessionId: string): Promise<HostMessageItem[]> {
  const api = getDesktopHostSessionApi();
  const items: HostMessageItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.readMessages(sessionId, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.messages);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

type HostSessionListQuery = NonNullable<Parameters<ReturnType<typeof getDesktopHostSessionApi>['list']>[0]>;

async function readHostSessionRows(
  query: HostSessionListQuery = {},
): Promise<Array<Record<string, unknown>>> {
  const api = getDesktopHostLocalSessionApi();
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await api.listLocalSessions({
      ...query,
      includeAllSessions: true,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const session of page.sessions) rows.push(coreSessionToIpcRow(session));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

async function readAllHostLocalSessions(): Promise<CoreSession[]> {
  const api = getDesktopHostLocalSessionApi();
  const sessions: CoreSession[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listLocalSessions({
      includeAllSessions: true,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    sessions.push(...page.sessions);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return sessions;
}

async function readHostSessionRow(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const session = await getDesktopHostLocalSessionApi().readLocalSession(sessionId, {
    includeAllSessions: true,
  });
  return session ? coreSessionToIpcRow(session) : undefined;
}

async function searchHostSessionRows(
  query: string,
  limit: number,
  includeContent = true,
): Promise<Array<Record<string, unknown>>> {
  const results = await getDesktopHostSessionApi().searchSessions(query, { limit, includeContent });
  const rows: Array<Record<string, unknown> | null> = await Promise.all(results.map(async (result) => {
    const session = await getDesktopHostLocalSessionApi().readLocalSession(result.session.id, {
      includeAllSessions: true,
    });
    return session ? { ...coreSessionToIpcRow(session), snippet: result.snippet } : null;
  }));
  return rows.filter((row): row is Record<string, unknown> => row !== null);
}

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
import type { NewEvent } from '../db/core';
import {
  ipcSessionToCoreCreate,
  ipcSessionToUpdate,
  coreSessionToIpcRow,
  ipcMessageToNewEvent,
  newEventToIpcMessage,
  storedEventsToIpcMessages,
  serializeMessageContent,
  serializeDisplayContent,
  ipcTaskToHostCreate,
  ipcTaskToHostUpdate,
  hostTaskToIpcRow,
  ipcPermissionToCoreCreate,
  ipcPermissionToResolve,
  corePermissionToIpcRow,
  coreMailboxToIpcRow,
  coreGoalToIpcRow,
  hostMessageItemsToIpcMessages,
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
 * registered project, Host API unavailable, or cwd unparseable).
 *
 * Used by both `projects:resolveAdditionalRoots` (writable-roots fan-out
 * for session cwd) and `projects:resolveProject` (lightweight
 * cwd → projectId reverse-lookup for runtime injection).
 */
async function resolveProjectByCwd(
  cwd: string
): Promise<{ projectId: string; paths: string[]; cwdNormalized: string } | null> {
  try {
    const rows = await getDesktopHostProjectApi().listProjects();
    const cwdNorm = normalizePath(cwd).absolute_normalized_path;
    const hit = rows.find((row) => row.paths.some((entry) => entry.path === cwdNorm));
    if (!hit) return null;
    return {
      projectId: hit.project_id,
      paths: hit.paths.map((entry) => entry.path),
      cwdNormalized: cwdNorm,
    };
  } catch {
    return null;
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
 * Notify a parent session that a spawned child session finished (Plan 504).
 * Writes a `background_notification` mailbox row into the parent — the same
 * "background work completed, wake me" contract the cron/background-task path
 * uses — then pokes the idle wake dispatcher exactly like `mailbox:send` does.
 * The parent is woken now if idle; if busy, the existing lock-release → idle
 * re-kick and slot-checkpoint mailbox claim deliver it on the next available
 * turn. Best-effort: a wake failure must not surface to the spawn path.
 */
async function notifySpawnCompletion(
  parentSessionId: string,
  childSessionId: string,
  status: 'completed' | 'failed',
  summary: string,
): Promise<void> {
  try {
    const item = await getDesktopHostLocalMailboxApi().enqueue({
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
/**
 * A `db:request` whose transport did not say who sent it.
 *
 * Deliberately not "the host". `senderPid: null` means host-initiated, and a
 * `db:request` never is — the agent server is a fork. So a missing sender is
 * given a pid the spawn registry can never contain, which the Control Plane
 * refuses. Defaulting it to the host would have made the sender check pass for
 * exactly the case it exists to catch.
 */
const UNATTRIBUTED_SENDER: CommandSenderFacts = {
  senderPid: -1,
  registeredSessionId: null,
  role: null,
};

/** The wire refusal when composition never created a Control Plane. */
const RUN_UNAVAILABLE_REASON =
  'this host created no Control Plane, so it has no durable owner for a run; call initCoreDatabase() and createControlPlane() at composition';

export async function dispatchDbAction(
  action: string,
  payload: unknown,
  sender?: CommandSenderFacts,
  trustedAttempt?: CommandSenderFacts['trustedAttempt'],
): Promise<unknown> {
  if (isHostResearchAction(action)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`Invalid payload for Host Research action: ${action}`);
    }
    return getDesktopHostResearchApi().dispatch(action, payload as Record<string, unknown>);
  }

  const p = payload as Record<string, unknown>;
  const now = Date.now();

  switch (action) {
    case 'bot:dispatch:lookup': {
      return lookupDesktopBotDispatch(p.ticket as BotDispatchTicket);
    }
    case 'bot:dispatch:reserve': {
      return reserveDesktopBotDispatch(p.ticket as BotDispatchTicket, String(p.candidateRunId ?? ''));
    }
    case 'bot:dispatch:isCurrent': {
      return isDesktopBotDispatchCurrent(p.ticket as BotDispatchTicket);
    }
    // ==================== Control Plane / run actions (plan 586) ====================
    // Handled by the Control Plane rather than inline. It authenticates this
    // child-process sender before its injected request adapts the command to
    // HostRunApiV1. The dispatcher returns `undefined` for an action it does
    // not own, so the fallthrough below still runs for everything else.
    //
    // The agent-server is a FORK, so this is the authenticated Control Plane
    // route for durable run operations. Runtime locks use the Host lock API.
    //
    // Plan 587 C6.1: the dispatcher is the one composition created, reached
    // through `getControlPlane()`. `run:unavailable` is a refusal, not a silent
    // success, when composition did not create the sender-authorising service.
    case 'run:create':
    case 'run:append':
    case 'run:complete':
    case 'run:get':
    case 'run:events':
    case 'run:list-session': {
      const runId = String(p.runId ?? '');
      const controlPlane = getControlPlane();
      if (controlPlane === null) {
        return writeRunReceiptOnWire({ state: 'unavailable', runId, reason: RUN_UNAVAILABLE_REASON });
      }
      const releaseCheckoutAdmission = action === 'run:create'
        ? getDesktopCheckoutService().reserveRun(String(p.sessionId ?? ''),
          p.manifest && typeof p.manifest === 'object' && 'cwd' in p.manifest ? String(p.manifest.cwd) : undefined) : () => {};
      const receipt = await (async () => { try { return await controlPlane.serve(
        { schema: COMMAND_SCHEMA_VERSION, action, payload: p },
        // A `db:request` is never host-initiated: the agent server is a fork,
        // so a missing sender means the transport did not thread its facts
        // through. `noSender` is refused rather than treated as the host.
        sender ?? UNATTRIBUTED_SENDER,
      ); } finally { releaseCheckoutAdmission(); } })();

      if (receipt.outcome === 'rejected') {
        // Refused before storage, so there is no producer reply to forward and
        // no `write` receipt to serialise. The refusal is reported IN the
        // receipt vocabulary — `invalid` is its own "refused before it reached
        // storage" state — with C6.1's refusal code kept verbatim in `reason`.
        // A refusal the reader can only call `unreadable` loses the reason,
        // which is the whole of what a refusal has to say.
        if (receipt.write !== undefined) {
          return writeRunReceiptOnWire(receipt.write);
        }
        return writeRunReceiptOnWire({
          state: 'invalid',
          runId,
          reason: `${receipt.refusal}: ${receipt.reason}`,
        });
      }

      // The producer's own reply, verbatim.
      //
      // It used to return `receipt.write` here — the TYPED `RunWriteReceipt`.
      // Two fields do not survive that trip, and both are load-bearing:
      //
      //  - the typed union has no `ok` member, so every reply lost the boolean
      //    `readRunReceipt` requires and came back `unreadable`. That is the
      //    dropped chat turn: the row was written, `openRun` was told the run
      //    did not exist, and the worker was never sent `chat:start`.
      //  - the typed union has no `written` member either, so `run:append` lost
      //    the count the reader validates, and the first `run.started` append
      //    was refused as `started_not_durable` — a second, quieter instance of
      //    the same drift.
      //
      // `serve` only reaches this arm for an `accepted` command, and it accepts
      // one only after reading `result` with `readRunReceipt`, so `result` IS a
      // wire receipt by construction. Forwarding it loses nothing; rebuilding
      // it from the parsed form is what dropped the fields.
      //
      // A READ answers here too, and needs no special case: its `result` is the
      // run row or the event list, which is exactly what the caller asked for.
      // Handing a read back a receipt instead — which is what returning
      // `receipt.write` for every action in this arm did — hands the caller a
      // `{state:'unreadable'}` object where a run row was asked for.
      return receipt.result;
    }

    case 'plugin-app:binding-current': {
      return authorizePluginAppBindingCheck({
        payload: p,
        ...(sender ? { sender } : {}),
        ...(trustedAttempt ? { trustedAttempt } : {}),
        isBindingCurrent: (bindingId, nonce, toolId, caller) =>
          getDesktopHostPluginAppInvocationApi().isBindingCurrent(bindingId, nonce, toolId, caller),
      });
    }

    // ==================== Session actions (Host API compatibility adapter) ====================
    case 'session:create': {
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
      const data: Record<string, unknown> = { ...p, model };
      const parentSessionId =
        (data.parent_session_id as string | undefined) ?? (data.parent_id as string | undefined) ?? null;
      const isTrusted = data.is_trusted_permission_override === true;
      const explicitProfile = typeof data.permission_profile === 'string' ? data.permission_profile : undefined;
      const permissionProfile = await getDesktopHostSessionApi().resolveSessionPermissionProfile({
        explicit: explicitProfile,
        parentSessionId,
        trustedOverride: isTrusted,
      });
      const input = ipcSessionToCoreCreate(data, permissionProfile);
      const hostApi = getDesktopHostSessionApi();
      const requestedCwd = typeof data.working_directory === 'string' ? data.working_directory.trim() : '';
      const workspace = requestedCwd
        ? await hostApi.registerLocalDirectory(requestedCwd)
        : undefined;
      const hostCreate: Parameters<typeof hostApi.create>[0] = {
        id: input.id,
        ...(workspace ? {
          workspaceId: workspace.workspaceId,
          workspaceRootId: workspace.rootId,
          workspaceRelativePath: workspace.relativePath,
        } : {}),
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
      const persisted = await getDesktopHostLocalSessionApi().readLocalSession(created.id, {
        includeAllSessions: true,
      });
      if (!persisted) throw new Error(`Host created session but it could not be read back: ${created.id}`);
      return coreSessionToIpcRow(persisted);
    }

    case 'session:get':
      return readHostSessionRow(p.id as string);

    case 'session:checkoutControl': {
      const id = String(p.id ?? '');
      const { parseSessionCheckoutCommand } = await import('@duya/host');
      const command = parseSessionCheckoutCommand(p.command);
      const service = getDesktopCheckoutService();
      if (command.action === 'status') return { state: service.read(id), outcome: 'status' };
      if (!trustedAttempt || trustedAttempt.sessionId !== id) throw new Error('Checkout mutation requires a trusted worker attempt.');
      return service.control(id, command, trustedAttempt);
    }
    case 'session:checkoutReclaim': {
      if (typeof p.root !== 'string' || p.root.length > 4096) throw new Error('Invalid checkout root.');
      return getDesktopCheckoutService().reclaim(p.root);
    }

    case 'session:setExtension': {
      // Plan 621 D: key-level extension write from the worker, served by the
      // same Host session API the HTTP surface reads. `update` merges the
      // given extension keys one at a time (`sessions.setExtension`), so
      // concurrent extension writers cannot clobber each other.
      const id = p.id as string;
      const key = p.key as string;
      if (!id || !key) throw new Error('session:setExtension requires id and key');
      // The extension bag is persisted as JSON, so a value that is not JSON
      // would corrupt the column. Rejecting it here is the same contract the
      // store applies: an unwritable value is refused, not coerced.
      if (!isJsonValue(p.value)) {
        throw new Error(`session:setExtension requires a JSON value for key "${key}"`);
      }
      await getDesktopHostSessionApi().update(id, undefined, {
        extensions: { [key]: p.value },
      });
      return { ok: true };
    }

    case 'session:ensureBot': {
      // Plan 477 P3.1 / 491 P1.2 — lazily materialize a bot's persistent
      // session (`bot:<agentId>`) on first user chat. Mirrors the exact
      // get-or-create shape of agent-dm-dispatcher's defaultBotSessionCreator
      // so wake-created and chat-created rows converge on the same canonical
      // row (idempotent, no config validation — a misconfigured bot surfaces
      // as a profile-resolution error in the worker, same as wake runs).
      const hostApi = getDesktopHostSessionApi();
      const sessionId = p.sessionId as string;
      const agentId = parseAgentIdFromBotSession(sessionId);
      if (!agentId) {
        return { ok: false, reason: 'not-a-bot-session' };
      }
      const existing = await hostApi.get(sessionId, { includeAllSessions: true });
      if (existing) {
        // Backfill the agent's configured provider/model when an older row was
        // created before per-agent config landed (it stored the defaults).
        const cfg = await botAgentConfigFor(agentId);
        if (cfg.model && !existing.model) {
          await hostApi.update(sessionId, undefined, {
            model: cfg.model,
            providerId: cfg.providerId ?? existing.providerId,
          });
        }
        const compatible = await readHostSessionRow(sessionId);
        if (!compatible) throw new Error(`Host session could not be read back: ${sessionId}`);
        return { ok: true, created: false, session: compatible };
      }
      const cfg = await botAgentConfigFor(agentId);
      const created = await hostApi.create({
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
      const compatible = await getDesktopHostLocalSessionApi().readLocalSession(created.id, {
        includeAllSessions: true,
      });
      if (!compatible) throw new Error(`Host created session but it could not be read back: ${created.id}`);
      // The row was created outside any renderer action (the agent-server
      // fork asked for it), so the normal renderer→main sync path never
      // fires. Broadcast so the session list picks the thread up without a
      // manual refresh — same rationale as createCronSessionRow.
      // `allBrowserWindows` yields none on a headless host (no renderer to
      // notify), which is what the previous catch around this loop reported.
      for (const window of allBrowserWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('sync:threads-changed');
        }
      }
      return { ok: true, created: true, session: coreSessionToIpcRow(compatible) };
    }

    case 'session:update': {
      const id = p.id as string;
      const extKeys = ['system_prompt', 'context_summary', 'context_summary_updated_at', 'source'] as const;
      const patch = ipcSessionToUpdate(p);
      const changesWorkingDirectory = patch.workingDirectory !== undefined;
      const requestedWorkingDirectory = typeof patch.workingDirectory === 'string'
        ? patch.workingDirectory.trim()
        : '';
      let workspacePatch: Parameters<ReturnType<typeof getDesktopHostSessionApi>['update']>[2]['workspace'];
      if (changesWorkingDirectory && requestedWorkingDirectory.length === 0) {
        workspacePatch = { state: 'legacy_unbound' };
      } else if (changesWorkingDirectory) {
        workspacePatch = await getDesktopHostSessionApi().registerLocalDirectory(requestedWorkingDirectory);
      }
      const hostApi = getDesktopHostSessionApi();
      const extensions = Object.fromEntries(extKeys.filter((key) => p[key] !== undefined).map((key) => [key, p[key]]));
      type HostPatch = Parameters<typeof hostApi.update>[2];
      const hostPatch: HostPatch = {
        ...(workspacePatch !== undefined ? { workspace: workspacePatch } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.projectName !== undefined ? { projectName: patch.projectName } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode as HostPatch['permissionMode'] } : {}),
        ...(patch.parentSessionId !== undefined ? { parentSessionId: patch.parentSessionId } : {}),
        ...(patch.agentProfileId !== undefined ? { agentProfileId: patch.agentProfileId } : {}),
        ...(patch.agentType !== undefined ? { agentType: patch.agentType } : {}),
        ...(patch.agentName !== undefined ? { agentName: patch.agentName } : {}),
        ...(p.draft_message !== undefined ? { draft: p.draft_message as string | null } : {}),
        ...(Object.keys(extensions).length > 0
          ? { extensions: extensions as NonNullable<HostPatch['extensions']> }
          : {}),
      };
      await hostApi.update(id, undefined, hostPatch);
      return readHostSessionRow(id);
    }

    // Decision 5: session:delete is now soft delete (status='deleted'), no cascade.
    case 'session:delete':
      return (await getDesktopHostSessionApi().delete(p.id as string)).deleted;

    case 'session:list':
      return readHostSessionRows();

    case 'session:listByWorkingDirectory': {
      const workingDirectory = (p.workingDirectory as string) || '';
      return (await readHostSessionRows()).filter((row) => row.working_directory === workingDirectory);
    }

    case 'session:listByParentId': {
      return readHostSessionRows({ parentSessionId: p.parentId as string });
    }

    // Plan 504 — session tool minimal loop. The worker calls
    // sessionDb.spawn; MAIN creates a real project-scoped child session row,
    // records parent→child lineage, and fires an ASYNC ordinary agent run via
    // runPromptInSession (the same POST /sessions/:id/chat cron uses). Returns
    // immediately with the child session id; the child's completion/failure
    // wakes the parent through a background_notification mailbox row.
    case 'session:spawn': {
      let workingDirectory = p.workingDirectory as string | undefined;
      const prompt = p.prompt as string | undefined;
      const parentSessionId = p.parentSessionId as string | undefined;
      if (!workingDirectory || !prompt || !parentSessionId) {
        return { ok: false, reason: 'missing_required_fields' };
      }

      const checkoutService = getDesktopCheckoutService();
      if (p.use_worktree !== undefined && typeof p.use_worktree !== 'boolean') return { ok: false, reason: 'invalid_use_worktree' };
      for (const key of ['source_branch', 'branch_name']) if (p[key] !== undefined && (typeof p[key] !== 'string' || !String(p[key]).trim())) return { ok: false, reason: `invalid_${key}` };
      const parentCursor = checkoutService.read(parentSessionId);
      const isolated = p.use_worktree === true || (p.use_worktree === undefined && Boolean(parentCursor.checkout));
      if (!isolated && (p.source_branch !== undefined || p.branch_name !== undefined)) return { ok: false, reason: 'independent_branch_requires_worktree' };
      if (!trustedAttempt || trustedAttempt.sessionId !== parentSessionId) return { ok: false, reason: 'caller_attempt_not_current' };
      if (path.resolve(workingDirectory) !== path.resolve(parentCursor.cwd)) return { ok: false, reason: 'working_directory_must_match_parent' };
      workingDirectory = parentCursor.cwd;

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
      const permissionMode = await getDesktopHostSessionApi().resolveSessionPermissionProfile({
        parentSessionId,
      });
      const childInput = ipcSessionToCoreCreate(
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
      );
      const hostApi = getDesktopHostSessionApi();
      const parent = await hostApi.get(parentSessionId, { includeAllSessions: true });
      const workspace = parent?.workspace.state === 'bound' ? parent.workspace : await hostApi.registerLocalDirectory(workingDirectory);
      const hostCreate: Parameters<typeof hostApi.create>[0] = {
        id: childInput.id,
        workspaceId: workspace.workspaceId,
        workspaceRootId: workspace.rootId,
        workspaceRelativePath: workspace.relativePath,
        ...(childInput.title !== undefined ? { title: childInput.title } : {}),
        ...(childInput.status !== undefined ? { status: childInput.status } : {}),
        ...(childInput.model !== undefined ? { model: childInput.model } : {}),
        ...(childInput.providerId !== undefined ? { providerId: childInput.providerId } : {}),
        ...(childInput.mode !== undefined ? { mode: childInput.mode } : {}),
        ...(childInput.permissionMode !== undefined
          ? { permissionMode: childInput.permissionMode as NonNullable<Parameters<typeof hostApi.create>[0]['permissionMode']> }
          : {}),
        ...(childInput.parentSessionId !== undefined ? { parentSessionId: childInput.parentSessionId } : {}),
        spawn: { type: 'session', reason: 'session-tool' },
        ...(childInput.agentType !== undefined ? { agentType: childInput.agentType } : {}),
        ...(childInput.createdAt !== undefined ? { createdAt: childInput.createdAt } : {}),
      };
      await hostApi.create(hostCreate);
      let checkoutResult;
      try {
        checkoutResult = await checkoutService.createChildCheckout(childId, workingDirectory, trustedAttempt, isolated,
          p.source_branch as string | undefined, p.branch_name as string | undefined);
        workingDirectory = checkoutResult.state.cwd;
      } catch (error) {
        await hostApi.update(childId, undefined, { status: 'error' });
        return { ok: false, reason: error instanceof Error ? error.message : String(error), sessionId: childId };
      }

      // Surface in the sidebar without a manual refresh (same as session:ensureBot).
      // `allBrowserWindows` yields none on a headless host (no renderer to
      // notify), which is what the previous catch around this loop reported.
      for (const window of allBrowserWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('sync:threads-changed');
        }
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

      return { ok: true, sessionId: childId, parentId: parentSessionId, workingDirectory,
        ...(isolated ? { isolation: 'worktree', checkout: checkoutResult.state.checkout,
          branchName: p.branch_name ?? `duya/session/${childId.replace(/[^A-Za-z0-9._-]/g, '-')}` } : {}) };
    }

    // Plan 504 Phase 2 — continuous session management. All `session:spawn*`
    // actions scope to sessions the caller spawned (child.parentSessionId ===
    // caller), matching grok's launchedIds ownership gate so one session cannot
    // prod another session's children.

    case 'session:spawnList': {
      const parentSessionId = p.parentSessionId as string | undefined;
      if (!parentSessionId) return { ok: false, reason: 'missing_parentSessionId' };
      const children = await readHostSessionRows({ parentSessionId });
      return { ok: true, sessions: children };
    }

    case 'session:spawnGet': {
      const sessionId = p.sessionId as string | undefined;
      const callerSessionId = p.callerSessionId as string | undefined;
      if (!sessionId || !callerSessionId) return { ok: false, reason: 'missing_ids' };
      const session = await readHostSessionRow(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parent_session_id !== callerSessionId) {
        return { ok: false, reason: 'not_owned' };
      }
      // Diff statistics come from the latest turn review (duya's own +N/-M
      // capture; aggregate across all saved reviews as a cumulative total).
      let linesAdded = 0;
      let linesRemoved = 0;
      let filesChanged = 0;
      try {
        const stats = await getDesktopHostSessionApi().getSessionChangeStats(sessionId);
        linesAdded = stats.linesAdded;
        linesRemoved = stats.linesRemoved;
        filesChanged = stats.filesChanged;
      } catch {
        // chat_turn_reviews absent / unreadable — stats default to zero.
      }
      return {
        ok: true,
        session: {
          id: sessionId,
          title: (session.title as string | null | undefined) ?? '',
          status: (session.status as string | null | undefined) ?? '',
          workingDirectory: (session.working_directory as string | null | undefined) ?? '',
          parentId: session.parent_session_id,
          filesChanged,
          linesAdded,
          linesRemoved,
          updatedAt: session.updated_at,
          createdAt: session.created_at,
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
      const session = await readHostSessionRow(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parent_session_id !== callerSessionId) {
        return { ok: false, reason: 'not_owned' };
      }
      const parentSessionId = callerSessionId;
      const workingDirectory = (await getDesktopCheckoutService().verifyCursor(sessionId)).cwd;
      if (!workingDirectory) return { ok: false, reason: 'no_working_directory' };

      // Reuse the same provider/model the child was created with.
      const activeLlm = getProviderStore().getDefaultLlmProvider();
      const activeProvider = activeLlm ? toLegacyApiProvider(activeLlm) : undefined;
      if (!activeLlm || !activeProvider) return { ok: false, reason: 'no_active_provider' };
      const options = (activeProvider.options ?? {}) as Record<string, unknown>;
      const model =
        (session.model as string | null | undefined) ??
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
      const session = await readHostSessionRow(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parent_session_id !== callerSessionId) return { ok: false, reason: 'not_owned' };
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
      const session = await readHostSessionRow(sessionId);
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.parent_session_id !== callerSessionId) return { ok: false, reason: 'not_owned' };
      await getDesktopHostSessionApi().update(sessionId, undefined, { title: title.trim() });
      return { ok: true, sessionId };
    }

    // ==================== Goal actions (Host API adapter) ====================
    // Plan 331: session_goals — per-session goal + token budget mirror. The
    // Agent persists token/time deltas after each turn through the Host API.
    case 'goal:get': {
      const goal = await getDesktopHostGoalApi().getGoal(p.sessionId as string);
      return goal ? coreGoalToIpcRow(goal) : undefined;
    }

    case 'goal:create': {
      const goal = await getDesktopHostGoalApi().getOrCreateGoal({
        id: p.id as string,
        sessionId: p.session_id as string,
        goalText: (p.goal_text as string | null | undefined) ?? null,
        tokenBudget: (p.token_budget as number | null | undefined) ?? null,
      });
      return coreGoalToIpcRow(goal);
    }

    case 'goal:updateBudget': {
      const goal = await getDesktopHostGoalApi().updateBudget(p.sessionId as string, {
        tokensUsedDelta: p.tokensUsedDelta as number | undefined,
        timeUsedDelta: p.timeUsedDelta as number | undefined,
      });
      return goal ? coreGoalToIpcRow(goal) : undefined;
    }

    case 'goal:setStatus': {
      const goal = await getDesktopHostGoalApi().setStatus(
        p.sessionId as string,
        p.status as 'active' | 'paused' | 'usage_limited' | 'complete',
      );
      return goal ? coreGoalToIpcRow(goal) : undefined;
    }

    case 'goal:listByStatus': {
      const goals = await getDesktopHostGoalApi().listByStatus(
        p.status as 'active' | 'paused' | 'usage_limited' | 'complete',
      );
      return goals.map(coreGoalToIpcRow);
    }

    // ==================== Mode state actions (Host API adapter) ====================
    // Plan 413c: mode_state_snapshots — per (session, mode) ModeTracker snapshot.
    // The Agent persists tracker snapshots after state transitions and restores
    // them on session resume via these actions.
    case 'modeState:get': {
      return getDesktopHostModeStateApi().getModeState(p.sessionId as string, p.mode as string);
    }

    case 'modeState:upsert': {
      return getDesktopHostModeStateApi().upsertModeState({
        sessionId: p.sessionId as string,
        mode: p.mode as string,
        status: p.status as string,
        snapshotJson: p.snapshotJson as string,
        reminderCount: (p.reminderCount as number | undefined) ?? 0,
      });
    }

    case 'modeState:setStatus': {
      return getDesktopHostModeStateApi().setModeStateStatus(
        p.sessionId as string,
        p.mode as string,
        p.status as string,
      );
    }

    case 'modeState:listBySession': {
      return getDesktopHostModeStateApi().listModeStateBySession(p.sessionId as string);
    }

    // Session search runs through Host so Desktop and CLI use the same data owner.
    case 'session:search': {
      const opts = p.opts as { limit?: number } | undefined;
      const limit = opts?.limit ?? 10;
      return searchHostSessionRows(p.query as string, limit);
    }

    case 'session:loadMessages': {
      const sessionId = p.sessionId as string;
      const messages = hostMessageItemsToIpcMessages(
        sessionId,
        await readHostMessageItems(sessionId),
      );
      const parsedDocuments = await getDesktopHostLocalAttachmentApi().getParsedDocumentsForSession(sessionId);

      return { messages, parsedDocuments };
    }

    // ==================== Message actions (core store thin forward) ====================
    // Decision 5: message:add uses INSERT OR IGNORE semantics via appendBatch
    // (same-id re-send is a no-op instead of overwriting).
    case 'message:add': {
      const event = ipcMessageToNewEvent(p.session_id as string, p as unknown as Parameters<typeof ipcMessageToNewEvent>[1]);
      await getDesktopHostSessionApi().appendTimeline(event.sessionId, { entries: [event.payload] });
      const items = await readHostMessageItems(event.sessionId);
      return hostMessageItemsToIpcMessages(event.sessionId, items).find((row) => row.id === event.id) ?? null;
    }

    case 'message:getBySession': {
      const sessionId = p.sessionId as string;
      return hostMessageItemsToIpcMessages(sessionId, await readHostMessageItems(sessionId));
    }

    // ==================== Tool approval side state (plan 498) ====================
    // Worker-side writes for durable approval cards: row creation, one-shot
    // ledger consume (from canUseTool), and always-allow rule reads.
    case 'toolApproval:create': {
      return getDesktopHostToolApprovalApi().createToolApproval({
        id: p.id as string,
        messageId: p.messageId as string,
        sessionId: p.sessionId as string,
        scopeType: (p.scopeType as 'bot' | 'session') ?? 'session',
        scopeId: p.scopeId as string,
        toolName: p.toolName as string,
        ...(p.toolInput === undefined ? {} : { toolInput: p.toolInput as Record<string, unknown> }),
      });
    }

    case 'toolApproval:consumeApproved': {
      return getDesktopHostToolApprovalApi().consumeApprovedToolApproval({
        sessionId: p.sessionId as string,
        toolName: p.toolName as string,
        inputHash: toolApprovalInputHash(p.toolInput as Record<string, unknown> | undefined),
      });
    }

    case 'toolApproval:listRules': {
      return getDesktopHostToolApprovalApi().listToolApprovalRules({
        scopeType: (p.scopeType as 'bot' | 'session') ?? 'session',
        scopeId: p.scopeId as string,
      });
    }

    // Plan 587 R2.4: the worker path's "always allow" now writes the SAME
    // durable table the bot card path already wrote. Two writers, one table,
    // one scope key -- so a grant made in the UI and a grant made by a click on
    // a permission prompt are the same kind of fact and cannot disagree.
    case 'toolApproval:upsertRule': {
      const scopeType = (p.scopeType as 'bot' | 'session') ?? 'session';
      const scopeId = p.scopeId as string;
      const toolName = p.toolName as string;
      if (scopeId === '' || toolName === '') {
        return { ok: false, error: 'toolApproval:upsertRule requires scopeId and toolName' };
      }
      await getDesktopHostToolApprovalApi().upsertToolApprovalRule({ scopeType, scopeId, toolName });
      return { ok: true };
    }

    // Plan 587 R2.4: the router's permission answer. This is the DURABLE write
    // the interactive path never made — `handlePostPermission` used to forward
    // the decision to the worker and record nothing, so a decision that reached
    // a tool call had no row saying it had been made.
    //
    // `resolveToolApproval`'s CAS is the whole late/duplicate guard: the first
    // answer wins and claims, every later one is told `claimed: false` and is
    // answered with the row that is already on record. Returns
    // `{ ok: false, error: 'not_found' }` rather than `undefined` so the caller
    // can tell "no such request" from "the bridge does not know this action".
    case 'toolApproval:resolve': {
      const decision = p.decision as 'allow' | 'always' | 'deny';
      if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
        return { ok: false, error: 'invalid_decision' };
      }
      const claimed = await getDesktopHostToolApprovalApi().resolveToolApproval(p.id as string, decision);
      if (!claimed) return { ok: false, error: 'not_found' };
      return { ok: true, claimed: claimed.claimed, row: claimed.row };
    }

    case 'message:getCount': {
      return getDesktopHostSessionApi().countTimeline(p.sessionId as string);
    }

    case 'message:deleteBySession': {
      return getDesktopHostSessionApi().deleteTimeline(p.sessionId as string);
    }

    // Decision 3: message:append maps to MessageLog.appendBatch (INSERT OR IGNORE
    // idempotency). turnId is forwarded to NewEvent.turnId for turn-scoped queries.
    case 'message:append': {
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
        const receipt = await getDesktopHostSessionApi().appendTimeline(sessionId, {
          entries: events.map((event) => event.payload),
          ...(turnId !== undefined ? { turnId } : {}),
        });

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

        return { success: true, count: receipt.writtenCount };
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
    // apps/desktop/src/main/db/core/rollout-events.ts.
    case 'journal:emit': {
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
        const receipt = await getDesktopHostSessionApi().appendTimeline(sessionId, {
          entries: [newEvent.payload],
          turnId: newEvent.turnId ?? null,
        });
        return { success: true, count: receipt.writtenCount };
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
        await getDesktopHostLocalSendMessageStateApi().createWidgetPending(
          p as unknown as CreateWidgetPendingInput,
        );
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:createWidgetPending failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:updateWidgetResponse': {
      const msgId = p.messageId as string;
      try {
        await getDesktopHostLocalSendMessageStateApi().updateWidgetResponse({
          messageId: msgId,
          status: p.status as 'pending' | 'answered' | 'dismissed',
          customAnswer: p.customAnswer as string | null | undefined,
          answeredAt: p.answeredAt as number | null | undefined,
        });
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:updateWidgetResponse failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:upsertCursorAgentRun': {
      const msgId = p.messageId as string;
      try {
        await getDesktopHostLocalSendMessageStateApi().upsertCursorAgentRun(
          p as unknown as CursorAgentRunInput,
        );
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:upsertCursorAgentRun failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:updateCursorAgentRun': {
      const msgId = p.messageId as string;
      try {
        await getDesktopHostLocalSendMessageStateApi().updateCursorAgentRun({
          messageId: msgId,
          status: p.status as 'pending' | 'running' | 'completed' | 'failed' | 'aborted',
          updatedAt: p.updatedAt as number,
        });
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:updateCursorAgentRun failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:createSecretPending': {
      const msgId = p.messageId as string;
      try {
        await getDesktopHostLocalSendMessageStateApi().createSecretPending(
          p as unknown as CreateSecretPendingInput,
        );
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:createSecretPending failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    case 'sendMessageState:markSecretProvided': {
      const msgId = p.messageId as string;
      try {
        await getDesktopHostLocalSendMessageStateApi().markSecretProvided({
          messageId: msgId,
          status: p.status as 'provided' | 'dismissed',
          providedAt: p.providedAt as number | null | undefined,
        });
        return { success: true, messageId: msgId };
      } catch (err) {
        getLogger().error('sendMessageState:markSecretProvided failed', err instanceof Error ? err : new Error(String(err)), { messageId: msgId }, LogComponent.AgentCommunicator);
        return { success: false, reason: 'transaction_failed' };
      }
    }

    // Decision 3: message:replace maps to MessageLog.appendBatch (INSERT OR IGNORE
    // idempotency). Generation optimistic lock is deprecated (append-only store).
    case 'message:replace': {
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
      const hostApi = getDesktopHostSessionApi();
      if (!(await hostApi.get(sessionId, { includeAllSessions: true }))) {
        await hostApi.create({ id: sessionId, createdAt: Date.now() });
      }

      try {
        const events: NewEvent[] = messages.map((msg) => {
          const id = (msg.id as string) || randomUUID();
          msg.id = id;
          return ipcMessageToNewEvent(sessionId, msg as unknown as Parameters<typeof ipcMessageToNewEvent>[1]);
        });
        await getDesktopHostSessionApi().appendTimeline(sessionId, {
          entries: events.map((event) => event.payload),
        });
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
      // Plan 500 P1: origin attributes the run (user chat / agent wake /
      // background automation) so the bot run scheduler can classify any
      // in-flight run before deciding to preempt it.
      const origin =
        p.origin === 'user' || p.origin === 'agent' || p.origin === 'background'
          ? p.origin
          : undefined;
      const result = await getDesktopHostLockApi().acquireLock({
        sessionId: p.sessionId as string,
        lockId: p.lockId as string,
        owner: p.owner as string,
        ttlSec: (p.ttlSec as number) || 300,
        ...(origin === undefined ? {} : { origin }),
      });
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
      return getDesktopHostLockApi().renewLock({
        sessionId: p.sessionId as string,
        lockId: p.lockId as string,
        ttlSec: (p.ttlSec as number) || 300,
      });
    }

    case 'lock:release': {
      const result = await getDesktopHostLockApi().releaseLock({
        sessionId: p.sessionId as string,
        lockId: p.lockId as string,
      });
      // Plan 476 P2.1: a released runtime lock means "this session's run
      // ended" — re-kick the wake dispatcher so background wakes that were
      // parked behind a user turn can drain now. Harmless when the session
      // has nothing queued or is still busy.
      notifySessionIdle(p.sessionId as string);
      return result;
    }

    case 'lock:isLocked': {
      return getDesktopHostLockApi().isSessionLocked(p.sessionId as string);
    }

    // Plan 500 P1: run attribution of the current lock holder (null = idle
    // or unattributed legacy row).
    case 'lock:origin': {
      return getDesktopHostLockApi().getSessionLockOrigin(p.sessionId as string);
    }

    // ==================== Task actions (Host API compatibility adapter) ====================
    case 'task:create': {
      const data = p as Parameters<typeof ipcTaskToHostCreate>[0];
      const task = await getDesktopHostTaskApi().createTask(data.session_id, ipcTaskToHostCreate(data));
      return hostTaskToIpcRow(task);
    }

    case 'task:get': {
      const task = await getDesktopHostTaskApi().getTask(p.id as string);
      return task ? hostTaskToIpcRow(task) : undefined;
    }

    case 'task:getBySession': {
      const tasks = await getDesktopHostTaskApi().listTasks(p.sessionId as string);
      return tasks.map(hostTaskToIpcRow);
    }

    case 'task:update': {
      const task = await getDesktopHostTaskApi().updateTask(p.id as string, ipcTaskToHostUpdate(p));
      return task ? hostTaskToIpcRow(task) : undefined;
    }

    case 'task:delete': {
      return getDesktopHostTaskApi().deleteTask(p.id as string);
    }

    case 'task:deleteBySession': {
      await getDesktopHostTaskApi().deleteTasksBySession(p.sessionId as string);
      return { success: true };
    }

    case 'task:claim': {
      const result = await getDesktopHostTaskApi().claimTask(p.id as string, p.owner as string);
      if (result.success && result.task) {
        return { success: true, task: hostTaskToIpcRow(result.task) };
      }
      return result;
    }

    case 'task:block': {
      return getDesktopHostTaskApi().blockTasks(p.fromId as string, p.toId as string);
    }

    case 'task:unassignTeammate': {
      return getDesktopHostTaskApi().unassignTeammateTasks(p.sessionId as string, p.owner as string);
    }

    case 'task:getByOwner': {
      const tasks = await getDesktopHostTaskApi().listTasksByOwner(p.sessionId as string, p.owner as string);
      return tasks.map(hostTaskToIpcRow);
    }

    // ==================== Settings actions ====================
    case 'setting:get': {
      return getDesktopHostLocalSettingsApi().getSetting(p.key as string);
    }

    case 'setting:set': {
      await getDesktopHostLocalSettingsApi().setSetting(p.key as string, p.value as string);
      return { success: true };
    }

    case 'setting:getAll': {
      return getDesktopHostLocalSettingsApi().getSettings();
    }

    case 'setting:getJson': {
      const value = await getDesktopHostLocalSettingsApi().getSetting(p.key as string);
      if (value === null) return p.defaultValue;
      try {
        return JSON.parse(value);
      } catch {
        return p.defaultValue;
      }
    }

    case 'setting:setJson': {
      const serialized = JSON.stringify(p.value);
      if (serialized === undefined) throw new Error('Setting value is not JSON serializable');
      await getDesktopHostLocalSettingsApi().setSetting(p.key as string, serialized);
      return { success: true };
    }

    // ==================== Permission actions (Host API) ====================
    case 'permission:create': {
      const perm = await getDesktopHostPermissionRequestApi().createPermissionRequest(
        ipcPermissionToCoreCreate(p as Parameters<typeof ipcPermissionToCoreCreate>[0]),
      );
      return corePermissionToIpcRow(perm);
    }

    case 'permission:get': {
      const perm = await getDesktopHostPermissionRequestApi().getPermissionRequest(p.id as string);
      return perm ? corePermissionToIpcRow(perm) : undefined;
    }

    case 'permission:resolve': {
      const extra = p.extra as { message?: string; updatedPermissions?: unknown[]; updatedInput?: Record<string, unknown> } | undefined;
      const resolved = await getDesktopHostPermissionRequestApi().resolvePermissionRequest(p.id as string, {
        status: p.status as 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted',
        decision: p.status as string,
        ...ipcPermissionToResolve(extra),
      });
      return resolved ? corePermissionToIpcRow(resolved) : undefined;
    }

    // ==================== Search actions (core store thin forward) ====================
    // Decision 7: combine SessionStore.search (metadata LIKE) with
    // MessageLog.searchText (rollout content scan). Returns the old
    // `s.* + snippet` shape so consumers have zero changes.
    case 'search:sessions': {
      const limit = (p.limit as number) || 10;
      return searchHostSessionRows(p.query as string, limit);
    }

    // ==================== Channel actions ====================
    case 'channel:getBindings': {
      const channelType = p.channelType as string | undefined;
      return getDesktopHostLocalChannelPersistenceApi().listChannelBindings(channelType);
    }

    case 'channel:getBinding':
      return getDesktopHostLocalChannelPersistenceApi().getChannelBinding(
        p.channelType as string,
        p.chatId as string,
      );

    case 'channel:upsertBinding': {
      return getDesktopHostLocalChannelPersistenceApi().upsertChannelBinding({
        id: p.id as string,
        channel_type: p.channel_type as string,
        chat_id: p.chat_id as string,
        duya_session_id: p.duya_session_id as string,
        ...(typeof p.sdk_session_id === 'string' ? { sdk_session_id: p.sdk_session_id } : {}),
        ...(typeof p.working_directory === 'string' ? { working_directory: p.working_directory } : {}),
        ...(typeof p.model === 'string' ? { model: p.model } : {}),
        ...(typeof p.mode === 'string' ? { mode: p.mode } : {}),
      });
    }

    case 'channel:getOffset':
      return getDesktopHostLocalChannelPersistenceApi().getChannelOffset(
        p.channelType as string,
        p.offsetKey as string,
      );

    case 'channel:setOffset': {
      await getDesktopHostLocalChannelPersistenceApi().setChannelOffset({
        channelType: p.channelType as string,
        offsetKey: p.offsetKey as string,
        offsetValue: p.offsetValue as string,
        offsetType: (p.offsetType as string | undefined) || 'long_polling',
      });
    }

    // ==================== Project actions ====================
    case 'project:getGroups': {
      // Plan 328 Phase 5: aggregate from core SessionStore.
      // Plan 525: sessions of one multi-path project entity merge into a
      // single group whose working_directory is the entity's canonical
      // root (paths[0]); sessions in projects without an entity keep the
      // per-path grouping.
      const all = await readAllHostLocalSessions();
      const normalizeForMatch = (value: string): string =>
        value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

      // Best-effort entity lookup through the Host-owned project API.
      let entityByPath: Map<string, { projectId: string; canonicalRoot: string; name: string }>;
      try {
        const projects = await getDesktopHostProjectApi().listProjects();
        entityByPath = new Map();
        for (const row of projects) {
          for (const entry of row.paths) {
            entityByPath.set(normalizeForMatch(entry.path), {
              projectId: row.project_id,
              canonicalRoot: row.paths[0]?.path ?? entry.path,
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
      return getDesktopHostLocalSessionApi().listLocalSessionSummariesByPrefix({
        idPrefix: `cron:${input.cronId}:`,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      });
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
      const capability = await store.resolveRuntimeCapability(runtimeLlm.id, resolvedModelId);
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
        const rows = await getDesktopHostProjectApi().listProjects();
        // Normalize the cwd through the same algorithm as the stored
        // path entries. `normalizePath` swallows realpath failures
        // (ELOOP / ENOENT / EACCES) and falls back to lexical resolve,
        // so cwd for a fresh chat on a not-yet-created directory still
        // matches a stored entry created from the same lexical form.
        const cwdNorm = normalizePath(sessionCwd).absolute_normalized_path;
        const hit = rows.find((row) => row.paths.some((entry) => entry.path === cwdNorm));
        if (!hit) return { projectId: null, additionalRoots: [] };
        // L2 hardening: only inject roots that the project actually
        // owns. `row.paths` is the canonical list stored in
        // `projects.paths` (already normalized by `createProject` /
        // `updateProject` since the L1 fix). Filter against the cwd
        // (already excluded) and dedupe — we never trust any extra
        // root passed in by the IPC caller (the bridge contract is
        // rooted solely in DB state).
        const cwdNormLower = cwdNorm.toLowerCase();
        const seen = new Set<string>([cwdNormLower]);
        const additionalRoots: string[] = [];
        for (const entry of hit.paths) {
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
        // Resolve the project entity home from the shared data root. The root
        // honors DUYA_TEST and DUYA_TEST_NAMESPACE so tests stay isolated.
        const projectHome = path.join(resolveDataRoot(), 'projects', hit.projectId);
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
      // S1: the legacy identity tools go through the Bot application service
      // (one writer over the config store + profile.json), answering the
      // legacy `{ id, name }` shape the tools already consume.
      const service = await getDesktopBotService();
      const receipt = await service.createBot({
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
      });
      getLogger().info(
        `Agent created via CreateAgent tool: '${receipt.id}' (${input.name.trim()})`,
        { agentId: receipt.id },
        LogComponent.AgentProcess,
      );
      return { id: receipt.id, name: receipt.name };
    }

    case 'config:agents:update': {
      const input = p as { agentId?: string; name?: string; description?: string };
      if (!input.agentId) {
        throw new Error('agentId is required');
      }
      const service = await getDesktopBotService();
      const receipt = await service.updateBot({
        id: input.agentId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      });
      getLogger().info(
        `Agent updated via UpdateAgent tool: '${input.agentId}'`,
        { agentId: input.agentId },
        LogComponent.AgentProcess,
      );
      return { id: receipt.id, name: receipt.name };
    }

    // ==================== Bot application (S1) ====================
    // The typed Bot surface: same service as the legacy actions above, full
    // receipts and structured revision conflicts. BotServiceError already
    // carries `[code] message`, so the transport's error string stays
    // machine-readable without a new wire shape.
    case 'bot:create': {
      const input = p as { name?: string; description?: string; requestId?: string };
      if (!input.name || !input.name.trim()) {
        throw new BotServiceError('bot_invalid_name', 'bot name is required');
      }
      const service = await getDesktopBotService();
      return service.createBot({
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      });
    }
    case 'bot:update': {
      const input = p as { botId?: string; agentId?: string; name?: string; description?: string; expectedRevision?: number };
      const botId = input.botId ?? input.agentId;
      if (!botId) {
        throw new BotServiceError('bot_not_found', 'botId is required');
      }
      const service = await getDesktopBotService();
      return service.updateBot({
        id: botId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      });
    }
    case 'bot:get': {
      const input = p as { botId?: string; agentId?: string };
      const botId = input.botId ?? input.agentId;
      if (!botId) {
        throw new BotServiceError('bot_not_found', 'botId is required');
      }
      const service = await getDesktopBotService();
      return service.getBot(botId);
    }
    case 'bot:list': {
      const service = await getDesktopBotService();
      return service.listBots();
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
      const bindings = await getDesktopHostLocalChannelPersistenceApi().listChannelBindings();

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
    // Plan 332 Phase 2: new payloads use the file-backed AttachmentStore;
    // Host also projects older parsed-document rows from `message_attachments`.
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

      return getDesktopHostLocalAttachmentApi().storeParsedDocument({
        messageId,
        sessionId,
        filename,
        filePath,
        charCount,
        text,
        ...(extractMethod === undefined ? {} : { extractMethod }),
        ...(imageChunks === undefined ? {} : { imageChunks }),
      });
    }

    case 'attachment:getForSession': {
      const sessionId = p.sessionId as string;
      return getDesktopHostLocalAttachmentApi().getParsedDocumentsForSession(sessionId);
    }

    case 'attachment:getImagesForSession': {
      const sessionId = p.sessionId as string;
      return getDesktopHostLocalAttachmentApi().getImageAttachmentsForSession(sessionId);
    }

    case 'attachment:getForMessage': {
      const messageId = p.messageId as string;
      return getDesktopHostLocalAttachmentApi().getParsedDocumentsForMessage(messageId);
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
      return getDesktopHostLocalPluginSetupApi().listPluginSetupValues();
    }

    case 'modelCapability:get': {
      const modelName = (p.modelName as string).trim().toLowerCase();
      return getDesktopHostLocalModelCapabilityApi().getModelCapability(modelName);
    }

    case 'modelCapability:set': {
      const modelName = (p.modelName as string).trim().toLowerCase();
      const method = (p.method as string) || 'unknown';
      return getDesktopHostLocalModelCapabilityApi().setModelCapability({
        modelName,
        isMultimodal: Boolean(p.isMultimodal),
        method,
      });
    }

    case 'modelCapability:delete': {
      const modelName = (p.modelName as string).trim().toLowerCase();
      return getDesktopHostLocalModelCapabilityApi().deleteModelCapability(modelName);
    }

    // ==================== Mailbox actions (core store thin forward) ====================
    // Plan 328 Phase 3: all mailbox cases forward to the Mailbox core store via
    // core-db-adapters. DTO shape (snake_case flat row) is preserved so the
    // Worker code has zero changes. The apply matrix is enforced by
    // Mailbox.assertApplyAllowed (single source of truth, Plan 202 §5.2).
    case 'mailbox:send': {
      const item = await getDesktopHostLocalMailboxApi().enqueue({
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
      const mailbox = getDesktopHostLocalMailboxApi();
      const existing = await mailbox.getItem(p.id as string);
      if (!existing) return null;
      // Retry-safe: if the row was already promoted as queued_for_next_agent_turn,
      // return it unchanged so the renderer's retry is idempotent.
      if (existing.status === 'applied' && existing.appliedSummary === 'queued_for_next_agent_turn') {
        return coreMailboxToIpcRow(existing);
      }
      const previousContent = existing.content;
      const edited = await mailbox.edit(p.id as string, {
        content: p.content as string | undefined,
        kind: p.kind as MailboxKind | undefined,
      });
      if (!edited) return null;
      const row = coreMailboxToIpcRow(edited);
      emitMailboxEvent('emitMailEdited', row, previousContent);
      return row;
    }

    case 'mailbox:guide': {
      const mailbox = getDesktopHostLocalMailboxApi();
      const existing = await mailbox.getItem(p.id as string);
      if (!existing) return null;
      const previousContent = existing.content;
      const guided = await mailbox.guide(p.id as string);
      if (!guided) return null;
      const row = coreMailboxToIpcRow(guided);
      emitMailboxEvent('emitMailEdited', row, previousContent);
      return row;
    }

    case 'mailbox:promoteQueued': {
      const row = await getDesktopHostLocalMailboxApi().promoteQueued(p.id as string);
      if (!row) return null;
      emitMailboxEvent('emitMailApplied', coreMailboxToIpcRow(row));
      return coreMailboxToIpcRow(row);
    }

    case 'mailbox:cancel': {
      const mailbox = getDesktopHostLocalMailboxApi();
      const reason = p.reason as string | undefined;
      const cancelled = await mailbox.cancel(p.id as string, reason);
      if (!cancelled) return null;
      const row = coreMailboxToIpcRow(cancelled);
      emitMailboxEvent('emitMailCancelled', row, reason);
      return row;
    }

    case 'mailbox:list': {
      const mailbox = getDesktopHostLocalMailboxApi();
      const limit = (p.limit as number) ?? 50;
      const statuses = p.status as MailboxStatus[] | undefined;
      const items = await mailbox.listMailboxItems(p.sessionId as string, { status: statuses, limit });
      return items.map(coreMailboxToIpcRow);
    }

    case 'mailbox:listForSession': {
      const items = await getDesktopHostLocalMailboxApi().listMailboxItemsForSession(p.sessionId as string);
      return items.map(coreMailboxToIpcRow);
    }

    case 'mailbox:claimBatch': {
      const result = await getDesktopHostLocalMailboxApi().claimBatch({
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
      const item = await getDesktopHostLocalMailboxApi().apply({
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
      const mailbox = getDesktopHostLocalMailboxApi();
      const reason = (p.reason as string | undefined) ?? 'cancelled_by_agent';
      const cancelled = await mailbox.cancelByAgent({
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

      const input: TurnReviewWriteInput = {
        id: typeof p.id === 'string' ? p.id : randomUUID(),
        sessionId,
        turnId,
        workingDirectory,
        files: files as TurnReviewFile[],
        patch,
        additions: typeof p.additions === 'number' ? p.additions : 0,
        removals: typeof p.removals === 'number' ? p.removals : 0,
        truncated: p.truncated === true,
        binary: p.binary === true,
        capturedAt: typeof p.capturedAt === 'number' ? p.capturedAt : now,
      };
      await getDesktopHostLocalTurnReviewApi().saveTurnReview(input);
      return true;
    }

    case 'turn-suggestion:save': {
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
      const turnId = typeof p.turnId === 'string' ? p.turnId : '';
      const suggestion = typeof p.suggestion === 'string' ? p.suggestion : '';
      if (!sessionId || !turnId) {
        throw new Error('Invalid turn suggestion payload');
      }

      const input: TurnSuggestionWriteInput = {
        id: typeof p.id === 'string' ? p.id : randomUUID(),
        sessionId,
        turnId,
        suggestion,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : now,
      };
      await getDesktopHostLocalTurnSuggestionApi().saveTurnSuggestion(input);
      return true;
    }

    // ─── Workflow runs (plan 552 Phase 4) ───
    case 'workflowRun:create': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
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
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.getRun(p.id as string);
    }
    case 'workflowRun:getByDedupKey': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.getRunByDedupKey(p.dedupKey as string);
    }
    case 'workflowRun:list': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
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
      const workflowRuns = getDesktopHostWorkflowRunApi();
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
      const workflowRuns = getDesktopHostWorkflowRunApi();
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
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.latestEventSeq(p.runId as string);
    }
    case 'workflowRun:listEvents': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.listEvents(p.runId as string, (p.afterSeq as number | undefined) ?? -1);
    }
    case 'workflowRun:setWaitTill': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.setWaitTill(p.id as string, (p.waitTill as number | null | undefined) ?? null);
    }
    case 'workflowRun:setVersionId': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.setVersionId(p.id as string, p.versionId as string);
    }
    case 'workflowRun:listWaitingPast': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.listWaitingPast(p.now as number);
    }
    case 'workflowRun:reconcileStale': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.reconcileStaleRuns((p.activeRunIds as string[]) ?? []);
    }
    case 'workflowRun:saveSnapshot': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.saveSnapshot({
        runId: p.runId as string,
        definition: p.definition,
        ...(typeof p.definitionHash === 'string' ? { definitionHash: p.definitionHash } : {}),
        ...(p.definitionHashSource === 'dag' || p.definitionHashSource === 'dwf-script'
          ? { definitionHashSource: p.definitionHashSource } : {}),
        nodeStack: (p.nodeStack as WorkflowRunSnapshot['nodeStack']) ?? [],
        journal: (p.journal as WorkflowRunSnapshot['journal']) ?? [],
      });
    }
    case 'workflowRun:loadSnapshot': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.loadSnapshot(p.runId as string);
    }
    case 'workflowRun:appendJournal': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.appendJournalRecord(p.runId as string, p.record as WorkflowRunSnapshot['journal'][number]);
    }
    case 'workflowRun:replaceJournal': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.replaceJournal(p.runId as string, (p.records as WorkflowRunSnapshot['journal']) ?? []);
    }
    case 'workflowRun:loadJournal': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.loadJournal(p.runId as string);
    }
    case 'workflowRun:delete': {
      const workflowRuns = getDesktopHostWorkflowRunApi();
      return workflowRuns.deleteRun(p.id as string);
    }

    default:
      throw new Error(`Unknown DB action: ${action}`);
  }
}

// Handle DB request from Agent
export async function handleDbRequest(msg: DbRequest, sender?: CommandSenderFacts): Promise<DbResponse> {
  const { id, action, payload } = msg;

  try {
    // The trusted Plugin App attempt is NOT read from the request body. A
    // worker owns the body it sends, so an attempt claim inside it is that
    // worker's own claim about its identity. Only the transport that actually
    // correlated the worker with the orchestrator's live attempt may supply
    // one, and it does so through the sender facts.
    const result = await dispatchDbAction(action, payload, sender, sender?.trustedAttempt);
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
