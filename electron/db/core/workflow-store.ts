/**
 * workflow-store.ts — run management persistence for the workflow
 * engine (plan 552 §6.1, keyed in the 413c style).
 *
 * n8n shape: execution = one metadata row (`workflow_runs`) + a 1:1
 * snapshot blob (`workflow_run_snapshots`) holding the frozen definition
 * and the node stack. The journal record sequence lives in its own
 * append-only table (`workflow_run_events`, plan 560 migration 31) —
 * large payloads (screenshots) stay OUTSIDE both and are referenced
 * through the artifact store.
 *
 * `workflow_version_id` makes breakpoint resume reproducible ("可修正":
 * editing the workflow mints a new version; old runs keep theirs).
 * `dedup_key` is the trigger idempotency index (§7: at-least-once
 * delivery must not double-execute).
 *
 * Plan 560 adds the run-anchored columns (`origin` / `scope` /
 * `project_dir` / `parent_session_id` / `artifacts_json` / `summary` /
 * `finished_at` / `spent_tokens`) so a run is a first-class citizen that
 * never needs a chat session. See docs/exec-plans/active/560-workflow-independent-runtime.md.
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

/**
 * What a run is anchored to (plan 560 D1). `library` is the run-anchored
 * path — no chat session is involved anywhere in the lifecycle.
 * `agent` / `cron` are future entry points whose columns are already in
 * place so no second migration is needed to land them.
 */
export type WorkflowRunOrigin = 'library' | 'session' | 'agent' | 'cron';

/** Scope resolution of the definition the run was launched from. */
export type WorkflowRunScope = 'project' | 'global';

/** One published artifact of a run (plan 560 §5.1 / D3). */
export interface WorkflowArtifactRef {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  /**
   * Path relative to the run's artifact root
   * (`~/.duya/workflow-artifacts/<runId>/`) — the child process writes the
   * bytes, main stores only this reference.
   */
  relPath: string;
}

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
  // ─── plan 560 run anchoring ───
  origin: WorkflowRunOrigin;
  scope: WorkflowRunScope | null;
  /** Working directory the run executes in (agent nodes inherit it). */
  projectDir: string | null;
  /** Only set for `agent` / `session` origins. */
  parentSessionId: string | null;
  artifacts: WorkflowArtifactRef[];
  /** One-paragraph outcome summary rendered in the run card. */
  summary: string | null;
  finishedAt: number | null;
  spentTokens: number | null;
  /** Plan 568: run-level agent model override recorded for 重跑/续跑复用. */
  agentModel: string | null;
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
  // ─── plan 560 ───
  origin?: WorkflowRunOrigin;
  scope?: WorkflowRunScope | null;
  projectDir?: string | null;
  parentSessionId?: string | null;
  summary?: string | null;
  /** Plan 568: run-level agent model override. */
  agentModel?: string | null;
}

/** Terminal outcome written once, at the end of a run (plan 560). */
export interface WorkflowRunOutcomeInput {
  status: WorkflowRunStatus;
  summary?: string | null;
  artifacts?: WorkflowArtifactRef[];
  spentTokens?: number | null;
  finishedAt?: number | null;
}

/** The 1:1 snapshot blob (§6.1). */
export interface WorkflowRunSnapshot {
  runId: string;
  /** Frozen definition (parsed object) for reproducible resume. */
  definition: unknown;
  /** Node stack — statuses/outputs the console renders. */
  nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
  /**
   * @deprecated Plan 560 migration 31 moved the journal into
   * `workflow_run_events`. Read it via `loadJournal()` / `listEvents()`.
   * The key may still be present on rows written before the migration —
   * `loadSnapshot()` keeps a legacy read path for exactly that. Do not
   * write it back; the type stays until v1 of plan 560 is closed.
   */
  journal: JournalRecord[];
  updatedAt: number;
}

/**
 * `saveSnapshot` input. `nodeStack` / `journal` are optional so callers
 * stop having to thread the journal through a blob it no longer lives in
 * — any records handed in are upserted into the events table instead of
 * being silently dropped.
 */
export interface WorkflowRunSnapshotSaveInput {
  runId: string;
  definition: unknown;
  nodeStack?: WorkflowRunSnapshot['nodeStack'];
  /** @deprecated Ingested into `workflow_run_events`, not stored in the blob. */
  journal?: JournalRecord[];
  updatedAt?: number;
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
  origin: string;
  scope: string | null;
  project_dir: string | null;
  parent_session_id: string | null;
  artifacts_json: string;
  summary: string | null;
  finished_at: number | null;
  spent_tokens: number | null;
  agent_model: string | null;
  created_at: number;
  updated_at: number;
}

interface SnapshotRow {
  run_id: string;
  snapshot_json: string;
  updated_at: number;
}

interface EventRow {
  seq: number;
  record_json: string;
}

/** Columns of a table, for idempotent `ALTER TABLE ADD COLUMN`. */
function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function parseJsonObject(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function parseArtifacts(raw: string | null): WorkflowArtifactRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkflowArtifactRef[]) : [];
  } catch {
    return [];
  }
}

/** Best-effort epoch-ms for an event row's `created_at`. */
function eventTimestamp(record: JournalRecord): number {
  const atMs = (record as { atMs?: unknown }).atMs;
  return typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now();
}

/** The monotonic cursor a `JournalRecord` carries (plan 560 D4). */
function recordSeq(record: JournalRecord, fallback: number): number {
  const seq = (record as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : fallback;
}

export class WorkflowRunStore {
  /** Migration id=28/29: workflow run metadata + snapshot blobs (plan 552 Phase 4).
   *  IDs 26/27 are taken by SessionStore (add_archived_at_and_archived_path_to_sessions)
   *  so we shifted up to avoid the duplicate-id collision that the migrator
   *  otherwise silently swallows — see "Duplicate core migration id 26".
   *  IDs 30/31: plan 560 run anchoring + journal relocation.
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
    {
      id: 30,
      name: 'extend_workflow_runs_and_create_run_events',
      up: (db) => {
        // SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so the
        // guard is an explicit column probe. The migrator accounts by id and
        // would not normally re-run this, but a dev DB that ran a partial
        // build (or a hand-applied column) must not abort initCoreDatabase.
        const existing = tableColumns(db, 'workflow_runs');
        const addColumn = (name: string, ddl: string): void => {
          if (!existing.has(name)) db.exec(`ALTER TABLE workflow_runs ADD COLUMN ${ddl}`);
        };
        addColumn('origin', `origin TEXT NOT NULL DEFAULT 'library'`);
        addColumn('scope', 'scope TEXT');
        addColumn('project_dir', 'project_dir TEXT');
        addColumn('parent_session_id', 'parent_session_id TEXT');
        addColumn('artifacts_json', `artifacts_json TEXT NOT NULL DEFAULT '[]'`);
        addColumn('summary', 'summary TEXT');
        addColumn('finished_at', 'finished_at INTEGER');
        addColumn('spent_tokens', 'spent_tokens INTEGER');

        // Every row that exists at this instant predates the run-anchored
        // launch path — they all came through `workflow:run` (session
        // anchor) and were just back-filled with the 'library' default.
        // Re-label them so run history filters stay truthful.
        db.exec(`UPDATE workflow_runs SET origin = 'session' WHERE origin = 'library'`);

        // Journal events, one row per record. No field expansion: the
        // `JournalRecord` shape is the single event vocabulary (plan 560 D4).
        db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_run_events (
            run_id      TEXT    NOT NULL,
            seq         INTEGER NOT NULL,
            record_json TEXT    NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (run_id, seq)
          );
          CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run ON workflow_run_events(run_id, seq);
          CREATE INDEX IF NOT EXISTS idx_workflow_runs_origin ON workflow_runs(origin, created_at);
        `);
      },
    },
    {
      id: 31,
      name: 'move_workflow_journal_into_run_events',
      up: (db) => {
        // One-shot relocation of the journal out of the snapshot blob.
        // Idempotent by construction: `(run_id, seq)` is the primary key, so
        // a re-run (or a partially migrated DB) re-inserts nothing.
        const rows = db
          .prepare('SELECT run_id, snapshot_json FROM workflow_run_snapshots')
          .all() as Array<{ run_id: string; snapshot_json: string }>;
        const insert = db.prepare(
          `INSERT OR IGNORE INTO workflow_run_events (run_id, seq, record_json, created_at)
           VALUES (?, ?, ?, ?)`,
        );
        const rewrite = db.prepare('UPDATE workflow_run_snapshots SET snapshot_json = ? WHERE run_id = ?');
        const txn = db.transaction(() => {
          for (const row of rows) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(row.snapshot_json) as Record<string, unknown>;
            } catch {
              continue; // unreadable blob — leave it alone, nothing to migrate
            }
            const journal = Array.isArray(parsed.journal) ? (parsed.journal as JournalRecord[]) : [];
            journal.forEach((record, index) => {
              insert.run(row.run_id, recordSeq(record, index), JSON.stringify(record), eventTimestamp(record));
            });
            if ('journal' in parsed) {
              delete parsed.journal;
              rewrite.run(JSON.stringify(parsed), row.run_id);
            }
          }
        });
        txn();
      },
    },
    {
      id: 32,
      name: 'add_agent_model_to_workflow_runs',
      up: (db) => {
        // Plan 568: run-level agent model override, recorded at create time so
        // 重跑 / 续跑 reuse the same model instead of silently falling back to
        // the current provider default. Idempotent column probe (migration 30
        // pattern).
        const existing = tableColumns(db, 'workflow_runs');
        if (!existing.has('agent_model')) {
          db.exec(`ALTER TABLE workflow_runs ADD COLUMN agent_model TEXT`);
        }
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  createRun(input: WorkflowRunCreateInput): WorkflowRun {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
          id, workflow_name, workflow_version_id, status, trigger_kind,
          dedup_key, params_json, wait_till, retry_of, pause_message,
          created_at, updated_at, origin, scope, project_dir,
          parent_session_id, artifacts_json, summary, finished_at, spent_tokens,
          agent_model
        ) VALUES (
          @id, @workflow_name, @workflow_version_id, @status, @trigger_kind,
          @dedup_key, @params_json, NULL, @retry_of, NULL,
          @created_at, @updated_at, @origin, @scope, @project_dir,
          @parent_session_id, '[]', @summary, NULL, NULL,
          @agent_model
        )`,
      )
      .run({
        id,
        workflow_name: input.workflowName,
        workflow_version_id: input.workflowVersionId ?? null,
        status: input.status ?? 'inactive',
        trigger_kind: input.triggerKind ?? null,
        dedup_key: input.dedupKey ?? null,
        params_json: JSON.stringify(input.params ?? {}),
        retry_of: input.retryOf ?? null,
        created_at: now,
        updated_at: now,
        origin: input.origin ?? 'library',
        scope: input.scope ?? null,
        project_dir: input.projectDir ?? null,
        parent_session_id: input.parentSessionId ?? null,
        summary: input.summary ?? null,
        agent_model: input.agentModel ?? null,
      });
    return this.getRun(id)!;
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

  listRuns(filter?: {
    status?: WorkflowRunStatus;
    workflowName?: string;
    origin?: WorkflowRunOrigin;
    /** Plan 565: session transcript rehydration (runs anchored to one chat). */
    parentSessionId?: string;
    limit?: number;
    offset?: number;
  }): WorkflowRun[] {
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
    if (filter?.origin) {
      conditions.push('origin = @origin');
      args.origin = filter.origin;
    }
    if (filter?.parentSessionId) {
      conditions.push('parent_session_id = @parentSessionId');
      args.parentSessionId = filter.parentSessionId;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filter?.limit ?? 50, 500);
    const offset = filter?.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...args, limit, offset }) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  /** Run ids currently in a RUNNING-class status — the reaper's live set. */
  listActiveRunIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM workflow_runs
         WHERE status IN ('active', 'verifying', 'planning', 'awaiting_confirm')`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
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

  /**
   * Terminal write for a run (plan 560): status + outcome fields in one
   * statement. Omitted fields are left untouched, so a partial outcome
   * never clobbers an earlier one.
   */
  finishRun(id: string, outcome: WorkflowRunOutcomeInput): boolean {
    const sets: string[] = ['status = @status', 'updated_at = @updated_at'];
    const args: Record<string, unknown> = {
      id,
      status: outcome.status,
      updated_at: Date.now(),
    };
    if (outcome.summary !== undefined) {
      sets.push('summary = @summary');
      args.summary = outcome.summary;
    }
    if (outcome.artifacts !== undefined) {
      sets.push('artifacts_json = @artifacts_json');
      args.artifacts_json = JSON.stringify(outcome.artifacts);
    }
    if (outcome.spentTokens !== undefined) {
      sets.push('spent_tokens = @spent_tokens');
      args.spent_tokens = outcome.spentTokens;
    }
    if (outcome.finishedAt !== undefined) {
      sets.push('finished_at = @finished_at');
      args.finished_at = outcome.finishedAt;
    } else {
      sets.push('finished_at = COALESCE(finished_at, @now_ms)');
      args.now_ms = Date.now();
    }
    const r = this.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = @id`).run(args);
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

  /**
   * Write the definition + node stack. The `journal` is no longer part of
   * the blob (plan 560 migration 31) — records handed in here are upserted
   * into `workflow_run_events` so an un-updated caller loses nothing.
   */
  saveSnapshot(snapshot: WorkflowRunSnapshotSaveInput): void {
    const txn = this.db.transaction(() => {
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
            nodeStack: snapshot.nodeStack ?? [],
          }),
          updated_at: snapshot.updatedAt ?? Date.now(),
        });
      if (snapshot.journal && snapshot.journal.length > 0) {
        this.appendRecords(snapshot.runId, snapshot.journal);
      }
    });
    txn();
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
      // Legacy read path: rows written before migration 31 still carry the
      // journal inline, and migration 31 may not have run on an old DB.
      journal: parsed.journal ?? [],
      updatedAt: row.updated_at,
    };
  }

  /**
   * Append one journal record to the events table (plan 560 §4.2). This
   * used to rewrite the whole snapshot blob per record — an O(n²) write
   * amplification that is now a single INSERT.
   */
  appendJournalRecord(runId: string, record: JournalRecord): void {
    this.appendRecords(runId, [record]);
  }

  /** Shared INSERT path for one or more records; `(run_id, seq)` is idempotent. */
  private appendRecords(runId: string, records: readonly JournalRecord[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO workflow_run_events (run_id, seq, record_json, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const txn = this.db.transaction(() => {
      records.forEach((record, index) => {
        insert.run(runId, recordSeq(record, index), JSON.stringify(record), eventTimestamp(record));
      });
    });
    txn();
  }

  /**
   * The run's event stream, ascending by `seq`. `afterSeq` is the SSE
   * cursor (plan 560 D5) — it makes "catch up after a missed frame"
   * idempotent because the merge key is the same `seq`.
   */
  listEvents(runId: string, afterSeq = -1): JournalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT seq, record_json FROM workflow_run_events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(runId, afterSeq) as EventRow[];
    return rows.map((r) => JSON.parse(r.record_json) as JournalRecord);
  }

  /** Highest `seq` persisted for a run — the SSE `afterSeq` seed. */
  latestEventSeq(runId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(seq) AS seq FROM workflow_run_events WHERE run_id = ?')
      .get(runId) as { seq: number | null } | undefined;
    return row?.seq ?? null;
  }

  getEventCount(runId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM workflow_run_events WHERE run_id = ?')
      .get(runId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  loadJournal(runId: string): JournalRecord[] {
    const events = this.listEvents(runId, -1);
    if (events.length > 0) return events;
    return this.loadSnapshot(runId)?.journal ?? [];
  }

  deleteRun(id: string): boolean {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_run_events WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM workflow_run_snapshots WHERE run_id = ?').run(id);
      const r = this.db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id);
      return r.changes > 0;
    });
    return txn();
  }
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    workflowVersionId: row.workflow_version_id,
    status: row.status as WorkflowRunStatus,
    triggerKind: (row.trigger_kind as WorkflowTriggerKind | null) ?? null,
    dedupKey: row.dedup_key,
    params: parseJsonObject(row.params_json, {}),
    waitTill: row.wait_till,
    retryOf: row.retry_of,
    pauseMessage: row.pause_message,
    origin: (row.origin as WorkflowRunOrigin | null) ?? 'library',
    scope: (row.scope as WorkflowRunScope | null) ?? null,
    projectDir: row.project_dir,
    parentSessionId: row.parent_session_id,
    artifacts: parseArtifacts(row.artifacts_json),
    summary: row.summary,
    finishedAt: row.finished_at,
    spentTokens: row.spent_tokens,
    agentModel: row.agent_model ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
