/**
 * Projection outbox (Plan 303 Phase B, design v3 D12).
 *
 * DB ↔ file atomicity queue: every projection change is first committed
 * to `projection_outbox` (in the same transaction as the DB change that
 * motivates it), and a sweeper (`drainOutbox`) later applies it to the
 * filesystem with exponential backoff. DB is the source of truth; files
 * are always rebuildable (see `reconcile.ts`).
 *
 * Interfaces deviate from the plan text in one deliberate way: all
 * public functions take the better-sqlite3 handle as their first
 * argument (packages/agent must not import electron's DB singleton;
 * Plan 305 wires the handle).
 *
 * Replaces the Plan 302 no-op stub that previously lived in this file.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial delay before a freshly enqueued row becomes drainable. */
const ENQUEUE_DELAY_MS = 1_000;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_ATTEMPTS = 20;

/** Backoff schedule in ms, indexed by 1-based attempt_count. */
const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  targetPath: string;
  operation: 'write' | 'delete';
  content: string | null;
  now?: number;
}

export interface EnqueueResult {
  projectionId: number;
  /** ISO 8601 timestamp of the first scheduled drain attempt. */
  nextAttemptAt: string;
}

/** Subset of `projection_outbox` columns the sweeper operates on. */
export interface OutboxRow {
  projection_id: number;
  target_path: string;
  operation: 'write' | 'delete';
  content: string | null;
  attempt_count: number;
}

/** Internal test hooks; not part of the production contract. */
export interface DrainHooks {
  beforeWrite?: (row: OutboxRow) => void;
}

export interface DrainOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** Extra allowlist roots appended to the default (~/.duya/memory). */
  allowedRoots?: string[];
  now?: number;
  _hooks?: DrainHooks;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Backoff for the given 1-based attempt number. Attempts beyond the
 * schedule clamp to the last entry (6h).
 */
export function outboxBackoffMs(attempt: number): number {
  const clamped = Math.min(Math.max(Math.floor(attempt), 1), BACKOFF_MS.length);
  return BACKOFF_MS[clamped - 1];
}

/** sha256 hex of the UTF-8 encoding of `content`. */
export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function defaultMemoryRoot(): string {
  return path.join(os.homedir(), '.duya', 'memory');
}

function isWithin(candidate: string, roots: string[], allowEqual: boolean): boolean {
  return roots.some((root) =>
    candidate === root ? allowEqual : candidate.startsWith(root + path.sep)
  );
}

/** Canonicalize a path via realpath when it exists (best effort). */
function canonicalizeExisting(p: string): string {
  try {
    if (fs.existsSync(p)) return fs.realpathSync(p);
  } catch {
    // Fall through to the unresolved path.
  }
  return p;
}

/**
 * Reject any target that is not strictly inside the allowlist, including
 * symlink escapes: the target itself (when it exists) or its nearest
 * existing ancestor directory must stay inside the allowlist after
 * realpath resolution. An ancestor ABOVE an allowlist root (i.e. the
 * root itself has not been created yet) is accepted only when its real
 * location is a genuine prefix of that root.
 */
export function assertSafe(targetPath: string, allowedRoots?: string[]): void {
  const roots = [defaultMemoryRoot(), ...(allowedRoots ?? [])].map((r) => path.resolve(r));
  const canonicalRoots = roots.map(canonicalizeExisting);
  const resolved = path.resolve(targetPath);

  if (!isWithin(resolved, roots, false)) {
    throw new Error(`outbox target outside allowlist: ${targetPath}`);
  }

  let probe = resolved;
  if (!fs.existsSync(probe)) {
    let cursor: string | null = path.dirname(resolved);
    while (cursor !== null && !fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      cursor = parent === cursor ? null : parent;
    }
    if (cursor === null) {
      throw new Error(`outbox target has no existing ancestor: ${targetPath}`);
    }
    probe = cursor;
  }

  const real = fs.realpathSync(probe);
  const insideRoots = isWithin(real, canonicalRoots, true);
  // The probed ancestor may legitimately sit ABOVE an allowlist root
  // that does not exist yet (e.g. ~/.duya/memory not yet created).
  const isRootPrefix = canonicalRoots.some((root) => root.startsWith(real + path.sep));
  if (!insideRoots && !isRootPrefix) {
    throw new Error(`outbox target escapes allowlist via symlink: ${targetPath}`);
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Insert one outbox row. Transaction-aware: when the caller already
 * holds a better-sqlite3 transaction (`db.inTransaction`), the INSERT
 * joins it (so `stage1_outputs` + outbox commit atomically); otherwise
 * the INSERT runs in its own transaction.
 */
export function enqueueProjectionOutbox(db: Database, input: EnqueueInput): EnqueueResult {
  const now = input.now ?? Date.now();
  const nextAttemptAtMs = now + ENQUEUE_DELAY_MS;
  const insert = (): number => {
    const result = db
      .prepare(
        `INSERT INTO projection_outbox
           (target_path, operation, content, attempt_count, next_attempt_at, last_error, enqueued_at, completed_at)
         VALUES (?, ?, ?, 0, ?, NULL, ?, NULL)`
      )
      .run(input.targetPath, input.operation, input.content, nextAttemptAtMs, now);
    return Number(result.lastInsertRowid);
  };
  const projectionId = db.inTransaction ? insert() : db.transaction(insert)();
  return { projectionId, nextAttemptAt: new Date(nextAttemptAtMs).toISOString() };
}

// ---------------------------------------------------------------------------
// Drain (sweeper)
// ---------------------------------------------------------------------------

/** In-process single-flight guard; cross-process safety comes from the
 * per-row `UPDATE ... WHERE completed_at IS NULL` CAS. */
let drainInFlight = false;

/**
 * Process up to `batchSize` due outbox rows. Returns the number of rows
 * processed this pass. A re-entrant call while a drain is in flight
 * returns 0 immediately.
 */
export function drainOutbox(db: Database, opts: DrainOptions = {}): number {
  if (drainInFlight) return 0;
  drainInFlight = true;
  try {
    const now = opts.now ?? Date.now();
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const rows = db
      .prepare(
        `SELECT projection_id, target_path, operation, content, attempt_count
         FROM projection_outbox
         WHERE completed_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY projection_id ASC
         LIMIT ?`
      )
      .all(now, batchSize) as OutboxRow[];
    for (const row of rows) {
      processOutboxRow(db, row, now, maxAttempts, opts.allowedRoots, opts._hooks);
    }
    return rows.length;
  } finally {
    drainInFlight = false;
  }
}

function processOutboxRow(
  db: Database,
  row: OutboxRow,
  now: number,
  maxAttempts: number,
  allowedRoots: string[] | undefined,
  hooks: DrainHooks | undefined
): void {
  try {
    assertSafe(row.target_path, allowedRoots);
  } catch {
    db.prepare(
      `UPDATE projection_outbox
       SET completed_at = ?, attempt_count = attempt_count + 1, last_error = 'unsafe-path'
       WHERE projection_id = ?`
    ).run(now, row.projection_id);
    return;
  }

  if (row.operation === 'write') {
    const dir = path.dirname(row.target_path);
    const tmpPath = path.join(dir, `.${path.basename(row.target_path)}.${row.projection_id}.tmp`);
    try {
      hooks?.beforeWrite?.(row);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, row.content ?? '', 'utf8');
      fs.renameSync(tmpPath, row.target_path);
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Best-effort temp cleanup.
      }
      recordFailure(db, row, now, maxAttempts, err);
      return;
    }
  } else {
    try {
      fs.rmSync(row.target_path, { force: true });
      pruneEmptyProjectionParents(row.target_path, allowedRoots);
    } catch (err) {
      recordFailure(db, row, now, maxAttempts, err);
      return;
    }
  }

  // changes === 0 means a concurrent drain completed the row first; ignore.
  db.prepare(
    `UPDATE projection_outbox
     SET completed_at = ?, attempt_count = attempt_count + 1
     WHERE projection_id = ? AND completed_at IS NULL`
  ).run(now, row.projection_id);
}

/**
 * Delete empty generated directories after a managed file is removed. The
 * walk stops before every allowlisted root and never removes a non-empty
 * directory, so user-owned files make the cleanup fail closed.
 */
function pruneEmptyProjectionParents(targetPath: string, allowedRoots?: string[]): void {
  const roots = [defaultMemoryRoot(), ...(allowedRoots ?? [])].map((root) => path.resolve(root));
  let current = path.dirname(path.resolve(targetPath));
  while (isWithin(current, roots, false)) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function recordFailure(
  db: Database,
  row: OutboxRow,
  now: number,
  maxAttempts: number,
  err: unknown
): void {
  const attempts = row.attempt_count + 1;
  const message = err instanceof Error ? err.message : String(err);
  if (attempts > maxAttempts) {
    // Retire: stop queuing this row, keep the failure visible.
    db.prepare(
      `UPDATE projection_outbox
       SET completed_at = ?, attempt_count = ?, last_error = ?
       WHERE projection_id = ?`
    ).run(now, attempts, `retired-after-${attempts}-attempts`, row.projection_id);
  } else {
    db.prepare(
      `UPDATE projection_outbox
       SET attempt_count = ?, next_attempt_at = ?, last_error = ?
       WHERE projection_id = ?`
    ).run(attempts, now + outboxBackoffMs(attempts), message, row.projection_id);
  }
}
