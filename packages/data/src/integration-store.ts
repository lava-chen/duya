/**
 * integration-store.ts — the observed PR / CI / review / merge projection for
 * `duya-core.db` (plan 621, migrations 43 + 44).
 *
 * ## `integrations` is a cache; `integration_events` is the history
 *
 * `(repo, pr_number)` identifies an Integration, and GitHub is the authority
 * for everything else about it. Every column that could be mistaken for a fact
 * is therefore prefixed `observed_`, and §4.3 forbids any of them from
 * participating in a decision about writing, deleting or identity. Reading this
 * module to answer "can this checkout go away" is a contract violation, not a
 * shortcut: the row may be days old.
 *
 * The row itself is a single-line upsert: it answers "what did we last see".
 * History lives in `integration_events` (migration 44, plan 621 slice E): one
 * append-only row per OBSERVED STATE CHANGE, so §4.4's "state transitions do
 * not overwrite history" has a home. Two disciplines keep the table bounded:
 * a repeated observation of the same state appends nothing (polling must not
 * flood it), and `from_state` of the very first event is NULL — `none` is a
 * state meaning "there is no PR", which is a different fact from "we never
 * looked before".
 *
 * ## Why `integration_sessions` carries no foreign key to `sessions`
 *
 * Same reasoning as `workspace-store.ts:186-188`. A legacy import replaces
 * session rows, and a cascade would silently delete the association when that
 * happens — the PR would then look unattributed although a human already
 * recorded that this session produced it. The association is a claim about
 * history, so it outlives the row it names; a stale session id is recoverable,
 * a silently dropped association is not.
 *
 * ## Times
 *
 * `first_seen_at` is written once and never moved: it answers "when did this
 * session start contributing to this PR". `last_seen_at` only advances, so a
 * caller re-linking with an older timestamp cannot rewind it.
 */

import type { HostIntegrationState } from '@duya/agent-protocol';
import type { Migration, SqliteDatabase } from './core-database.js';

/** One observed PR. All `observed_*` columns are a cache of an external fact. */
export interface IntegrationRow {
  readonly repo: string;
  readonly pr_number: number;
  readonly observed_state: HostIntegrationState;
  readonly observed_head_sha: string | null;
  readonly observed_base_ref: string | null;
  readonly observed_url: string | null;
  /** Non-null when the last observation failed; paired with `observed_state = 'unknown'`. */
  readonly observed_error: string | null;
  readonly observed_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/** One session's contribution window on one PR. */
export interface IntegrationSessionRow {
  readonly repo: string;
  readonly pr_number: number;
  readonly session_id: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
}

/**
 * One append-only state-transition record. `from_state` is NULL for the first
 * observed state; `observed_error` is set only when `to_state` is `unknown`.
 */
export interface IntegrationEventRow {
  readonly id: number;
  readonly repo: string;
  readonly pr_number: number;
  readonly from_state: HostIntegrationState | null;
  readonly to_state: HostIntegrationState;
  readonly observed_error: string | null;
  readonly observed_at: number;
}

export interface UpsertIntegrationObservationInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly state: HostIntegrationState;
  readonly headSha?: string | null;
  readonly baseRef?: string | null;
  readonly url?: string | null;
  /** Required when `state` is `'unknown'`; must name the failure, not "error". */
  readonly observedError?: string | null;
  readonly observedAt?: number;
}

export interface LinkIntegrationSessionInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly sessionId: string;
  /** Only meaningful as an advance; a value older than `last_seen_at` is ignored. */
  readonly at?: number;
}

/** Observed-state projection over the core database. Read-mostly, non-authoritative. */
export class IntegrationStore {
  /**
   * Migrations id=43 (`integrations` + `integration_sessions`, slice B) and
   * id=44 (`integration_events`, slice E). Owned by plan 621.
   */
  static readonly migrations: Migration[] = [
    {
      id: 43,
      name: 'create_integrations',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS integrations (
            repo              TEXT NOT NULL,
            pr_number         INTEGER NOT NULL,
            observed_state    TEXT NOT NULL,
            observed_head_sha TEXT,
            observed_base_ref TEXT,
            observed_url      TEXT,
            observed_error    TEXT,
            observed_at       INTEGER NOT NULL,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            PRIMARY KEY (repo, pr_number)
          );

          -- No FK to sessions on purpose: see the module header. A legacy
          -- import replaces session rows, and a cascade there would silently
          -- drop the record that this session contributed to this PR.
          CREATE TABLE IF NOT EXISTS integration_sessions (
            repo           TEXT NOT NULL,
            pr_number      INTEGER NOT NULL,
            session_id     TEXT NOT NULL,
            first_seen_at  INTEGER NOT NULL,
            last_seen_at   INTEGER NOT NULL,
            PRIMARY KEY (repo, pr_number, session_id)
          );

          CREATE INDEX IF NOT EXISTS idx_integrations_state_observed
            ON integrations(observed_state, observed_at);
          CREATE INDEX IF NOT EXISTS idx_integration_sessions_session
            ON integration_sessions(session_id);
        `);
      },
    },
    {
      id: 44,
      name: 'create_integration_events',
      up: (db) => {
        db.exec(`
          -- Append-only transition history (plan 621 §4.4): the integrations
          -- row is a single-line upsert, so without this table every state
          -- change would overwrite the previous one. No FK to integrations:
          -- the projection can be rebuilt from GitHub, the history cannot.
          -- the projection can be rebuilt from GitHub, the history cannot.
          CREATE TABLE IF NOT EXISTS integration_events (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            repo           TEXT NOT NULL,
            pr_number      INTEGER NOT NULL,
            from_state     TEXT,
            to_state       TEXT NOT NULL,
            observed_error TEXT,
            observed_at    INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_integration_events_pr
            ON integration_events(repo, pr_number, observed_at);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  get raw(): SqliteDatabase {
    return this.db;
  }

  /**
   * Write one observation over the previous one, and append an
   * `integration_events` row when the observed state changed.
   *
   * Only `observed_*` and `updated_at` move. `created_at` is the first time
   * this PR was ever seen and is never rewritten, so "how long have we known
   * about this PR" survives a thousand re-observations. A successful
   * observation clears `observed_error`, because the previous failure is no
   * longer true of the row.
   *
   * The event append is state-change-gated (§4.4): a repeated observation of
   * the same state writes history only once, so a poller cannot flood the
   * table. A failed (`unknown`) observation is recorded like any other —
   * "we tried and could not see" is as historical as a successful read.
   */
  upsertObservation(input: UpsertIntegrationObservationInput): IntegrationRow {
    const repo = requireNonEmpty(input.repo, 'repo');
    const prNumber = requirePositiveInteger(input.prNumber, 'prNumber');
    const observedError = input.observedError ?? null;
    if (input.state === 'unknown' && (observedError === null || observedError.trim() === '')) {
      // An `unknown` row without a reason is indistinguishable from data loss
      // and cannot be shown to anyone. The contract pairs the two (§4.4).
      throw new Error('integration-store: an unknown observation requires observedError');
    }

    const now = Date.now();
    const observedAt = input.observedAt ?? now;
    // One transaction: a row without its transition (or the reverse) would be
    // a half-written history.
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO integrations (
            repo, pr_number, observed_state, observed_head_sha, observed_base_ref,
            observed_url, observed_error, observed_at, created_at, updated_at
          ) VALUES (
            @repo, @pr_number, @state, @head_sha, @base_ref,
            @url, @error, @observed_at, @created_at, @updated_at
          )
          ON CONFLICT(repo, pr_number) DO UPDATE SET
            observed_state    = excluded.observed_state,
            observed_head_sha = excluded.observed_head_sha,
            observed_base_ref = excluded.observed_base_ref,
            observed_url      = excluded.observed_url,
            observed_error    = excluded.observed_error,
            observed_at       = excluded.observed_at,
            updated_at        = excluded.updated_at`,
        )
        .run({
          repo,
          pr_number: prNumber,
          state: input.state,
          head_sha: input.headSha ?? null,
          base_ref: input.baseRef ?? null,
          url: input.url ?? null,
          error: observedError,
          observed_at: observedAt,
          created_at: now,
          updated_at: now,
        });

      const last = this.db
        .prepare(
          `SELECT to_state FROM integration_events
           WHERE repo = ? AND pr_number = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(repo, prNumber) as { to_state: HostIntegrationState } | undefined;
      if (last === undefined || last.to_state !== input.state) {
        this.db
          .prepare(
            `INSERT INTO integration_events (
              repo, pr_number, from_state, to_state, observed_error, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(repo, prNumber, last?.to_state ?? null, input.state, observedError, observedAt);
      }
    });
    write();
    return this.get(repo, prNumber)!;
  }

  get(repo: string, prNumber: number): IntegrationRow | null {
    if (!repo || !Number.isSafeInteger(prNumber)) return null;
    const row = this.db
      .prepare('SELECT * FROM integrations WHERE repo = ? AND pr_number = ?')
      .get(repo, prNumber) as IntegrationRow | undefined;
    return row ?? null;
  }

  /**
   * Every PR this session is associated with, oldest observation first.
   *
   * Reads `integration_sessions` (the association) and not any session column:
   * the link is written explicitly, because "this session produced that PR" is
   * not derivable from a session row.
   */
  listForSession(sessionId: string): IntegrationRow[] {
    if (!sessionId) return [];
    return this.db
      .prepare(
        `SELECT i.* FROM integrations i
         JOIN integration_sessions s
           ON s.repo = i.repo AND s.pr_number = i.pr_number
         WHERE s.session_id = ?
         ORDER BY i.observed_at, i.repo, i.pr_number`,
      )
      .all(sessionId) as IntegrationRow[];
  }

  /**
   * The state-transition history of one PR, newest first.
   *
   * Reads `integration_events` only: this is history, never the current
   * answer — "what is the state now" belongs to `get` / the `observed_*` row.
   */
  listEvents(repo: string, prNumber: number, limit = 50): IntegrationEventRow[] {
    if (!repo || !Number.isSafeInteger(prNumber)) return [];
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
    return this.db
      .prepare(
        `SELECT * FROM integration_events
         WHERE repo = ? AND pr_number = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(repo, prNumber, bounded) as IntegrationEventRow[];
  }

  /**
   * Record that a session contributed to a PR. Idempotent: a repeat link keeps
   * `first_seen_at` and only advances `last_seen_at`.
   */
  linkSession(input: LinkIntegrationSessionInput): IntegrationSessionRow {
    const repo = requireNonEmpty(input.repo, 'repo');
    const prNumber = requirePositiveInteger(input.prNumber, 'prNumber');
    const sessionId = requireNonEmpty(input.sessionId, 'sessionId');
    const at = input.at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO integration_sessions (
          repo, pr_number, session_id, first_seen_at, last_seen_at
        ) VALUES (
          @repo, @pr_number, @session_id, @at, @at
        )
        ON CONFLICT(repo, pr_number, session_id) DO UPDATE SET
          last_seen_at = MAX(integration_sessions.last_seen_at, excluded.last_seen_at)`,
      )
      .run({ repo, pr_number: prNumber, session_id: sessionId, at });
    return this.getSessionLink(repo, prNumber, sessionId)!;
  }

  /** Sessions associated with one PR, earliest contribution first. */
  listSessionsFor(repo: string, prNumber: number): IntegrationSessionRow[] {
    if (!repo || !Number.isSafeInteger(prNumber)) return [];
    return this.db
      .prepare(
        `SELECT * FROM integration_sessions
         WHERE repo = ? AND pr_number = ?
         ORDER BY first_seen_at, session_id`,
      )
      .all(repo, prNumber) as IntegrationSessionRow[];
  }

  private getSessionLink(repo: string, prNumber: number, sessionId: string): IntegrationSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM integration_sessions
         WHERE repo = ? AND pr_number = ? AND session_id = ?`,
      )
      .get(repo, prNumber, sessionId) as IntegrationSessionRow | undefined;
    return row ?? null;
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`integration-store: ${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`integration-store: ${field} must be a positive integer`);
  }
  return value;
}
