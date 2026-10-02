/**
 * run-store.ts — durable run and run-event persistence (plan 586).
 *
 * ## Why this table pair is new and not an extension of `workflow_runs`
 *
 * `workflow_runs` is real, durable, and already has a `(run_id, seq)` event
 * table beside it (`workflow_run_events`, migration 30). It was considered and
 * rejected as the home for an agent run, for three reasons that are properties
 * of the data rather than of taste:
 *
 *  1. **It is not nullable-free.** `workflow_name` is `NOT NULL` and the row is
 *     meaningless without a workflow definition. An agent chat turn has no
 *     workflow; forcing one in would put a fiction in a `NOT NULL` column.
 *  2. **Its status vocabulary is a workflow lifecycle** (`planning`,
 *     `awaiting_confirm`, `backoff_paused`, `user_paused`). A run's vocabulary
 *     is the protocol's four terminal arms plus a live state. Overloading one
 *     means every reader of the other pays for the ambiguity.
 *  3. **Its event table stores a `JournalRecord`** — a workflow node record,
 *     not a `RunEventEnvelope`. Sharing the table would mean a `record_json`
 *     that is sometimes one and sometimes the other, which is how a replay
 *     reader ends up unable to tell which it is holding.
 *
 * So the shape is mirrored, not shared: `(run_id, seq)` primary key, a JSON
 * envelope column, an index for ordered replay. `03-target-structure.md` and
 * the migration list in `06-migration-plan.md` both name a `runs` table as the
 * intended landing place, and this is it.
 *
 * ## The manifest is stored verbatim
 *
 * `manifest_json` is the whole frozen manifest, not a summary of it. That is
 * what makes `manifestFingerprint` re-verifiable at resume: the run can prove
 * that the manifest it was given is the manifest it recorded, rather than
 * asserting it. A run whose `manifest_hash` disagrees with a re-fingerprint of
 * its own `manifest_json` has been tampered with or corrupted, and that is
 * detectable with two columns and a hash function.
 *
 * ## Migration ids
 *
 * 35 and 36, measured above the current core maximum of 34. NOT 27/28: the
 * `id <= current` guard in `runMigrations` silently skipped an id that
 * collided with an already-recorded `schema_version`, and that bug shipped —
 * `session_runtime_locks.origin` was missing for a release because migration id
 * 8 was already taken (`stores.ts:449-455`). The id is chosen by measurement
 * for that reason.
 */

import { randomUUID } from 'node:crypto';
import { manifestFingerprint, type RunEventEnvelope, type RunManifest, type RunTerminalState } from '@duya/agent-protocol';
import type { Migration, SqliteDatabase } from './database';

/** Live, or one of the four terminal arms. Deliberately NOT workflow statuses. */
export type RunStatus = 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';

/** Where a run came from. Mirrors `LockOrigin`, which is the attribution the
 *  bot run scheduler already reads. */
export type RunOrigin = 'user' | 'agent' | 'background';

export interface RunRow {
  id: string;
  session_id: string;
  manifest_hash: string;
  manifest_json: string;
  status: RunStatus;
  terminal: string | null;
  error_json: string | null;
  metrics_json: string | null;
  origin: RunOrigin | null;
  parent_run_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface RunEventRow {
  run_id: string;
  seq: number;
  event_type: string;
  envelope_json: string;
  created_at: number;
}

export interface CreateRunInput {
  readonly runId?: string;
  readonly sessionId: string;
  /** The frozen manifest, stored verbatim. */
  readonly manifest: unknown;
  /** `manifestFingerprint(manifest)`, pinned by the caller BEFORE the run. */
  readonly manifestHash: string;
  readonly origin?: RunOrigin;
  readonly parentRunId?: string;
}

export const RUN_STORE_MIGRATIONS: readonly Migration[] = [
  {
    id: 35,
    name: 'create_runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id            TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          status        TEXT NOT NULL,
          terminal      TEXT,
          error_json    TEXT,
          metrics_json  TEXT,
          origin        TEXT,
          parent_run_id TEXT,
          created_at    INTEGER NOT NULL,
          started_at    INTEGER,
          finished_at   INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
      `);
    },
  },
  {
    id: 36,
    name: 'create_run_events',
    up: (db) => {
      // `PRIMARY KEY (run_id, seq)` is the whole identity, and it is what makes
      // a duplicate append a no-op rather than a second record. A run's `seq`
      // is minted by the runtime and is gapless within the run; a replay
      // writes each record's original seq, exactly as `handleGetChat` already
      // does for the SSE ring.
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_events (
          run_id       TEXT    NOT NULL,
          seq          INTEGER NOT NULL,
          event_type   TEXT    NOT NULL,
          envelope_json TEXT   NOT NULL,
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (run_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
      `);
    },
  },
];

export class RunStore {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * The migrations, as the static every other aggregate exposes.
   *
   * `collectMigrations()` in `core-connection.ts` spreads `<Store>.migrations`
   * for each aggregate, and it is what `initCoreDatabase` hands to the runner.
   * Without this static the spread is `...undefined`, which throws — so the app
   * fails to open its database at boot rather than merely skipping two
   * migrations. Every gate missed it: esbuild does not evaluate, the main
   * process is outside the typecheck gate, and no test called
   * `collectMigrations()`. `run-store-migration.test.ts` does now.
   *
   * `RUN_STORE_MIGRATIONS` stays the exported source of truth; this is the
   * same array, not a second declaration that could drift.
   */
  static readonly migrations: Migration[] = [...RUN_STORE_MIGRATIONS];

  /**
   * Open a run.
   *
   * The row is written with `status: 'running'` BEFORE the runtime dispatches
   * anything, so a run that crashes on its first frame is still a run that
   * exists. A run whose record is created after it completes cannot be
   * recovered after it crashes, and a crash is exactly the case a durable run
   * record exists for.
   */
  createRun(input: CreateRunInput): string {
    const id = input.runId ?? randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs (
           id, session_id, manifest_hash, manifest_json, status,
           origin, parent_run_id, created_at, started_at
         ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.manifestHash,
        JSON.stringify(input.manifest),
        input.origin ?? null,
        input.parentRunId ?? null,
        now,
        now,
      );
    return id;
  }

  /**
   * Append durable run events.
   *
   * `INSERT OR IGNORE` on a `(run_id, seq)` primary key: a re-delivered batch
   * is a no-op, which is what lets the Control Plane retry an append it is not
   * sure landed. The alternative — checking first, then inserting — has a
   * window between the two statements that a concurrent delivery can slip
   * through.
   */
  appendEvents(envelopes: readonly RunEventEnvelope[]): number {
    if (envelopes.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO run_events (run_id, seq, event_type, envelope_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const tx = this.db.transaction((batch: readonly RunEventEnvelope[]) => {
      let written = 0;
      for (const envelope of batch) {
        written += stmt.run(
          envelope.runId,
          envelope.seq,
          envelope.payload.type,
          JSON.stringify(envelope),
          now,
        ).changes;
      }
      return written;
    });
    return tx(envelopes);
  }

  /**
   * Land the run's one-shot terminal state.
   *
   * The `WHERE status = 'running'` clause IS the compare-and-set. A second
   * writer — a late `done` frame, a timeout sweep, a cancel that raced the
   * natural completion — updates zero rows instead of overwriting a decided
   * history. The return value says which happened, so the caller can log the
   * loss rather than silently believing it won.
   */
  completeRun(
    runId: string,
    terminal: RunTerminalState,
    metrics?: unknown,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs
            SET status = ?,
                terminal = ?,
                error_json = ?,
                metrics_json = ?,
                finished_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(
        terminal.status,
        terminal.status,
        terminal.status === 'failed' ? JSON.stringify(terminal.error) : null,
        metrics === undefined ? null : JSON.stringify(metrics),
        Date.now(),
        runId,
      );
    return result.changes > 0;
  }

  getRun(id: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    return row ?? null;
  }

  /** A session's runs, newest first. This is the "session as a projection of
   *  its runs" shape RFC §2 asks for, expressed as a read. */
  listRunsBySession(sessionId: string, limit = 50): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as RunRow[];
  }

  /**
   * A run's durable events from a sequence cursor.
   *
   * `afterSeq` is exclusive so a reconnecting host can pass the last seq it
   * holds and receive exactly what it is missing. This is the durable half of
   * `GET /sessions/:id/chat`'s `since` parameter, and it is keyed on
   * `(runId, seq)` rather than a session-wide counter — the collision the
   * protocol documents at `envelope.ts:14-35` cannot arise between two runs
   * because the run is part of the key.
   */
  listEvents(runId: string, afterSeq = 0, limit = 1000): RunEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(runId, afterSeq, limit) as RunEventRow[];
  }

  /** Count of stored events, for diagnostics and for the run's own metrics. */
  countEvents(runId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
      .get(runId) as { n: number };
    return row.n;
  }

  /**
   * Re-fingerprint a stored manifest and compare it with the recorded hash.
   *
   * This is the check that makes `manifest_json` worth storing. The two columns
   * are written together but verified independently: the row's `manifest_hash`
   * must equal the fingerprint of the manifest in `manifest_json`. A
   * disagreement means the row was edited after the fact, or the writer hashed
   * something other than what it stored — and both make a resume unsafe, so a
   * caller must refuse rather than proceed.
   *
   * It recomputes with the SAME function that wrote the row
   * (`manifestFingerprint`, canonical-JSON sha256). A second, locally-invented
   * hash would compare two different digests and report a mismatch for every
   * healthy row, which is worse than having no check at all.
   */
  verifyManifest(runId: string): { ok: boolean; expected: string; actual: string } | null {
    const row = this.getRun(runId);
    if (row === null) return null;
    let actual: string;
    try {
      actual = manifestFingerprint(JSON.parse(row.manifest_json) as RunManifest);
    } catch {
      // An unparseable manifest is a failed verification, not a thrown error:
      // the caller asked "is this run's record intact?" and the answer is no.
      return { ok: false, expected: row.manifest_hash, actual: '<unparseable manifest_json>' };
    }
    return { ok: row.manifest_hash === actual, expected: row.manifest_hash, actual };
  }
}
