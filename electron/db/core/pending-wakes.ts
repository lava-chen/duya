/**
 * pending-wakes.ts — durable pending-wake markers (Plan 476 Phase 3.1).
 *
 * Why durable: the wake dispatcher's queue and its recently-dispatched
 * dedupe window live in main-process memory. When the host restarts (app
 * quit, crash, upgrade) any background work that was in flight — a
 * sub-agent run, a long background bash, an automation — loses its "will
 * wake the session when done" marker. `pending_wakes` records that intent
 * durably so a restart can re-arm the wake instead of silently dropping
 * the result.
 *
 * Semantics (aligned with grok `.part`+rename / pending-wake-rearm):
 *  - a background wake is persisted when it is *accepted* (queued) and
 *    cleared once it has been *consumed* (dispatched to a run);
 *  - the row key is `(kind, work_id)` — exactly the `kind\0id` union key
 *    used to merge live tasks with durable markers for the roster
 *    projection (476 §2.4, async-task-union equivalent);
 *  - rows older than the stale horizon are pruned on startup (48h) so a
 *    marker whose process died long ago cannot re-wake anything.
 *
 * Single-table CRUD, under ~150 lines — grouped in its own module because
 * it has no sibling aggregate (stores.ts comment: one file per boundary).
 */

import type { Migration } from './database';

export type PendingWakeKind =
  | 'task.completion'
  | 'automation.fire'
  | 'connector.inbound'
  | 'broadcast'
  | 'user.message'
  | 'agent.dm'
export type PendingWakeLane = 'user' | 'agent' | 'background'

export interface PendingWakeRow {
  kind: PendingWakeKind
  workId: string
  agentId: string
  lane: PendingWakeLane
  markedAtMs: number
  /** Human-readable label for the roster / rearm synthesis. */
  title: string | null
  quietOriginJson: string | null
}

export interface PersistPendingWakeInput {
  kind: PendingWakeKind
  workId: string
  agentId: string
  lane?: PendingWakeLane
  title?: string | null
  quietOriginJson?: string | null
}

export const PENDING_WAKE_STALE_MS = 48 * 60 * 60 * 1000 // 48h horizon (476 §2.4)

export class PendingWakeStore {
  /** Migration id=12: create pending_wakes (Plan 476 Phase 3). */
  static readonly migrations: Migration[] = [
    {
      id: 12,
      name: 'create_pending_wakes',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pending_wakes (
            kind             TEXT NOT NULL,
            work_id          TEXT NOT NULL,
            agent_id         TEXT NOT NULL,
            lane             TEXT NOT NULL DEFAULT 'background',
            marked_at_ms     INTEGER NOT NULL,
            title            TEXT,
            quiet_origin_json TEXT,
            PRIMARY KEY (kind, work_id)
          );
          CREATE INDEX IF NOT EXISTS idx_pending_wakes_marked ON pending_wakes(marked_at_ms);
          CREATE INDEX IF NOT EXISTS idx_pending_wakes_agent ON pending_wakes(agent_id);
        `);
      },
    },
  ];

  private readonly db: import('./database').SqliteDatabase

  constructor(db: import('./database').SqliteDatabase) {
    this.db = db
  }

  /** Insert or refresh a pending wake marker (idempotent by kind+workId). */
  persist(input: PersistPendingWakeInput): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO pending_wakes (kind, work_id, agent_id, lane, marked_at_ms, title, quiet_origin_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, work_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           lane = excluded.lane,
           marked_at_ms = excluded.marked_at_ms,
           title = excluded.title,
           quiet_origin_json = excluded.quiet_origin_json`,
      )
      .run(
        input.kind,
        input.workId,
        input.agentId,
        input.lane ?? 'background',
        now,
        input.title ?? null,
        input.quietOriginJson ?? null,
      )
  }

  /** Remove a consumed wake. Returns true when a row was actually deleted. */
  clear(kind: PendingWakeKind, workId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM pending_wakes WHERE kind = ? AND work_id = ?')
      .run(kind, workId)
    return result.changes > 0
  }

  /** Every pending marker (rearm reads this on startup). */
  listAll(): PendingWakeRow[] {
    return this.db
      .prepare(
        'SELECT kind, work_id, agent_id, lane, marked_at_ms, title, quiet_origin_json FROM pending_wakes',
      )
      .all() as unknown as PendingWakeRow[]
  }

  /** Rows for one agent (roster projection). */
  listForAgent(agentId: string): PendingWakeRow[] {
    return this.db
      .prepare(
        'SELECT kind, work_id, agent_id, lane, marked_at_ms, title, quiet_origin_json FROM pending_wakes WHERE agent_id = ?',
      )
      .all(agentId) as unknown as PendingWakeRow[]
  }

  /**
   * Remove markers whose intent is hopelessly stale (host was down / the
   * work died long ago). Returns the number of rows removed.
   */
  pruneStale(beforeMs: number = Date.now() - PENDING_WAKE_STALE_MS): number {
    const result = this.db.prepare('DELETE FROM pending_wakes WHERE marked_at_ms < ?').run(beforeMs)
    return result.changes
  }
}
