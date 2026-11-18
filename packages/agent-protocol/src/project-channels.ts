/**
 * project-channels.ts — the wire contract for external Project channels.
 *
 * One Project owns at most one active Discord connection; one connection binds
 * many guild channels. The Bot is the Project's external identity only — there
 * is no second Coordinator, no forged `botId`, and no parallel Session/Run
 * state machine behind these types. `sessionId` is a target of one accepted
 * input; `projectId` is the stable owner that survives a Coordinator swap.
 *
 * ## The identities are DERIVED, never submitted
 *
 * The Host verifies the real Bot user and the guild/channel with the platform,
 * then records those facts here. Nothing in a channel message, a model tool
 * call, or a client request can name an actor, a project, a source event, a
 * credential, or a raw Discord target and have it believed. Send inputs carry
 * only a binding id and a reply reference; the Host resolves everything else
 * from the authenticated caller and the current binding.
 *
 * ## Idempotency and revisions are part of the contract, not store details
 *
 * - Inbound dedup key is `connectionId + messageId` (A/B/C agree on this exact
 *   composition). The same key with a different body fingerprint is a hard
 *   conflict, never an overwrite of an already-accepted body.
 * - Delivery idempotency is `projectId + requestId`. `queued` is not `sent`;
 *   a transport or persistence gap after the network call is `unknown`, which
 *   no caller may turn into an automatic resend.
 * - Connection and Binding writes are revision CAS: a caller presents the
 *   `expectedRevision` it read, and a stale write is refused rather than
 *   silently applied to a newer row.
 * - A connection `generation` fences runtime callbacks. A stopped or rotated
 *   generation's late callback cannot mutate a newer configuration. It is a
 *   runtime counter, distinct from the persisted config `revision`.
 *
 * This package has ZERO runtime dependencies (drift test #1). Only pure
 * derivation helpers live here; all storage and transport stay in their own
 * packages.
 */

import type { DiagnosticDetail } from './primitives.js';

/** Platform scope is frozen for the first version. */
export const PROJECT_CHANNEL_PLATFORMS = ['discord'] as const;
export type ProjectChannelPlatform = (typeof PROJECT_CHANNEL_PLATFORMS)[number];

// ─── Persisted objects (client-safe: no token, secret path, or message body flood) ──

/**
 * A Project's external Bot identity. `credentialConfigured` is a boolean fact,
 * not a claim that the connection is online: runtime state lives in
 * {@link ProjectChannelRuntimeObservation}.
 */
export interface ProjectChannelConnection {
  readonly connectionId: string;
  readonly projectId: string;
  readonly platform: ProjectChannelPlatform;
  /** Bot user id verified against the platform, never trusted from input. */
  readonly botUserId: string;
  readonly label: string;
  readonly enabled: boolean;
  /** CAS revision, bumped on every accepted config/credential/enable change. */
  readonly revision: number;
  /** Runtime fencing counter, bumped on start/rotate/stop of the transport. */
  readonly generation: number;
  readonly credentialConfigured: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A guild text channel this Project's Bot may observe and reply in. */
export interface ProjectChannelBinding {
  readonly bindingId: string;
  readonly projectId: string;
  readonly connectionId: string;
  /** Guild and channel are platform-verified on create, not guessed by name. */
  readonly guildId: string;
  readonly channelId: string;
  /** Non-empty allowlist; membership is checked by the Host on every event. */
  readonly allowedUserIds: readonly string[];
  /** Explicit opt-in for sends with no originating inbound event. */
  readonly allowProactive: boolean;
  readonly enabled: boolean;
  /** CAS revision. Revocation bumps it and invalidates queued authorizations. */
  readonly revision: number;
  readonly label: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * External event plus the evidence of what the Host did with it. This is NOT a
 * Session/Run state machine: it records one platform message and the durable
 * input it was accepted into, so a redelivery cannot create a second obligation.
 */
export interface ProjectChannelInboundEvent {
  readonly inboundId: string;
  readonly connectionId: string;
  /** Generation that observed the event; a stale generation is ignored. */
  readonly generation: number;
  readonly bindingId: string;
  /** Binding revision this event was accepted under. */
  readonly bindingRevision: number;
  readonly platformMessageId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly senderId: string;
  /** Native platform mention ids; fuzzy name matches never count. */
  readonly mentionIds: readonly string[];
  readonly text: string;
  readonly receivedAt: number;
  /** `connectionId + messageId`, composed by the store. */
  readonly dedupKey: string;
  /** Digest of the immutable body fields, used for conflict detection. */
  readonly bodyFingerprint: string;
  /** The accepted Session input, once the Host has admitted one. */
  readonly inputId: string | null;
  readonly targetSessionId: string | null;
  readonly createdAt: number;
}

export const PROJECT_CHANNEL_DELIVERY_STATUSES = [
  'queued',
  'sending',
  'sent',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type ProjectChannelDeliveryStatus = (typeof PROJECT_CHANNEL_DELIVERY_STATUSES)[number];

/**
 * A durable outbound obligation. `unknown` is deliberately distinct from
 * `failed`: without platform evidence a retry could duplicate a sent message.
 */
export interface ProjectChannelDelivery {
  readonly deliveryId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly epoch: number | null;
  readonly requestId: string;
  readonly bodyFingerprint: string;
  readonly replyToInboundId: string | null;
  /** Platform receipt, present only when the platform acknowledged the send. */
  readonly platformMessageId: string | null;
  readonly status: ProjectChannelDeliveryStatus;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const PROJECT_CHANNEL_RUNTIME_STATES = ['connected', 'disconnected', 'error'] as const;
export type ProjectChannelRuntimeState = (typeof PROJECT_CHANNEL_RUNTIME_STATES)[number];

/**
 * An observation of the live transport, kept separate from persisted config.
 * A configured connection may be offline; an observed Bot may differ from the
 * stored one after a token rotation, which must never silently pass.
 */
export interface ProjectChannelRuntimeObservation {
  readonly connectionId: string;
  readonly generation: number;
  readonly observedBotUserId: string | null;
  readonly state: ProjectChannelRuntimeState;
  /** Safe, structural code only — never a token, body, or raw provider error. */
  readonly errorCode: ProjectChannelErrorCode | null;
  readonly observedAt: number;
}

// ─── Control-plane write inputs (local authenticated caller only) ─────────────

/** Credentials appear ONLY here, on an authenticated local write. Never in an output DTO. */
export interface ConfigureProjectChannelConnectionInput {
  readonly projectId: string;
  readonly requestId: string;
  /** CAS; omit only when creating the first connection for the project. */
  readonly expectedRevision?: number;
  readonly label?: string;
  readonly token: string;
}

export interface CreateProjectChannelBindingInput {
  readonly projectId: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly guildId: string;
  readonly channelId: string;
  /** Non-empty; every id is a platform user id, not a name. */
  readonly allowedUserIds: readonly string[];
  readonly allowProactive?: boolean;
  readonly label?: string;
}

/** CAS patch. Absent fields are unchanged; clearing the allowlist is refused. */
export interface UpdateProjectChannelBindingInput {
  readonly projectId: string;
  readonly bindingId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly allowedUserIds?: readonly string[];
  readonly allowProactive?: boolean;
  readonly enabled?: boolean;
  readonly label?: string;
}

export interface RevokeProjectChannelBindingInput {
  readonly projectId: string;
  readonly bindingId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}

/** CAS disable. Does not claim the remote token was revoked. */
export interface DisconnectProjectChannelInput {
  readonly projectId: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}

/** One page of recent deliveries for a project, from oldest to newest by cursor. */
export interface ProjectChannelDeliveryPage {
  readonly deliveries: readonly ProjectChannelDelivery[];
  readonly nextCursor: number | null;
}

/** Read projection for `GET .../channels`. No bodies, no secrets. */
export interface ProjectChannelOverview {
  readonly projectId: string;
  readonly connection: ProjectChannelConnection | null;
  readonly bindings: readonly ProjectChannelBinding[];
  readonly observation: ProjectChannelRuntimeObservation | null;
  readonly deliveries: ProjectChannelDeliveryPage;
}

/**
 * Authenticated local control plane. A separate optional Host API: the legacy
 * `HostProjectApiV1` mocks stay valid when this surface is absent. Not a model
 * tool, and not reachable from a channel message.
 */
export interface HostProjectChannelApiV1 {
  getProjectChannels(projectId: string, cursor?: number, limit?: number): Promise<ProjectChannelOverview | null>;
  configureDiscordConnection(input: ConfigureProjectChannelConnectionInput): Promise<ProjectChannelConnection>;
  createBinding(input: CreateProjectChannelBindingInput): Promise<ProjectChannelBinding>;
  updateBinding(input: UpdateProjectChannelBindingInput): Promise<ProjectChannelBinding | null>;
  revokeBinding(input: RevokeProjectChannelBindingInput): Promise<ProjectChannelBinding | null>;
  disconnectConnection(input: DisconnectProjectChannelInput): Promise<ProjectChannelConnection | null>;
  getDelivery(projectId: string, deliveryId: string): Promise<ProjectChannelDelivery | null>;
}

// ─── Coordinator model projection (A freezes the shape; D implements the tool) ──

/** One canonical `send_message` shape; the legacy Bot tool keeps its own schema. */
export interface ProjectChannelSendMessageInput {
  readonly requestId: string;
  readonly channelBindingId: string;
  readonly text: string;
  /** Must reference a real inbound event of this Project and binding. */
  readonly replyToInboundId?: string;
}

/** Returned by `project.list_channels`; no raw Discord ids or secrets. */
export interface ProjectChannelListChannelsEntry {
  readonly bindingId: string;
  readonly label: string;
  readonly canReply: boolean;
  readonly canProactive: boolean;
}

export interface ProjectChannelSendResult {
  readonly deliveryId: string;
  readonly status: ProjectChannelDeliveryStatus;
}

// ─── Neutral transport port (B implements, C consumes, E assembles) ───────────

/**
 * Structured inbound callback. Every field comes from the transport's own
 * observation, never from a client-supplied payload. B sets `authorIsBot` /
 * `authorIsWebhook` so C can fail closed on echoes.
 */
export interface ProjectChannelInboundCallback {
  readonly connectionId: string;
  readonly generation: number;
  readonly platformMessageId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly authorIsBot: boolean;
  readonly authorIsWebhook: boolean;
  /** Native mention ids only; the adapter does not do fuzzy name matching. */
  readonly mentionIds: readonly string[];
  readonly text: string;
  readonly observedAt: number;
}

export interface ProjectChannelTransportHandlers {
  /** Returns the durable inbound id so B can correlate its own receipt. */
  onInbound(event: ProjectChannelInboundCallback): Promise<string>;
  onObservation(observation: ProjectChannelRuntimeObservation): void;
}

export interface StartProjectChannelTransportInput {
  readonly connectionId: string;
  readonly generation: number;
  /** Host-resolved secret. Enters only the trusted transport, never a Worker or DB bridge. */
  readonly token: string;
  readonly handlers: ProjectChannelTransportHandlers;
}

export interface VerifyProjectChannelIdentityInput {
  readonly connectionId: string;
  readonly token: string;
}

/** The real Bot user as reported by the platform, for cross-project identity checks. */
export interface ProjectChannelIdentityVerification {
  readonly botUserId: string;
  readonly verifiedAt: number;
}

export interface InspectProjectChannelInput {
  readonly connectionId: string;
  readonly token: string;
  readonly guildId: string;
  readonly channelId: string;
}

export interface ProjectChannelChannelInspection {
  readonly guildId: string;
  readonly channelId: string;
  readonly isTextChannel: boolean;
  readonly isThread: boolean;
  readonly inspectedAt: number;
}

export interface ProjectChannelTransportSendInput {
  readonly deliveryId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly guildId: string;
  readonly channelId: string;
  readonly text: string;
  /** Reply without pinging the original author. */
  readonly replyToPlatformMessageId?: string;
}

/** Classification lives with the writer; the adapter never asserts `sent`. */
export interface ProjectChannelTransportSendFailure {
  readonly code: ProjectChannelErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface ProjectChannelTransportPort {
  start(input: StartProjectChannelTransportInput): Promise<ProjectChannelRuntimeObservation>;
  /** Stops socket, timers and reconnect for exactly one generation. */
  stop(connectionId: string, generation: number): Promise<void>;
  observe(connectionId: string): ProjectChannelRuntimeObservation | null;
  verifyIdentity(input: VerifyProjectChannelIdentityInput): Promise<ProjectChannelIdentityVerification>;
  inspectChannel(input: InspectProjectChannelInput): Promise<ProjectChannelChannelInspection>;
  /**
   * Returns the platform message id on acknowledgement. `allowed_mentions`
   * is disabled by the adapter regardless of text content. A network gap is
   * a classified failure, not a fabricate `sent` receipt.
   */
  send(input: ProjectChannelTransportSendInput): Promise<
    { readonly platformMessageId: string } | ProjectChannelTransportSendFailure
  >;
}

// ─── Error semantics ───────────────────────────────────────────────────────────

/**
 * Closed domain code set for the project-channel control plane and transport.
 * These are NOT added to the run-boundary `ErrorCode`: a channel permission or
 * revision failure is not a run failure. Where one maps to a run category the
 * Host carries it in `ErrorCause.code`, never by branching on this set.
 */
export const PROJECT_CHANNEL_ERROR_CODES = [
  'invalid_request',
  'project_not_found',
  'connection_not_found',
  'connection_exists',
  'bot_identity_conflict',
  'credential_invalid',
  'credential_not_configured',
  'connection_disabled',
  'generation_stale',
  'binding_not_found',
  'binding_conflict',
  'binding_revoked',
  'invalid_allowlist',
  'invalid_target',
  'unauthorized_member',
  'stale_revision',
  'request_conflict',
  'inbound_fingerprint_conflict',
  'reply_scope_invalid',
  'proactive_not_allowed',
  'delivery_not_found',
  'delivery_conflict',
  'delivery_retryable',
  'delivery_failed',
  'delivery_unknown',
  'transport_unavailable',
  'internal',
] as const;
export type ProjectChannelErrorCode = (typeof PROJECT_CHANNEL_ERROR_CODES)[number];

export interface ProjectChannelErrorInfo {
  readonly code: ProjectChannelErrorCode;
  readonly message: string;
  /** Shipped by the writer; clients must not guess retryability. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: DiagnosticDetail;
  /** Producer's own code, preserved for diagnosis; never a branch condition. */
  readonly cause?: { readonly system: string; readonly code: string; readonly status?: number };
}

export type ProjectChannelResult<T> = { readonly ok: T } | { readonly err: ProjectChannelErrorInfo };

export function isProjectChannelErrorCode(code: string): code is ProjectChannelErrorCode {
  return PROJECT_CHANNEL_ERROR_CODES.some((candidate) => candidate === code);
}

/** Codes a caller may retry after a bounded backoff or Retry-After. */
export function isProjectChannelRetryable(code: ProjectChannelErrorCode): boolean {
  return code === 'delivery_retryable' || code === 'transport_unavailable';
}

export function projectChannelError(
  code: ProjectChannelErrorCode,
  message: string,
  extra?: Omit<ProjectChannelErrorInfo, 'code' | 'message' | 'retryable'>,
): ProjectChannelErrorInfo {
  return { code, message, retryable: isProjectChannelRetryable(code), ...extra };
}

// ─── Canonical derivation helpers (both sides derive, nobody transports the key) ──

/** Stable inbound dedup key. A/B/C must use this exact function. */
export function inboundDedupKey(connectionId: string, platformMessageId: string): string {
  return `${connectionId}\u0000${platformMessageId}`;
}

/** Delivery idempotency key is scoped to the Project, not the connection. */
export function deliveryRequestKey(projectId: string, requestId: string): string {
  return `${projectId}\u0000${requestId}`;
}

/** Immutable fields that decide whether a redelivered event is the same body. */
export interface ProjectChannelInboundBody {
  readonly text: string;
  readonly senderId: string;
  readonly mentionIds: readonly string[];
  readonly guildId: string;
  readonly channelId: string;
  readonly receivedAt: number;
}

/** Digest of a message body. Same key + different digest is a hard conflict. */
export function inboundBodyFingerprint(body: ProjectChannelInboundBody): string {
  return canonicalFingerprint({
    text: body.text,
    senderId: body.senderId,
    mentionIds: [...body.mentionIds].sort(),
    guildId: body.guildId,
    channelId: body.channelId,
    receivedAt: body.receivedAt,
  });
}

/** Immutable fields that decide whether a retried send is the same request. */
export interface ProjectChannelDeliveryBody {
  readonly bindingId: string;
  readonly text: string;
  readonly replyToInboundId: string | null;
}

export function deliveryBodyFingerprint(body: ProjectChannelDeliveryBody): string {
  return canonicalFingerprint({
    bindingId: body.bindingId,
    text: body.text,
    replyToInboundId: body.replyToInboundId,
  });
}

/**
 * Small deterministic string fingerprint. FNV-1a over a stable JSON form keeps
 * this package dependency-free while still making field order irrelevant.
 * Digest values are compared, never parsed or used as a security primitive.
 */
function canonicalFingerprint(value: Readonly<Record<string, unknown>>): string {
  const canonical = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc1:${hash.toString(16).padStart(8, '0')}:${canonical.length.toString(16)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
