/**
 * workflow-store.ts — run management persistence for the workflow
 * engine (plan 552 §6.1, keyed in the 413c style).
 *
 * n8n shape: execution = one metadata row (`workflow_runs`) + a 1:1
 * snapshot blob (`workflow_run_snapshots`) holding the frozen YAML
 * definition, the node stack and the journal record sequence. Large
 * payloads (screenshots) live OUTSIDE the blob — journal records carry
 * references resolved through the artifact store.
 *
 * `workflow_version_id` makes breakpoint resume reproducible ("可修正":
 * editing the YAML mints a new version; old runs keep theirs).
 * `dedup_key` is the trigger idempotency index (§7: at-least-once
 * delivery must not double-execute).
 */

import { randomUUID } from 'node:crypto';
import type { Migration, SqliteDatabase } from './database';
import type { JournalRecord } from '../../../packages/agent/src/modes/workflow/journal';

// ─── workflow_runs ───

/** Run lifecycle status — mirrors RunLifecycleState (415 §6.2.1). */
export type WorkflowRunStatus =
  | 'inactive'
  | 'planning'
  | 'awaiting_confirm'
  | 'active'
  | 'verifying'
  | 'user_paused'
  | 'backoff_paused'
  | 'no_progress_paused'
  | 'infra_paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

export type WorkflowTriggerKind = 'manual' | 'cron' | 'bot' | 'http';

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersionId: string | null;
  status: WorkflowRunStatus;
  triggerKind: WorkflowTriggerKind | null;
  dedupKey: string | null;
  params: Record<string, unknown>;
  /** Epoch ms until which the run is parked (human / timeout). */
  waitTill: number | null;
  retryOf: string | null;
  pauseMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunCreateInput {
  id?: string;
  workflowName: string;
  workflowVersionId?: string | null;
  status?: WorkflowRunStatus;
  triggerKind?: WorkflowTriggerKind | null;
  dedupKey?: string | null;
  params?: Record<string, unknown>;
  retryOf?: string | null;
}

/** The 1:1 snapshot blob (§6.1). */
export interface WorkflowRunSnapshot {
  runId: string;
  /** Frozen YAML definition (parsed object) for reproducible resume. */
  definition: unknown;
  /** Node stack — statuses/outputs the console renders. */
  nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
  /** Journal record sequence (append-only; cache source on resume). */
  journal: JournalRecord[];
  updatedAt: number;
}

interface WorkflowRunRow {
  id: string;
  workflow_name: string;
  workflow_version_id: string | null;
  status: string;
  trigger_kind: string | null;
  dedup_key: string | null;
  params_json: string;
  wait_till: number | null;
  retry_of: string | null;
  pause_message: string | null;
  created_at: number;
  updated_at: number;
}

interface SnapshotRow {
  run_id: string;
  snapshot_json: string;
  updated_at: number;
}

export class WorkflowRunStore {
  /** Migration id=28/29: workflow run metadata + snapshot blobs (plan 552 Phase 4).
   *  IDs 26/27 are taken by SessionStore (add_archived_at_and_archived_path_to_sessions)
   *  so we shifted up to avoid the duplicate-id collision that the migrator
   *  otherwise silently swallows — see "Duplicate core migration id 26".
   */
  static readonly migrations: Migration[] = [
    {
      id: 28,
      name: 'create_workflow_runs',
      up: (db) => {
        // `IF NOT EXISTS` defends against the duplicate-id legacy where an
        // earlier build (id 26/27, before this rename) may have left the
        // table around — without it, migration 29's CREATE TABLE on an
        // already-populated DB aborts initCoreDatabase and every renderer
        // IPC handler explodes with "Core stores not initialized".
        db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_runs (
            id                  TEXT PRIMARY KEY,
            workflow_name       TEXT NOT NULL,
            workflow_version_id TEXT,
            status              TEXT NOT NULL,
            trigger_kind        TEXT,
            dedup_key           TEXT UNIQUE,
            params_json         TEXT NOT NULL DEFAULT '{}',
            wait_till           INTEGER,
            retry_of            TEXT,
            pause_message       TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
          CREATE INDEX IF NOT EXISTS idx_workflow_runs_name ON workflow_runs(workflow_name, created_at);
          CREATE INDEX IF NOT EXISTS idx_workflow_runs_wait_till ON workflow_runs(wait_till);
        `);
      },
    },
    {
      id: 29,
      name: 'create_workflow_run_snapshots',
      up: (db) => {
        // Same idempotency rationale as migration 28.
        db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_run_snapshots (
            run_id        TEXT PRIMARY KEY,
            snapshot_json TEXT NOT NULL,
            updated_at    INTEGER NOT NULL
          );
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  createRun(input: WorkflowRunCreateInput): WorkflowRun {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
          id, workflow_name, workflow_version_id, status, trigger_kind,
          dedup_key, params_json, wait_till, retry_of, pause_message,
          created_at, updated_at
        ) VALUES (
          @id, @workflow_name, @workflow_version_id, @status, @trigger_kind,
          @dedup_key, @params_json, NULL, @retry_of, NULL,
          @created_at, @updated_at
        )`,
      )
      .run({
        id: input.id ?? randomUUID(),
        workflow_name: input.workflowName,
        workflow_version_id: input.workflowVersionId ?? null,
        status: input.status ?? 'inactive',
        trigger_kind: input.triggerKind ?? null,
        dedup_key: input.dedupKey ?? null,
        params_json: JSON.stringify(input.params ?? {}),
        retry_of: input.retryOf ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.getRun(input.id ?? (this.db.prepare('SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id)!;
  }

  getRun(id: string): WorkflowRun | null {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  /** Trigger idempotency lookup (§7): hit → return the existing run. */
  getRunByDedupKey(dedupKey: string): WorkflowRun | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_runs WHERE dedup_key = ?')
      .get(dedupKey) as WorkflowRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(filter?: { status?: WorkflowRunStatus; workflowName?: string; limit?: number; offset?: number }): WorkflowRun[] {
    const conditions: string[] = [];
    const args: Record<string, unknown> = {};
    if (filter?.status) {
      conditions.push('status = @status');
      args.status = filter.status;
    }
    if (filter?.workflowName) {
      conditions.push('workflow_name = @workflowName');
      args.workflowName = filter.workflowName;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filter?.limit ?? 50, 500);
    const offset = filter?.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...args, limit, offset }) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  updateStatus(id: string, status: WorkflowRunStatus, pauseMessage?: string | null): boolean {
    const r = this.db
      .prepare(
        `UPDATE workflow_runs
         SET status = @status,
             pause_message = @pause_message,
             updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id,
        status,
        pause_message: pauseMessage === undefined ? null : pauseMessage,
        updated_at: Date.now(),
      });
    return r.changes > 0;
  }

  setWaitTill(id: string, waitTill: number | null): boolean {
    const r = this.db
      .prepare('UPDATE workflow_runs SET wait_till = @wait_till, updated_at = @updated_at WHERE id = @id')
      .run({ id, wait_till: waitTill, updated_at: Date.now() });
    return r.changes > 0;
  }

  setVersionId(id: string, versionId: string): boolean {
    const r = this.db
      .prepare('UPDATE workflow_runs SET workflow_version_id = @v, updated_at = @updated_at WHERE id = @id')
      .run({ id, v: versionId, updated_at: Date.now() });
    return r.changes > 0;
  }

  /** Runs parked past `nowMs` — the wait-tracker scan source (§6.3). */
  listWaitingPast(nowMs: number): WorkflowRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE wait_till IS NOT NULL AND wait_till <= @now
           AND status IN ('blocked', 'verifying', 'active')
         ORDER BY wait_till ASC`,
      )
      .all({ now: nowMs }) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Crash reconciliation (§6.2): any run whose status says RUNNING-class
   * but which the live engine does not report as in-flight is marked
   * `interrupted` — NEVER auto-rerun; resume (journal replay) is the
   * user's / scheduler's explicit decision (n8n maxStalledCount:0).
   */
  reconcileStaleRuns(activeRunIds: ReadonlySet<string>): WorkflowRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE status IN ('active', 'verifying', 'planning', 'awaiting_confirm')`,
      )
      .all() as WorkflowRunRow[];
    const stale: WorkflowRun[] = [];
    const mark = this.db.prepare(
      'UPDATE workflow_runs SET status = ?, pause_message = ?, updated_at = ? WHERE id = ?',
    );
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        if (activeRunIds.has(row.id)) continue;
        mark.run('interrupted', 'crash reconciliation: engine not running this run', Date.now(), row.id);
        stale.push(rowToRun({ ...row, status: 'interrupted', pause_message: 'crash reconciliation: engine not running this run' }));
      }
    });
    txn();
    return stale;
  }

  // ─── snapshot blob (1:1) ───

  saveSnapshot(snapshot: Omit<WorkflowRunSnapshot, 'updatedAt'> & { updatedAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO workflow_run_snapshots (run_id, snapshot_json, updated_at)
         VALUES (@run_id, @snapshot_json, @updated_at)
         ON CONFLICT(run_id) DO UPDATE SET
           snapshot_json = @snapshot_json,
           updated_at = @updated_at`,
      )
      .run({
        run_id: snapshot.runId,
        snapshot_json: JSON.stringify({
          definition: snapshot.definition,
          nodeStack: snapshot.nodeStack,
          journal: snapshot.journal,
        }),
        updated_at: snapshot.updatedAt ?? Date.now(),
      });
  }

  loadSnapshot(runId: string): WorkflowRunSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_run_snapshots WHERE run_id = ?')
      .get(runId) as SnapshotRow | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.snapshot_json) as Omit<WorkflowRunSnapshot, 'runId' | 'updatedAt'>;
    return {
      runId,
      definition: parsed.definition,
      nodeStack: parsed.nodeStack ?? [],
      journal: parsed.journal ?? [],
      updatedAt: row.updated_at,
    };
  }

  /**
   * Append one journal record to the blob (load → push → save inside a
   * transaction). Runs are tens-of-nodes scale, so blob rewrite per
   * append is the cheap, atomic durability form.
   */
  appendJournalRecord(runId: string, record: JournalRecord): void {
    const txn = this.db.transaction(() => {
      const snapshot = this.loadSnapshot(runId);
      if (!snapshot) throw new Error(`no snapshot for run ${runId}`);
      snapshot.journal.push(record);
      this.saveSnapshot(snapshot);
    });
    txn();
  }

  loadJournal(runId: string): JournalRecord[] {
    return this.loadSnapshot(runId)?.journal ?? [];
  }

  deleteRun(id: string): boolean {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_run_snapshots WHERE run_id = ?').run(id);
      const r = this.db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id);
      return r.changes > 0;
    });
    return txn();
  }
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params_json) as Record<string, unknown>;
  } catch {
    params = {};
  }
  return {
    id: row.id,
    workflowName: row.workflow_name,
    workflowVersionId: row.workflow_version_id,
    status: row.status as WorkflowRunStatus,
    triggerKind: (row.trigger_kind as WorkflowTriggerKind | null) ?? null,
    dedupKey: row.dedup_key,
    params,
    waitTill: row.wait_till,
    retryOf: row.retry_of,
    pauseMessage: row.pause_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
