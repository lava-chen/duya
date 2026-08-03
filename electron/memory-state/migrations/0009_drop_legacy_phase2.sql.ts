import * as crypto from 'crypto';

/**
 * Migration 0009: Drop legacy Phase 2 tables (Plan 406 Phase D).
 *
 * Design doc §3.7 step 3 + §16: after the two real consumers
 * (`extractor.queryExistingKeys` and Settings `memory:list`) have been
 * switched to read from the file manifest (Tasks 6 + 7), the
 * `memory_entries` cache, its `memory_evidence` companion, and the
 * pre-redesign `phase2_runs` ledger (migration 0005) are no longer
 * referenced by any code path. This migration drops them.
 *
 * `memory_usage_events` is NOT dropped — it remains the telemetry sink
 * for retrieval/citation events, which are still produced by the runtime
 * agent's memory read path.
 *
 * `DROP TABLE IF EXISTS` makes the migration idempotent: a fresh install
 * that never had the legacy tables (e.g. a post-Phase D rollout) applies
 * this migration as a no-op.
 *
 * Pre-conditions (enforced by the migration runner, not by SQL):
 *   - Task 6 (extractor file-manifest switch) is deployed.
 *   - Task 7 (memory:list file-manifest switch) is deployed.
 *   - Task 11 (consolidator.ts delete) is committed so no code path
 *     writes to memory_entries.
 */
const SQL = `
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS memory_evidence;
DROP TABLE IF EXISTS phase2_runs;
`;

export const migration0009 = {
  version: 9,
  name: 'drop_legacy_phase2',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};