#!/usr/bin/env node
/**
 * reconcile-memory-state.mjs
 *
 * One-shot recovery for memory-state.db (Plan 336 Task F).
 *
 * The hung-curation-agent bug (M3 emits a `result` SSE event without
 * `message_stop`, leaving the agent's for-await loop blocked until
 * `withHardDeadline` fires 20 min later) has left `curation_runs` full of
 * `abandoned` entries and `rollout_leases` full of pre-fix `bad-job-status`
 * / `invalid-json` failures that pre-date Plan 336 Tasks E/E2.
 *
 * The MemoryWorker already calls `abandonExpiredRuns` on every cycle, so
 * orphan recovery runs continuously. This script is for:
 *
 *   1. Visibility — snapshot the DB so the user can see what's stuck where.
 *   2. Force re-extraction — clear `next_retry_at` on rollout_leases whose
 *      `last_error` was a known-now-fixed cause (`bad-job-status`,
 *      `invalid-json`, `schema-violation`) so the worker re-extracts them
 *      immediately instead of waiting out the 24h backoff (attempt 7-9).
 *      We deliberately do NOT touch `context-window-exceeded` errors
 *      (those rollouts genuinely have too much history; retrying with the
 *      same input won't help).
 *
 * Idempotent. Safe to re-run. Uses Node 22+'s built-in `node:sqlite`
 * (no ABI mismatch with Electron's better-sqlite3).
 *
 * Usage:
 *   node scripts/reconcile-memory-state.mjs                # snapshot only
 *   node scripts/reconcile-memory-state.mjs --re-extract    # also clear backoff
 *   node scripts/reconcile-memory-state.mjs --db <path>     # override
 *
 * Exit codes:
 *   0  success
 *   1  unexpected error
 *   2  database file missing
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB = path.join(
  homedir(),
  'AppData',
  'Roaming',
  'duya',
  'duya-dev',
  'databases',
  'memory-state.db',
);

// Errors that Plan 336 Tasks E/E2 fixed. Anything else is left for the
// worker to handle on its natural backoff cadence.
const REEXTRACTABLE_ERRORS = ['bad-job-status', 'invalid-json', 'schema-violation'];

function parseArgs(argv) {
  const out = { dbPath: DEFAULT_DB, reextract: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--re-extract') out.reextract = true;
    else if (a === '--db') out.dbPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/reconcile-memory-state.mjs [--re-extract] [--db <path>]',
      );
      process.exit(0);
    }
  }
  return out;
}

function snapshot(db) {
  const q = (sql) => db.prepare(sql).get();
  const all = (sql) => db.prepare(sql).all();
  return {
    curation_runs: {
      running: q("SELECT COUNT(*) AS n FROM curation_runs WHERE status='running'").n,
      failed: q("SELECT COUNT(*) AS n FROM curation_runs WHERE status='failed'").n,
      abandoned: q("SELECT COUNT(*) AS n FROM curation_runs WHERE status='abandoned'").n,
      succeeded: q("SELECT COUNT(*) AS n FROM curation_runs WHERE status='succeeded'").n,
    },
    rollout_leases: {
      failed: q("SELECT COUNT(*) AS n FROM rollout_leases WHERE job_status='failed'").n,
      retry_pending: q(
        "SELECT COUNT(*) AS n FROM rollout_leases WHERE job_status='failed' AND next_retry_at IS NOT NULL AND next_retry_at > strftime('%s','now')*1000",
      ).n,
      by_error: all(
        `SELECT last_error, COUNT(*) AS n, MAX(heartbeat_at) AS last_heartbeat
           FROM rollout_leases
          WHERE job_status = 'failed'
          GROUP BY last_error
          ORDER BY n DESC`,
      ),
    },
    stage1_outputs: {
      succeeded: q("SELECT COUNT(*) AS n FROM stage1_outputs WHERE job_status='succeeded'").n,
      succeeded_no_output: q(
        "SELECT COUNT(*) AS n FROM stage1_outputs WHERE job_status='succeeded_no_output'",
      ).n,
      latest_success_at: q(
        "SELECT MAX(generated_at) AS t FROM stage1_outputs WHERE job_status='succeeded'",
      ).t,
    },
    projection_outbox: {
      pending: q("SELECT COUNT(*) AS n FROM projection_outbox WHERE completed_at IS NULL").n,
      done: q("SELECT COUNT(*) AS n FROM projection_outbox WHERE completed_at IS NOT NULL").n,
    },
  };
}

function clearReextractableBackoff(db) {
  const placeholders = REEXTRACTABLE_ERRORS.map(() => '?').join(',');
  return db
    .prepare(
      `UPDATE rollout_leases
          SET next_retry_at = NULL,
              last_error = 'reconciled-' || last_error
        WHERE job_status = 'failed'
          AND last_error IN (${placeholders})`,
    )
    .run(...REEXTRACTABLE_ERRORS).changes;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) {
    console.error(`memory-state.db not found at ${args.dbPath}`);
    console.error('Pass --db <path> to override.');
    process.exit(2);
  }

  const db = new DatabaseSync(args.dbPath);

  console.log(`# reconcile-memory-state (${args.reextract ? 'APPLY re-extract' : 'SNAPSHOT only'})`);
  console.log(`db: ${args.dbPath}`);
  console.log(`now: ${new Date().toISOString()}\n`);

  const s = snapshot(db);
  console.log(JSON.stringify(s, null, 2));

  if (args.reextract) {
    const cleared = clearReextractableBackoff(db);
    console.log(`\ncleared_lease_backoff (${REEXTRACTABLE_ERRORS.join('/')}): ${cleared}`);
    const after = snapshot(db);
    console.log('\nafter :', JSON.stringify(after, null, 2));
  }

  db.close();
}

try {
  main();
} catch (err) {
  console.error('reconcile-memory-state failed:', err);
  process.exit(1);
}