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
 * 35, 36 and 37, measured above the current core maximum of 34. NOT 27/28: the
 * `id <= current` guard in `runMigrations` silently skipped an id that
 * collided with an already-recorded `schema_version`, and that bug shipped —
 * `session_runtime_locks.origin` was missing for a release because migration id
 * 8 was already taken (`stores.ts:449-455`). The id is chosen by measurement
 * for that reason.
 */

import { randomUUID } from 'node:crypto';
import { manifestFingerprint, type ProtocolErrorInfo, type RunEventEnvelope, type RunManifest, type RunTerminalState } from '@duya/agent-protocol';
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
  /**
   * The digest of the run's INPUT, or `null` on a row written before the
   * column existed (and by a caller that does not supply one).
   *
   * A second claim, separate from the manifest: the manifest is the frozen
   * CONFIGURATION, and this is what was actually asked for. Both have to be
   * stored, because a reused `runId` is only the same run if both agree.
   */
  input_hash: string | null;
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
  /**
   * The digest of this run's input, pinned by the same caller.
   *
   * Optional because the store does not know how to hash a host's input — it
   * is the protocol's `runInputRevision`, and the host that resolved the prompt
   * is the only side that can compute it. A caller that omits it gets a row
   * with `input_hash = null`, and can then never prove a reused `runId` is the
   * same run (see {@link RunOpenOutcome}).
   */
  readonly inputHash?: string;
  readonly origin?: RunOrigin;
  readonly parentRunId?: string;
}

/**
 * What an attempt to open a run produced.
 *
 * A discriminated union rather than the previous `string | throws`, because
 * "the row already says this" and "the row already says something ELSE" are
 * different answers to the same question and the old code answered both with
 * `existed: true`.
 */
export type RunOpenOutcome =
  /** This call inserted the row. */
  | { readonly state: 'created'; readonly runId: string }
  /** The row exists and records the SAME manifest and input. A retry. */
  | { readonly state: 'reused'; readonly runId: string; readonly row: RunRow }
  /** The row exists and records DIFFERENT content. Refused, not merged. */
  | { readonly state: 'conflict'; readonly runId: string; readonly row: RunRow; readonly reason: string };

/**
 * What a terminal compare-and-set produced.
 *
 * `completeRun` answers a boolean, which is the right answer to "did I win the
 * race" and the wrong answer to "is this run settled". A lost CAS with an
 * AGREEING terminal is a settled run; one with a DISAGREEING terminal is a lost
 * claim; and neither is "the row is gone". The three are separate states
 * because each one calls for a different action downstream.
 */
export type RunSettleOutcome =
  | { readonly state: 'applied' }
  | { readonly state: 'reconciled'; readonly committed: RunTerminalState }
  | { readonly state: 'conflict'; readonly committed: RunTerminalState }
  | { readonly state: 'absent' };

/**
 * A `(run_id, seq)` row already held a DIFFERENT envelope.
 *
 * Its own error class because it is the one append failure that is never
 * transient: re-offering the same envelope fails identically every time, so a
 * caller that retries it is burning a bounded retry on a permanent disagreement
 * about what event that sequence number was.
 */
export class RunEventConflictError extends Error {
  readonly code = 'event_content_conflict' as const;

  constructor(
    readonly runId: string,
    readonly seq: number,
  ) {
    super(
      `run ${runId} already recorded a different event at seq ${seq}: the same identity with different content is a conflict, not a retry`,
    );
    this.name = 'RunEventConflictError';
  }
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
  {
    id: 37,
    name: 'runs_input_hash',
    up: (db) => {
      // Why a second hash column at all. `manifest_hash` pins the frozen
      // CONFIGURATION, and R2.2 already computes a digest of the run's INPUT —
      // the prompt and options, which the manifest deliberately excludes so a
      // reworded message does not change a manifest's fingerprint. Without
      // this column the input digest is computed, put on the executor's
      // command, and then thrown away, so a reused `runId` can only ever be
      // checked against configuration. Two different prompts under one manifest
      // would then be indistinguishable, and "is this the same run?" would
      // silently answer yes for whichever of them arrived first.
      //
      // Nullable on purpose: rows written before this migration have no input
      // digest, and a NOT NULL column with no default would fail on every one
      // of them at boot.
      //
      // Idempotent via `PRAGMA table_info`, because SQLite cannot ADD a column
      // twice and a retried boot re-runs the whole list. Same guard as
      // `mailbox.ts:353` and `session-store.ts:188`; an unguarded ADD here
      // would be the "Duplicate core migration id" incident from
      // `stores.ts:449-455` wearing a different hat.
      const cols = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === 'input_hash')) return;
      db.exec('ALTER TABLE runs ADD COLUMN input_hash TEXT');
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
   *
   * ## Why this returns an outcome instead of an id
   *
   * A reused `runId` is a retry or a conflict, and the old code answered
   * `{ ok: true, existed: true }` to BOTH — including to a `runId` already
   * holding a different manifest, which is a caller that believes it opened a
   * run and is actually holding somebody else's. Deciding it here rather than
   * in the Control Plane is deliberate: R1.2 made this the ONE place write
   * idempotency is enforced, and a second comparison above it could disagree
   * with this one.
   */
  createRun(input: CreateRunInput): RunOpenOutcome {
    const id = input.runId ?? randomUUID();
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO runs (
             id, session_id, manifest_hash, manifest_json, status,
             input_hash, origin, parent_run_id, created_at, started_at
           ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.manifestHash,
          JSON.stringify(input.manifest),
          input.inputHash ?? null,
          input.origin ?? null,
          input.parentRunId ?? null,
          now,
          now,
        );
      return { state: 'created', runId: id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const row = this.getRun(id);
      // The row was there a moment ago and is not now. Re-reading threw nothing
      // and found nothing, so the original violation is the honest thing to
      // report; a `reused` verdict on a row that does not exist would be a
      // claim about a record nobody can find.
      if (row === null) throw error;
      return classifyReuse(id, row, input);
    }
  }

  /**
   * Append durable run events.
   *
   * ## Why this is not `INSERT OR IGNORE`
   *
   * `INSERT OR IGNORE` on a `(run_id, seq)` primary key was here, and it was
   * hiding a content conflict. A duplicate append of the SAME envelope is a
   * retry and must be a no-op, which IGNORE gives cheaply. But IGNORE cannot
   * tell that case from the one where the same `(run_id, seq)` arrives holding
   * a DIFFERENT envelope — and it reports both identically, as "zero rows
   * written". The caller therefore learned nothing from the count: a re-delivery
   * and a genuine contradiction looked the same, and the contradiction was
   * discarded rather than refused. A run whose `seq 7` says two different things
   * has no replayable transcript, and the first writer's version is the one a
   * later reader silently gets.
   *
   * So IGNORE is replaced by an explicit two-step: insert, and on a duplicate
   * READ THE ROW BACK AND COMPARE. Identical content is a retry. Anything else
   * throws {@link RunEventConflictError}.
   *
   * The comparison is on `envelope_json` alone, never on `created_at`: the
   * timestamp is this attempt's clock reading, and including it would make every
   * retry look like a conflict.
   *
   * All-or-nothing, as it already was. A batch that contains one contradicted
   * sequence rolls the whole batch back and throws, rather than writing the
   * rest and reporting a failure — a partial write plus a refusal would tell the
   * runtime a batch was lost when most of it landed, and its accounting
   * (`lostEvents += batch.length`) would then over-count.
   *
   * @returns how many rows were actually INSERTED. A full re-delivery of an
   *   already-stored batch is `0` and is not an error, which is the property
   *   the Control Plane's bounded retry depends on.
   */
  appendEvents(envelopes: readonly RunEventEnvelope[]): number {
    if (envelopes.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, envelope_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, seq) DO NOTHING`,
    );
    const readBack = this.db.prepare(
      'SELECT envelope_json FROM run_events WHERE run_id = ? AND seq = ?',
    );
    const now = Date.now();
    const tx = this.db.transaction((batch: readonly RunEventEnvelope[]) => {
      let written = 0;
      for (const envelope of batch) {
        const json = JSON.stringify(envelope);
        if (
          insert.run(
            envelope.runId,
            envelope.seq,
            envelope.payload.type,
            json,
            now,
          ).changes > 0
        ) {
          written += 1;
          continue;
        }
        // The row is already there. That is a RETRY only if it holds the very
        // envelope being offered; anything else is two different events claiming
        // one identity, and the plan requires that to be refused.
        const existing = readBack.get(envelope.runId, envelope.seq) as
          | { envelope_json: string }
          | undefined;
        if (existing === undefined || existing.envelope_json !== json) {
          throw new RunEventConflictError(envelope.runId, envelope.seq);
        }
      }
      return written;
    });
    return tx(envelopes);
  }

  /**
   * Land the run's one-shot terminal state, reconciling a lost race.
   *
   * {@link completeRun} answers "did I win the CAS", which is not the question a
   * caller has. A caller wants to know whether the run is SETTLED, and a lost
   * CAS leaves three genuinely different situations behind it:
   *
   *  - the committed terminal is the one we proposed. The run IS terminated as
   *    asked, two writers simply raced, and reporting this as a degraded run
   *    tells a host its run failed when it succeeded. `reconciled`.
   *  - the committed terminal is a DIFFERENT one. Another writer owns this run's
   *    history. `conflict` — reported, never overwritten.
   *  - there is no row at all. The write matched nothing, and no amount of
   *    retrying produces a settled run. `absent`.
   *
   * The read-back happens in this method rather than in the caller because the
   * caller cannot do it: the CAS result and the committed row are two separate
   * statements, and a caller that only saw `false` would have to open a second
   * connection to find out which of the three it is in.
   */
  settleRun(runId: string, terminal: RunTerminalState, metrics?: unknown): RunSettleOutcome {
    if (this.completeRun(runId, terminal, metrics)) return { state: 'applied' };
    const row = this.getRun(runId);
    if (row === null) return { state: 'absent' };
    const committed = readCommittedTerminal(row);
    if (committed === null) {
      // Unreachable by construction: `completeRun` matches on
      // `status = 'running'`, so a CAS that missed can only have met a row that
      // is NOT running, and every non-running status carries a terminal. It is
      // still checked rather than assumed, and it throws instead of returning a
      // fabricated verdict: inventing a `conflict` here would blame another
      // writer for a state no writer produced, and returning `applied` would
      // claim a terminal that was never read.
      throw new Error(
        `run ${runId} matched neither the running CAS nor a committed terminal (status=${row.status}, terminal=${String(row.terminal)})`,
      );
    }
    return terminalsAgree(committed, terminal)
      ? { state: 'reconciled', committed }
      : { state: 'conflict', committed };
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

/**
 * Is a duplicate `runId` the same run being retried, or a different run?
 *
 * ## Why a different input revision is a CONFLICT and not a retry
 *
 * The plan treats "same runId + same manifest" and "same runId + same input" as
 * two separate conditions, and this is the judgement between them.
 *
 * A manifest is CONFIGURATION: the model, the roots, the permissions, the
 * budget. Two starts that agree on it asked the same machinery to do the same
 * kind of work. An input revision is the CLAIM about what was asked for — the
 * prompt and options, hashed. The row can hold exactly one of them. So a
 * second start with the same manifest and a different input is not a retry of
 * the first; it is a second, different claim about a run that already has a
 * first claim, and answering `reused` would hand the caller a handle to a run
 * that executed a different prompt. That is the same false-success shape R1.1
 * removed from the result path and R1.2 removed from the write path, so it gets
 * the same treatment here: refused, loudly, with the row left untouched.
 *
 * A caller that supplies NO input hash also cannot be told `reused` when the row
 * holds one. "Unknown" is not "same", and treating it as same is precisely the
 * optimism this function exists to remove.
 */
function classifyReuse(id: string, row: RunRow, input: CreateRunInput): RunOpenOutcome {
  if (row.manifest_hash !== input.manifestHash) {
    return {
      state: 'conflict',
      runId: id,
      row,
      reason: `run ${id} is already recorded with a different manifest (${short(row.manifest_hash)}), not ${short(input.manifestHash)}`,
    };
  }
  const asked = input.inputHash ?? null;
  if (asked !== row.input_hash) {
    return {
      state: 'conflict',
      runId: id,
      row,
      reason:
        asked === null
          ? `run ${id} is already recorded with input ${short(row.input_hash)} and this caller supplied none, so "the same run" is unproven`
          : `run ${id} is already recorded with a different input (${short(row.input_hash)}), not ${short(asked)}`,
    };
  }
  return { state: 'reused', runId: id, row };
}

/**
 * The terminal a row already holds, rebuilt from its columns.
 *
 * `null` for a row that holds no terminal, which `settleRun` treats as an
 * invariant violation rather than a verdict.
 */
function readCommittedTerminal(row: RunRow): RunTerminalState | null {
  if (row.status === 'running' || row.terminal === null) return null;
  if (row.status === 'failed') {
    // The stored `error_json` is the authority when it is readable. A failure
    // row whose body is missing or corrupt is still a real committed failure,
    // so it reads back as `persistence_failed` rather than as a fabricated code
    // from whatever was parsed — the run DID fail, and "its error was
    // unreadable" is the finding, not a licence to invent the cause.
    return { status: 'failed', error: readCommittedError(row.error_json) };
  }
  if (row.status === 'completed' || row.status === 'cancelled' || row.status === 'budget_exhausted') {
    // `terminal` is written alongside `status` by the same UPDATE, so it names
    // the same arm; the guard is here because the two are separate columns and
    // a row edited by hand can disagree.
    return row.terminal === row.status ? ({ status: row.status } as RunTerminalState) : null;
  }
  return null;
}

/** The error a committed `failed` row carries, or an honest stand-in. */
function readCommittedError(errorJson: string | null): ProtocolErrorInfo {
  const fallback: ProtocolErrorInfo = {
    code: 'persistence_failed',
    message: 'this run is durably failed, but its stored error body is unreadable',
  };
  if (errorJson === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorJson);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;
  const record = parsed as { code?: unknown; message?: unknown };
  // Both fields or neither: a body with a message but no code is not a usable
  // `ProtocolErrorInfo` (the code is the whole point of knowing a run failed),
  // so it degrades to the fallback rather than being half-filled.
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return fallback;
  return { code: record.code as ProtocolErrorInfo['code'], message: record.message };
}

/**
 * Do two terminals say the same thing?
 *
 * Duplicated from `control-plane/run-receipt.ts` rather than imported, and that
 * is a real cost: the store is a `db/core` module and importing from
 * `control-plane` would be a new upward edge the architecture policy would
 * rightly question. The rule is four lines and it is asserted from both sides —
 * `run-store-idempotency.test.ts` and `run-receipt-contract.test.ts` — so a
 * change to one that is not made to the other fails a test rather than passing
 * quietly. If these two ever need to move together, the shared owner is
 * `@duya/agent-protocol`, which both already depend on.
 */
function terminalsAgree(a: RunTerminalState, b: RunTerminalState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'failed' && b.status === 'failed') {
    return a.error.code === b.error.code && a.error.message === b.error.message;
  }
  if (a.status === 'failed' || b.status === 'failed') return false;
  return a.stopReason === b.stopReason;
}

/** True when a better-sqlite3 error is a primary-key / uniqueness clash. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}

/** A hash prefix short enough for a log line, never the whole digest. */
function short(hash: string | null): string {
  if (hash === null) return '<none>';
  return hash.slice(0, 12);
}
