/**
 * toolApprovalState.ts - Persistent tool-approval side state (plan 498).
 *
 * Rakazo-aligned approval flow: when a tool permission ask happens, the
 * worker persists an approval row (this module) plus a chat card message
 * (`msg_type='tool-approval'`); the renderer answers through the unified
 * resolver which CAS-transitions the row here:
 *
 *   pending ──allow/always──▶ approved ──continuation replay──▶ consumed
 *      └──────deny──────────▶ denied
 *
 * `approved` rows double as a one-shot ledger: `consumeApprovedToolApproval`
 * matches on tool name + input hash so a later continuation run can replay
 * exactly the approved call and nothing else. `tool_approval_rules` stores
 * "Always allow this tool" grants scoped per bot agent (bot sessions) or
 * per session (interactive fallback) — never global.
 *
 * Schema lives in the legacy main DB following the module-owned side-table
 * pattern: idempotent DDL here, wired both as migration 56 and as a
 * self-repair call from `initializeSchema` so a partially-migrated database
 * self-heals on boot. Migration id 55 is intentionally skipped — it is
 * reserved by parallel in-flight work (send-message card side state).
 */

import { createHash } from 'crypto';

type BetterSqlite3Db = import('better-sqlite3').Database;

export type ToolApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied';
export type ToolApprovalDecision = 'allow' | 'always' | 'deny';
export type ToolApprovalScopeType = 'bot' | 'session';

export interface ToolApprovalInput {
  id: string;
  messageId: string;
  sessionId: string;
  scopeType: ToolApprovalScopeType;
  scopeId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

export interface ToolApprovalRow {
  id: string;
  message_id: string;
  session_id: string;
  scope_type: ToolApprovalScopeType;
  scope_id: string;
  tool_name: string;
  tool_input_json: string | null;
  input_hash: string;
  status: ToolApprovalStatus;
  decision: ToolApprovalDecision | null;
  decided_at: number | null;
  created_at: number;
}

/**
 * Stable hash over the tool input so the one-shot ledger can match a replay
 * exactly. Canonical JSON (sorted keys) keeps the hash independent of the
 * property order the model happened to emit.
 */
export function toolApprovalInputHash(toolInput?: Record<string, unknown>): string {
  const canonical = stableStringify(toolInput ?? {});
  return createHash('sha256').update(canonical).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Idempotent DDL — safe to run on every boot (self-repair) and in the
 * schema migration. Statements are prepared and run individually; better-sqlite3
 * prepares one statement per call, so no multi-statement string is involved.
 */
export function ensureToolApprovalTables(db: BetterSqlite3Db): void {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS tool_approval_state (' +
      'id TEXT PRIMARY KEY, ' +
      'message_id TEXT NOT NULL UNIQUE, ' +
      'session_id TEXT NOT NULL, ' +
      "scope_type TEXT NOT NULL DEFAULT 'session' CHECK (scope_type IN ('bot', 'session')), " +
      'scope_id TEXT NOT NULL, ' +
      'tool_name TEXT NOT NULL, ' +
      'tool_input_json TEXT, ' +
      'input_hash TEXT NOT NULL, ' +
      "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'consumed', 'denied')), " +
      "decision TEXT CHECK (decision IN ('allow', 'always', 'deny')), " +
      'decided_at INTEGER, ' +
      'created_at INTEGER NOT NULL)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_tool_approval_session ON tool_approval_state(session_id, status)',
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_tool_approval_scope ON tool_approval_state(scope_type, scope_id, status)',
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS tool_approval_rules (' +
      "scope_type TEXT NOT NULL CHECK (scope_type IN ('bot', 'session')), " +
      'scope_id TEXT NOT NULL, ' +
      'tool_name TEXT NOT NULL, ' +
      'created_at INTEGER NOT NULL, ' +
      'PRIMARY KEY (scope_type, scope_id, tool_name))',
  ).run();
}

export function createToolApproval(db: BetterSqlite3Db, input: ToolApprovalInput): ToolApprovalRow {
  const now = Date.now();
  db.prepare(
    'INSERT OR IGNORE INTO tool_approval_state ' +
      '(id, message_id, session_id, scope_type, scope_id, tool_name, tool_input_json, input_hash, status, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
  ).run(
    input.id,
    input.messageId,
    input.sessionId,
    input.scopeType,
    input.scopeId,
    input.toolName,
    input.toolInput === undefined ? null : JSON.stringify(input.toolInput),
    toolApprovalInputHash(input.toolInput),
    now,
  );
  return db.prepare('SELECT * FROM tool_approval_state WHERE id = ?').get(input.id) as ToolApprovalRow;
}

export function getToolApproval(db: BetterSqlite3Db, id: string): ToolApprovalRow | undefined {
  return db.prepare('SELECT * FROM tool_approval_state WHERE id = ?').get(id) as
    | ToolApprovalRow
    | undefined;
}

export function listToolApprovalsBySession(db: BetterSqlite3Db, sessionId: string): ToolApprovalRow[] {
  return db
    .prepare('SELECT * FROM tool_approval_state WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as ToolApprovalRow[];
}

/**
 * CAS transition out of `pending`. Terminal rows are returned unchanged
 * with `claimed: false` (idempotent double-resolve — the first decision
 * wins). Returns undefined when the row does not exist.
 */
export function resolveToolApproval(
  db: BetterSqlite3Db,
  id: string,
  decision: ToolApprovalDecision,
): { row: ToolApprovalRow; claimed: boolean } | undefined {
  const row = getToolApproval(db, id);
  if (!row) return undefined;
  if (row.status !== 'pending') return { row, claimed: false };

  const nextStatus: ToolApprovalStatus = decision === 'deny' ? 'denied' : 'approved';
  let claimed = false;
  const txn = db.transaction(() => {
    const updated = db
      .prepare(
        "UPDATE tool_approval_state SET status = ?, decision = ?, decided_at = ? " +
          "WHERE id = ? AND status = 'pending'",
      )
      .run(nextStatus, decision, Date.now(), id);
    claimed = updated.changes === 1;
    if (claimed && decision === 'always') {
      upsertToolApprovalRule(db, row.scope_type, row.scope_id, row.tool_name);
    }
  });
  txn();
  return { row: getToolApproval(db, id) as ToolApprovalRow, claimed };
}

/**
 * One-shot ledger consume: CAS `approved → consumed` for the row matching
 * session + tool name + input hash. Only a true claim returns true, so a
 * replay can never double-execute an approval.
 */
export function consumeApprovedToolApproval(
  db: BetterSqlite3Db,
  sessionId: string,
  toolName: string,
  inputHash: string,
): boolean {
  const claimed = db
    .prepare(
      "UPDATE tool_approval_state SET status = 'consumed' " +
        "WHERE session_id = ? AND tool_name = ? AND input_hash = ? AND status = 'approved'",
    )
    .run(sessionId, toolName, inputHash);
  return claimed.changes > 0;
}

/**
 * Consume by id — used by the interactive fast-path sync (the live worker
 * executes immediately, so the ledger entry must burn right away).
 */
export function consumeToolApprovalById(db: BetterSqlite3Db, id: string): ToolApprovalRow | undefined {
  db.prepare(
    "UPDATE tool_approval_state SET status = 'consumed' WHERE id = ? AND status = 'approved'",
  ).run(id);
  return getToolApproval(db, id);
}

export function upsertToolApprovalRule(
  db: BetterSqlite3Db,
  scopeType: ToolApprovalScopeType,
  scopeId: string,
  toolName: string,
): void {
  db.prepare(
    'INSERT INTO tool_approval_rules (scope_type, scope_id, tool_name, created_at) ' +
      'VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (scope_type, scope_id, tool_name) DO NOTHING',
  ).run(scopeType, scopeId, toolName, Date.now());
}

export function listToolApprovalRules(
  db: BetterSqlite3Db,
  scopeType: ToolApprovalScopeType,
  scopeId: string,
): string[] {
  return (
    db
      .prepare(
        'SELECT tool_name FROM tool_approval_rules WHERE scope_type = ? AND scope_id = ? ORDER BY created_at ASC',
      )
      .all(scopeType, scopeId) as Array<{ tool_name: string }>
  ).map((r) => r.tool_name);
}
