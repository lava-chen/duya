import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

// Test-only import of the authoritative migration DDL. The migration
// `.sql.ts` files import nothing but `crypto`, so pulling them across
// the package boundary is safe in vitest (production code in
// packages/agent MUST NOT import from electron/).
import { migration0001 } from '../../../../../electron/memory-state/migrations/0001_init.sql';
import { migration0002 } from '../../../../../electron/memory-state/migrations/0002_lease_stage1.sql';
import { migration0003 } from '../../../../../electron/memory-state/migrations/0003_outbox.sql';

/**
 * Shared test fixture for packages/agent memory-state modules
 * (lease / eligibility / outbox / reconcile).
 *
 * Each fixture creates:
 *   - a file-based temp SQLite DB with migrations 0001-0003 applied
 *     (file-based, not `:memory:`, so WAL mode and cross-handle
 *     concurrency behave like production)
 *   - a temp directory standing in for `~/.duya/memory` so outbox /
 *     reconcile tests can exercise the path allowlist without touching
 *     the real home directory
 */
export interface MemoryStateFixture {
  db: BetterSqlite3Database;
  /** Temp dir holding memory-state.db (including WAL sidecars). */
  dbDir: string;
  /** Temp dir used as the projection root (stands in for ~/.duya/memory). */
  memoryRoot: string;
  cleanup: () => void;
}

export function createMemoryStateFixture(): MemoryStateFixture {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-state-db-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-root-'));
  const db = new Database(path.join(dbDir, 'memory-state.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(migration0001.sql);
  db.exec(migration0002.sql);
  db.exec(migration0003.sql);
  return {
    db,
    dbDir,
    memoryRoot,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      for (const dir of [dbDir, memoryRoot]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup — OS temp dir reaper handles the rest.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Row insert helpers (defaults keep tests terse; override per scenario)
// ---------------------------------------------------------------------------

let catalogCounter = 0;

export interface CatalogRowOverrides {
  rollout_id?: string;
  scope_kind?: 'global' | 'project';
  project_id?: string | null;
  agent_type?: string;
  parent_id?: string | null;
  mode?: string | null;
  working_directory?: string | null;
  message_count?: number;
  last_message_id?: string | null;
  last_message_at?: number | null;
  source_status?: 'active' | 'deleted' | 'missing';
  source_fingerprint?: string | null;
  last_seen_at?: number;
  first_seen_at?: number;
}

export function insertCatalogRow(db: BetterSqlite3Database, overrides: CatalogRowOverrides = {}): string {
  catalogCounter += 1;
  const now = Date.now();
  const rolloutId = overrides.rollout_id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO rollout_catalog (
      rollout_id, scope_kind, project_id, agent_type, parent_id, mode,
      working_directory, working_directory_normalized, git_root,
      agent_profile_id, message_count, last_message_id, last_message_at,
      source_status, source_missing_at, source_deleted_at, generation,
      source_fingerprint, last_seen_at, first_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rolloutId,
    overrides.scope_kind ?? 'global',
    overrides.project_id ?? null,
    overrides.agent_type ?? 'main',
    overrides.parent_id ?? null,
    overrides.mode ?? null,
    overrides.working_directory ?? null,
    overrides.working_directory ?? null,
    null,
    null,
    overrides.message_count ?? 10,
    overrides.last_message_id ?? null,
    overrides.last_message_at ?? now,
    overrides.source_status ?? 'active',
    null,
    null,
    0,
    overrides.source_fingerprint ?? `fp-${catalogCounter}`,
    overrides.last_seen_at ?? now,
    overrides.first_seen_at ?? now
  );
  return rolloutId;
}

export interface Stage1OutputOverrides {
  rollout_id?: string;
  thread_id?: string;
  cwd?: string;
  project_id?: string;
  git_branch?: string | null;
  job_status?: 'succeeded' | 'succeeded_no_output';
  content_outcome?: 'success' | 'partial' | 'fail' | 'uncertain' | null;
  rollout_summary?: string | null;
  raw_memory?: string | null;
  rollout_slug?: string;
  generated_at?: number;
  source_updated_at?: number;
  source_content_hash?: string;
  extracted_through_seq?: number | null;
  output_updated_at?: number;
  content_hash_at_write?: string | null;
  schema_version?: number;
}

export function insertStage1Output(db: BetterSqlite3Database, overrides: Stage1OutputOverrides = {}): string {
  const now = Date.now();
  const rolloutId = overrides.rollout_id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO stage1_outputs (
      rollout_id, thread_id, cwd, project_id, git_branch,
      job_status, content_outcome, rollout_summary, raw_memory,
      rollout_slug, generated_at, source_updated_at, source_content_hash,
      extracted_through_seq, output_updated_at, schema_version,
      content_hash_at_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rolloutId,
    overrides.thread_id ?? rolloutId,
    overrides.cwd ?? '/tmp/workspace',
    overrides.project_id ?? 'global',
    overrides.git_branch ?? null,
    overrides.job_status ?? 'succeeded',
    overrides.content_outcome ?? 'success',
    overrides.rollout_summary ?? '# Summary\n\nbody',
    overrides.raw_memory ?? null,
    overrides.rollout_slug ?? 'test-slug',
    overrides.generated_at ?? now,
    overrides.source_updated_at ?? now,
    overrides.source_content_hash ?? 'hash',
    overrides.extracted_through_seq ?? null,
    overrides.output_updated_at ?? now,
    overrides.schema_version ?? 2,
    overrides.content_hash_at_write ?? null
  );
  return rolloutId;
}
