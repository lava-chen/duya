/**
 * legacy-import.ts — one-off read-only migration of the six legacy core
 * aggregates from `duya-main.db` into the new two-layer core store
 * (`duya-core.db` state tables + rollout JSONL files for message payloads).
 *
 * Plan 329. The file is split into three sections (flat-file discipline of
 * plan 326 decision 1 — the last of the seven core source files):
 *   1. Read-only row reading: `openLegacyReadonly` / `readLegacyRows`
 *   2. Message mapping: `legacyRowToNewEvent` / `sortSessionMessages`
 *      (kind derivation + the 4 signature/provider_state columns rehydrated
 *      back into content blocks, then `ingestMessage`)
 *   3. Import orchestration: the `LegacyImport` class
 *
 * The legacy database is opened strictly read-only. Sessions / mailbox /
 * tasks / permissions / locks are moved in a single transaction (fail → roll
 * back → retried next startup). Messages are moved per-session through
 * `MessageLog.appendBatch` (the same write path as runtime) with a resumable
 * breakpoint: `scan()` reconciles an interrupted run, `getCount()` is the
 * resume point, `INSERT OR IGNORE` keeps re-runs idempotent.
 *
 * See `docs/exec-plans/active/329-core-db-legacy-import.md`.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { ingestMessage, type Message, type MessageContent, type MessageEntry } from '@duya/agent/message';
import { getLogger, LogComponent } from '../../logging/logger';
import type { CoreStores } from '../core-connection';
import type { NewEvent } from './message-log';
import type { SqliteCtor, SqliteDatabase } from './database';

// ─── Inline types (no separate types.ts — flat 7-file discipline) ───

/** Legacy completion marker in the core `meta` table. */
const IMPORTED_MARKER_KEY = 'imported_from_legacy';
/** 46 = highest legacy migration id (`electron/db/schema.ts`). */
const LEGACY_MAX_MIGRATION = 46;

export interface LegacySessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string;
  system_prompt: string;
  working_directory: string;
  project_name: string;
  status: string;
  mode: string;
  permission_profile: string;
  provider_id: string;
  context_summary: string;
  context_summary_updated_at: number;
  is_deleted: number;
  generation: number;
  agent_profile_id: string | null;
  parent_id: string | null;
  agent_type: string;
  agent_name: string;
  conductor_mode_enabled: number;
  conductor_canvas_id: string | null;
}

export interface LegacyMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  display_content: string | null;
  name: string | null;
  tool_call_id: string | null;
  token_usage: string | null;
  msg_type: string;
  thinking: string | null;
  tool_name: string | null;
  tool_input: string | null;
  parent_tool_call_id: string | null;
  viz_spec: string | null;
  status: string;
  seq_index: number | null;
  duration_ms: number | null;
  sub_agent_id: string | null;
  created_at: number;
  provider_state?: string | null;
  thinking_signature?: string | null;
  tool_signature?: string | null;
  text_signature?: string | null;
}

export interface LegacyMailboxRow {
  id: string;
  session_id: string;
  submitted_during_run_id: string;
  content: string;
  kind: string;
  status: string;
  priority: number;
  constraints_json: string | null;
  attachments_json: string | null;
  source: string;
  client_msg_id: string | null;
  created_at: number;
  claim_token: string | null;
  claim_expires_at: number | null;
  observed_at: number | null;
  observed_at_checkpoint: string | null;
  observed_by_run_id: string | null;
  claim_attempts: number;
  last_claim_error: string | null;
  edit_locked_at: number | null;
  apply_mode: string | null;
  applied_at: number | null;
  applied_at_checkpoint: string | null;
  applied_summary: string | null;
  resulting_user_msg_id: string | null;
  failure_reason: string | null;
  edit_history_json: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

export interface LegacyTaskRow {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  status: string;
  active_form: string | null;
  owner: string | null;
  blocks: string;
  blocked_by: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

export interface LegacyPermissionRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  tool_input: string | null;
  status: string;
  decision: string | null;
  message: string | null;
  updated_permissions: string | null;
  updated_input: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface LegacyLockRow {
  session_id: string;
  lock_id: string;
  owner: string;
  expires_at: number;
}

export interface LegacyRows {
  sessions: LegacySessionRow[];
  messages: LegacyMessageRow[];
  mailbox: LegacyMailboxRow[];
  tasks: LegacyTaskRow[];
  permissions: LegacyPermissionRow[];
  locks: LegacyLockRow[];
}

export interface ImportReport {
  sessions: number;
  events: number;
  mailboxItems: number;
  tasks: number;
  permissions: number;
  locks: number;
  /** Session ids whose messages were re-sequenced (missing/duplicate seq_index). */
  renumberedSessions: string[];
  durationMs: number;
}

export interface SortResult {
  sorted: LegacyMessageRow[];
  /** True when seq_index was unusable and rows were ordered by created_at, id. */
  renumbered: boolean;
}

// ============================================================
// Section 1: read-only reading
// ============================================================

/**
 * Open the legacy database strictly read-only. `readonly` + `fileMustExist`
 * means the file is never created or modified — safe to run against a live
 * lock-free readonly handle.
 */
export function openLegacyReadonly(filename: string, sqlite?: SqliteCtor): SqliteDatabase {
  const Ctor = sqlite ?? (createRequire(__filename)('better-sqlite3') as SqliteCtor);
  return new Ctor(filename, { readonly: true, fileMustExist: true });
}

/**
 * Read all six legacy core tables in one pass. A missing table (older legacy
 * DB) yields an empty array and logs a WARN — never throws.
 */
export function readLegacyRows(db: SqliteDatabase): LegacyRows {
  const logger = getLogger();
  function readTable<T>(name: string): T[] {
    try {
      return db.prepare(`SELECT * FROM ${name}`).all() as T[];
    } catch {
      logger.warn(`Legacy import: table ${name} missing — treating as empty`, undefined, LogComponent.DB);
      return [];
    }
  }
  return {
    sessions: readTable<LegacySessionRow>('chat_sessions'),
    messages: readTable<LegacyMessageRow>('messages'),
    mailbox: readTable<LegacyMailboxRow>('agent_mailbox'),
    tasks: readTable<LegacyTaskRow>('tasks'),
    permissions: readTable<LegacyPermissionRow>('permission_requests'),
    locks: readTable<LegacyLockRow>('session_runtime_locks'),
  };
}

// ============================================================
// Section 2: message mapping
// ============================================================

/**
 * Rehydrate the 4 signature/provider_state columns back into content blocks.
 * These columns are NOT in `ingestMessage`'s `LEGACY_KNOWN_KEYS` and the
 * legacy `content` is a flat string, so they must be merged into the parsed
 * blocks before ingest — otherwise they are silently dropped (plan 329
 * decision 4). Mirrors `messageRowToMessage` (session/db.ts).
 */
function legacyRowToMessage(row: LegacyMessageRow): Message {
  let content: string | MessageContent[];
  let toolCallId = row.tool_call_id || undefined;

  if (row.msg_type === 'thinking' && row.thinking) {
    content = [{ type: 'thinking', thinking: row.thinking }];
  } else if (row.msg_type === 'tool_use' && row.tool_name) {
    let input: Record<string, unknown> = {};
    let toolId = row.id;
    try {
      const parsed = JSON.parse(row.content) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const block = parsed[0] as { id?: string; input?: Record<string, unknown> };
        if (block.id) toolId = block.id;
        if (block.input) input = block.input;
      }
    } catch {
      try {
        input = row.tool_input ? (JSON.parse(row.tool_input) as Record<string, unknown>) : {};
      } catch {
        input = {};
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    toolCallId = toolId;
  } else {
    try {
      const parsed = JSON.parse(row.content) as unknown;
      content = Array.isArray(parsed) ? (parsed as MessageContent[]) : row.content;
    } catch {
      content = row.content;
    }
  }

  // Restore signatures from dedicated columns back into content blocks.
  if (Array.isArray(content)) {
    if (row.thinking_signature) {
      const block = content.find((b) => b.type === 'thinking');
      if (block && block.type === 'thinking') block.thinkingSignature = row.thinking_signature;
    }
    if (row.tool_signature) {
      const block = content.find((b) => b.type === 'tool_use');
      if (block && block.type === 'tool_use') block.thoughtSignature = row.tool_signature;
    }
    if (row.text_signature) {
      const block = content.find((b) => b.type === 'text');
      if (block && block.type === 'text') block.textSignature = row.text_signature;
    }
  }

  let tokenUsage: Message['tokenUsage'];
  if (row.token_usage) {
    try {
      tokenUsage = JSON.parse(row.token_usage) as Message['tokenUsage'];
    } catch {
      tokenUsage = undefined;
    }
  }

  let providerState: { api?: Message['api']; providerId?: string; model?: string } | undefined;
  if (row.provider_state) {
    try {
      providerState = JSON.parse(row.provider_state) as { api?: Message['api']; providerId?: string; model?: string };
    } catch {
      providerState = undefined;
    }
  }

  return {
    id: row.id,
    role: row.role,
    content,
    displayContent: row.display_content ?? undefined,
    name: row.name ?? undefined,
    tool_call_id: toolCallId,
    timestamp: row.created_at,
    msg_type: row.msg_type || undefined,
    thinking: row.thinking || undefined,
    tool_name: row.tool_name || undefined,
    tool_input: row.tool_input || undefined,
    parent_tool_call_id: row.parent_tool_call_id || undefined,
    viz_spec: row.viz_spec || undefined,
    status: row.status || undefined,
    seq_index: row.seq_index ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
    sub_agent_id: row.sub_agent_id || undefined,
    tokenUsage,
    api: providerState?.api,
    providerId: providerState?.providerId,
    model: providerState?.model,
  };
}

/**
 * Map one legacy `messages` row to a `NewEvent` for `MessageLog.appendBatch`.
 * The payload is a `MessageEntry` whose `message` is produced by `ingestMessage`
 * (kind is derived from the resulting AgentMessage role). `turn_id` is always
 * null (legacy DB has no turn dimension — plan 329 decision 4).
 */
export function legacyRowToNewEvent(row: LegacyMessageRow): NewEvent {
  const entry: MessageEntry = {
    type: 'message',
    id: row.id,
    parentId: null,
    createdAt: row.created_at,
    message: ingestMessage(legacyRowToMessage(row)),
  };
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: null,
    payload: entry,
    createdAt: row.created_at,
  };
}

/**
 * Deterministic per-session ordering (plan 329 decision 3). seq_index is
 * preferred when present and injective; otherwise fall back to a stable
 * `created_at, id` sort and report `renumbered=true`. Being a pure function,
 * the same input always yields the same order — the resumable breakpoint
 * (skip `getCount(sessionId)` prefix) depends on this determinism.
 */
export function sortSessionMessages(rows: LegacyMessageRow[]): SortResult {
  if (hasValidSeqIndex(rows)) {
    return { sorted: [...rows].sort((a, b) => a.seq_index! - b.seq_index!), renumbered: false };
  }
  const sorted = [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { sorted, renumbered: true };
}

/** True when every row has a non-null, pairwise-distinct seq_index. */
function hasValidSeqIndex(rows: LegacyMessageRow[]): boolean {
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.seq_index === null || row.seq_index === undefined) return false;
    if (seen.has(row.seq_index)) return false;
    seen.add(row.seq_index);
  }
  return true;
}

// ============================================================
// Section 3: import orchestration
// ============================================================

export class LegacyImport {
  private readonly stores: CoreStores;
  private readonly legacyPath: string;
  private readonly Sqlite: SqliteCtor;

  /**
   * @param stores    The aggregated core stores (plan 328 Phase 1 singleton).
   * @param legacyPath Path to the legacy `duya-main.db`.
   * @param sqlite     Optional better-sqlite3 ctor (injected for tests).
   */
  constructor(stores: CoreStores, legacyPath: string, sqlite?: SqliteCtor) {
    this.stores = stores;
    this.legacyPath = legacyPath;
    this.Sqlite = sqlite ?? (createRequire(__filename)('better-sqlite3') as SqliteCtor);
  }

  /** True when `meta.imported_from_legacy` is absent (import not yet done). */
  needsImport(): boolean {
    const row = this.stores.coreDb.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(IMPORTED_MARKER_KEY) as { value?: string } | undefined;
    return !row;
  }

  /**
   * Execute the import. Idempotent and resumable. Returns a count report.
   * When the legacy file does not exist (fresh user / namespace), writes the
   * `none@<ts>` marker so startup stops probing on every boot.
   */
  run(): ImportReport {
    const started = Date.now();

    if (!fs.existsSync(this.legacyPath)) {
      this.setMarker(`none@${new Date().toISOString()}`);
      return emptyReport(started);
    }

    const db = openLegacyReadonly(this.legacyPath, this.Sqlite);
    try {
      const rows = readLegacyRows(db);
      const metadata = this.importMetadata(rows);
      const messages = this.importMessages(rows.messages);
      this.setMarker(`v${LEGACY_MAX_MIGRATION}@${new Date().toISOString()}`);
      return {
        sessions: metadata.sessions,
        events: messages.events,
        mailboxItems: metadata.mailboxItems,
        tasks: metadata.tasks,
        permissions: metadata.permissions,
        locks: metadata.locks,
        renumberedSessions: messages.renumberedSessions,
        durationMs: Date.now() - started,
      };
    } finally {
      db.close();
    }
  }

  // ─── Sessions / mailbox / tasks / permissions / locks (single txn) ───

  private importMetadata(rows: LegacyRows): {
    sessions: number;
    mailboxItems: number;
    tasks: number;
    permissions: number;
    locks: number;
  } {
    const db = this.stores.coreDb.db;

    const sessionStmt = db.prepare(
      `INSERT OR IGNORE INTO sessions (
        id, title, working_directory, project_name, status, model, provider_id,
        mode, permission_mode, agent_profile_id, parent_session_id, agent_type,
        agent_name, draft, extensions, rollout_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    );

    const mailboxStmt = db.prepare(
      `INSERT OR IGNORE INTO mailbox_items (
        id, session_id, kind, status, priority, content, attachments, source,
        client_msg_id, submitted_run_id, claim_token, claim_expires_at,
        claim_attempts, last_claim_error, observed_at, observed_at_checkpoint,
        observed_by_run_id, apply_mode, applied_at, applied_at_checkpoint,
        applied_summary, resulting_event_id, edit_locked_at, cancelled_at,
        cancelled_by, cancel_reason, meta, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const taskStmt = db.prepare(
      `INSERT OR IGNORE INTO tasks (
        id, session_id, subject, description, active_form, owner,
        status, blocks, blocked_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const permissionStmt = db.prepare(
      `INSERT OR IGNORE INTO permission_requests (
        id, session_id, tool_name, tool_input, status, decision, message,
        updated_permissions, updated_input, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const lockStmt = db.prepare(
      `INSERT OR IGNORE INTO session_runtime_locks (session_id, lock_id, owner, expires_at)
       VALUES (?, ?, ?, ?)`,
    );

    const txn = db.transaction(() => {
      for (const row of rows.sessions) {
        sessionStmt.run(
          row.id,
          row.title,
          row.working_directory,
          row.project_name,
          row.is_deleted ? 'deleted' : row.status,
          row.model,
          row.provider_id,
          row.mode,
          row.permission_profile,
          row.agent_profile_id,
          row.parent_id,
          row.agent_type,
          row.agent_name,
          JSON.stringify(buildSessionExtensions(row)),
          row.created_at,
          row.updated_at,
        );
      }
      for (const row of rows.mailbox) {
        const p = mapMailboxRow(row);
        mailboxStmt.run(
          p.id,
          p.session_id,
          p.kind,
          p.status,
          p.priority,
          p.content,
          p.attachments,
          p.source,
          p.client_msg_id,
          p.submitted_run_id,
          p.claim_token,
          p.claim_expires_at,
          p.claim_attempts,
          p.last_claim_error,
          p.observed_at,
          p.observed_at_checkpoint,
          p.observed_by_run_id,
          p.apply_mode,
          p.applied_at,
          p.applied_at_checkpoint,
          p.applied_summary,
          p.resulting_event_id,
          p.edit_locked_at,
          p.cancelled_at,
          p.cancelled_by,
          p.cancel_reason,
          p.meta,
          p.created_at,
        );
      }
      for (const row of rows.tasks) {
        taskStmt.run(
          row.id,
          row.session_id,
          row.subject,
          row.description,
          row.active_form,
          row.owner,
          row.status,
          row.blocks,
          row.blocked_by,
          row.metadata,
          row.created_at,
          row.updated_at,
        );
      }
      for (const row of rows.permissions) {
        permissionStmt.run(
          row.id,
          row.session_id,
          row.tool_name,
          row.tool_input,
          row.status,
          row.decision,
          row.message,
          row.updated_permissions,
          row.updated_input,
          row.created_at,
          row.resolved_at,
        );
      }
      for (const row of rows.locks) {
        lockStmt.run(row.session_id, row.lock_id, row.owner, row.expires_at);
      }
    });
    txn();

    return {
      sessions: rows.sessions.length,
      mailboxItems: rows.mailbox.length,
      tasks: rows.tasks.length,
      permissions: rows.permissions.length,
      locks: rows.locks.length,
    };
  }

  // ─── Messages (resumable per-session carry through MessageLog) ───

  private importMessages(rows: LegacyMessageRow[]): {
    events: number;
    renumberedSessions: string[];
  } {
    const log = this.stores.messageLog;
    const bySession = new Map<string, LegacyMessageRow[]>();
    for (const row of rows) {
      const arr = bySession.get(row.session_id);
      if (arr) arr.push(row);
      else bySession.set(row.session_id, [row]);
    }

    let events = 0;
    const renumberedSessions: string[] = [];
    for (const [sessionId, sessionRows] of bySession) {
      const { sorted, renumbered } = sortSessionMessages(sessionRows);
      // Reconcile any orphan file lines from an interrupted run, then resume
      // at the indexed count (the sort is deterministic, so the prefix matches).
      log.scan(sessionId);
      const imported = log.getCount(sessionId);
      const remaining = sorted.slice(imported);
      if (remaining.length > 0) {
        log.appendBatch(remaining.map(legacyRowToNewEvent));
        events += remaining.length;
      }
      if (renumbered) renumberedSessions.push(sessionId);
    }
    return { events, renumberedSessions };
  }

  // ─── Meta marker ───

  private setMarker(value: string): void {
    this.stores.coreDb.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(IMPORTED_MARKER_KEY, value);
  }
}

// ─── Helpers ───

/** Build the `extensions` JSON for a legacy session (plan 329 decisions 5). */
function buildSessionExtensions(row: LegacySessionRow): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (row.system_prompt) ext.system_prompt = row.system_prompt;
  if (row.conductor_mode_enabled) ext.conductor_mode_enabled = row.conductor_mode_enabled;
  if (row.conductor_canvas_id) ext.conductor_canvas_id = row.conductor_canvas_id;
  if (row.context_summary) ext.legacy_context_summary = row.context_summary;
  return ext;
}

/**
 * Map a legacy `agent_mailbox` row onto the new `mailbox_items` shape
 * (plan 329 decision 6): column renames + `constraints_json`/`edit_history_json`
 * merged into `meta` + `failure_reason` merged into `cancel_reason`.
 */
function mapMailboxRow(row: LegacyMailboxRow): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (row.constraints_json) meta.constraints = safeParse(row.constraints_json);
  if (row.edit_history_json) meta.editHistory = safeParse(row.edit_history_json);
  const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '{}';

  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    content: row.content,
    attachments: row.attachments_json,
    source: row.source,
    client_msg_id: row.client_msg_id,
    submitted_run_id: row.submitted_during_run_id,
    claim_token: row.claim_token,
    claim_expires_at: row.claim_expires_at,
    claim_attempts: row.claim_attempts,
    last_claim_error: row.last_claim_error,
    observed_at: row.observed_at,
    observed_at_checkpoint: row.observed_at_checkpoint,
    observed_by_run_id: row.observed_by_run_id,
    apply_mode: row.apply_mode,
    applied_at: row.applied_at,
    applied_at_checkpoint: row.applied_at_checkpoint,
    applied_summary: row.applied_summary,
    resulting_event_id: row.resulting_user_msg_id,
    edit_locked_at: row.edit_locked_at,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    cancel_reason: row.failure_reason ?? row.cancel_reason,
    meta: metaJson,
    created_at: row.created_at,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function emptyReport(started: number): ImportReport {
  return {
    sessions: 0,
    events: 0,
    mailboxItems: 0,
    tasks: 0,
    permissions: 0,
    locks: 0,
    renumberedSessions: [],
    durationMs: Date.now() - started,
  };
}