/**
 * project-channel-store.ts — durable Project channel configuration and evidence.
 *
 * Lives in `duya-core.db` (migration 69, allocated by Plan A on this base; the
 * last core migration at the base SHA was 68). Every write that can be retried
 * is idempotent by a stable key, and every update that can be stale is a
 * revision CAS. Deletes are revocations: the row is retained with `enabled=0`
 * so already-sent evidence and audit are never cascaded away.
 *
 * Credentials NEVER enter this store. The Host resolves the token, asks the
 * transport to verify the real Bot user, and passes only that verified id plus
 * a `credentialConfigured` fact here.
 */

import type {
  ProjectChannelBinding,
  ProjectChannelConnection,
  ProjectChannelDelivery,
  ProjectChannelDeliveryStatus,
  ProjectChannelErrorCode,
  ProjectChannelInboundEvent,
  ProjectChannelPlatform,
  ProjectChannelRuntimeObservation,
  ProjectChannelRuntimeState,
} from '@duya/agent-protocol/project-channels';
import {
  deliveryBodyFingerprint,
  deliveryRequestKey,
  inboundBodyFingerprint,
  inboundDedupKey,
  type ProjectChannelDeliveryBody,
  type ProjectChannelInboundBody,
} from '@duya/agent-protocol/project-channels';
import type { Migration, SqliteDatabase } from './core-database.js';

/** A store refusal with a stable domain code for the Host to branch on. */
export class ProjectChannelStoreError extends Error {
  readonly code: ProjectChannelErrorCode;

  constructor(code: ProjectChannelErrorCode, message: string) {
    super(message);
    this.name = 'ProjectChannelStoreError';
    this.code = code;
  }
}

export const PROJECT_CHANNEL_MIGRATIONS: Migration[] = [
  {
    id: 69,
    name: 'create_project_channels',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_channel_connections (
          connection_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          platform TEXT NOT NULL CHECK(platform = 'discord'),
          bot_user_id TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL DEFAULT 1,
          generation INTEGER NOT NULL DEFAULT 0,
          credential_configured INTEGER NOT NULL DEFAULT 1,
          create_request_id TEXT NOT NULL,
          revoked_request_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, create_request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pcc_project ON project_channel_connections(project_id, enabled);

        CREATE TABLE IF NOT EXISTS project_channel_bindings (
          binding_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          allowed_user_ids TEXT NOT NULL CHECK(json_array_length(allowed_user_ids) >= 1),
          allow_proactive INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL DEFAULT 1,
          label TEXT NOT NULL DEFAULT '',
          create_request_id TEXT NOT NULL,
          revoked_request_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, create_request_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pcb_active_channel
          ON project_channel_bindings(connection_id, guild_id, channel_id) WHERE enabled = 1;
        CREATE INDEX IF NOT EXISTS idx_pcb_project ON project_channel_bindings(project_id, enabled);

        CREATE TABLE IF NOT EXISTS project_channel_inbounds (
          inbound_id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          binding_id TEXT NOT NULL,
          binding_revision INTEGER NOT NULL,
          platform_message_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          mention_ids TEXT NOT NULL,
          text TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          dedup_key TEXT NOT NULL UNIQUE,
          body_fingerprint TEXT NOT NULL,
          input_id TEXT,
          target_session_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pci_binding ON project_channel_inbounds(binding_id, created_at);

        CREATE TABLE IF NOT EXISTS project_channel_deliveries (
          delivery_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          binding_revision INTEGER NOT NULL,
          connection_id TEXT NOT NULL,
          connection_revision INTEGER NOT NULL,
          session_id TEXT,
          run_id TEXT,
          epoch INTEGER,
          request_id TEXT NOT NULL,
          request_key TEXT NOT NULL UNIQUE,
          body_fingerprint TEXT NOT NULL,
          reply_to_inbound_id TEXT,
          platform_message_id TEXT,
          status TEXT NOT NULL CHECK(status IN (
            'queued','sending','sent','failed','unknown','cancelled'
          )),
          reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pcd_project ON project_channel_deliveries(project_id, created_at);

        CREATE TABLE IF NOT EXISTS project_channel_observations (
          connection_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          observed_bot_user_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('connected','disconnected','error')),
          error_code TEXT,
          observed_at INTEGER NOT NULL
        );
      `);
    },
  },
];

// ─── Row shapes (explicit columns; never spread a caller object into a write) ──

interface ConnectionRow {
  connection_id: string; project_id: string; platform: ProjectChannelPlatform;
  bot_user_id: string; label: string; enabled: number; revision: number;
  generation: number; credential_configured: number; create_request_id: string;
  revoked_request_id: string | null; created_at: number; updated_at: number;
}
interface BindingRow {
  binding_id: string; project_id: string; connection_id: string;
  guild_id: string; channel_id: string; allowed_user_ids: string;
  allow_proactive: number; enabled: number; revision: number; label: string;
  create_request_id: string; revoked_request_id: string | null;
  created_at: number; updated_at: number;
}
interface InboundRow {
  inbound_id: string; connection_id: string; generation: number;
  binding_id: string; binding_revision: number; platform_message_id: string;
  guild_id: string; channel_id: string; sender_id: string; mention_ids: string;
  text: string; received_at: number; dedup_key: string; body_fingerprint: string;
  input_id: string | null; target_session_id: string | null; created_at: number;
}
interface DeliveryRow {
  delivery_id: string; project_id: string; binding_id: string;
  binding_revision: number; connection_id: string; connection_revision: number;
  session_id: string | null; run_id: string | null; epoch: number | null;
  request_id: string; request_key: string; body_fingerprint: string;
  reply_to_inbound_id: string | null; platform_message_id: string | null;
  status: ProjectChannelDeliveryStatus; reason: string | null;
  created_at: number; updated_at: number;
}
interface ObservationRow {
  connection_id: string; generation: number; observed_bot_user_id: string | null;
  state: ProjectChannelRuntimeState; error_code: ProjectChannelErrorCode | null;
  observed_at: number;
}

/** An allowlist is a set: dedupe and sort so equality and storage agree. */
function normalizeAllowlist(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function decodeConnection(row: ConnectionRow): ProjectChannelConnection {
  return {
    connectionId: row.connection_id, projectId: row.project_id, platform: row.platform,
    botUserId: row.bot_user_id, label: row.label, enabled: row.enabled === 1,
    revision: row.revision, generation: row.generation,
    credentialConfigured: row.credential_configured === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function decodeBinding(row: BindingRow): ProjectChannelBinding {
  return {
    bindingId: row.binding_id, projectId: row.project_id, connectionId: row.connection_id,
    guildId: row.guild_id, channelId: row.channel_id,
    allowedUserIds: JSON.parse(row.allowed_user_ids) as string[],
    allowProactive: row.allow_proactive === 1, enabled: row.enabled === 1,
    revision: row.revision, label: row.label,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function decodeInbound(row: InboundRow): ProjectChannelInboundEvent {
  return {
    inboundId: row.inbound_id, connectionId: row.connection_id, generation: row.generation,
    bindingId: row.binding_id, bindingRevision: row.binding_revision,
    platformMessageId: row.platform_message_id, guildId: row.guild_id,
    channelId: row.channel_id, senderId: row.sender_id,
    mentionIds: JSON.parse(row.mention_ids) as string[], text: row.text,
    receivedAt: row.received_at, dedupKey: row.dedup_key,
    bodyFingerprint: row.body_fingerprint, inputId: row.input_id,
    targetSessionId: row.target_session_id, createdAt: row.created_at,
  };
}
function decodeDelivery(row: DeliveryRow): ProjectChannelDelivery {
  return {
    deliveryId: row.delivery_id, projectId: row.project_id, bindingId: row.binding_id,
    bindingRevision: row.binding_revision, connectionId: row.connection_id,
    connectionRevision: row.connection_revision, sessionId: row.session_id,
    runId: row.run_id, epoch: row.epoch, requestId: row.request_id,
    bodyFingerprint: row.body_fingerprint, replyToInboundId: row.reply_to_inbound_id,
    platformMessageId: row.platform_message_id, status: row.status, reason: row.reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function decodeObservation(row: ObservationRow): ProjectChannelRuntimeObservation {
  return {
    connectionId: row.connection_id, generation: row.generation,
    observedBotUserId: row.observed_bot_user_id, state: row.state,
    errorCode: row.error_code, observedAt: row.observed_at,
  };
}

// ─── Write inputs ──────────────────────────────────────────────────────────────

export interface CreateConnectionInput {
  readonly connectionId: string;
  readonly projectId: string;
  readonly requestId: string;
  /** Verified by the transport, not read from the caller's config. */
  readonly botUserId: string;
  readonly label?: string;
  readonly now?: number;
}
export interface CreateBindingInput {
  readonly bindingId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly allowedUserIds: readonly string[];
  readonly allowProactive?: boolean;
  readonly label?: string;
  readonly now?: number;
}
export interface UpdateBindingInput {
  readonly projectId: string;
  readonly bindingId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly allowedUserIds?: readonly string[];
  readonly allowProactive?: boolean;
  readonly enabled?: boolean;
  readonly label?: string;
  readonly now?: number;
}
export interface RevokeBindingInput {
  readonly projectId: string;
  readonly bindingId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly now?: number;
}
export interface AcceptInboundInput {
  readonly inboundId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly body: ProjectChannelInboundBody & { readonly platformMessageId: string };
  readonly now?: number;
}
export interface CreateDeliveryInput {
  readonly deliveryId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly sessionId?: string | null;
  readonly runId?: string | null;
  readonly epoch?: number | null;
  readonly requestId: string;
  readonly body: ProjectChannelDeliveryBody;
  readonly replyToInboundId?: string | null;
  readonly now?: number;
}
export interface ObserveInput {
  readonly connectionId: string;
  readonly generation: number;
  readonly observedBotUserId?: string | null;
  readonly state: ProjectChannelRuntimeState;
  readonly errorCode?: ProjectChannelErrorCode | null;
  readonly observedAt: number;
}

export interface Acceptance<T> {
  readonly record: T;
  /** True when the key already existed and the ORIGINAL record was returned. */
  readonly deduplicated: boolean;
}

/**
 * Synchronous SQLite store. All multi-statement operations run inside one
 * `db.transaction` so a crash cannot leave half an acceptance behind.
 */
export class ProjectChannelStore {
  static readonly migrations = PROJECT_CHANNEL_MIGRATIONS;

  constructor(private readonly db: SqliteDatabase) {}

  // ── Connection ─────────────────────────────────────────────────────────────

  getConnection(connectionId: string): ProjectChannelConnection | null {
    const row = this.db.prepare('SELECT * FROM project_channel_connections WHERE connection_id = ?')
      .get(connectionId) as ConnectionRow | undefined;
    return row ? decodeConnection(row) : null;
  }

  getActiveConnection(connectionId: string): ProjectChannelConnection | null {
    const row = this.db.prepare(
      'SELECT * FROM project_channel_connections WHERE connection_id = ? AND enabled = 1',
    ).get(connectionId) as ConnectionRow | undefined;
    return row ? decodeConnection(row) : null;
  }

  getActiveConnectionForProject(projectId: string): ProjectChannelConnection | null {
    const row = this.db.prepare(
      'SELECT * FROM project_channel_connections WHERE project_id = ? AND enabled = 1',
    ).get(projectId) as ConnectionRow | undefined;
    return row ? decodeConnection(row) : null;
  }

  listConnections(projectId?: string): ProjectChannelConnection[] {
    const rows = (projectId === undefined
      ? this.db.prepare('SELECT * FROM project_channel_connections ORDER BY created_at, connection_id').all()
      : this.db.prepare(
          'SELECT * FROM project_channel_connections WHERE project_id = ? ORDER BY created_at, connection_id',
        ).all(projectId)) as ConnectionRow[];
    return rows.map(decodeConnection);
  }

  /**
   * Create a connection. Idempotent by `(projectId, requestId)`: a retry with a
   * different id but the same request key returns the original. A Bot identity
   * is globally unique — two Projects can never claim the same Bot user.
   */
  createConnection(input: CreateConnectionInput): Acceptance<ProjectChannelConnection> {
    return this.db.transaction(() => {
      const byRequest = this.db.prepare(
        'SELECT * FROM project_channel_connections WHERE project_id = ? AND create_request_id = ?',
      ).get(input.projectId, input.requestId) as ConnectionRow | undefined;
      if (byRequest) {
        if (byRequest.bot_user_id !== input.botUserId || byRequest.project_id !== input.projectId) {
          throw new ProjectChannelStoreError('request_conflict', 'connection request id reused for a different identity');
        }
        return { record: decodeConnection(byRequest), deduplicated: true };
      }
      const byBot = this.db.prepare(
        'SELECT project_id FROM project_channel_connections WHERE bot_user_id = ?',
      ).get(input.botUserId) as { project_id: string } | undefined;
      if (byBot) {
        throw new ProjectChannelStoreError(
          byBot.project_id === input.projectId ? 'request_conflict' : 'bot_identity_conflict',
          'bot identity is already bound to a connection',
        );
      }
      const active = this.getActiveConnectionForProject(input.projectId);
      if (active) {
        throw new ProjectChannelStoreError('connection_exists', 'project already has an active connection');
      }
      const now = input.now ?? Date.now();
      this.db.prepare(`INSERT INTO project_channel_connections
        (connection_id,project_id,platform,bot_user_id,label,enabled,revision,generation,
         credential_configured,create_request_id,created_at,updated_at)
        VALUES (?,?,?,?,?,1,1,0,1,?,?,?)`).run(
        input.connectionId, input.projectId, 'discord', input.botUserId,
        input.label ?? '', input.requestId, now, now,
      );
      return { record: this.getConnection(input.connectionId)!, deduplicated: false };
    })();
  }

  /** CAS update after token rotation. A new Bot identity requires a new connection. */
  rotateConnection(input: {
    readonly connectionId: string;
    readonly expectedRevision: number;
    readonly botUserId: string;
    readonly now?: number;
  }): ProjectChannelConnection | null {
    return this.db.transaction(() => {
      const row = this.getConnection(input.connectionId);
      if (!row) throw new ProjectChannelStoreError('connection_not_found', 'connection does not exist');
      if (!row.enabled) throw new ProjectChannelStoreError('connection_disabled', 'connection is disabled');
      if (row.revision !== input.expectedRevision) {
        throw new ProjectChannelStoreError('stale_revision', 'connection revision changed');
      }
      if (row.botUserId !== input.botUserId) {
        const other = this.db.prepare(
          'SELECT project_id FROM project_channel_connections WHERE bot_user_id = ?',
        ).get(input.botUserId) as { project_id: string } | undefined;
        if (other) throw new ProjectChannelStoreError('bot_identity_conflict', 'bot identity is already bound');
        throw new ProjectChannelStoreError('request_conflict', 'changing bot identity requires a new connection');
      }
      const now = input.now ?? Date.now();
      const changed = this.db.prepare(`UPDATE project_channel_connections
        SET revision = revision + 1, generation = generation + 1, credential_configured = 1, updated_at = ?
        WHERE connection_id = ? AND revision = ? AND enabled = 1`).run(now, input.connectionId, input.expectedRevision);
      if (!changed.changes) throw new ProjectChannelStoreError('stale_revision', 'connection revision changed');
      return this.getConnection(input.connectionId);
    })();
  }

  /** Rotate a token that verified to the SAME Bot user without changing identity. */
  markCredential(input: {
    readonly connectionId: string;
    readonly expectedRevision: number;
    readonly configured: boolean;
    readonly now?: number;
  }): ProjectChannelConnection | null {
    return this.db.transaction(() => {
      const row = this.getConnection(input.connectionId);
      if (!row) throw new ProjectChannelStoreError('connection_not_found', 'connection does not exist');
      if (row.revision !== input.expectedRevision) {
        throw new ProjectChannelStoreError('stale_revision', 'connection revision changed');
      }
      const now = input.now ?? Date.now();
      const changed = this.db.prepare(`UPDATE project_channel_connections
        SET credential_configured = ?, generation = generation + 1, revision = revision + 1, updated_at = ?
        WHERE connection_id = ? AND revision = ?`).run(
        input.configured ? 1 : 0, now, input.connectionId, input.expectedRevision,
      );
      if (!changed.changes) throw new ProjectChannelStoreError('stale_revision', 'connection revision changed');
      return this.getConnection(input.connectionId);
    })();
  }

  /** CAS disable. Idempotent on replay, and does not claim the remote token was revoked. */
  disconnectConnection(input: {
    readonly connectionId: string;
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly now?: number;
  }): ProjectChannelConnection | null {
    return this.db.transaction(() => {
      const row = this.getConnection(input.connectionId);
      if (!row) throw new ProjectChannelStoreError('connection_not_found', 'connection does not exist');
      if (!row.enabled) return row; // already disabled: a repeated revoke is a no-op
      if (row.revision !== input.expectedRevision) {
        throw new ProjectChannelStoreError('stale_revision', 'connection revision changed');
      }
      const now = input.now ?? Date.now();
      const changed = this.db.prepare(`UPDATE project_channel_connections
        SET enabled = 0, revision = revision + 1, generation = generation + 1,
            revoked_request_id = ?, updated_at = ?
        WHERE connection_id = ? AND revision = ? AND enabled = 1`).run(
        input.requestId, now, input.connectionId, input.expectedRevision,
      );
      if (!changed.changes) throw new ProjectChannelStoreError('stale_revision', 'connection revision changed');
      return this.getConnection(input.connectionId);
    })();
  }

  /** Atomically advance the runtime generation. C passes the value to the transport. */
  advanceGeneration(connectionId: string, now = Date.now()): number {
    const row = this.getConnection(connectionId);
    if (!row) throw new ProjectChannelStoreError('connection_not_found', 'connection does not exist');
    if (!row.enabled) throw new ProjectChannelStoreError('connection_disabled', 'connection is disabled');
    this.db.prepare(
      'UPDATE project_channel_connections SET generation = generation + 1, updated_at = ? WHERE connection_id = ?',
    ).run(now, connectionId);
    return this.getConnection(connectionId)!.generation;
  }

  // ── Binding ────────────────────────────────────────────────────────────────

  getBinding(bindingId: string): ProjectChannelBinding | null {
    const row = this.db.prepare('SELECT * FROM project_channel_bindings WHERE binding_id = ?')
      .get(bindingId) as BindingRow | undefined;
    return row ? decodeBinding(row) : null;
  }

  listBindings(projectId: string, connectionId?: string): ProjectChannelBinding[] {
    const rows = (connectionId === undefined
      ? this.db.prepare(
          'SELECT * FROM project_channel_bindings WHERE project_id = ? ORDER BY created_at, binding_id',
        ).all(projectId)
      : this.db.prepare(
          'SELECT * FROM project_channel_bindings WHERE project_id = ? AND connection_id = ? ORDER BY created_at, binding_id',
        ).all(projectId, connectionId)) as BindingRow[];
    return rows.map(decodeBinding);
  }

  /** Create a binding. Idempotent by `(projectId, requestId)`; empty allowlist refused. */
  createBinding(input: CreateBindingInput): Acceptance<ProjectChannelBinding> {
    return this.db.transaction(() => {
      const byRequest = this.db.prepare(
        'SELECT * FROM project_channel_bindings WHERE project_id = ? AND create_request_id = ?',
      ).get(input.projectId, input.requestId) as BindingRow | undefined;
      if (byRequest) {
        const storedAllowlist = JSON.parse(byRequest.allowed_user_ids) as string[];
        if (byRequest.connection_id !== input.connectionId || byRequest.guild_id !== input.guildId
          || byRequest.channel_id !== input.channelId
          || JSON.stringify(storedAllowlist) !== JSON.stringify(normalizeAllowlist(input.allowedUserIds))) {
          throw new ProjectChannelStoreError('request_conflict', 'binding request id reused for a different target');
        }
        return { record: decodeBinding(byRequest), deduplicated: true };
      }
      const allowed = normalizeAllowlist(input.allowedUserIds);
      if (allowed.length === 0) {
        throw new ProjectChannelStoreError('invalid_allowlist', 'binding allowlist must not be empty');
      }
      const connection = this.getActiveConnection(input.connectionId);
      if (!connection || connection.projectId !== input.projectId) {
        throw new ProjectChannelStoreError('connection_not_found', 'connection is not active for this project');
      }
      const duplicate = this.db.prepare(`SELECT binding_id FROM project_channel_bindings
        WHERE connection_id = ? AND guild_id = ? AND channel_id = ? AND enabled = 1`).get(
        input.connectionId, input.guildId, input.channelId,
      ) as { binding_id: string } | undefined;
      if (duplicate) throw new ProjectChannelStoreError('binding_conflict', 'channel already has an active binding');
      const now = input.now ?? Date.now();
      this.db.prepare(`INSERT INTO project_channel_bindings
        (binding_id,project_id,connection_id,guild_id,channel_id,allowed_user_ids,
         allow_proactive,enabled,revision,label,create_request_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,1,1,?,?,?,?)`).run(
        input.bindingId, input.projectId, input.connectionId, input.guildId, input.channelId,
        JSON.stringify(allowed), input.allowProactive ? 1 : 0, input.label ?? '',
        input.requestId, now, now,
      );
      return { record: this.getBinding(input.bindingId)!, deduplicated: false };
    })();
  }

  /** CAS patch. Revoked bindings cannot be patched back into service. */
  updateBinding(input: UpdateBindingInput): ProjectChannelBinding | null {
    return this.db.transaction(() => {
      const row = this.getBinding(input.bindingId);
      if (!row || row.projectId !== input.projectId) {
        throw new ProjectChannelStoreError('binding_not_found', 'binding does not exist for this project');
      }
      if (!row.enabled) throw new ProjectChannelStoreError('binding_revoked', 'binding has been revoked');
      if (row.revision !== input.expectedRevision) {
        throw new ProjectChannelStoreError('stale_revision', 'binding revision changed');
      }
      const allowed = input.allowedUserIds === undefined
        ? row.allowedUserIds : normalizeAllowlist(input.allowedUserIds);
      if (allowed.length === 0) {
        throw new ProjectChannelStoreError('invalid_allowlist', 'binding allowlist must not be empty');
      }
      const now = input.now ?? Date.now();
      const changed = this.db.prepare(`UPDATE project_channel_bindings SET
        allowed_user_ids = ?, allow_proactive = ?, enabled = ?, label = ?,
        revision = revision + 1, updated_at = ?
        WHERE binding_id = ? AND project_id = ? AND revision = ? AND enabled = 1`).run(
        JSON.stringify(allowed),
        (input.allowProactive ?? row.allowProactive) ? 1 : 0,
        (input.enabled ?? row.enabled) ? 1 : 0,
        input.label ?? row.label,
        now, input.bindingId, input.projectId, input.expectedRevision,
      );
      if (!changed.changes) throw new ProjectChannelStoreError('stale_revision', 'binding revision changed');
      return this.getBinding(input.bindingId);
    })();
  }

  /** CAS revoke. Keeps the row for audit; idempotent on a repeated request. */
  revokeBinding(input: RevokeBindingInput): ProjectChannelBinding | null {
    return this.db.transaction(() => {
      const row = this.getBinding(input.bindingId);
      if (!row || row.projectId !== input.projectId) {
        throw new ProjectChannelStoreError('binding_not_found', 'binding does not exist for this project');
      }
      if (!row.enabled) return row;
      if (row.revision !== input.expectedRevision) {
        throw new ProjectChannelStoreError('stale_revision', 'binding revision changed');
      }
      const now = input.now ?? Date.now();
      const changed = this.db.prepare(`UPDATE project_channel_bindings
        SET enabled = 0, revision = revision + 1, revoked_request_id = ?, updated_at = ?
        WHERE binding_id = ? AND project_id = ? AND revision = ? AND enabled = 1`).run(
        input.requestId, now, input.bindingId, input.projectId, input.expectedRevision,
      );
      if (!changed.changes) throw new ProjectChannelStoreError('stale_revision', 'binding revision changed');
      return this.getBinding(input.bindingId);
    })();
  }

  // ── Inbound event ──────────────────────────────────────────────────────────

  getInbound(inboundId: string): ProjectChannelInboundEvent | null {
    const row = this.db.prepare('SELECT * FROM project_channel_inbounds WHERE inbound_id = ?')
      .get(inboundId) as InboundRow | undefined;
    return row ? decodeInbound(row) : null;
  }

  getInboundByDedup(connectionId: string, platformMessageId: string): ProjectChannelInboundEvent | null {
    const row = this.db.prepare('SELECT * FROM project_channel_inbounds WHERE dedup_key = ?')
      .get(inboundDedupKey(connectionId, platformMessageId)) as InboundRow | undefined;
    return row ? decodeInbound(row) : null;
  }

  /**
   * Persist one external event before the transport is told it was accepted.
   * Same dedup key + same fingerprint returns the ORIGINAL row; same key with a
   * different body is a hard conflict and never overwrites accepted evidence.
   */
  acceptInbound(input: AcceptInboundInput): Acceptance<ProjectChannelInboundEvent> {
    return this.db.transaction(() => {
      const dedupKey = inboundDedupKey(input.connectionId, input.body.platformMessageId);
      const fingerprint = inboundBodyFingerprint(input.body);
      const existing = this.db.prepare('SELECT * FROM project_channel_inbounds WHERE dedup_key = ?')
        .get(dedupKey) as InboundRow | undefined;
      if (existing) {
        if (existing.body_fingerprint !== fingerprint) {
          throw new ProjectChannelStoreError(
            'inbound_fingerprint_conflict',
            'same platform message id arrived with a different body',
          );
        }
        return { record: decodeInbound(existing), deduplicated: true };
      }
      const now = input.now ?? Date.now();
      this.db.prepare(`INSERT INTO project_channel_inbounds
        (inbound_id,connection_id,generation,binding_id,binding_revision,platform_message_id,
         guild_id,channel_id,sender_id,mention_ids,text,received_at,dedup_key,body_fingerprint,
         created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.inboundId, input.connectionId, input.generation, input.bindingId,
        input.bindingRevision, input.body.platformMessageId, input.body.guildId,
        input.body.channelId, input.body.senderId, JSON.stringify([...input.body.mentionIds]),
        input.body.text, input.body.receivedAt, dedupKey, fingerprint, now,
      );
      return { record: this.getInbound(input.inboundId)!, deduplicated: false };
    })();
  }

  /** Bind the accepted Session input once. A different second target is a conflict. */
  attachInput(input: {
    readonly inboundId: string;
    readonly inputId: string;
    readonly targetSessionId: string;
  }): ProjectChannelInboundEvent {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM project_channel_inbounds WHERE inbound_id = ?')
        .get(input.inboundId) as InboundRow | undefined;
      if (!row) throw new ProjectChannelStoreError('invalid_request', 'inbound event does not exist');
      if (row.input_id !== null && (row.input_id !== input.inputId || row.target_session_id !== input.targetSessionId)) {
        throw new ProjectChannelStoreError('request_conflict', 'inbound already attached to a different input');
      }
      if (row.input_id === null) {
        this.db.prepare(
          'UPDATE project_channel_inbounds SET input_id = ?, target_session_id = ? WHERE inbound_id = ?',
        ).run(input.inputId, input.targetSessionId, input.inboundId);
      }
      return this.getInbound(input.inboundId)!;
    })();
  }

  // ── Delivery ───────────────────────────────────────────────────────────────

  getDelivery(deliveryId: string): ProjectChannelDelivery | null {
    const row = this.db.prepare('SELECT * FROM project_channel_deliveries WHERE delivery_id = ?')
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? decodeDelivery(row) : null;
  }

  getDeliveryByRequest(projectId: string, requestId: string): ProjectChannelDelivery | null {
    const row = this.db.prepare('SELECT * FROM project_channel_deliveries WHERE request_key = ?')
      .get(deliveryRequestKey(projectId, requestId)) as DeliveryRow | undefined;
    return row ? decodeDelivery(row) : null;
  }

  listDeliveries(projectId: string, cursor = 0, limit = 50): {
    deliveries: ProjectChannelDelivery[]; nextCursor: number | null;
  } {
    const rows = this.db.prepare(`SELECT * FROM project_channel_deliveries
      WHERE project_id = ? AND created_at > ? ORDER BY created_at, delivery_id LIMIT ?`).all(
      projectId, cursor, limit + 1,
    ) as DeliveryRow[];
    const page = rows.slice(0, limit);
    return {
      deliveries: page.map(decodeDelivery),
      nextCursor: rows.length > limit && page.length > 0 ? page[page.length - 1]!.created_at : null,
    };
  }

  /** Establish a durable obligation before any network call. Idempotent by request key. */
  createDelivery(input: CreateDeliveryInput): Acceptance<ProjectChannelDelivery> {
    return this.db.transaction(() => {
      const key = deliveryRequestKey(input.projectId, input.requestId);
      const fingerprint = deliveryBodyFingerprint(input.body);
      const existing = this.db.prepare('SELECT * FROM project_channel_deliveries WHERE request_key = ?')
        .get(key) as DeliveryRow | undefined;
      if (existing) {
        if (existing.body_fingerprint !== fingerprint || existing.binding_id !== input.body.bindingId
          || existing.reply_to_inbound_id !== (input.replyToInboundId ?? null)) {
          throw new ProjectChannelStoreError('delivery_conflict', 'request id reused for a different delivery body');
        }
        return { record: decodeDelivery(existing), deduplicated: true };
      }
      const now = input.now ?? Date.now();
      this.db.prepare(`INSERT INTO project_channel_deliveries
        (delivery_id,project_id,binding_id,binding_revision,connection_id,connection_revision,
         session_id,run_id,epoch,request_id,request_key,body_fingerprint,reply_to_inbound_id,
         status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(
        input.deliveryId, input.projectId, input.body.bindingId, input.bindingRevision,
        input.connectionId, input.connectionRevision, input.sessionId ?? null,
        input.runId ?? null, input.epoch ?? null, input.requestId, key, fingerprint,
        input.replyToInboundId ?? null, now, now,
      );
      return { record: this.getDelivery(input.deliveryId)!, deduplicated: false };
    })();
  }

  /** queued → sending. Must be committed before the network call. */
  claimDelivery(deliveryId: string, now = Date.now()): ProjectChannelDelivery | null {
    const changed = this.db.prepare(
      `UPDATE project_channel_deliveries SET status = 'sending', updated_at = ?
       WHERE delivery_id = ? AND status = 'queued'`,
    ).run(now, deliveryId);
    return changed.changes ? this.getDelivery(deliveryId) : null;
  }

  /**
   * sending → terminal. `unknown` is stored as-is: no automatic resend is
   * derived from it. A stale claim (status no longer `sending`) cannot settle.
   */
  settleDelivery(input: {
    readonly deliveryId: string;
    readonly status: Extract<ProjectChannelDeliveryStatus, 'sent' | 'failed' | 'unknown' | 'cancelled'>;
    readonly platformMessageId?: string | null;
    readonly reason?: string | null;
    readonly now?: number;
  }): ProjectChannelDelivery | null {
    const changed = this.db.prepare(`UPDATE project_channel_deliveries
      SET status = ?, platform_message_id = ?, reason = ?, updated_at = ?
      WHERE delivery_id = ? AND status = 'sending'`).run(
      input.status, input.platformMessageId ?? null, input.reason ?? null,
      input.now ?? Date.now(), input.deliveryId,
    );
    return changed.changes ? this.getDelivery(input.deliveryId) : null;
  }

  // ── Observation ────────────────────────────────────────────────────────────

  getObservation(connectionId: string): ProjectChannelRuntimeObservation | null {
    const row = this.db.prepare('SELECT * FROM project_channel_observations WHERE connection_id = ?')
      .get(connectionId) as ObservationRow | undefined;
    return row ? decodeObservation(row) : null;
  }

  observe(input: ObserveInput): ProjectChannelRuntimeObservation {
    this.db.prepare(`INSERT INTO project_channel_observations
      (connection_id,generation,observed_bot_user_id,state,error_code,observed_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(connection_id) DO UPDATE SET
        generation = excluded.generation, observed_bot_user_id = excluded.observed_bot_user_id,
        state = excluded.state, error_code = excluded.error_code, observed_at = excluded.observed_at
      WHERE excluded.generation >= project_channel_observations.generation`).run(
      input.connectionId, input.generation, input.observedBotUserId ?? null,
      input.state, input.errorCode ?? null, input.observedAt,
    );
    return this.getObservation(input.connectionId)!;
  }
}
