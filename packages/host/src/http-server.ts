import { timingSafeEqual } from 'node:crypto';
import { logger } from '@duya/host/worker-logger';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  HostLocalSessionImportApiV1,
  HostLocalSessionImportInput,
  HostLocalRolloutImportInput,
  HostSessionApiV1,
  HostSessionCreateInput,
  HostSessionPatch,
  HostSessionListQuery,
  HostMessageReadQuery,
  HostSessionPermissionProfileInput,
  HostLocalParsedDocumentInput,
  HostLocalImageAttachment,
  HostLocalSessionSummaryQuery,
  HostTimelineAppendInput,
  HostWorkspaceRegistrationApiV1,
} from '@duya/agent-protocol/session-api';
import type {
  AgentRunOrigin,
  CreateAgentRunInput,
  HostRunApiV1,
  HostRunExecutionApiV1,
  HostTaskApiV1,
  HostProjectApiV1,
  HostProjectCreateInput,
  HostProjectPatch,
  HostProjectPathEntry,
  JsonObject,
  RunEventEnvelope,
  RunId,
  SessionId,
  RunMetrics,
  RunTerminalState,
  RunAttemptFence,
  SettleAgentRunResult,
  StartAgentRunInput,
  PermissionPolicyMode,
  PermissionRulesWire,
  FileAttachment,
  TaskCreateInput,
  TaskId,
  TaskStatus,
  TaskUpdateInput,
  UnfencedRunWriteAuthorization,
  WorkspaceId,
} from '@duya/agent-protocol';
import {
  CURRENT_VERSION,
  HOST_CAPABILITIES,
  HOST_CAPABILITY_OWNERS,
  PROTOCOL_SCHEMA_REVISION,
  isPermissionPolicyMode,
  isProtocolCapability,
  type HostCapability,
  type HostIdentity,
  type ProtocolCapability,
} from '@duya/agent-protocol';
import type {
  HostPermissionRequestApiV1,
  HostPermissionRequestCreateInput,
  HostPermissionRequestResolveInput,
  HostPermissionRequestStatus,
} from '@duya/agent-protocol';
import type {
  HostToolApprovalApiV1,
  HostToolApprovalDecision,
  HostToolApprovalInput,
  HostToolApprovalScopeType,
} from '@duya/agent-protocol';
import type { HostCheckoutApiV1, HostIntegrationApiV1, HostLockApiV1 } from '@duya/agent-protocol';
import { HostCheckoutApiError } from './checkout-api.js';
import type { IntegrationSync } from './scm/sync.js';
import type { DurableTimelineEntry } from '@duya/agent-protocol/rollout-events';
import type { JournalRecord } from '@duya/agent-protocol';
import type { GoalCreateInput, GoalStatus, HostGoalApiV1 } from '@duya/agent-protocol/goals';
import type { HostModeStateApiV1, ModeStateUpsertInput } from '@duya/agent-protocol/mode-state';
import type {
  WorkflowArtifactRef,
  WorkflowRunApiV1,
  WorkflowRunCreateInput,
  WorkflowRunFilter,
  WorkflowRunOrigin,
  WorkflowRunOutcomeInput,
  WorkflowRunScope,
  WorkflowRunSnapshotSaveInput,
  WorkflowRunStatus,
  WorkflowTriggerKind,
} from '@duya/agent-protocol/workflow-runs';
import type { HostLocalSessionApiV1 } from './local-session-api.js';
import type {
  HostLocalProjectApiV1,
  HostLocalProjectResolutionInput,
} from './local-project-api.js';
import { HostLocalRolloutApiError, type HostLocalRolloutApiV1 } from './local-rollout-api.js';
import { HostWorkspaceFileApiError, type HostLocalWorkspaceFileApiV1 } from './local-workspace-file-api.js';
import type { HostLocalAttachmentApiV1 } from '@duya/agent-protocol/session-api';
import type { HostLocalSettingsApiV1 } from '@duya/agent-protocol/session-api';
import type { GatewayUserMappingInput, HostLocalGatewayUserMapApiV1 } from '@duya/agent-protocol/gateway-user-map';
import type {
  ChannelBindingInput,
  ChannelOffsetInput,
  HostLocalChannelPersistenceApiV1,
  WeixinContextTokenInput,
} from '@duya/agent-protocol/channel-persistence';
import type {
  AgentProfileCreateInput,
  AgentProfilePromptOverride,
  AgentProfileUpdateInput,
  HostLocalAgentProfileApiV1,
} from '@duya/agent-protocol/agent-profiles';
import type {
  GatewayChannelDirectoryEntry,
  HostLocalGatewayDirectoryApiV1,
} from '@duya/agent-protocol/gateway-directory';
import type { HostLocalGatewayAllowlistApiV1 } from '@duya/agent-protocol/gateway-allowlist';
import type {
  GatewayMessageMirrorInput,
  HostLocalGatewayMessageMirrorApiV1,
} from '@duya/agent-protocol/gateway-message-mirror';
import type {
  GatewayThreadWriteInput,
  HostLocalGatewayThreadApiV1,
} from '@duya/agent-protocol/gateway-threads';
import type {
  CreateSecretPendingInput,
  CreateWidgetPendingInput,
  CursorAgentRunInput,
  HostLocalSendMessageStateApiV1,
  MarkSecretProvidedInput,
  UpdateCursorAgentRunInput,
  UpdateWidgetResponseInput,
} from '@duya/agent-protocol/send-message-state';
import type {
  HostLocalModelCapabilityApiV1,
  ModelCapabilityWriteInput,
} from '@duya/agent-protocol/model-capabilities';
import type {
  HostLocalProviderModelCapabilityApiV1,
  ProviderModelCapabilityRecord,
} from '@duya/agent-protocol/model-capabilities';
import type { HostLocalProviderCatalogApiV1 } from '@duya/agent-protocol/provider-catalog';
import type {
  HostAppConnectionStatus,
  HostAppConnectionWriteInput,
  HostLocalAppConnectionApiV1,
} from '@duya/agent-protocol/app-connections';
import type { HostLocalPluginSetupApiV1 } from '@duya/agent-protocol/plugin-setup';
import type { HostPluginAppInstanceApiV1 } from '@duya/agent-protocol';
import { HostPluginAppInstanceApiError } from './local-plugin-app-instance-api.js';
import { routePluginAppInstances } from './plugin-app-instance-routes.js';
import type { HostPluginAppInvocationApiV1 } from '@duya/agent-protocol';
import { routePluginAppInvocations } from './plugin-app-invocation-routes.js';
import type { HostPluginAppGrantApiV1 } from '@duya/agent-protocol';
import { routePluginAppGrants } from './plugin-app-grant-routes.js';
import type {
  HostLocalSidebarSectionsApiV1,
  SidebarSectionCreateInput,
  SidebarSectionPatch,
} from '@duya/agent-protocol/sidebar-sections';
import type { HostLocalUsageApiV1 } from '@duya/agent-protocol/usage-api';
import type {
  CreateHostImportBatchInput,
  CreateHostImportBatchItemInput,
  HostLocalImportBatchApiV1,
} from '@duya/agent-protocol/import-batches';
import type {
  HostLocalTurnReviewApiV1,
  TurnReviewFile,
  TurnReviewFileStatus,
  TurnReviewWriteInput,
} from '@duya/agent-protocol/turn-review';
import type {
  HostLocalTerminalHistoryApiV1,
  TerminalHistoryQuery,
  TerminalHistoryRecordInput,
} from '@duya/agent-protocol/terminal-history';
import type {
  HostLocalMailboxApiV1,
  HostMailboxApplyMode,
  HostMailboxCheckpoint,
  HostMailboxEnqueueInput,
  HostMailboxKind,
  HostMailboxStatus,
} from '@duya/agent-protocol/mailbox';
import type {
  HostLocalPendingWakeApiV1,
  HostPendingWakeInput,
  HostPendingWakeKind,
  HostPendingWakeLane,
} from '@duya/agent-protocol';
import { HostSessionApiError } from './session-api.js';
import { HostTaskApiError } from './task-api.js';
import { HostRunApiError } from './run-api.js';
import { HostProjectApiError } from './project-api.js';
import { isHostResearchAction, type HostResearchApiV1 } from '@duya/agent-protocol/research-api';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_BODY_LIMIT = 16 * 1024 * 1024;
const SESSION_PERMISSION_PROFILES = new Set(['default', 'auto', 'full_access']);
const PERMISSION_REQUEST_STATUSES = new Set(['pending', 'allow', 'deny', 'timeout', 'aborted']);
const HOST_MAILBOX_KINDS: readonly HostMailboxKind[] = ['queued', 'followup', 'background_notification', 'agent_dm'];
const HOST_MAILBOX_STATUSES: readonly HostMailboxStatus[] = ['pending', 'observed', 'applied', 'cancelled'];
const HOST_MAILBOX_APPLY_MODES: readonly HostMailboxApplyMode[] = [
  'promote_to_user_message',
  'runtime_instruction',
  'tool_guard',
  'permission_context',
  'interrupt_signal',
  'deferred_to_next_turn',
];
const HOST_MAILBOX_CHECKPOINTS: readonly HostMailboxCheckpoint[] = [
  'before_model_turn',
  'after_model_turn',
  'before_tool_call',
  'after_tool_call',
  'before_file_write',
  'before_shell_command',
  'before_final_answer',
  'on_permission_request',
  'on_error_recovery',
];
const HOST_PENDING_WAKE_KINDS: readonly HostPendingWakeKind[] = [
  'task.completion',
  'automation.fire',
  'connector.inbound',
  'broadcast',
  'user.message',
  'agent.dm',
];
const HOST_PENDING_WAKE_LANES: readonly HostPendingWakeLane[] = ['user', 'agent', 'background'];

function isMailboxRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isHostMailboxKind(value: unknown): value is HostMailboxKind {
  return typeof value === 'string' && HOST_MAILBOX_KINDS.includes(value as HostMailboxKind);
}

function isHostMailboxStatus(value: unknown): value is HostMailboxStatus {
  return typeof value === 'string' && HOST_MAILBOX_STATUSES.includes(value as HostMailboxStatus);
}

function isHostPendingWakeKind(value: unknown): value is HostPendingWakeKind {
  return typeof value === 'string' && HOST_PENDING_WAKE_KINDS.includes(value as HostPendingWakeKind);
}

function isHostPendingWakeLane(value: unknown): value is HostPendingWakeLane {
  return typeof value === 'string' && HOST_PENDING_WAKE_LANES.includes(value as HostPendingWakeLane);
}

function isHostMailboxApplyMode(value: unknown): value is HostMailboxApplyMode {
  return typeof value === 'string' && HOST_MAILBOX_APPLY_MODES.includes(value as HostMailboxApplyMode);
}

function isHostMailboxCheckpoint(value: unknown): value is HostMailboxCheckpoint {
  return typeof value === 'string' && HOST_MAILBOX_CHECKPOINTS.includes(value as HostMailboxCheckpoint);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isStringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((entry) => isBoundedString(entry, 1, maxLength));
}

function isAgentProfilePromptOverride(value: unknown): value is AgentProfilePromptOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.disableSections === undefined || isStringList(record.disableSections, 200, 100)) &&
    (record.enableSections === undefined || isStringList(record.enableSections, 200, 100));
}

function isAgentProfileMutation(value: Record<string, unknown>, includeCreateFields: boolean): boolean {
  const stringFields: ReadonlyArray<readonly [string, number, number]> = [
    ['name', 1, 200],
    ['description', 0, 5000],
    ['prompt_system', 1, 200],
    ['default_model', 1, 300],
    ['profile_kind', 1, 64],
  ];
  for (const [key, min, max] of stringFields) {
    if (key in value && value[key] !== null && !isBoundedString(value[key], min, max)) return false;
  }
  for (const key of ['allowed_tools', 'disallowed_tools']) {
    if (key in value && value[key] !== null && !isStringList(value[key], 500, 200)) return false;
  }
  if ('prompt_profile' in value && value.prompt_profile !== null && !isAgentProfilePromptOverride(value.prompt_profile)) {
    return false;
  }
  for (const key of ['is_enabled', ...(includeCreateFields ? ['user_visible', 'is_preset'] : [])]) {
    if (key in value && value[key] !== null && typeof value[key] !== 'boolean') return false;
  }
  if (includeCreateFields && 'id' in value && !isBoundedString(value.id, 1, 200)) return false;
  return true;
}

export interface HostSessionHttpServerOptions {
  readonly api: HostSessionApiV1;
  /** Local Desktop compatibility projection; standalone/remote Hosts omit it. */
  readonly localSessionApi?: HostLocalSessionApiV1;
  /** Local-only workspace path resolution; remote clients use Workspace IDs. */
  readonly localProjectApi?: HostLocalProjectApiV1;
  /** Local file import capability; remote APIs must use an upload contract. */
  readonly localRolloutApi?: HostLocalRolloutApiV1;
  /** Local-only parsed-document projection, including local filesystem paths. */
  readonly localAttachmentApi?: HostLocalAttachmentApiV1;
  /** Local-only settings access; values may contain credentials. */
  readonly localSettingsApi?: HostLocalSettingsApiV1;
  /** Local-only Gateway chat/session identity mappings. */
  readonly localGatewayUserMapApi?: HostLocalGatewayUserMapApiV1;
  /** Local-only session channel bindings and adapter offsets. */
  readonly localChannelPersistenceApi?: HostLocalChannelPersistenceApiV1;
  /** Local-only persisted Agent profile CRUD. */
  readonly localAgentProfileApi?: HostLocalAgentProfileApiV1;
  /** Local-only adapter-discovered Gateway channel directory. */
  readonly localGatewayDirectoryApi?: HostLocalGatewayDirectoryApiV1;
  /** Local-only Gateway sender allow-list with atomic Data-store mutations. */
  readonly localGatewayAllowlistApi?: HostLocalGatewayAllowlistApiV1;
  /** Local-only Gateway delivery-mirror transcript writes. */
  readonly localGatewayMessageMirrorApi?: HostLocalGatewayMessageMirrorApiV1;
  /** Local-only legacy Gateway thread-roster projection. */
  readonly localGatewayThreadApi?: HostLocalGatewayThreadApiV1;
  /** Local-only persistence for interactive message-card state. */
  readonly localSendMessageStateApi?: HostLocalSendMessageStateApiV1;
  /** Local-only access to the cached model-capability registry. */
  readonly localModelCapabilityApi?: HostLocalModelCapabilityApiV1;
  /** Local-only persistence for provider/model capability overrides. */
  readonly localProviderModelCapabilityApi?: HostLocalProviderModelCapabilityApiV1;
  /** Local-only read of the configured provider/model catalog. */
  readonly localProviderCatalogApi?: HostLocalProviderCatalogApiV1;
  /** Local-only persisted App Connection metadata; never includes credentials. */
  readonly localAppConnectionApi?: HostLocalAppConnectionApiV1;
  /** Local-only access to plugin setup values, which may contain credentials. */
  readonly localPluginSetupApi?: HostLocalPluginSetupApiV1;
  readonly pluginAppInstanceApi?: HostPluginAppInstanceApiV1;
  readonly pluginAppGrantApi?: HostPluginAppGrantApiV1;
  readonly pluginAppInvocationApi?: HostPluginAppInvocationApiV1;
  /** Local-only sidebar groups; project paths are local filesystem values. */
  readonly localSidebarSectionsApi?: HostLocalSidebarSectionsApiV1;
  /** Local-only usage source index; includes user session metadata and pricing. */
  readonly localUsageApi?: HostLocalUsageApiV1;
  /** Local-only import history and rollback metadata. */
  readonly localImportBatchApi?: HostLocalImportBatchApiV1;
  /** Local-only review history; payloads contain raw paths and patch contents. */
  readonly localTurnReviewApi?: HostLocalTurnReviewApiV1;
  /** Local-only command history; values may contain user-entered secrets. */
  readonly localTerminalHistoryApi?: HostLocalTerminalHistoryApiV1;
  /** Local-only mailbox persistence and run-loop state transitions. */
  readonly localMailboxApi?: HostLocalMailboxApiV1;
  /** Local-only durable wake queue markers. */
  readonly localPendingWakeApi?: HostLocalPendingWakeApiV1;
  readonly workflowRunApi?: WorkflowRunApiV1;
  readonly runApi?: HostRunApiV1;
  /** Host-owned execution: start/cancel real runs (plan 12 gate 3). */
  readonly runExecutionApi?: HostRunExecutionApiV1;
  readonly goalApi?: HostGoalApiV1;
  readonly modeStateApi?: HostModeStateApiV1;
  readonly taskApi: HostTaskApiV1;
  readonly projectApi?: HostProjectApiV1;
  readonly permissionRequestApi?: HostPermissionRequestApiV1;
  readonly toolApprovalApi?: HostToolApprovalApiV1;
  readonly lockApi?: HostLockApiV1;
  readonly researchApi?: HostResearchApiV1;
  readonly workspaceApi?: HostWorkspaceRegistrationApiV1;
  /** Local-only reads of workspace files, addressed by Workspace identity. */
  readonly workspaceFileApi?: HostLocalWorkspaceFileApiV1;
  /**
   * Checkout observation and reclaim (plan 621). Optional: a Host composed
   * without A's provider has no checkout authority, and its routes answer 404
   * with a named code instead of pretending every session is checkout-free.
   */
  readonly checkoutApi?: HostCheckoutApiV1;
  /** Observed PR/CI/review projection (plan 621). Absent answers 404, same reason. */
  readonly integrationApi?: HostIntegrationApiV1;
  /**
   * Session-level integration sync (plan 621 slice E). It is the explicit
   * "re-read GitHub now" act that writes the projection; reading
   * `integrationApi` never does. Optional for the same reason as the API
   * above: a Host without a sync implementation answers 404 with a named code
   * instead of pretending the projection is current.
   */
  readonly integrationSync?: IntegrationSync;
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  /**
   * Identity this Host answers a handshake with. Defaults to the standalone
   * headless shape, which is what `duya serve` actually is.
   *
   * Additive and optional: an existing construction keeps working and keeps the
   * old default. `kind` is a structural claim only — it must never be used to
   * infer a capability, which is what `provides` is for.
   */
  readonly identity?: HostIdentity;
}

/**
 * Host version reported by a handshake when the caller supplies no identity.
 *
 * Mirrors `packages/host/package.json`. It is a literal rather than a manifest
 * read because this module is esbuild-bundled into the packaged Host, where a
 * `package.json` lookup is not guaranteed to resolve. An embedded Host that
 * needs its own version passes `identity` instead of editing this line.
 */
const HOST_VERSION = '0.1.0';

/**
 * Bytes a single workspace file transfer may reach.
 *
 * Named here rather than in the client because only this process enforces it,
 * and a limit the client invents is a comment, not a limit.
 */
const HOST_MAX_FILE_BYTES = 32 * 1024 * 1024;

/**
 * What this Host can serve, read off the APIs it actually registered.
 *
 * Derived, never declared, for the reason `assertHostCapabilityConsistency`
 * exists: a host that lists a capability it has no channel for produces an
 * affordance that throws only when a user clicks it. The mapping is kept
 * short on purpose — a name added here without a registered API behind it is
 * exactly the promise nobody keeps.
 */
function registeredHostCapabilities(options: HostSessionHttpServerOptions): readonly HostCapability[] {
  const provided: HostCapability[] = [];
  // The core session API is required, so the control plane is always
  // authoritative for sessions and messages.
  provided.push('session_persistence');
  // Reads and writes rollout files inside the workspace. The dedicated
  // workspace-file read serves the same capability on its own, so either
  // channel is enough to advertise it — and a Host with only the file read
  // would otherwise refuse a capability it can in fact serve.
  if (options.localRolloutApi !== undefined || options.workspaceFileApi !== undefined) {
    provided.push('workspace_filesystem');
  }
  // Local settings key/value access.
  if (options.localSettingsApi) provided.push('settings_store');
  // Starting and cancelling runs needs an execution API behind the route. A
  // Host assembled for the run ledger alone cannot serve this, and advertising
  // it would make a client attach and then fail on its first turn.
  if (options.runExecutionApi !== undefined) provided.push('agent_run_execution');
  return provided;
}

/**
 * A stated reason for every capability missing from `provides`.
 *
 * A refusal the client cannot put into words is indistinguishable from a bug,
 * so every absent name carries one of two mechanically derived reasons: this
 * process cannot host a `host-local` surface, or no registered channel serves
 * the name. Nothing here is a guess about why someone might want the feature.
 */
function unsupportedReasons(
  identity: HostIdentity,
  provided: readonly HostCapability[],
): Readonly<Record<string, string>> {
  const reasons: Record<string, string> = {};
  for (const capability of HOST_CAPABILITIES) {
    if (provided.includes(capability)) continue;
    const ownedLocally = HOST_CAPABILITY_OWNERS[capability] === 'host-local';
    reasons[capability] = ownedLocally && identity.kind !== 'desktop'
      ? `Host ${identity.name} runs as ${identity.kind}, so it cannot serve the host-local capability ${capability}`
      : `Host ${identity.name} registers no channel that serves ${capability}`;
  }
  return reasons;
}

/**
 * The consume-side declaration a client sent with the handshake, if it sent one.
 *
 * Read defensively: the header is untrusted input from any authenticated
 * client, so an unparsable or partially known list yields only the names that
 * survive `isProtocolCapability`. A name the protocol does not define is
 * dropped rather than echoed, so the answer can never widen the vocabulary.
 */
function readConsumedDeclaration(req: IncomingMessage): readonly ProtocolCapability[] | null {
  const header = req.headers['x-duya-host-declaration'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8_192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const capabilities = (parsed as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities)) return null;
  return capabilities.filter(isProtocolCapability);
}

function isAppConnectionStatus(value: unknown): value is HostAppConnectionStatus {
  return value === 'disconnected' || value === 'pending' || value === 'connected' ||
    value === 'expired' || value === 'revoked' || value === 'error';
}

function isAppConnectionTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isAppConnectionWriteInput(
  value: Record<string, unknown>,
): value is Record<string, unknown> & HostAppConnectionWriteInput {
  return hasOnlyFields(value, [
    'id', 'provider', 'accountLabel', 'accountId', 'scopes', 'status', 'expiresAt', 'lastError', 'createdAt',
  ]) &&
    isBoundedString(value.id, 1, 200) &&
    isBoundedString(value.provider, 1, 200) &&
    isBoundedString(value.accountLabel, 0, 1000) &&
    isBoundedString(value.accountId, 0, 1000) &&
    Array.isArray(value.scopes) && value.scopes.length <= 200 &&
    value.scopes.every((scope) => isBoundedString(scope, 0, 500)) &&
    isAppConnectionStatus(value.status) &&
    (value.expiresAt === null || isAppConnectionTime(value.expiresAt)) &&
    (value.lastError === null || isBoundedString(value.lastError, 0, 4000)) &&
    isAppConnectionTime(value.createdAt);
}

/**
 * Authenticated loopback HTTP transport for the Host session service.
 * Public/remote deployments must terminate TLS and authenticate at a trusted
 * proxy; this server deliberately refuses direct non-loopback binding.
 */
export class HostSessionHttpServer {
  readonly #options: HostSessionHttpServerOptions;
  readonly #host: string;
  readonly #activeRunEventStreams = new Set<ServerResponse>();
  #server: Server | null = null;
  #port = 0;

  constructor(options: HostSessionHttpServerOptions) {
    this.#host = options.host ?? '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(this.#host)) {
      throw new Error(`HostSessionHttpServer refuses non-loopback binding: ${this.#host}`);
    }
    if (options.token.trim().length === 0) {
      throw new Error('HostSessionHttpServer requires a non-empty bearer token');
    }
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
      throw new Error('HostSessionHttpServer port must be an integer between 0 and 65535');
    }
    this.#options = options;
  }

  get port(): number {
    return this.#port;
  }

  get origin(): string {
    if (this.#port === 0) throw new Error('HostSessionHttpServer is not listening');
    const host = this.#host.includes(':') ? `[${this.#host}]` : this.#host;
    return `http://${host}:${this.#port}`;
  }

  async listen(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      void this.#route(req, res).catch(() => {
        if (!res.headersSent) this.#sendJson(res, 500, { error: { code: 'internal_error' } });
        else res.destroy();
      });
    });
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(this.#options.port ?? 0, this.#host, () => {
          server.off('error', onError);
          resolve();
        });
      });
      const address = server.address() as AddressInfo | null;
      if (!address) throw new Error('HostSessionHttpServer did not receive a bound address');
      this.#port = address.port;
    } catch (error) {
      this.#server = null;
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    if (!server) return;
    for (const response of this.#activeRunEventStreams) response.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  #authorise(req: IncomingMessage): { ok: true } | { ok: false; status: number; code: string } {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return { ok: false, status: 401, code: 'missing_bearer_token' };
    }
    const supplied = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.#options.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return { ok: false, status: 403, code: 'invalid_bearer_token' };
    }
    if (typeof req.headers.origin === 'string') {
      return { ok: false, status: 403, code: 'origin_not_allowed' };
    }
    return { ok: true };
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.#authorise(req);
    if (!auth.ok) {
      this.#sendJson(res, auth.status, { error: { code: auth.code } });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      this.#sendJson(res, 400, { error: { code: 'invalid_url' } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      // Host starts serving only after its configured databases open.
      // The capability fields are ADDITIVE: an older client reads `ok`,
      // `apiVersion` and `databaseReady` exactly as before.
      const identity = this.#options.identity ?? { name: 'duya-host', version: HOST_VERSION, kind: 'headless' as const };
      const provides = registeredHostCapabilities(this.#options);
      const consumedBy = readConsumedDeclaration(req);
      this.#sendJson(res, 200, {
        ok: true,
        apiVersion: 1,
        databaseReady: true,
        host: identity,
        protocol: CURRENT_VERSION,
        schemaRevision: PROTOCOL_SCHEMA_REVISION,
        provides,
        limits: { maxFileBytes: HOST_MAX_FILE_BYTES, absentCapabilityPolicy: 'error' },
        unsupported: unsupportedReasons(identity, provides),
        consumedBy: consumedBy ?? [],
      });
      return;
    }
    if (url.pathname === '/v1/research/actions') {
      await this.#routeResearchActions(req, res);
      return;
    }
    if (url.pathname === '/v1/projects' || url.pathname.startsWith('/v1/projects/')) {
      await this.#routeProjects(req, url, res);
      return;
    }
    if (url.pathname === '/v1/checkouts' || url.pathname.startsWith('/v1/checkouts/')) {
      await this.#routeCheckouts(req, url, res);
      return;
    }
    if (url.pathname === '/v1/integrations' || url.pathname.startsWith('/v1/integrations/')) {
      await this.#routeIntegrations(req, url, res);
      return;
    }
    if (url.pathname === '/v1/local/mailbox' || url.pathname.startsWith('/v1/local/mailbox/')) {
      await this.#routeLocalMailbox(req, url, res);
      return;
    }
    if (url.pathname === '/v1/local/sidebar-sections' || url.pathname.startsWith('/v1/local/sidebar-sections/')) {
      await this.#routeLocalSidebarSections(req, url, res);
      return;
    }
    if (url.pathname === '/v1/local/usage/index') {
      const api = this.#options.localUsageApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'usage_api_unavailable' } });
        return;
      }
      if (req.method !== 'GET') {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.getUsageIndex());
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/import-batches' || url.pathname.startsWith('/v1/local/import-batches/')) {
      await this.#routeLocalImportBatches(req, url, res);
      return;
    }
    if (url.pathname === '/v1/local/pending-wakes' || url.pathname.startsWith('/v1/local/pending-wakes/')) {
      await this.#routeLocalPendingWakes(req, url, res);
      return;
    }
    if (url.pathname === '/v1/agent-runs' || url.pathname.startsWith('/v1/agent-runs/')) {
      await this.#routeAgentRuns(req, url, res);
      return;
    }
    if (url.pathname === '/v1/mode-state' || url.pathname.startsWith('/v1/mode-state/')) {
      await this.#routeModeState(req, url, res);
      return;
    }
    if (url.pathname === '/v1/goals' || url.pathname.startsWith('/v1/goals/')) {
      await this.#routeGoals(req, url, res);
      return;
    }
    if (url.pathname === '/v1/workflow-runs' || url.pathname.startsWith('/v1/workflow-runs/')) {
      await this.#routeWorkflowRuns(req, url, res);
      return;
    }
    if (url.pathname === '/v1/permission-requests' || url.pathname.startsWith('/v1/permission-requests/')) {
      await this.#routePermissionRequests(req, url, res);
      return;
    }
    if (url.pathname === '/v1/locks' || url.pathname.startsWith('/v1/locks/')) {
      await this.#routeLocks(req, url, res);
      return;
    }
    if (url.pathname === '/v1/tool-approvals' || url.pathname.startsWith('/v1/tool-approvals/')) {
      await this.#routeToolApprovals(req, url, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/search/sessions') {
      const limit = parseQueryInteger(url.searchParams.get('limit'));
      const includeContentRaw = url.searchParams.get('includeContent');
      if ((url.searchParams.has('limit') && limit === undefined) || (limit !== undefined && limit < 0)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_page' } });
        return;
      }
      if (includeContentRaw !== null && includeContentRaw !== 'true' && includeContentRaw !== 'false') {
        this.#sendJson(res, 400, { error: { code: 'invalid_search_filter' } });
        return;
      }
      try {
        const results = await this.#options.api.searchSessions(url.searchParams.get('q') ?? '', {
          ...(limit === undefined ? {} : { limit }),
          ...(includeContentRaw === null ? {} : { includeContent: includeContentRaw === 'true' }),
        });
        this.#sendJson(res, 200, results);
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/search/messages') {
      const limit = parseQueryInteger(url.searchParams.get('limit'));
      if ((url.searchParams.has('limit') && limit === undefined) || (limit !== undefined && limit < 0)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_page' } });
        return;
      }
      try {
        const sessionIds = url.searchParams.getAll('sessionId');
        const results = await this.#options.api.searchMessages(
          url.searchParams.get('q') ?? '',
          {
            ...(limit === undefined ? {} : { limit }),
            ...(sessionIds.length === 0 ? {} : { sessionIds }),
          },
        );
        this.#sendJson(res, 200, results);
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/rollouts/reconcile') {
      try {
        this.#sendJson(res, 200, await this.#options.api.reconcileRollouts());
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/local/rollouts/import') {
      const localRolloutApi = this.#options.localRolloutApi;
      if (!localRolloutApi) {
        this.#sendJson(res, 404, { error: { code: 'local_rollout_import_unavailable' } });
        return;
      }
      await this.#importRollout(req, res, localRolloutApi);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/local/sessions/import') {
      const localRolloutApi = this.#options.localRolloutApi;
      if (!localRolloutApi) {
        this.#sendJson(res, 404, { error: { code: 'local_session_import_unavailable' } });
        return;
      }
      await this.#createImportedSession(req, res, localRolloutApi);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/local/sessions/import/rollback') {
      const localRolloutApi = this.#options.localRolloutApi;
      if (!localRolloutApi) {
        this.#sendJson(res, 404, { error: { code: 'local_session_import_unavailable' } });
        return;
      }
      await this.#rollbackImportedSessions(req, res, localRolloutApi);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/local/rollouts/export') {
      const localRolloutApi = this.#options.localRolloutApi;
      if (!localRolloutApi) {
        this.#sendJson(res, 404, { error: { code: 'local_rollout_export_unavailable' } });
        return;
      }
      await this.#exportRollout(req, res, localRolloutApi);
      return;
    }
    if (url.pathname === '/v1/local/parsed-documents' && req.method === 'POST') {
      const api = this.#options.localAttachmentApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'local_attachment_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const imageChunks = body.imageChunks;
      if (
        typeof body.messageId !== 'string' || typeof body.sessionId !== 'string' ||
        typeof body.filename !== 'string' || typeof body.filePath !== 'string' ||
        typeof body.charCount !== 'number' || !Number.isFinite(body.charCount) ||
        typeof body.text !== 'string' ||
        (body.extractMethod !== undefined && typeof body.extractMethod !== 'string') ||
        (imageChunks !== undefined && (!Array.isArray(imageChunks) || imageChunks.some((chunk) =>
          !isRecord(chunk) || typeof chunk.base64 !== 'string' || typeof chunk.mediaType !== 'string')))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_parsed_document' } });
        return;
      }
      const input: HostLocalParsedDocumentInput = {
        messageId: body.messageId,
        sessionId: body.sessionId as SessionId,
        filename: body.filename,
        filePath: body.filePath,
        charCount: body.charCount,
        text: body.text,
        ...(body.extractMethod === undefined ? {} : { extractMethod: body.extractMethod as string }),
        ...(imageChunks === undefined ? {} : {
          imageChunks: imageChunks as NonNullable<HostLocalParsedDocumentInput['imageChunks']>,
        }),
      };
      try {
        this.#sendJson(res, 200, await api.storeParsedDocument(input));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const localSessionDocumentsMatch = /^\/v1\/local\/sessions\/([^/]+)\/parsed-documents$/.exec(url.pathname);
    if (req.method === 'GET' && localSessionDocumentsMatch) {
      const sessionId = this.#decodePathPart(localSessionDocumentsMatch[1]!, res);
      if (sessionId === null) return;
      const api = this.#options.localAttachmentApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'local_attachment_api_unavailable' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.getParsedDocumentsForSession(sessionId as SessionId));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const localSessionImagesMatch = /^\/v1\/local\/sessions\/([^/]+)\/image-attachments$/.exec(url.pathname);
    if (req.method === 'GET' && localSessionImagesMatch) {
      const sessionId = this.#decodePathPart(localSessionImagesMatch[1]!, res);
      if (sessionId === null) return;
      const api = this.#options.localAttachmentApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'local_attachment_api_unavailable' } });
        return;
      }
      try {
        const rows: readonly HostLocalImageAttachment[] = await api.getImageAttachmentsForSession(sessionId as SessionId);
        this.#sendJson(res, 200, rows);
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const localMessageDocumentsMatch = /^\/v1\/local\/messages\/([^/]+)\/parsed-documents$/.exec(url.pathname);
    if (req.method === 'GET' && localMessageDocumentsMatch) {
      const messageId = this.#decodePathPart(localMessageDocumentsMatch[1]!, res);
      if (messageId === null) return;
      const api = this.#options.localAttachmentApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'local_attachment_api_unavailable' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.getParsedDocumentsForMessage(messageId));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/settings' && req.method === 'GET') {
      const api = this.#options.localSettingsApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'local_settings_api_unavailable' } });
        return;
      }
      try {
        if (url.searchParams.has('key')) {
          this.#sendJson(res, 200, { value: await api.getSetting(url.searchParams.get('key') ?? '') });
        } else {
          this.#sendJson(res, 200, await api.getSettings());
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/settings' && req.method === 'POST') {
      const api = this.#options.localSettingsApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'local_settings_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (typeof body.key !== 'string' || typeof body.value !== 'string') {
        this.#sendJson(res, 400, { error: { code: 'invalid_setting' } });
        return;
      }
      try {
        await api.setSetting(body.key, body.value);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-messages/mirror' && req.method === 'POST') {
      const api = this.#options.localGatewayMessageMirrorApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_message_mirror_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
        typeof body.content !== 'string' || body.content.length === 0 ||
        (body.role !== undefined && typeof body.role !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_message_mirror' } });
        return;
      }
      const input: GatewayMessageMirrorInput = {
        sessionId: body.sessionId,
        content: body.content,
        ...(typeof body.role === 'string' ? { role: body.role } : {}),
      };
      try {
        this.#sendJson(res, 200, await api.appendGatewayMessageMirror(input));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-threads/title' && req.method === 'GET') {
      const api = this.#options.localGatewayThreadApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_thread_api_unavailable' } });
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId === null || sessionId.length === 0) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_thread_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { title: await api.getGatewayThreadTitle(sessionId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (
      (url.pathname === '/v1/local/gateway-threads/ensure' ||
        url.pathname === '/v1/local/gateway-threads/reset' ||
        url.pathname === '/v1/local/gateway-threads/title') &&
      req.method === 'POST'
    ) {
      const api = this.#options.localGatewayThreadApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_thread_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
        typeof body.title !== 'string' ||
        typeof body.now !== 'number' || !Number.isSafeInteger(body.now)
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_thread' } });
        return;
      }
      const input: GatewayThreadWriteInput = {
        sessionId: body.sessionId,
        title: body.title,
        now: body.now,
      };
      try {
        if (url.pathname.endsWith('/ensure')) await api.ensureGatewayThread(input);
        else if (url.pathname.endsWith('/reset')) await api.resetGatewayThread(input);
        else await api.setGatewayThreadTitle(input);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-threads/touch' && req.method === 'POST') {
      const api = this.#options.localGatewayThreadApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_thread_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
        typeof body.updatedAt !== 'number' || !Number.isSafeInteger(body.updatedAt)
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_thread_touch' } });
        return;
      }
      try {
        await api.touchGatewayThread(body.sessionId, body.updatedAt);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const sendMessageStateMatch = /^\/v1\/local\/send-message-state\/([a-z-]+)$/.exec(url.pathname);
    if (sendMessageStateMatch && req.method === 'POST') {
      const api = this.#options.localSendMessageStateApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'send_message_state_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const isTime = (value: unknown): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value);
      const hasStrings = (keys: readonly string[]): boolean => keys.every((key) =>
        typeof body[key] === 'string' && (key === 'prompt' || key === 'widgetJson' || body[key] !== ''),
      );
      try {
        switch (sendMessageStateMatch[1]) {
          case 'widget-pending': {
            if (!hasStrings(['id', 'messageId', 'sessionId', 'botAgentId', 'prompt', 'widgetJson']) || !isTime(body.createdAt)) {
              this.#sendJson(res, 400, { error: { code: 'invalid_widget_pending' } });
              return;
            }
            await api.createWidgetPending(body as unknown as CreateWidgetPendingInput);
            break;
          }
          case 'widget-response': {
            if (
              !hasStrings(['messageId']) ||
              (body.status !== 'pending' && body.status !== 'answered' && body.status !== 'dismissed') ||
              (body.customAnswer !== undefined && body.customAnswer !== null && typeof body.customAnswer !== 'string') ||
              (body.answeredAt !== undefined && body.answeredAt !== null && !isTime(body.answeredAt))
            ) {
              this.#sendJson(res, 400, { error: { code: 'invalid_widget_response' } });
              return;
            }
            await api.updateWidgetResponse(body as unknown as UpdateWidgetResponseInput);
            break;
          }
          case 'cursor-agent-run': {
            if (
              !hasStrings(['id', 'messageId', 'sessionId', 'bcId']) ||
              !['pending', 'running', 'completed', 'failed', 'aborted'].includes(String(body.status)) ||
              !isTime(body.createdAt) || !isTime(body.updatedAt)
            ) {
              this.#sendJson(res, 400, { error: { code: 'invalid_cursor_agent_run' } });
              return;
            }
            await api.upsertCursorAgentRun(body as unknown as CursorAgentRunInput);
            break;
          }
          case 'cursor-agent-run-status': {
            if (
              !hasStrings(['messageId']) ||
              !['pending', 'running', 'completed', 'failed', 'aborted'].includes(String(body.status)) ||
              !isTime(body.updatedAt)
            ) {
              this.#sendJson(res, 400, { error: { code: 'invalid_cursor_agent_run_status' } });
              return;
            }
            await api.updateCursorAgentRun(body as unknown as UpdateCursorAgentRunInput);
            break;
          }
          case 'secret-pending': {
            if (
              !hasStrings(['id', 'messageId', 'sessionId', 'label', 'connector', 'field']) ||
              !isTime(body.createdAt)
            ) {
              this.#sendJson(res, 400, { error: { code: 'invalid_secret_pending' } });
              return;
            }
            await api.createSecretPending(body as unknown as CreateSecretPendingInput);
            break;
          }
          case 'secret-status': {
            if (
              !hasStrings(['messageId']) ||
              (body.status !== 'provided' && body.status !== 'dismissed') ||
              (body.providedAt !== undefined && body.providedAt !== null && !isTime(body.providedAt))
            ) {
              this.#sendJson(res, 400, { error: { code: 'invalid_secret_status' } });
              return;
            }
            await api.markSecretProvided(body as unknown as MarkSecretProvidedInput);
            break;
          }
          default:
            this.#sendJson(res, 404, { error: { code: 'not_found' } });
            return;
        }
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/provider-catalog' && req.method === 'GET') {
      const api = this.#options.localProviderCatalogApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'provider_catalog_api_unavailable' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { catalog: await api.getProviderCatalog() });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/provider-model-capability' && req.method === 'GET') {
      const api = this.#options.localProviderModelCapabilityApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'provider_model_capability_api_unavailable' } });
        return;
      }
      const providerId = url.searchParams.get('providerId');
      const modelId = url.searchParams.get('modelId');
      if (providerId === null || providerId.trim() === '' || (modelId !== null && modelId.trim() === '')) {
        this.#sendJson(res, 400, { error: { code: 'invalid_provider_model_capability_query' } });
        return;
      }
      try {
        if (modelId === null) {
          this.#sendJson(res, 200, { capabilities: await api.listProviderModelCapabilities(providerId) });
        } else {
          this.#sendJson(res, 200, { capability: await api.getProviderModelCapability(providerId, modelId) });
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/provider-model-capability/set' && req.method === 'POST') {
      const api = this.#options.localProviderModelCapabilityApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'provider_model_capability_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const capability = isRecord(body) ? readProviderModelCapability(body.capability) : null;
      if (!capability) {
        this.#sendJson(res, 400, { error: { code: 'invalid_provider_model_capability' } });
        return;
      }
      try {
        this.#sendJson(res, 200, {
          capability: await api.upsertProviderModelCapability(capability),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/provider-model-capability/delete' && req.method === 'POST') {
      const api = this.#options.localProviderModelCapabilityApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'provider_model_capability_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        !isRecord(body) || typeof body.providerId !== 'string' || body.providerId.trim() === '' ||
        typeof body.modelId !== 'string' || body.modelId.trim() === ''
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_provider_model_capability' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.deleteProviderModelCapability(body.providerId, body.modelId));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/model-capability' && req.method === 'GET') {
      const api = this.#options.localModelCapabilityApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'model_capability_api_unavailable' } });
        return;
      }
      const modelName = url.searchParams.get('modelName');
      if (modelName === null || modelName.trim() === '') {
        this.#sendJson(res, 400, { error: { code: 'invalid_model_capability_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { capability: await api.getModelCapability(modelName) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/model-capability/set' && req.method === 'POST') {
      const api = this.#options.localModelCapabilityApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'model_capability_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.modelName !== 'string' || body.modelName.trim() === '' ||
        typeof body.isMultimodal !== 'boolean' ||
        (body.method !== undefined && typeof body.method !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_model_capability' } });
        return;
      }
      try {
        const input: ModelCapabilityWriteInput = {
          modelName: body.modelName,
          isMultimodal: body.isMultimodal,
          ...(typeof body.method === 'string' ? { method: body.method } : {}),
        };
        this.#sendJson(res, 200, await api.setModelCapability(input));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/model-capability/delete' && req.method === 'POST') {
      const api = this.#options.localModelCapabilityApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'model_capability_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (typeof body.modelName !== 'string' || body.modelName.trim() === '') {
        this.#sendJson(res, 400, { error: { code: 'invalid_model_capability' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.deleteModelCapability(body.modelName));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/app-connections' && req.method === 'GET') {
      const api = this.#options.localAppConnectionApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'app_connection_api_unavailable' } });
        return;
      }
      const provider = url.searchParams.get('provider');
      if (provider !== null && !isBoundedString(provider, 1, 200)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_app_connection_provider' } });
        return;
      }
      try {
        const connections = provider === null
          ? await api.listAppConnections()
          : await api.listAppConnectionsByProvider(provider);
        this.#sendJson(res, 200, { connections });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/app-connections/by-id' && req.method === 'GET') {
      const api = this.#options.localAppConnectionApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'app_connection_api_unavailable' } });
        return;
      }
      const id = url.searchParams.get('id');
      if (!isBoundedString(id, 1, 200)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_app_connection_id' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { connection: await api.getAppConnection(id) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/app-connections/upsert' && req.method === 'POST') {
      const api = this.#options.localAppConnectionApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'app_connection_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isAppConnectionWriteInput(body)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_app_connection' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { connection: await api.upsertAppConnection(body) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/app-connections/status' && req.method === 'POST') {
      const api = this.#options.localAppConnectionApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'app_connection_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        !hasOnlyFields(body, ['id', 'status', 'expiresAt', 'lastError']) ||
        !isBoundedString(body.id, 1, 200) ||
        !isAppConnectionStatus(body.status) ||
        (body.expiresAt !== undefined && body.expiresAt !== null && !isAppConnectionTime(body.expiresAt)) ||
        (body.lastError !== undefined && body.lastError !== null && !isBoundedString(body.lastError, 0, 4000))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_app_connection_status' } });
        return;
      }
      try {
        this.#sendJson(res, 200, {
          connection: await api.updateAppConnectionStatus(body.id, body.status, {
            ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt as number | null }),
            ...(body.lastError === undefined ? {} : { lastError: body.lastError as string | null }),
          }),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/app-connections/remove' && req.method === 'POST') {
      const api = this.#options.localAppConnectionApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'app_connection_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!hasOnlyFields(body, ['id']) || !isBoundedString(body.id, 1, 200)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_app_connection_id' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { removed: await api.removeAppConnection(body.id) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/plugin-app-instances' ||
        url.pathname.startsWith('/v1/local/plugin-app-instances/')) {
      try {
        await routePluginAppInstances(req, url, res, this.#options.pluginAppInstanceApi, {
          readJson: (request, response) => this.#readJson(request, response),
          sendJson: (response, status, body) => this.#sendJson(response, status, body),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/plugin-app-grants') {
      await routePluginAppGrants(req, url, res, this.#options.pluginAppGrantApi, {
        readJson: (request, response) => this.#readJson(request, response),
        sendJson: (response, status, body) => this.#sendJson(response, status, body),
      });
      return;
    }
    if (url.pathname === '/v1/local/plugin-app-invocations' ||
        url.pathname.startsWith('/v1/local/plugin-app-invocations/')) {
      await routePluginAppInvocations(req, url, res, this.#options.pluginAppInvocationApi, {
        readJson: (request, response) => this.#readJson(request, response),
        sendJson: (response, status, body) => this.#sendJson(response, status, body),
      });
      return;
    }
    if (url.pathname === '/v1/local/plugin-setup-values' && req.method === 'GET') {
      const api = this.#options.localPluginSetupApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'plugin_setup_api_unavailable' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { values: await api.listPluginSetupValues() });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/plugin-setup-values' && req.method === 'POST') {
      const api = this.#options.localPluginSetupApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'plugin_setup_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        !isBoundedString(body.pluginId, 1, 200) ||
        !isRecord(body.values) ||
        Object.entries(body.values).some(([key, value]) => key.length === 0 || key.length > 200 || typeof value !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_plugin_setup_values' } });
        return;
      }
      try {
        await api.mergePluginSetupValues(body.pluginId, body.values as Record<string, string>);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/plugin-setup-values' && req.method === 'DELETE') {
      const api = this.#options.localPluginSetupApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'plugin_setup_api_unavailable' } });
        return;
      }
      const pluginId = url.searchParams.get('pluginId');
      if (!isBoundedString(pluginId, 1, 200)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_plugin_setup_query' } });
        return;
      }
      try {
        await api.clearPluginSetupValues(pluginId);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname.startsWith('/v1/local/turn-reviews/') && req.method === 'GET') {
      const api = this.#options.localTurnReviewApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'turn_review_api_unavailable' } });
        return;
      }
      const route = url.pathname.slice('/v1/local/turn-reviews/'.length);
      if (route === 'latest') {
        const sessionId = url.searchParams.get('sessionId');
        if (!isBoundedString(sessionId, 1, 200)) {
          this.#sendJson(res, 400, { error: { code: 'invalid_turn_review_query' } });
          return;
        }
        try {
          this.#sendJson(res, 200, { review: await api.getLatestTurnReview(sessionId) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      if (route === 'history') {
        const sessionId = url.searchParams.get('sessionId');
        const limit = Number(url.searchParams.get('limit'));
        if (!isBoundedString(sessionId, 1, 200) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          this.#sendJson(res, 400, { error: { code: 'invalid_turn_review_query' } });
          return;
        }
        try {
          this.#sendJson(res, 200, { reviews: await api.listTurnReviewHistory(sessionId, limit) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      if (route === 'by-id') {
        const reviewId = url.searchParams.get('reviewId');
        if (!isBoundedString(reviewId, 1, 128)) {
          this.#sendJson(res, 400, { error: { code: 'invalid_turn_review_query' } });
          return;
        }
        try {
          this.#sendJson(res, 200, { review: await api.getTurnReviewById(reviewId) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      if (route === 'by-turn') {
        const sessionId = url.searchParams.get('sessionId');
        const turnId = url.searchParams.get('turnId');
        if (!isBoundedString(sessionId, 1, 200) || !isBoundedString(turnId, 1, 200)) {
          this.#sendJson(res, 400, { error: { code: 'invalid_turn_review_query' } });
          return;
        }
        try {
          this.#sendJson(res, 200, { review: await api.getTurnReviewByTurnId(sessionId, turnId) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
    }
    if (url.pathname === '/v1/local/turn-reviews' && req.method === 'POST') {
      const api = this.#options.localTurnReviewApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'turn_review_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const input = parseTurnReviewWriteInput(body);
      if (!input) {
        this.#sendJson(res, 400, { error: { code: 'invalid_turn_review' } });
        return;
      }
      try {
        await api.saveTurnReview(input);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-allowlist' && req.method === 'GET') {
      const api = this.#options.localGatewayAllowlistApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_allowlist_unavailable' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { allowlist: await api.getGatewayAllowlist() });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-allowlist/check' && req.method === 'GET') {
      const api = this.#options.localGatewayAllowlistApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_allowlist_unavailable' } });
        return;
      }
      const platform = url.searchParams.get('platform');
      const platformUserId = url.searchParams.get('platformUserId');
      if (platform === null || platformUserId === null) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_allowlist_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { allowed: await api.isGatewayUserAllowed(platform, platformUserId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (
      (url.pathname === '/v1/local/gateway-allowlist/add' || url.pathname === '/v1/local/gateway-allowlist/remove') &&
      req.method === 'POST'
    ) {
      const api = this.#options.localGatewayAllowlistApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_allowlist_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.platform !== 'string' || body.platform.length === 0 ||
        typeof body.platformUserId !== 'string' || body.platformUserId.length === 0
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_allowlist_entry' } });
        return;
      }
      try {
        if (url.pathname.endsWith('/add')) {
          await api.addGatewayAllowlistEntry(body.platform, body.platformUserId);
        } else {
          await api.removeGatewayAllowlistEntry(body.platform, body.platformUserId);
        }
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-directory' && req.method === 'GET') {
      const api = this.#options.localGatewayDirectoryApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_directory_unavailable' } });
        return;
      }
      const platform = url.searchParams.get('platform') ?? undefined;
      try {
        this.#sendJson(res, 200, { channels: await api.listGatewayChannels(platform) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-directory/replace' && req.method === 'POST') {
      const api = this.#options.localGatewayDirectoryApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_directory_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.platform !== 'string' || body.platform.length === 0 ||
        !Array.isArray(body.channels) || body.channels.length > 10_000 ||
        !body.channels.every((channel: unknown) => {
          if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return false;
          const entry = channel as Record<string, unknown>;
          return typeof entry.id === 'string' && entry.id.length > 0 &&
            typeof entry.name === 'string' && typeof entry.type === 'string' &&
            (entry.guild === undefined || typeof entry.guild === 'string');
        })
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_directory' } });
        return;
      }
      const channels: readonly Omit<GatewayChannelDirectoryEntry, 'platform'>[] = body.channels.map(
        (channel: Record<string, unknown>) => ({
          id: channel.id as string,
          name: channel.name as string,
          type: channel.type as string,
          ...(typeof channel.guild === 'string' ? { guild: channel.guild } : {}),
        }),
      );
      try {
        await api.replaceGatewayChannels(body.platform, channels);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/agent-profiles' && req.method === 'GET') {
      const api = this.#options.localAgentProfileApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'agent_profile_api_unavailable' } });
        return;
      }
      const id = url.searchParams.get('id');
      try {
        if (id !== null) this.#sendJson(res, 200, { profile: await api.getAgentProfile(id) });
        else this.#sendJson(res, 200, { profiles: await api.listAgentProfiles() });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/agent-profiles' && req.method === 'POST') {
      const api = this.#options.localAgentProfileApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'agent_profile_api_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isAgentProfileMutation(body, true)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_agent_profile' } });
        return;
      }
      try {
        this.#sendJson(res, 200, {
          profile: await api.createAgentProfile(body as unknown as AgentProfileCreateInput),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/agent-profiles' && req.method === 'PATCH') {
      const api = this.#options.localAgentProfileApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'agent_profile_api_unavailable' } });
        return;
      }
      const id = url.searchParams.get('id');
      if (!id) {
        this.#sendJson(res, 400, { error: { code: 'invalid_agent_profile_id' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isAgentProfileMutation(body, false)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_agent_profile_patch' } });
        return;
      }
      try {
        this.#sendJson(res, 200, {
          profile: await api.updateAgentProfile(id, body as unknown as AgentProfileUpdateInput),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/agent-profiles' && req.method === 'DELETE') {
      const api = this.#options.localAgentProfileApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'agent_profile_api_unavailable' } });
        return;
      }
      const id = url.searchParams.get('id');
      if (!id) {
        this.#sendJson(res, 400, { error: { code: 'invalid_agent_profile_id' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { deleted: await api.deleteAgentProfile(id) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-user-map' && req.method === 'GET') {
      const api = this.#options.localGatewayUserMapApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_user_map_unavailable' } });
        return;
      }
      const platform = url.searchParams.get('platform') ?? undefined;
      const chatId = url.searchParams.get('platformChatId');
      const sessionId = url.searchParams.get('sessionId');
      if (
        (chatId !== null && (platform === undefined || sessionId !== null)) ||
        (sessionId !== null && (sessionId.length === 0 || platform !== undefined || chatId !== null))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_user_map_query' } });
        return;
      }
      try {
        if (chatId !== null) {
          this.#sendJson(res, 200, { mapping: await api.findGatewayUserMapping(platform!, chatId) });
        } else if (sessionId !== null) {
          this.#sendJson(res, 200, { mapping: await api.findGatewayUserMappingBySession(sessionId) });
        } else {
          this.#sendJson(res, 200, { mappings: await api.listGatewayUserMappings(platform) });
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/channel-bindings' && req.method === 'GET') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const channelType = url.searchParams.get('channelType');
      const chatId = url.searchParams.get('chatId');
      if ((channelType === null) !== (chatId === null)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_channel_binding_query' } });
        return;
      }
      try {
        if (channelType !== null && chatId !== null) {
          this.#sendJson(res, 200, { binding: await api.getChannelBinding(channelType, chatId) });
        } else {
          this.#sendJson(res, 200, { bindings: await api.listChannelBindings(channelType ?? undefined) });
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/channel-bindings' && req.method === 'POST') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.id !== 'string' || body.id.length === 0 ||
        typeof body.channel_type !== 'string' || body.channel_type.length === 0 ||
        typeof body.chat_id !== 'string' || body.chat_id.length === 0 ||
        typeof body.duya_session_id !== 'string' || body.duya_session_id.length === 0 ||
        (body.sdk_session_id !== undefined && typeof body.sdk_session_id !== 'string') ||
        (body.working_directory !== undefined && typeof body.working_directory !== 'string') ||
        (body.model !== undefined && typeof body.model !== 'string') ||
        (body.mode !== undefined && typeof body.mode !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_channel_binding' } });
        return;
      }
      const input: ChannelBindingInput = {
        id: body.id,
        channel_type: body.channel_type,
        chat_id: body.chat_id,
        duya_session_id: body.duya_session_id,
        ...(typeof body.sdk_session_id === 'string' ? { sdk_session_id: body.sdk_session_id } : {}),
        ...(typeof body.working_directory === 'string' ? { working_directory: body.working_directory } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.mode === 'string' ? { mode: body.mode } : {}),
      };
      try {
        this.#sendJson(res, 200, { binding: await api.upsertChannelBinding(input) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/channel-offsets' && req.method === 'GET') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const channelType = url.searchParams.get('channelType');
      const offsetKey = url.searchParams.get('offsetKey');
      if (!channelType || !offsetKey) {
        this.#sendJson(res, 400, { error: { code: 'invalid_channel_offset_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { offset: await api.getChannelOffset(channelType, offsetKey) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/channel-offsets' && req.method === 'POST') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.channelType !== 'string' || body.channelType.length === 0 ||
        typeof body.offsetKey !== 'string' || body.offsetKey.length === 0 ||
        typeof body.offsetValue !== 'string' ||
        (body.offsetType !== undefined && typeof body.offsetType !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_channel_offset' } });
        return;
      }
      const input: ChannelOffsetInput = {
        channelType: body.channelType,
        offsetKey: body.offsetKey,
        offsetValue: body.offsetValue,
        ...(typeof body.offsetType === 'string' ? { offsetType: body.offsetType } : {}),
      };
      try {
        await api.setChannelOffset(input);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/weixin-context-tokens' && req.method === 'GET') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const accountId = url.searchParams.get('accountId');
      const peerUserId = url.searchParams.get('peerUserId');
      if (!accountId || !peerUserId) {
        this.#sendJson(res, 400, { error: { code: 'invalid_weixin_context_token_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, {
          contextToken: await api.getWeixinContextToken(accountId, peerUserId),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/weixin-context-tokens' && req.method === 'POST') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.accountId !== 'string' || body.accountId.length === 0 ||
        typeof body.peerUserId !== 'string' || body.peerUserId.length === 0 ||
        typeof body.contextToken !== 'string'
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_weixin_context_token' } });
        return;
      }
      const input: WeixinContextTokenInput = {
        accountId: body.accountId,
        peerUserId: body.peerUserId,
        contextToken: body.contextToken,
      };
      try {
        await api.setWeixinContextToken(input);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/weixin-context-tokens' && req.method === 'DELETE') {
      const api = this.#options.localChannelPersistenceApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'channel_persistence_unavailable' } });
        return;
      }
      const accountId = url.searchParams.get('accountId');
      if (!accountId) {
        this.#sendJson(res, 400, { error: { code: 'invalid_weixin_context_token_query' } });
        return;
      }
      try {
        await api.deleteWeixinContextTokens(accountId);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/gateway-user-map' && req.method === 'POST') {
      const api = this.#options.localGatewayUserMapApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'gateway_user_map_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.platform !== 'string' || body.platform.length === 0 ||
        typeof body.platformUserId !== 'string' ||
        typeof body.platformChatId !== 'string' || body.platformChatId.length === 0 ||
        typeof body.sessionId !== 'string' || body.sessionId.length === 0
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_gateway_user_mapping' } });
        return;
      }
      const input: GatewayUserMappingInput = {
        platform: body.platform,
        platformUserId: body.platformUserId,
        platformChatId: body.platformChatId,
        sessionId: body.sessionId,
      };
      try {
        await api.upsertGatewayUserMapping(input);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/terminal-history/suggest' && req.method === 'POST') {
      const api = this.#options.localTerminalHistoryApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'terminal_history_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.prefix !== 'string' ||
        (body.shell !== undefined && typeof body.shell !== 'string') ||
        (body.cwd !== undefined && typeof body.cwd !== 'string') ||
        (body.limit !== undefined && typeof body.limit !== 'number')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_terminal_history_query' } });
        return;
      }
      const query: TerminalHistoryQuery = {
        prefix: body.prefix,
        ...(typeof body.shell === 'string' ? { shell: body.shell } : {}),
        ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      };
      try {
        this.#sendJson(res, 200, { suggestions: await api.suggestTerminalHistory(query) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === '/v1/local/terminal-history/record' && req.method === 'POST') {
      const api = this.#options.localTerminalHistoryApi;
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'terminal_history_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.command !== 'string' ||
        typeof body.shell !== 'string' ||
        typeof body.cwd !== 'string' ||
        (body.source !== undefined && typeof body.source !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_terminal_history_record' } });
        return;
      }
      const input: TerminalHistoryRecordInput = {
        command: body.command,
        shell: body.shell,
        cwd: body.cwd,
        ...(typeof body.source === 'string' ? { source: body.source } : {}),
      };
      try {
        await api.recordTerminalCommand(input);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/workspaces/local-directories') {
      await this.#registerLocalDirectory(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/workspace/file') {
      const workspaceFileApi = this.#options.workspaceFileApi;
      if (!workspaceFileApi) {
        this.#sendJson(res, 404, { error: { code: 'workspace_file_read_unavailable' } });
        return;
      }
      await this.#readWorkspaceFile(req, res, workspaceFileApi);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/local/projects/resolve-path') {
      const localProjectApi = this.#options.localProjectApi;
      if (!localProjectApi) {
        this.#sendJson(res, 404, { error: { code: 'local_project_resolution_unavailable' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        typeof body.workingDirectory !== 'string' ||
        (body.agentProfileId !== undefined && body.agentProfileId !== null && typeof body.agentProfileId !== 'string') ||
        (body.cwd !== undefined && typeof body.cwd !== 'string') ||
        (body.workspaceOverridesPath !== undefined && typeof body.workspaceOverridesPath !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_local_project_resolution' } });
        return;
      }
      const input: HostLocalProjectResolutionInput = {
        workingDirectory: body.workingDirectory,
        ...(body.agentProfileId === undefined ? {} : { agentProfileId: body.agentProfileId as string | null }),
        ...(body.cwd === undefined ? {} : { cwd: body.cwd as string }),
        ...(body.workspaceOverridesPath === undefined ? {} : { workspaceOverridesPath: body.workspaceOverridesPath as string }),
      };
      try {
        this.#sendJson(res, 200, await localProjectApi.resolveProjectPath(input));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/local/sessions') {
      if (!this.#options.localSessionApi) {
        this.#sendJson(res, 404, { error: { code: 'local_session_projection_unavailable' } });
        return;
      }
      await this.#listSessions(url, res, true);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/local/session-summaries') {
      const localSessionApi = this.#options.localSessionApi;
      if (!localSessionApi) {
        this.#sendJson(res, 404, { error: { code: 'local_session_projection_unavailable' } });
        return;
      }
      const idPrefix = url.searchParams.get('idPrefix');
      const limit = parseQueryInteger(url.searchParams.get('limit'));
      const offset = parseQueryInteger(url.searchParams.get('offset'));
      if (
        idPrefix === null || idPrefix.length === 0 ||
        (url.searchParams.has('limit') && (limit === undefined || limit < 0)) ||
        (url.searchParams.has('offset') && (offset === undefined || offset < 0))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_local_session_summary_query' } });
        return;
      }
      const query: HostLocalSessionSummaryQuery = {
        idPrefix,
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      };
      try {
        this.#sendJson(res, 200, await localSessionApi.listLocalSessionSummariesByPrefix(query));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const localSessionMatch = /^\/v1\/local\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && localSessionMatch) {
      const sessionId = this.#decodePathPart(localSessionMatch[1]!, res);
      if (sessionId === null) return;
      const localSessionApi = this.#options.localSessionApi;
      if (!localSessionApi) {
        this.#sendJson(res, 404, { error: { code: 'local_session_projection_unavailable' } });
        return;
      }
      const includeAllSessionsRaw = url.searchParams.get('includeAllSessions');
      if (includeAllSessionsRaw !== null && includeAllSessionsRaw !== 'true' && includeAllSessionsRaw !== 'false') {
        this.#sendJson(res, 400, { error: { code: 'invalid_session_filter' } });
        return;
      }
      try {
        const session = await localSessionApi.readLocalSession(sessionId as SessionId, {
          ...(includeAllSessionsRaw === null ? {} : { includeAllSessions: includeAllSessionsRaw === 'true' }),
        });
        if (!session) {
          this.#sendJson(res, 404, { error: { code: 'session_not_found' } });
          return;
        }
        this.#sendJson(res, 200, { session });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const taskStatusesMatch = /^\/v1\/sessions\/([^/]+)\/tasks\/statuses$/.exec(url.pathname);
    if (req.method === 'GET' && taskStatusesMatch) {
      const sessionId = this.#decodePathPart(taskStatusesMatch[1]!, res);
      if (sessionId === null) return;
      try {
        this.#sendJson(res, 200, { statuses: await this.#options.taskApi.getAgentStatuses(sessionId as SessionId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const taskUnassignMatch = /^\/v1\/sessions\/([^/]+)\/tasks\/unassign$/.exec(url.pathname);
    if (req.method === 'POST' && taskUnassignMatch) {
      const sessionId = this.#decodePathPart(taskUnassignMatch[1]!, res);
      if (sessionId === null) return;
      await this.#unassignTasks(sessionId as SessionId, req, res);
      return;
    }
    const tasksByOwnerMatch = /^\/v1\/sessions\/([^/]+)\/tasks\/by-owner$/.exec(url.pathname);
    if (req.method === 'GET' && tasksByOwnerMatch) {
      const sessionId = this.#decodePathPart(tasksByOwnerMatch[1]!, res);
      if (sessionId === null) return;
      const owner = url.searchParams.get('owner');
      if (owner === null) {
        this.#sendJson(res, 400, { error: { code: 'missing_task_owner' } });
        return;
      }
      try {
        this.#sendJson(res, 200, {
          tasks: await this.#options.taskApi.listTasksByOwner(sessionId as SessionId, owner),
        });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const sessionTasksMatch = /^\/v1\/sessions\/([^/]+)\/tasks$/.exec(url.pathname);
    if (sessionTasksMatch) {
      const sessionId = this.#decodePathPart(sessionTasksMatch[1]!, res);
      if (sessionId === null) return;
      if (req.method === 'GET') {
        try {
          this.#sendJson(res, 200, { tasks: await this.#options.taskApi.listTasks(sessionId as SessionId) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      if (req.method === 'POST') {
        await this.#createTask(sessionId as SessionId, req, res);
        return;
      }
      if (req.method === 'DELETE') {
        try {
          await this.#options.taskApi.deleteTasksBySession(sessionId as SessionId);
          this.#sendJson(res, 200, { deleted: true });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
    }
    const taskClaimMatch = /^\/v1\/tasks\/([^/]+)\/claim$/.exec(url.pathname);
    if (req.method === 'POST' && taskClaimMatch) {
      const taskId = this.#decodePathPart(taskClaimMatch[1]!, res);
      if (taskId === null) return;
      await this.#claimTask(taskId as TaskId, req, res);
      return;
    }
    const taskBlockMatch = /^\/v1\/tasks\/([^/]+)\/blocks\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && taskBlockMatch) {
      const fromTaskId = this.#decodePathPart(taskBlockMatch[1]!, res);
      const toTaskId = this.#decodePathPart(taskBlockMatch[2]!, res);
      if (fromTaskId === null || toTaskId === null) return;
      try {
        this.#sendJson(res, 200, { blocked: await this.#options.taskApi.blockTasks(fromTaskId as TaskId, toTaskId as TaskId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch) {
      const taskId = this.#decodePathPart(taskMatch[1]!, res);
      if (taskId === null) return;
      if (req.method === 'GET') {
        try {
          this.#sendJson(res, 200, { task: await this.#options.taskApi.getTask(taskId as TaskId) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      if (req.method === 'PATCH') {
        await this.#updateTask(taskId as TaskId, req, res);
        return;
      }
      if (req.method === 'DELETE') {
        try {
          this.#sendJson(res, 200, { deleted: await this.#options.taskApi.deleteTask(taskId as TaskId) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
    }
    if (url.pathname === '/v1/sessions' && req.method === 'GET') {
      await this.#listSessions(url, res);
      return;
    }
    if (url.pathname === '/v1/session-permission-profile' && req.method === 'POST') {
      await this.#resolveSessionPermissionProfile(req, res);
      return;
    }
    if (url.pathname === '/v1/sessions' && req.method === 'POST') {
      await this.#createSession(req, res);
      return;
    }

    const sessionChangeStatsMatch = /^\/v1\/sessions\/([^/]+)\/change-stats$/.exec(url.pathname);
    if (req.method === 'GET' && sessionChangeStatsMatch) {
      const sessionId = this.#decodePathPart(sessionChangeStatsMatch[1]!, res);
      if (sessionId === null) return;
      try {
        this.#sendJson(res, 200, await this.#options.api.getSessionChangeStats(sessionId as SessionId));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    const sessionForkMatch = /^\/v1\/sessions\/([^/]+)\/fork-at$/.exec(url.pathname);
    if (req.method === 'POST' && sessionForkMatch) {
      const sessionId = this.#decodePathPart(sessionForkMatch[1]!, res);
      if (sessionId === null) return;
      await this.#forkSession(sessionId, req, res);
      return;
    }

    const messagesMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'GET' && messagesMatch) {
      const sessionId = this.#decodePathPart(messagesMatch[1]!, res);
      if (sessionId === null) return;
      await this.#readMessages(sessionId, url, res);
      return;
    }

    const projectedTimelineMatch = /^\/v1\/sessions\/([^/]+)\/projected-timeline$/.exec(url.pathname);
    if (req.method === 'GET' && projectedTimelineMatch) {
      const sessionId = this.#decodePathPart(projectedTimelineMatch[1]!, res);
      if (sessionId === null) return;
      await this.#readProjectedTimeline(sessionId, url, res);
      return;
    }

    const timelineMatch = /^\/v1\/sessions\/([^/]+)\/timeline$/.exec(url.pathname);
    if (timelineMatch) {
      const sessionId = this.#decodePathPart(timelineMatch[1]!, res);
      if (sessionId === null) return;
      if (req.method === 'GET') {
        await this.#readTimeline(sessionId, url, res);
        return;
      }
      if (req.method === 'POST') {
        await this.#appendTimeline(sessionId, req, res);
        return;
      }
      if (req.method === 'DELETE') {
        try {
          const deletedCount = await this.#options.api.deleteTimeline(sessionId as SessionId);
          this.#sendJson(res, 200, { deletedCount });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
    }

    const timelineCountMatch = /^\/v1\/sessions\/([^/]+)\/timeline\/count$/.exec(url.pathname);
    if (req.method === 'GET' && timelineCountMatch) {
      const sessionId = this.#decodePathPart(timelineCountMatch[1]!, res);
      if (sessionId === null) return;
      try {
        this.#sendJson(res, 200, { count: await this.#options.api.countTimeline(sessionId as SessionId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    const sessionArchiveMatch = /^\/v1\/sessions\/([^/]+)\/(archive|unarchive)$/.exec(url.pathname);
    if (req.method === 'POST' && sessionArchiveMatch) {
      const sessionId = this.#decodePathPart(sessionArchiveMatch[1]!, res);
      if (sessionId === null) return;
      try {
        if (sessionArchiveMatch[2] === 'archive') {
          this.#sendJson(res, 200, { result: await this.#options.api.archive(sessionId as SessionId) });
        } else {
          this.#sendJson(res, 200, { unarchived: await this.#options.api.unarchive(sessionId as SessionId) });
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (sessionMatch) {
      const sessionId = this.#decodePathPart(sessionMatch[1]!, res);
      if (sessionId === null) return;
      if (req.method === 'GET') {
        await this.#getSession(sessionId, url, res);
        return;
      }
      if (req.method === 'PATCH') {
        await this.#updateSession(sessionId, req, res);
        return;
      }
      if (req.method === 'DELETE') {
        await this.#deleteSession(sessionId, url, res);
        return;
      }
    }

    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #listSessions(url: URL, res: ServerResponse, localProjection = false): Promise<void> {
    const localSessionApi = this.#options.localSessionApi;
    if (localProjection && !localSessionApi) {
      this.#sendJson(res, 404, { error: { code: 'local_session_projection_unavailable' } });
      return;
    }
    const query: HostSessionListQuery = {};
    const limit = this.#optionalNumber(url.searchParams.get('limit'));
    const offset = this.#optionalNumber(url.searchParams.get('offset'));
    if (limit === null || offset === null) {
      this.#sendJson(res, 400, { error: { code: 'invalid_page' } });
      return;
    }
    const includeArchivedRaw = url.searchParams.get('includeArchived');
    const includeAllSessionsRaw = url.searchParams.get('includeAllSessions');
    const includeDeletedRaw = url.searchParams.get('includeDeleted');
    if ([includeArchivedRaw, includeAllSessionsRaw, includeDeletedRaw].some(
      (value) => value !== null && value !== 'true' && value !== 'false',
    )) {
      this.#sendJson(res, 400, { error: { code: 'invalid_session_filter' } });
      return;
    }
    const workspaceId = url.searchParams.get('workspaceId');
    const parentSessionId = url.searchParams.get('parentSessionId');
    try {
      const query: HostSessionListQuery = {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
        ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') ?? '' } : {}),
        ...(workspaceId === null ? {} : { workspaceId: workspaceId as WorkspaceId }),
        ...(parentSessionId === null ? {} : { parentSessionId: parentSessionId as SessionId }),
        ...(includeArchivedRaw === null ? {} : { includeArchived: includeArchivedRaw === 'true' }),
        ...(includeAllSessionsRaw === null ? {} : { includeAllSessions: includeAllSessionsRaw === 'true' }),
        ...(includeDeletedRaw === null ? {} : { includeDeleted: includeDeletedRaw === 'true' }),
      };
      const page = localProjection && localSessionApi
        ? await localSessionApi.listLocalSessions(query)
        : await this.#options.api.list(query);
      this.#sendJson(res, 200, page);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    const input = this.#parseCreateInput(body);
    if (!input) {
      this.#sendJson(res, 400, { error: { code: 'invalid_session' } });
      return;
    }
    try {
      this.#sendJson(res, 201, { session: await this.#options.api.create(input) });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #resolveSessionPermissionProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (
      (body.explicit !== undefined && body.explicit !== null && typeof body.explicit !== 'string') ||
      (body.parentSessionId !== undefined && body.parentSessionId !== null && typeof body.parentSessionId !== 'string') ||
      (body.trustedOverride !== undefined && typeof body.trustedOverride !== 'boolean')
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_permission_profile_request' } });
      return;
    }
    const input: HostSessionPermissionProfileInput = {
      ...(body.explicit === undefined ? {} : { explicit: body.explicit as string | null }),
      ...(body.parentSessionId === undefined ? {} : { parentSessionId: body.parentSessionId as SessionId | null }),
      ...(body.trustedOverride === undefined ? {} : { trustedOverride: body.trustedOverride as boolean }),
    };
    try {
      const permissionProfile = await this.#options.api.resolveSessionPermissionProfile(input);
      this.#sendJson(res, 200, { permissionProfile });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #forkSession(sourceSessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (
      typeof body.newSessionId !== 'string' || body.newSessionId.trim().length === 0 ||
      typeof body.throughMessageId !== 'string' || body.throughMessageId.length === 0 ||
      (body.title !== undefined && typeof body.title !== 'string')
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_session_fork' } });
      return;
    }
    try {
      const result = await this.#options.api.forkAt(sourceSessionId as SessionId, {
        newSessionId: body.newSessionId as SessionId,
        throughMessageId: body.throughMessageId,
        ...(body.title === undefined ? {} : { title: body.title }),
      });
      this.#sendJson(res, 200, result);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #routeResearchActions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const api = this.#options.researchApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'research_api_unavailable' } });
      return;
    }
    if (req.method !== 'POST') {
      this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    const body = await this.#readJson(req, res);
    if (!body) return;
    if (!isHostResearchAction(body.action) || !isRecord(body.payload)) {
      this.#sendJson(res, 400, { error: { code: 'invalid_research_request' } });
      return;
    }
    const result = await api.dispatch(body.action, body.payload);
    this.#sendJson(res, 200, { result });
  }

  async #routeWorkflowRuns(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.workflowRunApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'workflow_run_api_unavailable' } });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(2);
    try {
      if (parts.length === 0 && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const input = parseWorkflowRunCreateInput(body);
        if (!input) {
          this.#sendJson(res, 400, { error: { code: 'invalid_workflow_run' } });
          return;
        }
        this.#sendJson(res, 201, await api.createRun(input));
        return;
      }
      if (parts.length === 0 && req.method === 'GET') {
        const filter = parseWorkflowRunFilter(url.searchParams);
        if (!filter) {
          this.#sendJson(res, 400, { error: { code: 'invalid_workflow_run_filter' } });
          return;
        }
        this.#sendJson(res, 200, await api.listRuns(filter));
        return;
      }
      if (parts.length === 1 && parts[0] === 'active' && req.method === 'GET') {
        this.#sendJson(res, 200, await api.listActiveRunIds());
        return;
      }
      if (parts.length === 1 && parts[0] === 'waiting-past' && req.method === 'GET') {
        const nowMs = parseQueryInteger(url.searchParams.get('now'));
        if (nowMs === undefined) {
          this.#sendJson(res, 400, { error: { code: 'invalid_now' } });
          return;
        }
        this.#sendJson(res, 200, await api.listWaitingPast(nowMs));
        return;
      }
      if (parts.length === 1 && parts[0] === 'reconcile-stale' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (!Array.isArray(body.activeRunIds) || !body.activeRunIds.every((id) => typeof id === 'string')) {
          this.#sendJson(res, 400, { error: { code: 'invalid_active_run_ids' } });
          return;
        }
        this.#sendJson(res, 200, await api.reconcileStaleRuns(body.activeRunIds));
        return;
      }
      if (parts.length === 2 && parts[0] === 'by-dedup-key' && req.method === 'GET') {
        const dedupKey = this.#decodePathPart(parts[1]!, res);
        if (dedupKey === null) return;
        this.#sendJson(res, 200, await api.getRunByDedupKey(dedupKey));
        return;
      }
      if (parts.length === 0) {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }

      const runId = this.#decodePathPart(parts[0]!, res);
      if (runId === null) return;
      if (parts.length === 1 && req.method === 'GET') {
        this.#sendJson(res, 200, await api.getRun(runId));
        return;
      }
      if (parts.length === 1 && req.method === 'DELETE') {
        this.#sendJson(res, 200, await api.deleteRun(runId));
        return;
      }
      if (parts.length === 2 && parts[1] === 'status' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (!isWorkflowRunStatus(body.status) || (body.pauseMessage !== undefined && body.pauseMessage !== null && typeof body.pauseMessage !== 'string')) {
          this.#sendJson(res, 400, { error: { code: 'invalid_workflow_run_status' } });
          return;
        }
        this.#sendJson(res, 200, await api.updateStatus(runId, body.status, body.pauseMessage));
        return;
      }
      if (parts.length === 2 && parts[1] === 'finish' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const outcome = parseWorkflowRunOutcome(body);
        if (!outcome) {
          this.#sendJson(res, 400, { error: { code: 'invalid_workflow_run_outcome' } });
          return;
        }
        this.#sendJson(res, 200, await api.finishRun(runId, outcome));
        return;
      }
      if (parts.length === 2 && parts[1] === 'wait-till' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (body.waitTill !== null && (typeof body.waitTill !== 'number' || !Number.isFinite(body.waitTill))) {
          this.#sendJson(res, 400, { error: { code: 'invalid_wait_till' } });
          return;
        }
        this.#sendJson(res, 200, await api.setWaitTill(runId, body.waitTill as number | null));
        return;
      }
      if (parts.length === 2 && parts[1] === 'version' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (typeof body.versionId !== 'string' || body.versionId.length === 0) {
          this.#sendJson(res, 400, { error: { code: 'invalid_version_id' } });
          return;
        }
        this.#sendJson(res, 200, await api.setVersionId(runId, body.versionId));
        return;
      }
      if (parts.length === 2 && parts[1] === 'snapshot') {
        if (req.method === 'GET') {
          this.#sendJson(res, 200, await api.loadSnapshot(runId));
          return;
        }
        if (req.method === 'PUT') {
          const body = await this.#readJson(req, res);
          if (body === null) return;
          const snapshot = parseWorkflowRunSnapshot(runId, body);
          if (!snapshot) {
            this.#sendJson(res, 400, { error: { code: 'invalid_workflow_run_snapshot' } });
            return;
          }
          this.#sendJson(res, 200, await api.saveSnapshot(snapshot));
          return;
        }
      }
      if (parts.length === 2 && parts[1] === 'journal') {
        if (req.method === 'GET') {
          this.#sendJson(res, 200, await api.loadJournal(runId));
          return;
        }
        if (req.method === 'POST') {
          const body = await this.#readJson(req, res);
          if (body === null) return;
          if (!isJournalRecord(body.record)) {
            this.#sendJson(res, 400, { error: { code: 'invalid_workflow_journal_record' } });
            return;
          }
          this.#sendJson(res, 200, await api.appendJournalRecord(runId, body.record));
          return;
        }
      }
      if (parts.length === 2 && parts[1] === 'events' && req.method === 'GET') {
        const afterSeq = url.searchParams.has('afterSeq')
          ? parseQueryInteger(url.searchParams.get('afterSeq'))
          : -1;
        if (afterSeq === undefined) {
          this.#sendJson(res, 400, { error: { code: 'invalid_event_cursor' } });
          return;
        }
        this.#sendJson(res, 200, await api.listEvents(runId, afterSeq));
        return;
      }
      if (parts.length === 3 && parts[1] === 'events' && parts[2] === 'latest' && req.method === 'GET') {
        this.#sendJson(res, 200, await api.latestEventSeq(runId));
        return;
      }
      if (parts.length === 3 && parts[1] === 'events' && parts[2] === 'count' && req.method === 'GET') {
        this.#sendJson(res, 200, await api.getEventCount(runId));
        return;
      }
      this.#sendJson(res, 404, { error: { code: 'not_found' } });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #routeProjects(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.projectApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'project_api_unavailable' } });
      return;
    }

    if (url.pathname === '/v1/projects') {
      if (req.method === 'GET') {
        try {
          this.#sendJson(res, 200, { projects: await api.listProjects() });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      if (req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const input = this.#parseProjectCreate(body);
        if (!input) {
          this.#sendJson(res, 400, { error: { code: 'invalid_project' } });
          return;
        }
        try {
          this.#sendJson(res, 201, { project: await api.createProject(input) });
        } catch (error) {
          this.#sendApiError(res, error);
        }
        return;
      }
      this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
      return;
    }

    const match = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      this.#sendJson(res, 404, { error: { code: 'not_found' } });
      return;
    }
    const projectId = this.#decodePathPart(match[1]!, res);
    if (projectId === null) return;

    if (req.method === 'GET') {
      try {
        this.#sendJson(res, 200, { project: await api.getProject(projectId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'PATCH') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const patch = this.#parseProjectPatch(body);
      if (!patch) {
        this.#sendJson(res, 400, { error: { code: 'invalid_project_patch' } });
        return;
      }
      try {
        const project = await api.updateProject(projectId, patch);
        this.#sendJson(res, project ? 200 : 404, { project });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (req.method === 'DELETE') {
      try {
        this.#sendJson(res, 200, { deleted: await api.deleteProject(projectId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
  }

  /**
   * Checkout observation (plan 621 §4.6, first two reconcile entries).
   *
   * A Host without a checkout provider answers 404 rather than "no checkout":
   * the two are different answers and only one of them is true.
   */
  async #routeCheckouts(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.checkoutApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'checkout_api_unavailable' } });
      return;
    }

    if (url.pathname === '/v1/checkouts') {
      if (req.method !== 'GET') {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      const root = url.searchParams.get('root');
      // Exactly one selector: a request naming both is ambiguous, and a request
      // naming neither would have to fall back to a scan of every checkout.
      if ((sessionId === null) === (root === null)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_checkout_query' } });
        return;
      }
      try {
        if (sessionId !== null) {
          this.#sendJson(res, 200, { checkout: await api.observeForSession(sessionId as SessionId) });
        } else {
          this.#sendJson(res, 200, { checkout: await api.observeCheckout(root as string) });
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (url.pathname === '/v1/checkouts/reclaim') {
      if (req.method !== 'POST') {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isBoundedString(body.root, 1, 4096)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_checkout_query' } });
        return;
      }
      try {
        // `removed: false` is a 200: the refusal is the answer, not a failure.
        this.#sendJson(res, 200, { result: await api.requestReclaim(body.root) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  /** Observed PR / CI / review projection (plan 621 §4.6, Integration row). */
  async #routeIntegrations(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.integrationApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'integration_api_unavailable' } });
      return;
    }

    if (url.pathname === '/v1/integrations') {
      if (req.method !== 'GET') {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      if (!isNonEmptyString(sessionId)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_integration_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { records: await api.observeForSession(sessionId as SessionId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (url.pathname === '/v1/integrations/link') {
      if (req.method !== 'POST') {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const repo = body.repo;
      const prNumber = body.prNumber;
      const sessionId = body.sessionId;
      if (
        !isBoundedString(repo, 1, 200) ||
        !Number.isSafeInteger(prNumber) ||
        (prNumber as number) <= 0 ||
        !isBoundedString(sessionId, 1, 4096)
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_integration_link' } });
        return;
      }
      try {
        await api.linkSession(repo, prNumber as number, sessionId as SessionId);
        this.#sendJson(res, 200, { linked: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (url.pathname === '/v1/integrations/sync') {
      const sync = this.#options.integrationSync;
      if (!sync) {
        this.#sendJson(res, 404, { error: { code: 'integration_sync_unavailable' } });
        return;
      }
      if (req.method !== 'POST') {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const sessionId = body.sessionId;
      if (!isBoundedString(sessionId, 1, 4096)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_integration_sync' } });
        return;
      }
      try {
        // The result is reported as it happened: `written` is what landed,
        // `failed` is what GitHub did not answer for. A partial sync is a
        // partial sync, not a success.
        this.#sendJson(res, 200, await sync.syncSession(sessionId));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  #parseProjectCreate(value: Record<string, unknown>): HostProjectCreateInput | null {
    if (!isNonEmptyString(value.name)) return null;
    const paths = parseProjectPathEntries(value.paths);
    if (!paths) return null;
    if (value.description !== undefined && value.description !== null && typeof value.description !== 'string') return null;
    if (value.icon !== undefined && value.icon !== null && typeof value.icon !== 'string') return null;
    if (value.color !== undefined && value.color !== null && typeof value.color !== 'string') return null;
    return {
      name: value.name,
      paths,
      ...(value.description === undefined ? {} : { description: value.description as string | null }),
      ...(value.icon === undefined ? {} : { icon: value.icon as string | null }),
      ...(value.color === undefined ? {} : { color: value.color as string | null }),
    };
  }

  #parseProjectPatch(value: Record<string, unknown>): HostProjectPatch | null {
    if (value.name !== undefined && typeof value.name !== 'string') return null;
    if (value.description !== undefined && value.description !== null && typeof value.description !== 'string') return null;
    if (value.icon !== undefined && value.icon !== null && typeof value.icon !== 'string') return null;
    if (value.color !== undefined && value.color !== null && typeof value.color !== 'string') return null;
    const paths = value.paths === undefined ? undefined : parseProjectPathEntries(value.paths);
    if (value.paths !== undefined && !paths) return null;
    return {
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(value.description === undefined ? {} : { description: value.description as string | null }),
      ...(value.icon === undefined ? {} : { icon: value.icon as string | null }),
      ...(value.color === undefined ? {} : { color: value.color as string | null }),
      ...(paths === undefined || paths === null ? {} : { paths }),
    };
  }

  async #routeAgentRuns(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.runApi;
    const executionApi = this.#options.runExecutionApi;
    if (!api && !executionApi) {
      this.#sendJson(res, 404, { error: { code: 'agent_run_api_unavailable' } });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(2);
    try {
      // Host-owned execution: start a real run (plan 12 gate 3).
      if (parts.length === 1 && parts[0] === 'start' && req.method === 'POST') {
        if (!executionApi) {
          this.#sendJson(res, 404, { error: { code: 'agent_run_execution_unavailable' } });
          return;
        }
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const input = parseStartAgentRunInput(body);
        if (!input) {
          this.#sendJson(res, 400, { error: { code: 'invalid_start_agent_run' } });
          return;
        }
        this.#sendJson(res, 202, await executionApi.startAgentRun(input));
        return;
      }
      if (parts.length === 2 && parts[1] === 'cancel' && req.method === 'POST') {
        if (!executionApi) {
          this.#sendJson(res, 404, { error: { code: 'agent_run_execution_unavailable' } });
          return;
        }
        const decodedRunId = this.#decodePathPart(parts[0]!, res);
        if (decodedRunId === null) return;
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const reason =
          typeof body.reason === 'string'
            ? body.reason
            : 'host_run_cancel';
        this.#sendJson(res, 200, await executionApi.cancelAgentRun(decodedRunId as RunId, reason));
        return;
      }
      if (!api) {
        this.#sendJson(res, 404, { error: { code: 'agent_run_api_unavailable' } });
        return;
      }
      if (parts.length === 0 && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        const limit = this.#optionalNumber(url.searchParams.get('limit'));
        if (!isNonEmptyString(sessionId) || limit === null) {
          this.#sendJson(res, 400, { error: { code: 'invalid_agent_run_query' } });
          return;
        }
        this.#sendJson(res, 200, await api.listAgentRunsBySession(sessionId as SessionId, limit));
        return;
      }
      if (parts.length === 0 && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const input = parseCreateAgentRunInput(body);
        if (!input) {
          this.#sendJson(res, 400, { error: { code: 'invalid_agent_run' } });
          return;
        }
        this.#sendJson(res, 201, await api.createAgentRun(input));
        return;
      }
      if (parts.length === 3 && parts[1] === 'events' && parts[2] === 'stream' && req.method === 'GET') {
        const decodedRunId = this.#decodePathPart(parts[0]!, res);
        if (decodedRunId === null) return;
        const runId = decodedRunId as RunId;
        const lastEventId = req.headers['last-event-id'];
        const rawAfterSeq = typeof lastEventId === 'string' ? lastEventId : url.searchParams.get('afterSeq');
        const afterSeq = this.#optionalNumber(rawAfterSeq);
        const limit = this.#optionalNumber(url.searchParams.get('limit'));
        if (
          afterSeq === null || (afterSeq !== undefined && afterSeq < 0) || limit === null ||
          (limit !== undefined && (limit < 1 || limit > 1000))
        ) {
          this.#sendJson(res, 400, { error: { code: 'invalid_run_event_stream_query' } });
          return;
        }
        if (!(await api.getAgentRun(runId))) {
          this.#sendJson(res, 404, { error: { code: 'run_not_found' } });
          return;
        }
        if (!this.#server?.listening) {
          this.#sendJson(res, 503, { error: { code: 'host_shutting_down' } });
          return;
        }

        const abortController = new AbortController();
        let cursor = afterSeq ?? 0;
        const streamQuery = {
          afterSeq: cursor,
          ...(limit === undefined ? {} : { limit }),
          signal: abortController.signal,
        };
        const onClose = (): void => {
          abortController.abort();
          this.#activeRunEventStreams.delete(res);
        };
        this.#activeRunEventStreams.add(res);
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        res.once('close', onClose);
        try {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          heartbeat = setInterval(() => {
            if (!res.destroyed) res.write(': keep-alive\n\n');
          }, 15_000);
          heartbeat.unref?.();

          const writeEnvelope = async (envelope: RunEventEnvelope): Promise<boolean> => {
            if (abortController.signal.aborted || res.destroyed) return false;
            if (envelope.seq <= cursor) return true;
            cursor = envelope.seq;
            const frame = `id: ${envelope.seq}\nevent: run\ndata: ${JSON.stringify(envelope)}\n\n`;
            if (!res.write(frame)) {
              await new Promise<void>((resolve) => {
                const resume = (): void => {
                  res.off('drain', resume);
                  res.off('close', resume);
                  resolve();
                };
                res.once('drain', resume);
                res.once('close', resume);
              });
            }
            return !abortController.signal.aborted && !res.destroyed;
          };
          const liveStream = executionApi?.watchLiveAgentRunEvents?.(runId, streamQuery) ?? null;
          if (liveStream !== null && cursor === 0) {
            // `run.started` is committed before dispatch, before the live tee
            // begins. Seed it once so live subscribers still see the complete
            // lifecycle from its first durable event.
            const firstEvents = await api.readAgentRunEvents(runId, { afterSeq: 0, limit: 1 });
            for (const envelope of firstEvents) {
              if (!(await writeEnvelope(envelope))) break;
            }
          }
          const primaryStream = liveStream ?? api.watchAgentRunEvents(runId, streamQuery);
          for await (const envelope of primaryStream) {
            if (!(await writeEnvelope(envelope))) break;
          }
          // Ephemeral events only exist in the live channel. Once it closes,
          // continue from the last delivered sequence in the durable ledger so
          // the committed terminal (including synthesized cancellations) is
          // still delivered under the original persistence contract.
          if (liveStream !== null && !abortController.signal.aborted && !res.destroyed) {
            for await (const envelope of api.watchAgentRunEvents(runId, {
              afterSeq: cursor,
              ...(limit === undefined ? {} : { limit }),
              signal: abortController.signal,
            })) {
              if (!(await writeEnvelope(envelope))) break;
            }
          }
        } catch (error) {
          if (!res.headersSent) {
            this.#sendApiError(res, error);
            return;
          }
          if (!abortController.signal.aborted && !res.destroyed) {
            const failure = error instanceof HostRunApiError
              ? { status: error.status, code: error.code, message: error.message }
              : { status: 500, code: 'internal_error' };
            res.write(`event: error\ndata: ${JSON.stringify(failure)}\n\n`);
          }
        } finally {
          if (heartbeat !== null) clearInterval(heartbeat);
          res.off('close', onClose);
          this.#activeRunEventStreams.delete(res);
          if (!res.destroyed) res.end();
        }
        return;
      }
      if (parts.length < 1 || parts.length > 3) {
        this.#sendJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      const decodedRunId = this.#decodePathPart(parts[0]!, res);
      if (decodedRunId === null) return;
      const runId = decodedRunId as RunId;
      if (parts.length === 1 && req.method === 'GET') {
        this.#sendJson(res, 200, { run: await api.getAgentRun(runId) });
        return;
      }
      if (parts.length === 2 && parts[1] === 'events' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const events = parseAgentRunEvents(body, runId);
        if (events === null) {
          this.#sendJson(res, 400, { error: { code: 'invalid_agent_run_events' } });
          return;
        }
        const authority = parseRunWriteAuthority(body);
        if (authority === null) {
          this.#sendJson(res, 400, {
            error: {
              code: 'invalid_run_attempt_fence',
              message:
                'run event append requires a fence { epoch, writer }, or an explicit unfenced ' +
                '{ reason, authorizedBy } authorization; a write with no attempt is refused, not made unfenced',
            },
          });
          return;
        }
        const written = authority.kind === 'fenced'
          ? await api.appendAgentRunEvents(runId, events, authority.fence)
          : await requireUnfencedAppend(api, runId, events, authority);
        this.#sendJson(res, 200, { written });
        return;
      }
      if (parts.length === 2 && parts[1] === 'events' && req.method === 'GET') {
        const afterSeq = this.#optionalNumber(url.searchParams.get('afterSeq'));
        const limit = this.#optionalNumber(url.searchParams.get('limit'));
        if (afterSeq === null || limit === null) {
          this.#sendJson(res, 400, { error: { code: 'invalid_run_event_page' } });
          return;
        }
        const query: { afterSeq?: number; limit?: number } = {};
        if (afterSeq !== undefined) query.afterSeq = afterSeq;
        if (limit !== undefined) query.limit = limit;
        const events = await api.readAgentRunEvents(runId, query);
        this.#sendJson(res, 200, { events });
        return;
      }
      if (parts.length === 2 && parts[1] === 'terminal' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (
          !isRunTerminalState(body.terminal) ||
          (body.metrics !== undefined && !isRunMetrics(body.metrics))
        ) {
          this.#sendJson(res, 400, { error: { code: 'invalid_agent_run_terminal' } });
          return;
        }
        const authority = parseRunWriteAuthority(body);
        if (authority === null) {
          this.#sendJson(res, 400, {
            error: {
              code: 'invalid_run_attempt_fence',
              message:
                'run settle requires a fence { epoch, writer }, or an explicit unfenced ' +
                '{ reason, authorizedBy } authorization; a write with no attempt is refused, not made unfenced',
            },
          });
          return;
        }
        const result = authority.kind === 'fenced'
          ? await api.settleAgentRun(
            runId,
            body.terminal as RunTerminalState,
            authority.fence,
            body.metrics as RunMetrics | undefined,
          )
          : await requireUnfencedSettle(api, runId, body, authority);
        this.#sendJson(res, 200, result);
        return;
      }
      this.#sendJson(res, 404, { error: { code: 'not_found' } });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #routePermissionRequests(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.permissionRequestApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'permission_request_api_unavailable' } });
      return;
    }

    const parts = url.pathname.slice('/v1/permission-requests'.length).split('/').filter(Boolean);
    if (parts.length === 0 && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId !== null && !isNonEmptyString(sessionId)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_permission_request_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.listPendingPermissionRequests(sessionId ?? undefined));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 0 && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const input = parsePermissionRequestCreate(body);
      if (input === null) {
        this.#sendJson(res, 400, { error: { code: 'invalid_permission_request' } });
        return;
      }
      try {
        const permission = await api.createPermissionRequest(input);
        this.#sendJson(res, 201, { permission });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && req.method === 'GET') {
      const id = this.#decodePathPart(parts[0]!, res);
      if (id === null) return;
      try {
        this.#sendJson(res, 200, { permission: await api.getPermissionRequest(id) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 2 && parts[1] === 'resolve' && req.method === 'POST') {
      const id = this.#decodePathPart(parts[0]!, res);
      if (id === null) return;
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const input = parsePermissionRequestResolve(body);
      if (input === null) {
        this.#sendJson(res, 400, { error: { code: 'invalid_permission_request_resolution' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { permission: await api.resolvePermissionRequest(id, input) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #routeToolApprovals(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.toolApprovalApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'tool_approval_api_unavailable' } });
      return;
    }

    const parts = url.pathname.slice('/v1/tool-approvals'.length).split('/').filter(Boolean);
    if (parts.length === 0 && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const input = parseToolApprovalInput(body);
      if (!input) {
        this.#sendJson(res, 400, { error: { code: 'invalid_tool_approval' } });
        return;
      }
      try {
        this.#sendJson(res, 201, { approval: await api.createToolApproval(input) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 0 && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!isNonEmptyString(sessionId)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_tool_approval_query' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.listToolApprovalsBySession(sessionId));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && parts[0] === 'consume-approved' && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isNonEmptyString(body.sessionId) || !isNonEmptyString(body.toolName) || !isNonEmptyString(body.inputHash)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_tool_approval_consume' } });
        return;
      }
      try {
        const consumed = await api.consumeApprovedToolApproval({
          sessionId: body.sessionId,
          toolName: body.toolName,
          inputHash: body.inputHash,
        });
        this.#sendJson(res, 200, { consumed });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && parts[0] === 'rules' && req.method === 'GET') {
      const scope = parseToolApprovalScope(url.searchParams.get('scopeType'), url.searchParams.get('scopeId'));
      if (!scope) {
        this.#sendJson(res, 400, { error: { code: 'invalid_tool_approval_scope' } });
        return;
      }
      try {
        this.#sendJson(res, 200, await api.listToolApprovalRules(scope));
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && parts[0] === 'rules' && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const scope = parseToolApprovalScope(body.scopeType, body.scopeId);
      if (!scope || !isNonEmptyString(body.toolName)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_tool_approval_scope' } });
        return;
      }
      try {
        await api.upsertToolApprovalRule({ ...scope, toolName: body.toolName });
        this.#sendJson(res, 200, { ok: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && req.method === 'GET') {
      const id = this.#decodePathPart(parts[0]!, res);
      if (id === null) return;
      try {
        this.#sendJson(res, 200, { approval: await api.getToolApproval(id) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 2 && parts[1] === 'resolve' && req.method === 'POST') {
      const id = this.#decodePathPart(parts[0]!, res);
      if (id === null) return;
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isToolApprovalDecision(body.decision)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_tool_approval_decision' } });
        return;
      }
      try {
        this.#sendJson(res, 200, { result: await api.resolveToolApproval(id, body.decision) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 2 && parts[1] === 'consume' && req.method === 'POST') {
      const id = this.#decodePathPart(parts[0]!, res);
      if (id === null) return;
      try {
        this.#sendJson(res, 200, { approval: await api.consumeToolApprovalById(id) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #routeLocks(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.lockApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'lock_api_unavailable' } });
      return;
    }

    const parts = url.pathname.slice('/v1/locks'.length).split('/').filter(Boolean);
    if (parts.length === 1 && parts[0] === 'acquire' && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const origin = body.origin === 'user' || body.origin === 'agent' || body.origin === 'background'
        ? body.origin
        : null;
      if (
        !isNonEmptyString(body.sessionId) || !isNonEmptyString(body.lockId) || !isNonEmptyString(body.owner) ||
        (body.ttlSec !== undefined && (!isFiniteNumber(body.ttlSec) || body.ttlSec <= 0)) ||
        (body.origin !== undefined && origin === null)
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_lock_acquire' } });
        return;
      }
      try {
        const acquired = await api.acquireLock({
          sessionId: body.sessionId,
          lockId: body.lockId,
          owner: body.owner,
          ...(body.ttlSec === undefined ? {} : { ttlSec: body.ttlSec }),
          ...(origin === null ? {} : { origin }),
        });
        this.#sendJson(res, 200, { acquired });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && parts[0] === 'renew' && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        !isNonEmptyString(body.sessionId) || !isNonEmptyString(body.lockId) ||
        (body.ttlSec !== undefined && (!isFiniteNumber(body.ttlSec) || body.ttlSec <= 0))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_lock_renew' } });
        return;
      }
      try {
        const renewed = await api.renewLock({
          sessionId: body.sessionId,
          lockId: body.lockId,
          ...(body.ttlSec === undefined ? {} : { ttlSec: body.ttlSec }),
        });
        this.#sendJson(res, 200, { renewed });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 1 && parts[0] === 'release' && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (!isNonEmptyString(body.sessionId) || !isNonEmptyString(body.lockId)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_lock_release' } });
        return;
      }
      try {
        const released = await api.releaseLock({ sessionId: body.sessionId, lockId: body.lockId });
        this.#sendJson(res, 200, { released });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    if (parts.length === 2 && (parts[1] === 'status' || parts[1] === 'origin') && req.method === 'GET') {
      const sessionId = this.#decodePathPart(parts[0]!, res);
      if (sessionId === null) return;
      try {
        if (parts[1] === 'status') {
          this.#sendJson(res, 200, { locked: await api.isSessionLocked(sessionId) });
        } else {
          this.#sendJson(res, 200, { origin: await api.getSessionLockOrigin(sessionId) });
        }
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #routeModeState(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.modeStateApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'mode_state_api_unavailable' } });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(2);
    try {
      if (parts.length === 1 && req.method === 'GET') {
        const sessionId = this.#decodePathPart(parts[0]!, res);
        if (sessionId === null) return;
        this.#sendJson(res, 200, await api.listModeStateBySession(sessionId));
        return;
      }
      if (parts.length === 2) {
        const sessionId = this.#decodePathPart(parts[0]!, res);
        if (sessionId === null) return;
        const mode = this.#decodePathPart(parts[1]!, res);
        if (mode === null) return;
        if (req.method === 'GET') {
          this.#sendJson(res, 200, await api.getModeState(sessionId, mode));
          return;
        }
        if (req.method === 'POST') {
          const body = await this.#readJson(req, res);
          if (body === null) return;
          const input = parseModeStateUpsertInput(body, sessionId, mode);
          if (!input) {
            this.#sendJson(res, 400, { error: { code: 'invalid_mode_state' } });
            return;
          }
          await api.upsertModeState(input);
          this.#sendJson(res, 200, { ok: true });
          return;
        }
      }
      if (parts.length === 3 && parts[2] === 'status' && req.method === 'POST') {
        const sessionId = this.#decodePathPart(parts[0]!, res);
        if (sessionId === null) return;
        const mode = this.#decodePathPart(parts[1]!, res);
        if (mode === null) return;
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (!isNonEmptyString(body.status)) {
          this.#sendJson(res, 400, { error: { code: 'invalid_mode_state_status' } });
          return;
        }
        await api.setModeStateStatus(sessionId, mode, body.status);
        this.#sendJson(res, 200, { ok: true });
        return;
      }
      this.#sendJson(res, parts.length > 0 ? 404 : 405, { error: { code: 'not_found' } });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #routeGoals(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.goalApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'goal_api_unavailable' } });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean).slice(2);
    try {
      if (parts.length === 0 && req.method === 'GET') {
        const status = url.searchParams.get('status');
        if (!isGoalStatus(status)) {
          this.#sendJson(res, 400, { error: { code: 'invalid_goal_status' } });
          return;
        }
        this.#sendJson(res, 200, await api.listByStatus(status));
        return;
      }
      if (parts.length === 0 && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        const input = parseGoalCreateInput(body);
        if (!input) {
          this.#sendJson(res, 400, { error: { code: 'invalid_goal' } });
          return;
        }
        this.#sendJson(res, 200, await api.getOrCreateGoal(input));
        return;
      }
      if (parts.length === 0) {
        this.#sendJson(res, 405, { error: { code: 'method_not_allowed' } });
        return;
      }

      const sessionId = this.#decodePathPart(parts[0]!, res);
      if (sessionId === null) return;
      if (parts.length === 1 && req.method === 'GET') {
        this.#sendJson(res, 200, await api.getGoal(sessionId));
        return;
      }
      if (parts.length === 2 && parts[1] === 'budget' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (
          (body.tokensUsedDelta !== undefined && !isFiniteNumber(body.tokensUsedDelta)) ||
          (body.timeUsedDelta !== undefined && !isFiniteNumber(body.timeUsedDelta))
        ) {
          this.#sendJson(res, 400, { error: { code: 'invalid_goal_budget_delta' } });
          return;
        }
        this.#sendJson(res, 200, await api.updateBudget(sessionId, {
          ...(body.tokensUsedDelta === undefined ? {} : { tokensUsedDelta: body.tokensUsedDelta as number }),
          ...(body.timeUsedDelta === undefined ? {} : { timeUsedDelta: body.timeUsedDelta as number }),
        }));
        return;
      }
      if (parts.length === 2 && parts[1] === 'status' && req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (!isGoalStatus(body.status)) {
          this.#sendJson(res, 400, { error: { code: 'invalid_goal_status' } });
          return;
        }
        this.#sendJson(res, 200, await api.setStatus(sessionId, body.status));
        return;
      }
      this.#sendJson(res, 404, { error: { code: 'not_found' } });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #exportRollout(
    req: IncomingMessage,
    res: ServerResponse,
    localRolloutApi: HostLocalRolloutApiV1,
  ): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (
      typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
      (body.destinationDirectory !== undefined && typeof body.destinationDirectory !== 'string')
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_rollout_export' } });
      return;
    }
    try {
      const result = await localRolloutApi.exportRollout(
        body.sessionId,
        typeof body.destinationDirectory === 'string' ? body.destinationDirectory : undefined,
      );
      this.#sendJson(res, 200, result);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  /**
   * One workspace file read.
   *
   * The body carries a Workspace ID and a workspace-relative path, never a host
   * path: a client that cannot name an absolute path cannot ask for one
   * outside the workspace. The handler therefore validates SHAPE only, and the
   * API behind it owns containment.
   */
  async #readWorkspaceFile(
    req: IncomingMessage,
    res: ServerResponse,
    workspaceFileApi: HostLocalWorkspaceFileApiV1,
  ): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (
      typeof body.workspaceId !== 'string' || body.workspaceId.length === 0 ||
      typeof body.relativePath !== 'string' || body.relativePath.length === 0 ||
      (body.maxBytes !== undefined && (typeof body.maxBytes !== 'number' || !Number.isSafeInteger(body.maxBytes)))
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_workspace_file_read' } });
      return;
    }
    try {
      const result = await workspaceFileApi.readWorkspaceFile({
        workspaceId: body.workspaceId as WorkspaceId,
        relativePath: body.relativePath,
        ...(body.maxBytes === undefined ? {} : { maxBytes: body.maxBytes }),
      });
      this.#sendJson(res, 200, result);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #importRollout(
    req: IncomingMessage,
    res: ServerResponse,
    localRolloutApi: HostLocalRolloutApiV1,
  ): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (typeof body.sourcePath !== 'string' || body.sourcePath.length === 0) {
      this.#sendJson(res, 400, { error: { code: 'invalid_rollout_import' } });
      return;
    }
    let input: HostLocalRolloutImportInput;
    if (body.mode === 'restore') {
      if (body.title !== undefined && typeof body.title !== 'string') {
        this.#sendJson(res, 400, { error: { code: 'invalid_rollout_import' } });
        return;
      }
      input = {
        mode: 'restore',
        sourcePath: body.sourcePath,
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
      };
    } else if (body.mode === 'continue' && typeof body.targetSessionId === 'string' && body.targetSessionId.length > 0) {
      input = {
        mode: 'continue',
        sourcePath: body.sourcePath,
        targetSessionId: body.targetSessionId as SessionId,
      };
    } else {
      this.#sendJson(res, 400, { error: { code: 'invalid_rollout_import' } });
      return;
    }
    try {
      this.#sendJson(res, 200, await localRolloutApi.importRollout(input));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #createImportedSession(
    req: IncomingMessage,
    res: ServerResponse,
    api: HostLocalSessionImportApiV1,
  ): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (
      typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
      typeof body.title !== 'string' ||
      typeof body.workingDirectory !== 'string' ||
      typeof body.projectName !== 'string'
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_session_import' } });
      return;
    }
    try {
      const input: HostLocalSessionImportInput = {
        sessionId: body.sessionId,
        title: body.title,
        workingDirectory: body.workingDirectory,
        projectName: body.projectName,
      };
      this.#sendJson(res, 200, await api.createImportedSession(input));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #rollbackImportedSessions(
    req: IncomingMessage,
    res: ServerResponse,
    api: HostLocalSessionImportApiV1,
  ): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (
      !Array.isArray(body.sessionIds) || body.sessionIds.length > 1000 ||
      !body.sessionIds.every((sessionId) => typeof sessionId === 'string')
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_session_rollback' } });
      return;
    }
    try {
      this.#sendJson(res, 200, await api.rollbackImportedSessions(body.sessionIds));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #registerLocalDirectory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const workspaceApi = this.#options.workspaceApi;
    if (!workspaceApi) {
      this.#sendJson(res, 404, { error: { code: 'workspace_registration_unavailable' } });
      return;
    }
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (!isRecord(body) || typeof body.directory !== 'string') {
      this.#sendJson(res, 400, { error: { code: 'invalid_workspace_path' } });
      return;
    }
    try {
      const workspace = await workspaceApi.registerLocalDirectory(body.directory);
      this.#sendJson(res, 201, { workspace });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #getSession(sessionId: string, url: URL, res: ServerResponse): Promise<void> {
    const includeAllSessionsRaw = url.searchParams.get('includeAllSessions');
    if (includeAllSessionsRaw !== null && includeAllSessionsRaw !== 'true' && includeAllSessionsRaw !== 'false') {
      this.#sendJson(res, 400, { error: { code: 'invalid_session_filter' } });
      return;
    }
    try {
      const session = await this.#options.api.get(sessionId as SessionId, {
        ...(includeAllSessionsRaw === null ? {} : { includeAllSessions: includeAllSessionsRaw === 'true' }),
      });
      if (!session) {
        this.#sendJson(res, 404, { error: { code: 'session_not_found' } });
        return;
      }
      const timelineCount = await this.#options.api.countTimeline(session.id);
      this.#sendJson(res, 200, { session, timelineCount });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #updateSession(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    const expectedUpdatedAt = body.expectedUpdatedAt;
    const patch = this.#parsePatch(body.patch);
    if ((expectedUpdatedAt !== undefined && !Number.isSafeInteger(expectedUpdatedAt)) || !patch) {
      this.#sendJson(res, 400, { error: { code: 'invalid_session_update' } });
      return;
    }
    try {
      const result = await this.#options.api.update(
        sessionId as SessionId,
        expectedUpdatedAt as number | undefined,
        patch,
      );
      this.#sendJson(res, result.updated ? 200 : result.reason === 'conflict' ? 409 : 404, result);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #deleteSession(sessionId: string, url: URL, res: ServerResponse): Promise<void> {
    const expected = this.#optionalNumber(url.searchParams.get('expectedUpdatedAt'));
    if (expected === null) {
      this.#sendJson(res, 400, { error: { code: 'invalid_updated_at' } });
      return;
    }
    try {
      const result = await this.#options.api.delete(
        sessionId as SessionId,
        expected,
      );
      this.#sendJson(res, result.deleted ? 200 : result.reason === 'conflict' ? 409 : 404, result);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #readTimeline(sessionId: string, url: URL, res: ServerResponse): Promise<void> {
    const limit = this.#optionalNumber(url.searchParams.get('limit'));
    if (limit === null) {
      this.#sendJson(res, 400, { error: { code: 'invalid_page' } });
      return;
    }
    try {
      const page = await this.#options.api.readTimeline(
        sessionId as SessionId,
        {
          ...(limit === undefined ? {} : { limit }),
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') ?? '' } : {}),
        },
      );
      this.#sendJson(res, 200, page);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #readProjectedTimeline(sessionId: string, url: URL, res: ServerResponse): Promise<void> {
    const limit = this.#optionalNumber(url.searchParams.get('limit'));
    if (limit === null) {
      this.#sendJson(res, 400, { error: { code: 'invalid_page' } });
      return;
    }
    try {
      const page = await this.#options.api.readProjectedTimeline(
        sessionId as SessionId,
        {
          ...(limit === undefined ? {} : { limit }),
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') ?? '' } : {}),
        },
      );
      this.#sendJson(res, 200, page);
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #readMessages(sessionId: string, url: URL, res: ServerResponse): Promise<void> {
    const limit = this.#optionalNumber(url.searchParams.get('limit'));
    const includeSupersededRaw = url.searchParams.get('includeSuperseded');
    const sources = url.searchParams.getAll('source');
    if (
      limit === null ||
      (includeSupersededRaw !== null && includeSupersededRaw !== 'true' && includeSupersededRaw !== 'false') ||
      sources.length > 32 ||
      sources.some((source) => source.length === 0 || source.length > 128)
    ) {
      this.#sendJson(res, 400, { error: { code: 'invalid_message_query' } });
      return;
    }
    const query: HostMessageReadQuery = {
      ...(limit === undefined ? {} : { limit }),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') ?? '' } : {}),
      ...(includeSupersededRaw === null ? {} : { includeSuperseded: includeSupersededRaw === 'true' }),
      ...(sources.length === 0 ? {} : { sources }),
    };
    try {
      this.#sendJson(res, 200, await this.#options.api.readMessages(sessionId as SessionId, query));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #appendTimeline(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (!Array.isArray(body.entries) || !body.entries.every(isDurableTimelineEntry)) {
      this.#sendJson(res, 400, { error: { code: 'invalid_timeline_entries' } });
      return;
    }
    if (body.turnId !== undefined && body.turnId !== null && typeof body.turnId !== 'string') {
      this.#sendJson(res, 400, { error: { code: 'invalid_turn_id' } });
      return;
    }
    const input: HostTimelineAppendInput = {
      entries: body.entries,
      ...(body.turnId === undefined ? {} : { turnId: body.turnId as string | null }),
    };
    try {
      this.#sendJson(res, 200, await this.#options.api.appendTimeline(
        sessionId as NonNullable<HostSessionListQuery['workspaceId']>,
        input,
      ));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #routeLocalImportBatches(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.localImportBatchApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'import_batch_api_unavailable' } });
      return;
    }

    const basePath = '/v1/local/import-batches';
    if (url.pathname === basePath && req.method === 'GET') {
      try {
        this.#sendJson(res, 200, { batches: await api.listBatches() });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (url.pathname === basePath && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const input = parseHostImportBatchCreate(body);
      if (!input) {
        this.#sendJson(res, 400, { error: { code: 'invalid_import_batch' } });
        return;
      }
      try {
        this.#sendJson(res, 201, { batch: await api.createBatch(input) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }

    const suffix = url.pathname.slice(basePath.length).replace(/^\/+/, '');
    const [encodedBatchId, action, ...extra] = suffix.split('/');
    let batchId: string;
    try {
      batchId = decodeURIComponent(encodedBatchId ?? '');
    } catch {
      this.#sendJson(res, 400, { error: { code: 'invalid_import_batch_id' } });
      return;
    }
    if (!isBoundedString(batchId, 1, 200) || extra.length > 0) {
      this.#sendJson(res, 400, { error: { code: 'invalid_import_batch_id' } });
      return;
    }

    if (action === 'items' && req.method === 'GET') {
      try {
        this.#sendJson(res, 200, { items: await api.getBatchItems(batchId) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (action === 'items' && req.method === 'POST') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      const item = parseHostImportBatchItem(batchId, body);
      if (!item) {
        this.#sendJson(res, 400, { error: { code: 'invalid_import_batch_item' } });
        return;
      }
      try {
        this.#sendJson(res, 201, { item: await api.addItem(item) });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (!action && req.method === 'PATCH') {
      const body = await this.#readJson(req, res);
      if (body === null) return;
      if (
        !isBoundedString(body.status, 1, 64) ||
        typeof body.appliedItems !== 'number' ||
        !Number.isSafeInteger(body.appliedItems) ||
        body.appliedItems < 0
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_import_batch_status' } });
        return;
      }
      try {
        await api.updateBatchStatus(batchId, body.status, Number(body.appliedItems));
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    if (action === 'rollback' && req.method === 'POST') {
      try {
        await api.rollbackBatchItems(batchId);
        this.#sendJson(res, 200, { success: true });
      } catch (error) {
        this.#sendApiError(res, error);
      }
      return;
    }
    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #routeLocalSidebarSections(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.localSidebarSectionsApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'sidebar_sections_api_unavailable' } });
      return;
    }

    const requiredQuery = (key: string, maxLength = 4096): string | null => {
      const value = url.searchParams.get(key);
      return isBoundedString(value, 1, maxLength) ? value : null;
    };
    const optionalText = (value: unknown): value is string | null =>
      value === null || isBoundedString(value, 0, 512);
    const readStringArray = (value: unknown): string[] | null =>
      Array.isArray(value) && value.length <= 2000 && value.every((item) => isBoundedString(item, 0, 4096))
        ? value
        : null;

    try {
      if (req.method === 'GET' && url.pathname === '/v1/local/sidebar-sections') {
        this.#sendJson(res, 200, await api.listSidebarSections());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/local/sidebar-sections/project/section') {
        const workingDirectory = requiredQuery('workingDirectory');
        if (!workingDirectory) {
          this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_sections_query' } });
          return;
        }
        this.#sendJson(res, 200, {
          sectionId: await api.findSidebarSectionForProject(workingDirectory),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/local/sidebar-sections') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (
          !isBoundedString(body.name, 1, 200) ||
          (body.icon !== undefined && !optionalText(body.icon)) ||
          (body.color !== undefined && !optionalText(body.color)) ||
          (body.sortOrder !== undefined && (!Number.isSafeInteger(body.sortOrder) || (body.sortOrder as number) < 0)) ||
          (body.collapsed !== undefined && typeof body.collapsed !== 'boolean')
        ) {
          this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_section' } });
          return;
        }
        const input: SidebarSectionCreateInput = {
          name: body.name,
          ...(body.icon === null || typeof body.icon === 'string' ? { icon: body.icon } : {}),
          ...(body.color === null || typeof body.color === 'string' ? { color: body.color } : {}),
          ...(typeof body.sortOrder === 'number' ? { sortOrder: body.sortOrder } : {}),
          ...(typeof body.collapsed === 'boolean' ? { collapsed: body.collapsed } : {}),
        };
        this.#sendJson(res, 201, { section: await api.createSidebarSection(input) });
        return;
      }
      if (req.method === 'PATCH' && url.pathname === '/v1/local/sidebar-sections/section') {
        const id = requiredQuery('id', 256);
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (
          !id ||
          (body.name !== undefined && !isBoundedString(body.name, 1, 200)) ||
          (body.icon !== undefined && !optionalText(body.icon)) ||
          (body.color !== undefined && !optionalText(body.color)) ||
          (body.sortOrder !== undefined && (!Number.isSafeInteger(body.sortOrder) || (body.sortOrder as number) < 0)) ||
          (body.collapsed !== undefined && typeof body.collapsed !== 'boolean')
        ) {
          this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_section_patch' } });
          return;
        }
        const patch: SidebarSectionPatch = {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(body.icon === null || typeof body.icon === 'string' ? { icon: body.icon } : {}),
          ...(body.color === null || typeof body.color === 'string' ? { color: body.color } : {}),
          ...(typeof body.sortOrder === 'number' ? { sortOrder: body.sortOrder } : {}),
          ...(typeof body.collapsed === 'boolean' ? { collapsed: body.collapsed } : {}),
        };
        const section = await api.updateSidebarSection(id, patch);
        this.#sendJson(res, section ? 200 : 404, { section });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/v1/local/sidebar-sections/section') {
        const id = requiredQuery('id', 256);
        if (!id) {
          this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_sections_query' } });
          return;
        }
        this.#sendJson(res, 200, { deleted: await api.deleteSidebarSection(id) });
        return;
      }

      if (req.method === 'POST') {
        const body = await this.#readJson(req, res);
        if (body === null) return;
        if (url.pathname === '/v1/local/sidebar-sections/project/assign') {
          if (!isBoundedString(body.sectionId, 1, 256) || !isBoundedString(body.workingDirectory, 1, 4096)) {
            this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_project_assignment' } });
            return;
          }
          this.#sendJson(res, 200, {
            project: await api.assignSidebarProject(body.sectionId, body.workingDirectory),
          });
          return;
        }
        if (url.pathname === '/v1/local/sidebar-sections/project/unassign') {
          if (!isBoundedString(body.workingDirectory, 1, 4096)) {
            this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_project_assignment' } });
            return;
          }
          await api.unassignSidebarProject(body.workingDirectory);
          this.#sendJson(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/v1/local/sidebar-sections/reorder') {
          const orderedIds = readStringArray(body.orderedIds);
          if (!orderedIds) {
            this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_section_order' } });
            return;
          }
          await api.reorderSidebarSections(orderedIds);
          this.#sendJson(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/v1/local/sidebar-sections/project/reorder') {
          const orderedDirectories = readStringArray(body.orderedDirectories);
          if (!isBoundedString(body.sectionId, 1, 256) || !orderedDirectories) {
            this.#sendJson(res, 400, { error: { code: 'invalid_sidebar_project_order' } });
            return;
          }
          await api.reorderSidebarProjects(body.sectionId, orderedDirectories);
          this.#sendJson(res, 200, { ok: true });
          return;
        }
      }
      this.#sendJson(res, 404, { error: { code: 'not_found' } });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #routeLocalPendingWakes(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.localPendingWakeApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'local_pending_wake_api_unavailable' } });
      return;
    }

    const path = url.pathname;
    if (req.method === 'GET' && path === '/v1/local/pending-wakes') {
      this.#sendJson(res, 200, { items: await api.listPendingWakes() });
      return;
    }
    if (req.method === 'GET' && path === '/v1/local/pending-wakes/item') {
      const kind = url.searchParams.get('kind');
      const workId = url.searchParams.get('workId');
      if (!isHostPendingWakeKind(kind) || !workId) {
        this.#sendJson(res, 400, { error: { code: 'invalid_pending_wake_query' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.getPendingWake(kind, workId) });
      return;
    }
    if (req.method !== 'POST') {
      this.#sendJson(res, 404, { error: { code: 'not_found' } });
      return;
    }
    const body = await this.#readJson(req, res);
    if (!body) return;

    if (path === '/v1/local/pending-wakes/persist') {
      if (
        !isHostPendingWakeKind(body.kind) ||
        typeof body.workId !== 'string' || body.workId.length === 0 ||
        typeof body.agentId !== 'string' || body.agentId.length === 0 ||
        (body.lane !== undefined && !isHostPendingWakeLane(body.lane)) ||
        (body.title !== undefined && body.title !== null && typeof body.title !== 'string') ||
        (body.quietOriginJson !== undefined && body.quietOriginJson !== null && typeof body.quietOriginJson !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_pending_wake' } });
        return;
      }
      const input: HostPendingWakeInput = {
        kind: body.kind,
        workId: body.workId,
        agentId: body.agentId,
        ...(isHostPendingWakeLane(body.lane) ? { lane: body.lane } : {}),
        ...(body.title === null || typeof body.title === 'string' ? { title: body.title } : {}),
        ...(body.quietOriginJson === null || typeof body.quietOriginJson === 'string'
          ? { quietOriginJson: body.quietOriginJson }
          : {}),
      };
      await api.persistPendingWake(input);
      this.#sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/v1/local/pending-wakes/clear') {
      if (!isHostPendingWakeKind(body.kind) || typeof body.workId !== 'string' || body.workId.length === 0) {
        this.#sendJson(res, 400, { error: { code: 'invalid_pending_wake_query' } });
        return;
      }
      this.#sendJson(res, 200, { deleted: await api.clearPendingWake(body.kind, body.workId) });
      return;
    }
    if (path === '/v1/local/pending-wakes/prune-stale') {
      if (body.beforeMs !== undefined && (typeof body.beforeMs !== 'number' || !Number.isFinite(body.beforeMs))) {
        this.#sendJson(res, 400, { error: { code: 'invalid_pending_wake_prune' } });
        return;
      }
      this.#sendJson(res, 200, { pruned: await api.pruneStalePendingWakes(body.beforeMs as number | undefined) });
      return;
    }
    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #routeLocalMailbox(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const api = this.#options.localMailboxApi;
    if (!api) {
      this.#sendJson(res, 404, { error: { code: 'local_mailbox_api_unavailable' } });
      return;
    }

    const path = url.pathname;
    if (req.method === 'GET' && path === '/v1/local/mailbox/item') {
      const id = url.searchParams.get('id');
      if (!id) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_query' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.getItem(id) });
      return;
    }
    if (req.method === 'GET' && path === '/v1/local/mailbox/by-client-message') {
      const sessionId = url.searchParams.get('sessionId');
      const clientMsgId = url.searchParams.get('clientMsgId');
      if (!sessionId || !clientMsgId) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_query' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.getByClientMsgId(sessionId, clientMsgId) });
      return;
    }
    if (req.method === 'GET' && path === '/v1/local/mailbox/list') {
      const sessionId = url.searchParams.get('sessionId');
      const limit = parseQueryInteger(url.searchParams.get('limit'));
      const statuses = url.searchParams.getAll('status');
      if (
        !sessionId ||
        (url.searchParams.has('limit') && (limit === undefined || limit < 0)) ||
        statuses.some((status) => !isHostMailboxStatus(status))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_query' } });
        return;
      }
      const items = await api.listMailboxItems(sessionId, {
        ...(statuses.length === 0 ? {} : { status: statuses as HostMailboxStatus[] }),
        ...(limit === undefined ? {} : { limit }),
      });
      this.#sendJson(res, 200, { items });
      return;
    }
    if (req.method === 'GET' && path === '/v1/local/mailbox/list-for-session') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_query' } });
        return;
      }
      this.#sendJson(res, 200, { items: await api.listMailboxItemsForSession(sessionId) });
      return;
    }

    if (req.method !== 'POST') {
      this.#sendJson(res, path === '/v1/local/mailbox' ? 405 : 404, { error: { code: 'not_found' } });
      return;
    }
    const body = await this.#readJson(req, res);
    if (!body) return;

    if (path === '/v1/local/mailbox/enqueue') {
      if (
        !isNonEmptyString(body.id) ||
        !isNonEmptyString(body.sessionId) ||
        typeof body.submittedRunId !== 'string' ||
        typeof body.content !== 'string' ||
        !isHostMailboxKind(body.kind) ||
        (body.attachments !== undefined && !Array.isArray(body.attachments)) ||
        (body.clientMsgId !== undefined && body.clientMsgId !== null && typeof body.clientMsgId !== 'string') ||
        (body.source !== undefined && typeof body.source !== 'string') ||
        (body.meta !== undefined && !isMailboxRecord(body.meta))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_enqueue' } });
        return;
      }
      const input: HostMailboxEnqueueInput = {
        id: body.id,
        sessionId: body.sessionId,
        submittedRunId: body.submittedRunId,
        content: body.content,
        kind: body.kind,
        ...(Array.isArray(body.attachments) ? { attachments: body.attachments } : {}),
        ...(body.clientMsgId === undefined ? {} : { clientMsgId: body.clientMsgId as string | null }),
        ...(typeof body.source === 'string' ? { source: body.source } : {}),
        ...(isMailboxRecord(body.meta) ? { meta: body.meta } : {}),
      };
      this.#sendJson(res, 201, { item: await api.enqueue(input) });
      return;
    }
    if (path === '/v1/local/mailbox/edit') {
      const patch = body.patch;
      if (
        !isNonEmptyString(body.id) ||
        !isMailboxRecord(patch) ||
        (patch.content !== undefined && typeof patch.content !== 'string') ||
        (patch.kind !== undefined && !isHostMailboxKind(patch.kind))
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_edit' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.edit(body.id, {
        ...(typeof patch.content === 'string' ? { content: patch.content } : {}),
        ...(isHostMailboxKind(patch.kind) ? { kind: patch.kind } : {}),
      }) });
      return;
    }
    if (path === '/v1/local/mailbox/guide' || path === '/v1/local/mailbox/promote-queued') {
      if (!isNonEmptyString(body.id)) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_item_id' } });
        return;
      }
      const item = path.endsWith('/guide') ? await api.guide(body.id) : await api.promoteQueued(body.id);
      this.#sendJson(res, 200, { item });
      return;
    }
    if (path === '/v1/local/mailbox/cancel') {
      if (!isNonEmptyString(body.id) || (body.reason !== undefined && typeof body.reason !== 'string')) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_cancel' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.cancel(body.id, body.reason as string | undefined) });
      return;
    }
    if (path === '/v1/local/mailbox/cancel-by-agent') {
      if (!isNonEmptyString(body.id) || !isNonEmptyString(body.claimToken) || typeof body.reason !== 'string') {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_cancel' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.cancelByAgent({
        id: body.id,
        claimToken: body.claimToken,
        reason: body.reason,
      }) });
      return;
    }
    if (path === '/v1/local/mailbox/claim-batch') {
      if (
        !isNonEmptyString(body.sessionId) ||
        !isNonEmptyString(body.runId) ||
        !isHostMailboxCheckpoint(body.checkpoint) ||
        !optionalFiniteNumber(body.limit) ||
        !optionalFiniteNumber(body.leaseMs) ||
        !optionalFiniteNumber(body.coalesceWindowMs) ||
        !optionalFiniteNumber(body.maxClaimAttempts)
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_claim' } });
        return;
      }
      this.#sendJson(res, 200, { result: await api.claimBatch({
        sessionId: body.sessionId,
        runId: body.runId,
        checkpoint: body.checkpoint,
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        ...(typeof body.leaseMs === 'number' ? { leaseMs: body.leaseMs } : {}),
        ...(typeof body.coalesceWindowMs === 'number' ? { coalesceWindowMs: body.coalesceWindowMs } : {}),
        ...(typeof body.maxClaimAttempts === 'number' ? { maxClaimAttempts: body.maxClaimAttempts } : {}),
      }) });
      return;
    }
    if (path === '/v1/local/mailbox/apply') {
      if (
        !isNonEmptyString(body.id) ||
        !isNonEmptyString(body.claimToken) ||
        !isHostMailboxApplyMode(body.mode) ||
        !isHostMailboxCheckpoint(body.checkpoint) ||
        (body.summary !== undefined && typeof body.summary !== 'string') ||
        (body.resultingEventId !== undefined && body.resultingEventId !== null && typeof body.resultingEventId !== 'string')
      ) {
        this.#sendJson(res, 400, { error: { code: 'invalid_mailbox_apply' } });
        return;
      }
      this.#sendJson(res, 200, { item: await api.apply({
        id: body.id,
        claimToken: body.claimToken,
        mode: body.mode,
        checkpoint: body.checkpoint,
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        ...(body.resultingEventId === undefined ? {} : { resultingEventId: body.resultingEventId as string | null }),
      }) });
      return;
    }
    this.#sendJson(res, 404, { error: { code: 'not_found' } });
  }

  async #readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      this.#sendJson(res, 415, { error: { code: 'content_type_must_be_json' } });
      return null;
    }
    const limit = this.#options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        tooLarge = true;
        continue;
      }
      chunks.push(bytes);
    }
    if (tooLarge) {
      this.#sendJson(res, 413, { error: { code: 'request_too_large' } });
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isRecord(parsed)) throw new Error('body must be an object');
      return parsed;
    } catch {
      this.#sendJson(res, 400, { error: { code: 'invalid_json' } });
      return null;
    }
  }

  async #createTask(sessionId: SessionId, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    const input = this.#parseTaskCreate(body);
    if (!input) {
      this.#sendJson(res, 400, { error: { code: 'invalid_task' } });
      return;
    }
    try {
      this.#sendJson(res, 201, { task: await this.#options.taskApi.createTask(sessionId, input) });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #updateTask(taskId: TaskId, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    const patch = this.#parseTaskPatch(body);
    if (!patch) {
      this.#sendJson(res, 400, { error: { code: 'invalid_task_patch' } });
      return;
    }
    try {
      const task = await this.#options.taskApi.updateTask(taskId, patch);
      this.#sendJson(res, task ? 200 : 404, { task });
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #claimTask(taskId: TaskId, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (typeof body.owner !== 'string' || body.owner.trim().length === 0) {
      this.#sendJson(res, 400, { error: { code: 'invalid_task_owner' } });
      return;
    }
    try {
      this.#sendJson(res, 200, await this.#options.taskApi.claimTask(taskId, body.owner));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  async #unassignTasks(sessionId: SessionId, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.#readJson(req, res);
    if (body === null) return;
    if (typeof body.owner !== 'string' || body.owner.trim().length === 0) {
      this.#sendJson(res, 400, { error: { code: 'invalid_task_owner' } });
      return;
    }
    try {
      this.#sendJson(res, 200, await this.#options.taskApi.unassignTeammateTasks(sessionId, body.owner));
    } catch (error) {
      this.#sendApiError(res, error);
    }
  }

  #parseTaskCreate(value: Record<string, unknown>): TaskCreateInput | null {
    if (typeof value.subject !== 'string' || typeof value.description !== 'string') return null;
    if (!Array.isArray(value.blocks) || !value.blocks.every((id) => typeof id === 'string')) return null;
    if (!Array.isArray(value.blockedBy) || !value.blockedBy.every((id) => typeof id === 'string')) return null;
    if (value.id !== undefined && typeof value.id !== 'string') return null;
    if (value.status !== undefined && !isTaskStatus(value.status)) return null;
    if (value.activeForm !== undefined && typeof value.activeForm !== 'string') return null;
    if (value.owner !== undefined && typeof value.owner !== 'string') return null;
    if (value.metadata !== undefined && !isRecord(value.metadata)) return null;
    return {
      ...(typeof value.id === 'string' ? { id: value.id as TaskId } : {}),
      subject: value.subject,
      description: value.description,
      status: isTaskStatus(value.status) ? value.status : 'pending',
      ...(typeof value.activeForm === 'string' ? { activeForm: value.activeForm } : {}),
      ...(typeof value.owner === 'string' ? { owner: value.owner } : {}),
      blocks: value.blocks as string[],
      blockedBy: value.blockedBy as string[],
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    };
  }

  #parseTaskPatch(value: Record<string, unknown>): TaskUpdateInput | null {
    const patch: TaskUpdateInput = {};
    const output = patch as {
      subject?: string;
      description?: string;
      status?: TaskStatus;
      activeForm?: string | null;
      owner?: string | null;
      blocks?: string[];
      blockedBy?: string[];
      metadata?: Record<string, unknown>;
    };
    for (const key of ['subject', 'description'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') return null;
      if (typeof value[key] === 'string') output[key] = value[key];
    }
    for (const key of ['activeForm', 'owner'] as const) {
      if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return null;
      if (value[key] === null || typeof value[key] === 'string') output[key] = value[key];
    }
    if (value.status !== undefined && !isTaskStatus(value.status)) return null;
    if (isTaskStatus(value.status)) output.status = value.status;
    for (const key of ['blocks', 'blockedBy'] as const) {
      if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every((id) => typeof id === 'string'))) return null;
      if (Array.isArray(value[key])) output[key] = value[key] as string[];
    }
    if (value.metadata !== undefined && !isRecord(value.metadata)) return null;
    if (isRecord(value.metadata)) output.metadata = value.metadata;
    return patch;
  }

  #parseCreateInput(body: Record<string, unknown>): HostSessionCreateInput | null {
    const stringFields = ['id', 'workspaceId', 'workspaceRelativePath', 'title', 'projectName', 'status', 'model', 'providerId', 'mode', 'agentType', 'agentName'] as const;
    for (const key of stringFields) {
      if (body[key] !== undefined && typeof body[key] !== 'string') return null;
    }
    if (body.permissionMode !== undefined && !isSessionPermissionProfile(body.permissionMode)) return null;
    if (body.workspaceRootId !== undefined && body.workspaceRootId !== null && typeof body.workspaceRootId !== 'string') return null;
    if (body.workspaceId === undefined && (body.workspaceRootId !== undefined || body.workspaceRelativePath !== undefined)) return null;
    if (body.agentProfileId !== undefined && body.agentProfileId !== null && typeof body.agentProfileId !== 'string') return null;
    if (body.parentSessionId !== undefined && body.parentSessionId !== null && typeof body.parentSessionId !== 'string') return null;
    if (body.spawn !== undefined && !isSpawnInput(body.spawn)) return null;
    if (body.createdAt !== undefined && (!Number.isSafeInteger(body.createdAt) || (body.createdAt as number) < 0)) return null;
    if (body.draft !== undefined && body.draft !== null && typeof body.draft !== 'string') return null;
    if (body.extensions !== undefined && !isRecord(body.extensions)) return null;
    return {
      ...(typeof body.id === 'string' ? { id: body.id as SessionId } : {}),
      ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId as WorkspaceId } : {}),
      ...(body.workspaceRootId === null || typeof body.workspaceRootId === 'string'
        ? { workspaceRootId: body.workspaceRootId as string | null }
        : {}),
      ...(typeof body.workspaceRelativePath === 'string' ? { workspaceRelativePath: body.workspaceRelativePath } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.projectName === 'string' ? { projectName: body.projectName } : {}),
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.providerId === 'string' ? { providerId: body.providerId as Exclude<HostSessionCreateInput['providerId'], undefined> } : {}),
      ...(typeof body.mode === 'string' ? { mode: body.mode } : {}),
      ...(isSessionPermissionProfile(body.permissionMode) ? { permissionMode: body.permissionMode } : {}),
      ...(body.agentProfileId === null || typeof body.agentProfileId === 'string'
        ? { agentProfileId: body.agentProfileId as Exclude<HostSessionCreateInput['agentProfileId'], undefined> }
        : {}),
      ...(body.parentSessionId === null || typeof body.parentSessionId === 'string'
        ? { parentSessionId: body.parentSessionId as Exclude<HostSessionCreateInput['parentSessionId'], undefined> }
        : {}),
      ...(isSpawnInput(body.spawn) ? { spawn: body.spawn } : {}),
      ...(typeof body.agentType === 'string' ? { agentType: body.agentType } : {}),
      ...(typeof body.agentName === 'string' ? { agentName: body.agentName } : {}),
      ...(body.draft === null || typeof body.draft === 'string' ? { draft: body.draft as string | null } : {}),
      ...(isRecord(body.extensions) ? { extensions: body.extensions as JsonObject } : {}),
      ...(typeof body.createdAt === 'number' ? { createdAt: body.createdAt } : {}),
    };
  }

  #parsePatch(value: unknown): HostSessionPatch | null {
    if (!isRecord(value)) return null;
    const patch: HostSessionPatch = {};
    const parsed = patch as {
      title?: string;
      model?: string;
      providerId?: HostSessionPatch['providerId'];
      mode?: string;
      permissionMode?: HostSessionPatch['permissionMode'];
      workspace?: HostSessionPatch['workspace'];
      agentProfileId?: HostSessionPatch['agentProfileId'];
      projectName?: string;
      status?: string;
      parentSessionId?: SessionId | null;
      agentType?: string;
      agentName?: string;
      draft?: string | null;
      extensions?: JsonObject;
    };
    for (const key of ['title', 'projectName', 'status', 'model', 'mode', 'agentType', 'agentName'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') return null;
      if (typeof value[key] === 'string') parsed[key] = value[key];
    }
    if (value.providerId !== undefined && typeof value.providerId !== 'string') return null;
    if (typeof value.providerId === 'string') parsed.providerId = value.providerId as Exclude<HostSessionPatch['providerId'], undefined>;
    if (value.permissionMode !== undefined && !isSessionPermissionProfile(value.permissionMode)) return null;
    if (isSessionPermissionProfile(value.permissionMode)) parsed.permissionMode = value.permissionMode;
    if (value.agentProfileId !== undefined && value.agentProfileId !== null && typeof value.agentProfileId !== 'string') return null;
    if (value.agentProfileId === null || typeof value.agentProfileId === 'string') {
      parsed.agentProfileId = value.agentProfileId as Exclude<HostSessionPatch['agentProfileId'], undefined>;
    }
    if (value.parentSessionId !== undefined && value.parentSessionId !== null && typeof value.parentSessionId !== 'string') return null;
    if (value.parentSessionId === null || typeof value.parentSessionId === 'string') {
      parsed.parentSessionId = value.parentSessionId as SessionId | null;
    }
    if (value.draft !== undefined && value.draft !== null && typeof value.draft !== 'string') return null;
    if (value.draft === null || typeof value.draft === 'string') parsed.draft = value.draft as string | null;
    if (value.workspace !== undefined) {
      if (!isRecord(value.workspace)) return null;
      if (value.workspace.state === 'legacy_unbound') {
        parsed.workspace = { state: 'legacy_unbound' };
      } else if (
        value.workspace.state === 'bound' &&
        typeof value.workspace.workspaceId === 'string' &&
        (value.workspace.rootId === null || typeof value.workspace.rootId === 'string') &&
        typeof value.workspace.relativePath === 'string'
      ) {
        parsed.workspace = {
          state: 'bound',
          workspaceId: value.workspace.workspaceId as WorkspaceId,
          rootId: value.workspace.rootId,
          relativePath: value.workspace.relativePath,
        };
      } else {
        return null;
      }
    }
    if (value.extensions !== undefined && !isRecord(value.extensions)) return null;
    if (isRecord(value.extensions)) parsed.extensions = value.extensions as JsonObject;
    return patch;
  }

  #optionalNumber(raw: string | null): number | undefined | null {
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  #decodePathPart(raw: string, res: ServerResponse): string | null {
    try {
      const value = decodeURIComponent(raw);
      if (value.length === 0 || value.trim().length === 0) throw new Error('empty path part');
      return value;
    } catch {
      this.#sendJson(res, 400, { error: { code: 'invalid_path' } });
      return null;
    }
  }

  #sendApiError(res: ServerResponse, error: unknown): void {
    if (error instanceof HostCheckoutApiError) {
      // A Host missing the provider or the resolver is a composition gap, not a
      // client mistake: it must not read like "no checkout".
      this.#sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostPluginAppInstanceApiError) {
      this.#sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostProjectApiError) {
      this.#sendJson(res, 409, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostRunApiError) {
      // The attempt pair rides along on a fence refusal. Without it the client
      // sees a 409 it cannot tell from a conflict, and the caller's two opposite
      // remedies (drop the batch, or reconcile with the committed terminal)
      // collapse into one guess.
      this.#sendJson(res, error.status, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fenced === undefined ? {} : { fenced: error.fenced }),
        },
      });
      return;
    }
    if (error instanceof HostLocalRolloutApiError) {
      this.#sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostWorkspaceFileApiError) {
      // The status is carried by the API on purpose: "no such file" and
      // "resolves outside the workspace" must not read the same to a client,
      // and a 500 for either would be a lie about what the Host knows.
      this.#sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostTaskApiError) {
      this.#sendJson(res, 409, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostSessionApiError) {
      const status = error.code === 'session_not_found' || error.code === 'workspace_not_found'
        ? 404
        : 400;
      this.#sendJson(res, status, { error: { code: error.code, message: error.message } });
      return;
    }
    this.#sendJson(res, 500, { error: { code: 'internal_error' } });
  }

  #sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
      'cache-control': 'no-store',
    });
    res.end(data);
  }
}

function isSessionPermissionProfile(value: unknown): value is NonNullable<HostSessionCreateInput['permissionMode']> {
  return typeof value === 'string' && SESSION_PERMISSION_PROFILES.has(value);
}

function parseCreateAgentRunInput(value: unknown): CreateAgentRunInput | null {
  if (
    !isRecord(value) || typeof value.runId !== 'string' || value.runId.trim().length === 0 ||
    typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0 ||
    !isRecord(value.manifest) || value.manifest.version !== 1 || value.manifest.runId !== value.runId ||
    typeof value.manifest.workspaceId !== 'string' || typeof value.manifest.cwd !== 'string' ||
    !Array.isArray(value.manifest.roots) || !value.manifest.roots.every((root) => typeof root === 'string') ||
    typeof value.manifestHash !== 'string' || value.manifestHash.length === 0 ||
    typeof value.inputHash !== 'string' || value.inputHash.length === 0
  ) return null;
  if (value.origin !== undefined && value.origin !== 'user' && value.origin !== 'agent' && value.origin !== 'background') {
    return null;
  }
  if (value.parentRunId !== undefined && typeof value.parentRunId !== 'string') return null;
  return {
    runId: value.runId as RunId,
    sessionId: value.sessionId as SessionId,
    manifest: value.manifest as unknown as CreateAgentRunInput['manifest'],
    manifestHash: value.manifestHash,
    inputHash: value.inputHash,
    ...(value.origin === undefined ? {} : { origin: value.origin as AgentRunOrigin }),
    ...(value.parentRunId === undefined ? {} : { parentRunId: value.parentRunId as RunId }),
  };
}

function parseStartAgentRunInput(value: unknown): StartAgentRunInput | null {
  if (
    !isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0 ||
    typeof value.prompt !== 'string' || value.prompt.length === 0
  ) return null;
  if (value.options !== undefined && !isRecord(value.options)) return null;
  if (value.origin !== undefined && value.origin !== 'user' && value.origin !== 'agent' && value.origin !== 'background') {
    return null;
  }
  if (
    value.apiFormat !== undefined && value.apiFormat !== 'anthropic' && value.apiFormat !== 'openai'
  ) return null;
  // A malformed turn override is a 400, not a field to drop. The Host's own
  // rule is that an input it cannot honour refuses the turn; the wire has to
  // say the same thing, or a caller that sends `permissionMode: "auto"`
  // (the AGENT's vocabulary, not the protocol's) would get a run under
  // `default` and no idea why.
  if (value.permissionMode !== undefined && !isPermissionPolicyMode(value.permissionMode)) return null;
  if (
    value.agentProfileId !== undefined && value.agentProfileId !== null &&
    (typeof value.agentProfileId !== 'string' || value.agentProfileId.trim().length === 0)
  ) return null;
  if (value.effort !== undefined && (typeof value.effort !== 'string' || value.effort.trim().length === 0)) {
    return null;
  }
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) return null;
  if (value.modes !== undefined && !Array.isArray(value.modes)) return null;
  if (value.tools !== undefined && !Array.isArray(value.tools)) return null;
  if (value.permissionRules !== undefined && !isRecord(value.permissionRules)) return null;
  return {
    sessionId: value.sessionId as SessionId,
    prompt: value.prompt,
    ...(value.options === undefined ? {} : { options: value.options as Record<string, unknown> }),
    ...(value.model === undefined || typeof value.model !== 'string' ? {} : { model: value.model }),
    ...(value.providerId === undefined || typeof value.providerId !== 'string'
      ? {}
      : { providerId: value.providerId }),
    ...(value.apiFormat === undefined ? {} : { apiFormat: value.apiFormat }),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    ...(value.workingDirectory === undefined || typeof value.workingDirectory !== 'string'
      ? {}
      : { workingDirectory: value.workingDirectory }),
    ...(value.origin === undefined ? {} : { origin: value.origin as AgentRunOrigin }),
    ...(value.traceId === undefined || typeof value.traceId !== 'string' ? {} : { traceId: value.traceId }),
    ...(value.permissionMode === undefined
      ? {}
      : { permissionMode: value.permissionMode as PermissionPolicyMode }),
    ...(value.agentProfileId === undefined
      ? {}
      : { agentProfileId: value.agentProfileId as string | null }),
    ...(value.attachments === undefined
      ? {}
      : { attachments: value.attachments as readonly FileAttachment[] }),
    ...(value.modes === undefined ? {} : { modes: value.modes as readonly string[] }),
    ...(value.tools === undefined ? {} : { tools: value.tools as readonly string[] }),
    ...(value.permissionRules === undefined
      ? {}
      : { permissionRules: value.permissionRules as PermissionRulesWire }),
  };
}

/**
 * Which authority a run write is presenting, or `null` when it presents none.
 *
 * Exactly one of two shapes, and `null` for everything else — including a body
 * carrying both, and including a bare `epoch` number. The bare number is the
 * shape this replaces: it reads as "the fence" when it is absent, so a caller
 * that forgets it produced an unfenced write that looked fenced all the way to
 * storage. `null` is a 400 on the route, which is the only answer that keeps
 * "I have no attempt" from being something a caller can say by omission.
 */
type RunWriteAuthority =
  | { readonly kind: 'fenced'; readonly fence: RunAttemptFence }
  | { readonly kind: 'unfenced'; readonly authorization: UnfencedRunWriteAuthorization };

function parseRunWriteAuthority(body: unknown): RunWriteAuthority | null {
  if (!isRecord(body)) return null;
  const hasFence = body.fence !== undefined;
  const hasUnfenced = body.unfenced !== undefined;
  if (hasFence === hasUnfenced) return null;
  if (hasUnfenced) {
    const raw = body.unfenced;
    if (
      !isRecord(raw) ||
      typeof raw.reason !== 'string' || raw.reason.trim() === '' ||
      typeof raw.authorizedBy !== 'string' || raw.authorizedBy.trim() === ''
    ) {
      return null;
    }
    return {
      kind: 'unfenced',
      authorization: { reason: raw.reason, authorizedBy: raw.authorizedBy },
    };
  }
  const fence = parseRunAttemptFence(body.fence);
  return fence === null ? null : { kind: 'fenced', fence };
}

/** A fence is an attempt AND the writer presenting it; neither half stands alone. */
function parseRunAttemptFence(value: unknown): RunAttemptFence | null {
  if (!isRecord(value)) return null;
  const { epoch, writer } = value;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  if (typeof writer !== 'string' || writer.trim() === '') return null;
  return { epoch, writer };
}

/**
 * The unfenced append, or a 500-shaped refusal when this Host has no unfenced
 * path to offer.
 *
 * Thrown rather than answered inline because both unfenced helpers need the same
 * answer, and an implementation WITHOUT the optional method must refuse loudly:
 * silently falling back to the fenced method here would be the exact degradation
 * this route exists to prevent, one layer up.
 */
function requireUnfencedAppend(
  api: HostRunApiV1,
  runId: RunId,
  events: readonly RunEventEnvelope[],
  authority: { readonly authorization: UnfencedRunWriteAuthorization },
): Promise<number> {
  const append = api.appendAgentRunEventsUnfenced?.bind(api);
  if (append === undefined) {
    return Promise.reject(new HostRunApiError(
      400,
      'unfenced_run_write_unavailable',
      'this Host offers no unfenced run append path',
    ));
  }
  return append(runId, events, authority.authorization);
}

function requireUnfencedSettle(
  api: HostRunApiV1,
  runId: RunId,
  body: Record<string, unknown>,
  authority: { readonly authorization: UnfencedRunWriteAuthorization },
): Promise<SettleAgentRunResult> {
  const settle = api.settleAgentRunUnfenced?.bind(api);
  if (settle === undefined) {
    return Promise.reject(new HostRunApiError(
      400,
      'unfenced_run_write_unavailable',
      'this Host offers no unfenced run settle path',
    ));
  }
  return settle(
    runId,
    body.terminal as RunTerminalState,
    authority.authorization,
    body.metrics as RunMetrics | undefined,
  );
}

function parseAgentRunEvents(value: unknown, runId: RunId): RunEventEnvelope[] | null {
  if (!isRecord(value) || !Array.isArray(value.events)) return null;
  const events: RunEventEnvelope[] = [];
  for (const item of value.events) {
    if (
      !isRecord(item) || item.runId !== runId || typeof item.sessionId !== 'string' ||
      !Number.isSafeInteger(item.seq) || (item.seq as number) < 1 || !isFiniteNumber(item.timestamp) ||
      typeof item.traceId !== 'string' || !isRecord(item.payload) || typeof item.payload.type !== 'string' ||
      (item.spanId !== undefined && typeof item.spanId !== 'string') ||
      (item.parentRunId !== undefined && typeof item.parentRunId !== 'string')
    ) return null;
    events.push(item as unknown as RunEventEnvelope);
  }
  return events;
}

function isRunTerminalState(value: unknown): value is RunTerminalState {
  if (!isRecord(value)) return false;
  if (value.status === 'completed' || value.status === 'cancelled' || value.status === 'budget_exhausted') {
    return value.stopReason === undefined || typeof value.stopReason === 'string';
  }
  return value.status === 'failed' && isRecord(value.error) &&
    typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

function isRunMetrics(value: unknown): value is RunMetrics {
  if (!isRecord(value)) return false;
  return [
    'eventsTotal', 'eventsDurable', 'eventsVolatile', 'eventsEphemeral', 'toolCalls',
    'permissionRequests', 'wallClockMs',
  ].every((key) => isFiniteNumber(value[key]) && value[key] >= 0);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function isHostPermissionRequestStatus(value: unknown): value is HostPermissionRequestStatus {
  return typeof value === 'string' && PERMISSION_REQUEST_STATUSES.has(value);
}

function parsePermissionRequestCreate(value: Record<string, unknown>): HostPermissionRequestCreateInput | null {
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.toolName)) return null;
  if (value.sessionId !== undefined && value.sessionId !== null && typeof value.sessionId !== 'string') return null;
  if (value.toolInput !== undefined && value.toolInput !== null && !isRecord(value.toolInput)) return null;
  return {
    id: value.id,
    toolName: value.toolName,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string | null }),
    ...(value.toolInput === undefined ? {} : { toolInput: value.toolInput as Record<string, unknown> | null }),
  };
}

function parsePermissionRequestResolve(value: Record<string, unknown>): HostPermissionRequestResolveInput | null {
  if (!isHostPermissionRequestStatus(value.status)) return null;
  if (value.decision !== undefined && typeof value.decision !== 'string') return null;
  if (value.message !== undefined && typeof value.message !== 'string') return null;
  if (value.updatedPermissions !== undefined && !Array.isArray(value.updatedPermissions)) return null;
  if (value.updatedInput !== undefined && !isRecord(value.updatedInput)) return null;
  return {
    status: value.status,
    ...(value.decision === undefined ? {} : { decision: value.decision as string }),
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(value.updatedPermissions === undefined ? {} : { updatedPermissions: value.updatedPermissions }),
    ...(value.updatedInput === undefined ? {} : { updatedInput: value.updatedInput }),
  };
}

function isToolApprovalDecision(value: unknown): value is HostToolApprovalDecision {
  return value === 'allow' || value === 'always' || value === 'deny';
}

function parseToolApprovalScope(
  scopeType: unknown,
  scopeId: unknown,
): { readonly scopeType: HostToolApprovalScopeType; readonly scopeId: string } | null {
  if ((scopeType !== 'bot' && scopeType !== 'session') || !isNonEmptyString(scopeId)) return null;
  return { scopeType, scopeId };
}

function parseToolApprovalInput(value: Record<string, unknown>): HostToolApprovalInput | null {
  const scope = parseToolApprovalScope(value.scopeType, value.scopeId);
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.messageId) ||
    !isNonEmptyString(value.sessionId) ||
    !scope ||
    !isNonEmptyString(value.toolName) ||
    (value.toolInput !== undefined && !isRecord(value.toolInput))
  ) return null;
  return {
    id: value.id,
    messageId: value.messageId,
    sessionId: value.sessionId,
    ...scope,
    toolName: value.toolName,
    ...(value.toolInput === undefined ? {} : { toolInput: value.toolInput as Record<string, unknown> }),
  };
}

function isSpawnInput(value: unknown): value is NonNullable<HostSessionCreateInput['spawn']> {
  if (!isRecord(value)) return false;
  return ['type', 'reason', 'turnId'].every((key) => value[key] === undefined || typeof value[key] === 'string');
}

function readProviderModelCapability(value: unknown): ProviderModelCapabilityRecord | null {
  if (
    !isRecord(value) ||
    typeof value.providerId !== 'string' || value.providerId.trim() === '' ||
    typeof value.modelId !== 'string' || value.modelId.trim() === '' ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
    (value.source !== 'preset' && value.source !== 'models-api' && value.source !== 'user' && value.source !== 'probe')
  ) {
    return null;
  }
  const numberFields = ['contextWindow', 'maxOutputTokens'] as const;
  if (numberFields.some((key) => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))) {
    return null;
  }
  const booleanFields = ['supportsToolUse', 'supportsVision', 'supportsReasoning', 'supportsPromptCache', 'isLoaded'] as const;
  if (booleanFields.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')) return null;
  if (value.displayName !== undefined && typeof value.displayName !== 'string') return null;
  if (
    value.reasoningEffortOptions !== undefined &&
    (!Array.isArray(value.reasoningEffortOptions) || !value.reasoningEffortOptions.every((item) => typeof item === 'string'))
  ) {
    return null;
  }
  if (value.pricing !== undefined) {
    if (!isRecord(value.pricing)) return null;
    for (const key of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const) {
      const amount = value.pricing[key];
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) return null;
    }
    if (value.pricing.currency !== undefined && typeof value.pricing.currency !== 'string') return null;
  }

  return value as unknown as ProviderModelCapabilityRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTurnReviewWriteInput(body: Record<string, unknown>): TurnReviewWriteInput | null {
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const statuses: readonly TurnReviewFileStatus[] = ['modified', 'added', 'deleted', 'renamed', 'untracked'];
  if (
    typeof body.id !== 'string' || body.id.length === 0 ||
    typeof body.sessionId !== 'string' || body.sessionId.length === 0 ||
    typeof body.turnId !== 'string' || body.turnId.length === 0 ||
    typeof body.workingDirectory !== 'string' || body.workingDirectory.length === 0 ||
    typeof body.patch !== 'string' ||
    !isCount(body.additions) || !isCount(body.removals) ||
    typeof body.truncated !== 'boolean' || typeof body.binary !== 'boolean' ||
    typeof body.capturedAt !== 'number' || !Number.isSafeInteger(body.capturedAt) ||
    !Array.isArray(body.files)
  ) return null;

  const files: TurnReviewFile[] = [];
  for (const value of body.files) {
    if (
      !isRecord(value) ||
      typeof value.path !== 'string' || value.path.length === 0 ||
      typeof value.status !== 'string' || !statuses.includes(value.status as TurnReviewFileStatus) ||
      (value.oldPath !== undefined && typeof value.oldPath !== 'string') ||
      !isCount(value.additions) || !isCount(value.removals)
    ) return null;
    files.push({
      path: value.path,
      status: value.status as TurnReviewFileStatus,
      ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
      additions: value.additions,
      removals: value.removals,
    });
  }

  return {
    id: body.id,
    sessionId: body.sessionId,
    turnId: body.turnId,
    workingDirectory: body.workingDirectory,
    files,
    patch: body.patch,
    additions: body.additions,
    removals: body.removals,
    truncated: body.truncated,
    binary: body.binary,
    capturedAt: body.capturedAt,
  };
}

function parseProjectPathEntries(value: unknown): HostProjectPathEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries: HostProjectPathEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isNonEmptyString(entry.path)) return null;
    if (entry.description !== undefined && !isNullableString(entry.description)) return null;
    entries.push({
      path: entry.path,
      description: typeof entry.description === 'string' && entry.description.length > 0
        ? entry.description
        : null,
    });
  }
  return entries;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseModeStateUpsertInput(
  value: unknown,
  sessionId: string,
  mode: string,
): ModeStateUpsertInput | null {
  if (!isRecord(value) || !isNonEmptyString(value.status) || typeof value.snapshotJson !== 'string') return null;
  if (value.reminderCount !== undefined &&
      (!isFiniteNumber(value.reminderCount) || !Number.isInteger(value.reminderCount) || value.reminderCount < 0)) {
    return null;
  }
  return {
    sessionId,
    mode,
    status: value.status,
    snapshotJson: value.snapshotJson,
    ...(value.reminderCount === undefined ? {} : { reminderCount: value.reminderCount as number }),
  };
}

function isMessageEntry(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'message') return false;
  if (typeof value.id !== 'string' || !isNullableString(value.parentId) || !isFiniteNumber(value.createdAt)) return false;
  if (!isRecord(value.message) || typeof value.message.role !== 'string') return false;
  return typeof value.message.content === 'string' || Array.isArray(value.message.content);
}

function isDurableTimelineEntry(value: unknown): value is DurableTimelineEntry {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  switch (value.type) {
    case 'message':
      return isMessageEntry(value);
    case 'compaction':
      return isNullableString(value.parentId)
        && isFiniteNumber(value.createdAt)
        && typeof value.summary === 'string'
        && typeof value.firstKeptMessageId === 'string'
        && Array.isArray(value.compactedMessageIds)
        && value.compactedMessageIds.every((item) => typeof item === 'string')
        && isFiniteNumber(value.tokensBefore)
        && typeof value.strategy === 'string';
    case 'reasoning':
      return typeof value.turnId === 'string'
        && typeof value.model === 'string'
        && typeof value.text === 'string'
        && isFiniteNumber(value.createdAt);
    case 'tool_call':
      return typeof value.turnId === 'string'
        && typeof value.callId === 'string'
        && typeof value.toolName === 'string'
        && typeof value.inputSummary === 'string'
        && isFiniteNumber(value.createdAt);
    case 'turn_started':
      return typeof value.turnId === 'string' && isFiniteNumber(value.startedAt);
    case 'system_context':
      return typeof value.turnId === 'string'
        && (value.kind === 'agents_md' || value.kind === 'app_context')
        && typeof value.content === 'string'
        && isFiniteNumber(value.createdAt);
    case 'rebase':
      return isNullableString(value.turnId)
        && isFiniteNumber(value.createdAt)
        && Array.isArray(value.newMessages)
        && value.newMessages.every(isMessageEntry);
    case 'rotation':
      return typeof value.archiveFile === 'string'
        && isFiniteNumber(value.newGeneration)
        && (value.reason === 'compaction' || value.reason === 'manual')
        && isFiniteNumber(value.seqBeforeRotation)
        && isFiniteNumber(value.createdAt);
    case 'hook_invoked':
      return typeof value.turnId === 'string' && isFiniteNumber(value.createdAt);
    case 'prompt_snapshot':
      return typeof value.turnId === 'string'
        && isFiniteNumber(value.createdAt)
        && isPromptSnapshotPart(value.systemPrompt)
        && Array.isArray(value.contextBlocks)
        && value.contextBlocks.every(isPromptSnapshotBlock);
    default:
      // A type the taxonomy does not know. The whole batch is rejected —
      // one unknown line fails every line — so the reason is counted and
      // reported instead of vanishing into a bare 400 (plan 620 Phase A4).
      if (typeof value.type === 'string') {
        noteUnknownTimelineEntryType(value.type);
      }
      return false;
  }
}

/** One recorded piece of a prompt. */
function isPromptSnapshotPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.hash !== 'string' || !isFiniteNumber(value.length)) return false;
  if (value.content !== undefined && typeof value.content !== 'string') return false;
  return true;
}

/** One recorded volatile-context block. */
function isPromptSnapshotBlock(value: unknown): boolean {
  if (!isPromptSnapshotPart(value) || !isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.source === 'string';
}

/**
 * Unknown timeline entry types, counted.
 *
 * The HTTP endpoint validates a whole batch at once, so an unrecognized
 * `type` used to fail every line of the batch with one bare
 * `invalid_timeline_entries` and no hint about what was wrong. The count
 * makes the gap visible: a type the taxonomy does not know is a client
 * and a server that disagree.
 */
const UNKNOWN_TIMELINE_ENTRY_TYPES = new Map<string, number>();

function noteUnknownTimelineEntryType(type: string): void {
  const count = (UNKNOWN_TIMELINE_ENTRY_TYPES.get(type) ?? 0) + 1;
  UNKNOWN_TIMELINE_ENTRY_TYPES.set(type, count);
  if (count === 1 || count % 20 === 0) {
    logger.warn(
      `Rejecting timeline entry with unknown type "${type}" (${count} seen). ` +
        `The rollout taxonomy has no such discriminator — a client is sending ` +
        `a shape the server does not know.`,
    );
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseHostImportBatchCreate(value: Record<string, unknown>): CreateHostImportBatchInput | null {
  if (
    !isBoundedString(value.source, 1, 200) ||
    typeof value.totalItems !== 'number' ||
    !Number.isSafeInteger(value.totalItems) ||
    value.totalItems < 0 ||
    (value.sourceProjectPath !== undefined && typeof value.sourceProjectPath !== 'string') ||
    (value.targetProjectPath !== undefined && typeof value.targetProjectPath !== 'string')
  ) {
    return null;
  }
  return {
    source: value.source,
    totalItems: value.totalItems,
    ...(typeof value.sourceProjectPath === 'string' ? { sourceProjectPath: value.sourceProjectPath } : {}),
    ...(typeof value.targetProjectPath === 'string' ? { targetProjectPath: value.targetProjectPath } : {}),
  };
}

function parseHostImportBatchItem(
  batchId: string,
  value: Record<string, unknown>,
): CreateHostImportBatchItemInput | null {
  if (
    !isBoundedString(value.sourceType, 1, 200) ||
    !isBoundedString(value.sourcePath, 0, 4096) ||
    !isNullableString(value.sourceHash) ||
    !isBoundedString(value.targetType, 1, 200) ||
    !isBoundedString(value.targetPath, 0, 4096) ||
    !isBoundedString(value.title, 0, 2000) ||
    !isNullableString(value.summary) ||
    !isBoundedString(value.riskLevel, 1, 64) ||
    (value.requiresAuth !== 0 && value.requiresAuth !== 1) ||
    (value.isEnabled !== 0 && value.isEnabled !== 1)
  ) {
    return null;
  }
  return {
    batchId,
    sourceType: value.sourceType,
    sourcePath: value.sourcePath,
    sourceHash: value.sourceHash,
    targetType: value.targetType,
    targetPath: value.targetPath,
    title: value.title,
    summary: value.summary,
    riskLevel: value.riskLevel,
    requiresAuth: value.requiresAuth,
    isEnabled: value.isEnabled,
  };
}



function parseGoalCreateInput(value: unknown): GoalCreateInput | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null;
  if (value.goalText !== undefined && !isNullableString(value.goalText)) return null;
  if (value.tokenBudget !== undefined && value.tokenBudget !== null &&
      (!isFiniteNumber(value.tokenBudget) || value.tokenBudget < 0)) return null;
  return {
    id: value.id,
    sessionId: value.sessionId,
    ...(value.goalText === undefined ? {} : { goalText: value.goalText as string | null }),
    ...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget as number | null }),
  };
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === 'active' || value === 'paused' || value === 'usage_limited' || value === 'complete';
}

function parseWorkflowRunCreateInput(value: unknown): WorkflowRunCreateInput | null {
  if (!isRecord(value) || typeof value.workflowName !== 'string' || value.workflowName.length === 0) return null;
  if (value.id !== undefined && typeof value.id !== 'string') return null;
  if (value.status !== undefined && !isWorkflowRunStatus(value.status)) return null;
  if (value.triggerKind !== undefined && value.triggerKind !== null && !isWorkflowTriggerKind(value.triggerKind)) return null;
  if (value.origin !== undefined && !isWorkflowRunOrigin(value.origin)) return null;
  if (value.scope !== undefined && value.scope !== null && !isWorkflowRunScope(value.scope)) return null;
  if (value.params !== undefined && !isRecord(value.params)) return null;
  for (const key of ['workflowVersionId', 'dedupKey', 'retryOf', 'projectDir', 'parentSessionId', 'summary', 'agentModel']) {
    if (value[key] !== undefined && !isNullableString(value[key])) return null;
  }
  return {
    workflowName: value.workflowName,
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.triggerKind === undefined ? {} : { triggerKind: value.triggerKind as WorkflowTriggerKind | null }),
    ...(value.workflowVersionId === undefined ? {} : { workflowVersionId: value.workflowVersionId as string | null }),
    ...(value.dedupKey === undefined ? {} : { dedupKey: value.dedupKey as string | null }),
    ...(isRecord(value.params) ? { params: value.params } : {}),
    ...(value.retryOf === undefined ? {} : { retryOf: value.retryOf as string | null }),
    ...(value.origin === undefined ? {} : { origin: value.origin as WorkflowRunOrigin }),
    ...(value.scope === undefined ? {} : { scope: value.scope as WorkflowRunScope | null }),
    ...(value.projectDir === undefined ? {} : { projectDir: value.projectDir as string | null }),
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId as string | null }),
    ...(value.summary === undefined ? {} : { summary: value.summary as string | null }),
    ...(value.agentModel === undefined ? {} : { agentModel: value.agentModel as string | null }),
  };
}

function parseWorkflowRunFilter(params: URLSearchParams): WorkflowRunFilter | null {
  const filter: WorkflowRunFilter = {};
  const status = params.get('status');
  if (status !== null) {
    if (!isWorkflowRunStatus(status)) return null;
    filter.status = status;
  }
  const origin = params.get('origin');
  if (origin !== null) {
    if (!isWorkflowRunOrigin(origin)) return null;
    filter.origin = origin;
  }
  const workflowName = params.get('workflowName');
  const parentSessionId = params.get('parentSessionId');
  if (workflowName !== null) filter.workflowName = workflowName;
  if (parentSessionId !== null) filter.parentSessionId = parentSessionId;
  const limit = parseQueryInteger(params.get('limit'));
  const offset = parseQueryInteger(params.get('offset'));
  if ((params.has('limit') && (limit === undefined || limit < 0 || limit > 500)) ||
      (params.has('offset') && (offset === undefined || offset < 0))) return null;
  if (limit !== undefined) filter.limit = limit;
  if (offset !== undefined) filter.offset = offset;
  return filter;
}

function parseWorkflowRunOutcome(value: unknown): WorkflowRunOutcomeInput | null {
  if (!isRecord(value) || !isWorkflowRunStatus(value.status)) return null;
  if (value.summary !== undefined && !isNullableString(value.summary)) return null;
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || !value.artifacts.every(isWorkflowArtifactRef))) return null;
  if (value.spentTokens !== undefined && value.spentTokens !== null && !isFiniteNumber(value.spentTokens)) return null;
  if (value.finishedAt !== undefined && value.finishedAt !== null && !isFiniteNumber(value.finishedAt)) return null;
  return {
    status: value.status,
    ...(value.summary === undefined ? {} : { summary: value.summary as string | null }),
    ...(Array.isArray(value.artifacts) ? { artifacts: value.artifacts as WorkflowArtifactRef[] } : {}),
    ...(value.spentTokens === undefined ? {} : { spentTokens: value.spentTokens as number | null }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as number | null }),
  };
}

function parseWorkflowRunSnapshot(runId: string, value: Record<string, unknown>): WorkflowRunSnapshotSaveInput | null {
  if (!Object.prototype.hasOwnProperty.call(value, 'definition')) return null;
  if (value.nodeStack !== undefined && (!Array.isArray(value.nodeStack) || !value.nodeStack.every((entry) =>
    isRecord(entry) && typeof entry.nodeId === 'string' && typeof entry.status === 'string'))) return null;
  if (value.journal !== undefined && (!Array.isArray(value.journal) || !value.journal.every(isJournalRecord))) return null;
  if (value.updatedAt !== undefined && !isFiniteNumber(value.updatedAt)) return null;
  return {
    runId,
    definition: value.definition,
    ...(Array.isArray(value.nodeStack)
      ? { nodeStack: value.nodeStack as NonNullable<WorkflowRunSnapshotSaveInput['nodeStack']> }
      : {}),
    ...(Array.isArray(value.journal) ? { journal: value.journal as JournalRecord[] } : {}),
    ...(isFiniteNumber(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
  };
}

function isJournalRecord(value: unknown): value is JournalRecord {
  return isRecord(value) && Number.isSafeInteger(value.seq) && typeof value.kind === 'string' &&
    typeof value.nodeId === 'string' && Number.isSafeInteger(value.attempt) && isFiniteNumber(value.atMs) &&
    ['pending', 'running', 'succeeded', 'failed', 'skipped', 'waiting'].includes(String(value.status));
}

function isWorkflowArtifactRef(value: unknown): value is WorkflowArtifactRef {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.contentType === 'string' && isFiniteNumber(value.bytes) && typeof value.relPath === 'string';
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' && [
    'inactive', 'planning', 'awaiting_confirm', 'active', 'verifying', 'user_paused',
    'backoff_paused', 'no_progress_paused', 'infra_paused', 'blocked', 'budget_limited',
    'complete', 'interrupted', 'cancelled', 'failed',
  ].includes(value);
}

function isWorkflowTriggerKind(value: unknown): value is WorkflowTriggerKind {
  return value === 'manual' || value === 'cron' || value === 'bot' || value === 'http';
}

function isWorkflowRunOrigin(value: unknown): value is WorkflowRunOrigin {
  return value === 'library' || value === 'session' || value === 'agent' || value === 'cron';
}

function isWorkflowRunScope(value: unknown): value is WorkflowRunScope {
  return value === 'project' || value === 'global';
}

function parseQueryInteger(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
