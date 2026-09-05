/**
 * sendMessageState.ts — side-table state for card-shaped SendMessage (Plan 489 P0.2)
 *
 * The SendMessageTool delivers three interactive card types (widget / cursor-agent /
 * secret-request) via the normal `messages` pipeline. Their *interaction state* —
 * whether the user has answered a widget, the cursor-agent run lifecycle, and
 * whether a requested credential has been provided — is not stored on the message
 * row itself. These three side tables persist that state:
 *
 *   - widget_response_pending : pending/answered/dismissed state of a widget question
 *   - cursor_cloud_agent_run  : lifecycle of a referenced cursor-agent run
 *   - host_pending_secret     : whether a secret-request credential was provided
 *
 * The tables live in the legacy main DB (duya-main.db) alongside the other
 * SendMessage persistence (schema.ts). `message_id` is the UUID returned by
 * `messageDb.append` (a core-db message id) stored by value — no FK because the
 * real `messages` rows live in duya-core.db.
 *
 * Functions take an explicit `better-sqlite3.Database` so they are unit-testable
 * against an in-memory DB and reused by `db-bridge.ts` (IPC) and `schema.ts`
 * (self-repair + migration). Errors propagate to the caller; the IPC handler owns
 * structured logging, mirroring the `message:append` convention.
 */
import type BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = BetterSqlite3.Database;

// ─── Status enums ───────────────────────────────────────────────────────────

export type WidgetResponseStatus = 'pending' | 'answered' | 'dismissed';
export type CursorAgentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
export type HostPendingSecretStatus = 'pending' | 'provided' | 'dismissed';

// ─── DDL ─────────────────────────────────────────────────────────────────────

/**
 * DDL for the three SendMessage side tables plus their indexes. Single source of
 * truth reused by `schema.ts` (self-repair region + migration 55) and the helper
 * unit tests, so the on-disk shape never drifts from the tested one.
 */
export const SEND_MESSAGE_STATE_DDL: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS widget_response_pending (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    bot_agent_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    widget_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'dismissed')),
    custom_answer TEXT,
    answered_at INTEGER,
    created_at INTEGER NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS idx_widget_response_pending_status ON widget_response_pending(status)`,
  `CREATE INDEX IF NOT EXISTS idx_widget_response_pending_session ON widget_response_pending(session_id)`,
  `
  CREATE TABLE IF NOT EXISTS cursor_cloud_agent_run (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    bc_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'aborted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS idx_cursor_cloud_agent_run_status ON cursor_cloud_agent_run(status)`,
  `CREATE INDEX IF NOT EXISTS idx_cursor_cloud_agent_run_session ON cursor_cloud_agent_run(session_id)`,
  `
  CREATE TABLE IF NOT EXISTS host_pending_secret (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    label TEXT NOT NULL,
    connector TEXT NOT NULL,
    field TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'provided', 'dismissed')),
    provided_at INTEGER,
    created_at INTEGER NOT NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS idx_host_pending_secret_status ON host_pending_secret(status)`,
  `CREATE INDEX IF NOT EXISTS idx_host_pending_secret_session ON host_pending_secret(session_id)`,
];

/** Create the SendMessage side tables and indexes (idempotent). */
export function createSendMessageStateTables(db: SqliteDatabase): void {
  for (const ddl of SEND_MESSAGE_STATE_DDL) {
    db.exec(ddl);
  }
}

// ─── Widget response state ───────────────────────────────────────────────────

export interface CreateWidgetPendingInput {
  id: string;
  messageId: string;
  sessionId: string;
  botAgentId: string;
  prompt: string;
  widgetJson: string;
  createdAt: number;
}

export function createWidgetPending(db: SqliteDatabase, input: CreateWidgetPendingInput): void {
  db.prepare(
    `INSERT INTO widget_response_pending
       (id, message_id, session_id, bot_agent_id, prompt, widget_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    input.id,
    input.messageId,
    input.sessionId,
    input.botAgentId,
    input.prompt,
    input.widgetJson,
    input.createdAt,
  );
}

export interface UpdateWidgetResponseInput {
  messageId: string;
  status: WidgetResponseStatus;
  customAnswer?: string | null;
  answeredAt?: number | null;
}

export function updateWidgetResponse(db: SqliteDatabase, input: UpdateWidgetResponseInput): void {
  db.prepare(
    `UPDATE widget_response_pending SET
       status = ?,
       custom_answer = COALESCE(?, custom_answer),
       answered_at = COALESCE(?, answered_at)
     WHERE message_id = ?`,
  ).run(input.status, input.customAnswer ?? null, input.answeredAt ?? null, input.messageId);
}

// ─── Cursor-agent run state ─────────────────────────────────────────────────

export interface CursorAgentRunInput {
  id: string;
  messageId: string;
  sessionId: string;
  bcId: string;
  status: CursorAgentRunStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Insert a cursor-agent run row, or bump status/bc_id for a re-issued card with
 * the same message_id (INSERT OR REPLACE semantics via ON CONFLICT on the unique
 * message_id).
 */
export function upsertCursorAgentRun(db: SqliteDatabase, input: CursorAgentRunInput): void {
  db.prepare(
    `INSERT INTO cursor_cloud_agent_run
       (id, message_id, session_id, bc_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       status = excluded.status,
       bc_id = excluded.bc_id,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.messageId,
    input.sessionId,
    input.bcId,
    input.status,
    input.createdAt,
    input.updatedAt,
  );
}

export interface UpdateCursorAgentRunInput {
  messageId: string;
  status: CursorAgentRunStatus;
  updatedAt: number;
}

export function updateCursorAgentRun(db: SqliteDatabase, input: UpdateCursorAgentRunInput): void {
  db.prepare(
    `UPDATE cursor_cloud_agent_run SET status = ?, updated_at = ? WHERE message_id = ?`,
  ).run(input.status, input.updatedAt, input.messageId);
}

// ─── Secret-request state ───────────────────────────────────────────────────

export interface CreateSecretPendingInput {
  id: string;
  messageId: string;
  sessionId: string;
  label: string;
  connector: string;
  field: string;
  createdAt: number;
}

export function createSecretPending(db: SqliteDatabase, input: CreateSecretPendingInput): void {
  db.prepare(
    `INSERT INTO host_pending_secret
       (id, message_id, session_id, label, connector, field, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    input.id,
    input.messageId,
    input.sessionId,
    input.label,
    input.connector,
    input.field,
    input.createdAt,
  );
}

export interface MarkSecretProvidedInput {
  messageId: string;
  status: 'provided' | 'dismissed';
  providedAt?: number | null;
}

export function markSecretProvided(db: SqliteDatabase, input: MarkSecretProvidedInput): void {
  db.prepare(
    `UPDATE host_pending_secret SET status = ?, provided_at = COALESCE(?, provided_at) WHERE message_id = ?`,
  ).run(input.status, input.providedAt ?? null, input.messageId);
}