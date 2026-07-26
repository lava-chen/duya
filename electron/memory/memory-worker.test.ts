/**
 * Unit tests for memory-worker (Plan 305 Phase A).
 *
 * Covers lifecycle: pause/resume, singleton, forceSweep on empty set,
 * paused-tick skip, and shutdown while extract in flight.
 *
 * Uses the shared memory-state fixture (migrations 0001-0003 applied)
 * plus a stub main DB and mock LLM. No real LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
// The root node_modules/better-sqlite3 may be compiled for a different
// Node ABI than the running test runner. The agent workspace ships its
// own better-sqlite3 build; load it explicitly so the test is stable.
import { createRequire } from 'module';
const agentRequire = createRequire(
  path.resolve(__dirname, '../../packages/agent/package.json'),
);
const Database = agentRequire('better-sqlite3') as typeof import('better-sqlite3');
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { LLMClient } from '../../packages/agent/src/llm/base.js';
import {
  startMemoryWorker,
  getMemoryWorkerHandle,
  _resetMemoryWorkerForTesting,
  type MemoryWorkerDeps,
} from './memory-worker';
import { drainOutbox } from '../../packages/agent/src/memory-state/outbox.js';
import {
  deriveRolloutSummaryFilename,
  type Stage1OutputRow,
} from '../../packages/agent/src/memory-state/projectionContent.js';
import { migration0001 } from '../memory-state/migrations/0001_init.sql';
import { migration0002 } from '../memory-state/migrations/0002_lease_stage1.sql';
import { migration0003 } from '../memory-state/migrations/0003_outbox.sql';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface WorkerFixture {
  memoryDb: BetterSqlite3Database;
  mainDb: BetterSqlite3Database;
  memoryRoot: string;
  dbDir: string;
  llmClient: LLMClient;
  cleanup: () => void;
}

function createWorkerFixture(): WorkerFixture {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-db-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-root-'));
  const memoryDb = new Database(path.join(dbDir, 'memory-state.db'));
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');
  memoryDb.pragma('busy_timeout = 5000');
  memoryDb.exec(migration0001.sql);
  memoryDb.exec(migration0002.sql);
  memoryDb.exec(migration0003.sql);

  // Stub main DB — only needs a `messages` table for the extractor's
  // readMessages path. Most tests never hit it.
  const mainDb = new Database(path.join(dbDir, 'main.db'));
  mainDb.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_input TEXT,
      msg_type TEXT,
      seq_index INTEGER,
      created_at INTEGER,
      status TEXT
    );
  `);

  const llmClient: LLMClient = {
    streamChat: vi.fn().mockImplementation(async function* () {
      // Stub — worker never streams; it only uses chat().
    }),
    chat: vi.fn().mockResolvedValue({ content: '{"job_status":"succeeded_no_output","rollout_slug":"noop-test"}' }),
  };

  return {
    memoryDb,
    mainDb,
    memoryRoot,
    dbDir,
    llmClient,
    cleanup: () => {
      try {
        memoryDb.close();
      } catch {
        // already closed
      }
      try {
        mainDb.close();
      } catch {
        // already closed
      }
      for (const dir of [dbDir, memoryRoot]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    },
  };
}

function toDeps(f: WorkerFixture): MemoryWorkerDeps {
  return {
    memoryDb: f.memoryDb,
    mainDb: f.mainDb,
    llmClient: f.llmClient,
    rootDir: f.memoryRoot,
  };
}

function insertEligibleRollout(
  db: BetterSqlite3Database,
  overrides: Partial<{
    rollout_id: string;
    last_message_at: number;
    source_fingerprint: string;
  }> = {},
): string {
  const rolloutId = overrides.rollout_id ?? crypto.randomUUID();
  const now = Date.now();
  // last_message_at must be older than idleMs (6h default) to be eligible.
  const lastMessageAt = overrides.last_message_at ?? now - 7 * 3600 * 1000;
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
    'global',
    null,
    'main',
    null,
    null,
    '/tmp/workspace',
    '/tmp/workspace',
    null,
    null,
    1,
    null,
    lastMessageAt,
    'active',
    null,
    null,
    0,
    overrides.source_fingerprint ?? 'fp-test',
    now,
    now,
  );
  return rolloutId;
}

// `crypto` is imported at the top of the file.

/**
 * Insert a stage1_outputs row directly (bypasses the extractor). Used
 * for reconcile tests where we need DB rows but NOT eligible rollouts
 * (no rollout_catalog entry → selectEligible returns []).
 */
function insertStage1Output(
  db: BetterSqlite3Database,
  overrides: Partial<Stage1OutputRow> = {},
): Stage1OutputRow {
  const now = Date.now();
  const row: Stage1OutputRow = {
    rollout_id: overrides.rollout_id ?? crypto.randomUUID(),
    thread_id: overrides.thread_id ?? `thread-${crypto.randomUUID().slice(0, 8)}`,
    cwd: overrides.cwd ?? '/tmp/workspace',
    project_id: overrides.project_id ?? crypto.randomUUID(),
    git_branch: overrides.git_branch ?? null,
    job_status: overrides.job_status ?? 'succeeded',
    content_outcome: overrides.content_outcome ?? 'success',
    rollout_summary: overrides.rollout_summary ?? 'Test rollout summary body.',
    raw_memory: overrides.raw_memory ?? null,
    rollout_slug: overrides.rollout_slug ?? 'test-rollout',
    generated_at: overrides.generated_at ?? now,
    source_updated_at: overrides.source_updated_at ?? now,
    source_content_hash: overrides.source_content_hash ?? 'sha256-test-hash',
    extracted_through_seq: overrides.extracted_through_seq ?? null,
    output_updated_at: overrides.output_updated_at ?? now,
    schema_version: overrides.schema_version ?? 2,
    content_hash_at_write: overrides.content_hash_at_write ?? null,
  };
  db.prepare(
    `INSERT INTO stage1_outputs (
      rollout_id, thread_id, cwd, project_id, git_branch,
      job_status, content_outcome, rollout_summary, raw_memory,
      rollout_slug, generated_at, source_updated_at, source_content_hash,
      extracted_through_seq, output_updated_at, schema_version, content_hash_at_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.rollout_id,
    row.thread_id,
    row.cwd,
    row.project_id,
    row.git_branch,
    row.job_status,
    row.content_outcome,
    row.rollout_summary,
    row.raw_memory,
    row.rollout_slug,
    row.generated_at,
    row.source_updated_at,
    row.source_content_hash,
    row.extracted_through_seq,
    row.output_updated_at,
    row.schema_version,
    row.content_hash_at_write,
  );
  return row;
}

/**
 * Create a file under memoryRoot that looks like a D11 projection file
 * (matches the filename grammar) but does NOT map to any DB row.
 */
function createOrphanSummaryFile(memoryRoot: string, filename: string): string {
  const summariesDir = path.join(memoryRoot, 'rollout_summaries');
  fs.mkdirSync(summariesDir, { recursive: true });
  const filePath = path.join(summariesDir, filename);
  fs.writeFileSync(filePath, '---\norphan: true\n---\n\nstale content', 'utf8');
  return filePath;
}

/**
 * Force-drain the outbox by passing a future `now`, bypassing the
 * 1-second ENQUEUE_DELAY_MS. Used in tests to drain immediately after
 * reconcile enqueues rows.
 */
function forceDrainOutbox(
  db: BetterSqlite3Database,
  memoryRoot: string,
): number {
  return drainOutbox(db, {
    batchSize: 64,
    now: Date.now() + 10_000,
    allowedRoots: [memoryRoot],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory-worker (Plan 305 Phase A)', () => {
  let fixture: WorkerFixture;

  beforeEach(() => {
    fixture = createWorkerFixture();
  });

  afterEach(() => {
    const h = getMemoryWorkerHandle();
    if (h) {
      // shutdown is async but we don't need to wait in teardown
      void h.shutdown();
    }
    _resetMemoryWorkerForTesting();
    fixture.cleanup();
  });

  it('1. start then pause then resume — isPaused reflects state', () => {
    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      sweepOutboxEveryMs: 60_000,
      reconcileOnStart: false,
      paused: false,
    });
    expect(h.isPaused()).toBe(false);
    h.pause();
    expect(h.isPaused()).toBe(true);
    h.resume();
    expect(h.isPaused()).toBe(false);
  });

  it('2. two startMemoryWorker calls return the same handle', () => {
    const h1 = startMemoryWorker(toDeps(fixture), { instancesPerMinute: 1 });
    const h2 = startMemoryWorker(toDeps(fixture), { instancesPerMinute: 60 });
    expect(h2).toBe(h1);
    // Same workerId proves identity.
    expect(h2.workerId).toBe(h1.workerId);
  });

  it('3. forceSweep on empty eligible set returns zero counts', async () => {
    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
    });
    const result = await h.forceSweep();
    expect(result.selected).toBe(0);
    expect(result.extracted).toBe(0);
    expect(result.skippedNoop).toBe(0);
    // Outbox may drain 0 rows on a fresh DB.
    expect(result.outboxDrained).toBe(0);
    // No reconcile ran (reconcileOnStart=false AND forceSweep should still
    // run reconcile on first force — but we passed reconcileOnStart:false,
    // so reconcile is skipped entirely).
    expect(result.reconciled).toBeNull();
  });

  it('4. paused worker skips interval ticks (forceSweep still works)', async () => {
    // Use a fast tick so we'd see a tick within the test window if it
    // weren't paused.
    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 600, // 10 ticks/sec
      concurrency: 1,
      reconcileOnStart: false,
      paused: true,
    });
    expect(h.isPaused()).toBe(true);

    // Wait long enough that several interval ticks would have fired.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // LLM should never have been called (no ticks, no extracts).
    expect(fixture.llmClient.chat).not.toHaveBeenCalled();

    // forceSweep ignores pause and still returns a valid (empty) result.
    const result = await h.forceSweep();
    expect(result.selected).toBe(0);

    // forceSweep on an empty eligible set still does not call the LLM.
    expect(fixture.llmClient.chat).not.toHaveBeenCalled();
  });

  it('5. shutdown while extract in flight finishes cleanly', async () => {
    // Plant one eligible rollout.
    insertEligibleRollout(fixture.memoryDb);

    // LLM hangs until we release the gate, simulating an in-flight extract.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    (fixture.llmClient.chat as ReturnType<typeof vi.fn>).mockImplementation(() =>
      gate.then(() => ({
        content: '{"job_status":"succeeded_no_output","rollout_slug":"shutdown-test"}',
      })),
    );

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
    });

    // Kick off an extract via forceSweep (do not await).
    const sweepPromise = h.forceSweep();

    // Give the extract a moment to enter the LLM call.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Initiate shutdown — should wait for the in-flight extract.
    const shutdownPromise = h.shutdown();

    // Release the LLM gate so the extract completes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseGate();

    // Both should resolve without throwing.
    await Promise.all([sweepPromise, shutdownPromise]);

    // After shutdown, the handle is still present but timers are cleared;
    // a second shutdown should be a no-op (no throw).
    await expect(h.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase C: outbox sweeper tick + startup reconcile
// ---------------------------------------------------------------------------

describe('memory-worker (Plan 305 Phase C — reconcile + outbox sweeper)', () => {
  let fixture: WorkerFixture;

  beforeEach(() => {
    fixture = createWorkerFixture();
  });

  afterEach(() => {
    const h = getMemoryWorkerHandle();
    if (h) {
      void h.shutdown();
    }
    _resetMemoryWorkerForTesting();
    fixture.cleanup();
  });

  it('1. first startup with empty memory dir — 0 written, 0 removed, 0 mismatched', async () => {
    // Empty DB + empty filesystem → reconcile has nothing to write or remove.
    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: true,
    });

    const result = await h.forceSweep();

    expect(result.reconciled).not.toBeNull();
    expect(result.reconciled!.written).toBe(0);
    expect(result.reconciled!.removed).toBe(0);
    expect(result.reconciled!.mismatched).toBe(0);

    // No projection files should exist.
    const summariesDir = path.join(fixture.memoryRoot, 'rollout_summaries');
    expect(fs.existsSync(summariesDir)).toBe(false);
    expect(fs.existsSync(path.join(fixture.memoryRoot, 'raw_memories.md'))).toBe(false);
  });

  it('2. first startup with DB rows but missing files — writes summaries + raw_memories.md', async () => {
    // Plant one stage1_outputs row (no rollout_catalog entry → not eligible
    // for extraction, so reconcile runs in isolation).
    const row = insertStage1Output(fixture.memoryDb);

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: true,
    });

    const result = await h.forceSweep();

    // Reconcile should plan 2 writes: 1 summary file + 1 raw_memories.md.
    expect(result.reconciled).not.toBeNull();
    expect(result.reconciled!.written).toBe(2);
    expect(result.reconciled!.removed).toBe(0);
    expect(result.reconciled!.mismatched).toBe(0);

    // The outbox has a 1-second ENQUEUE_DELAY_MS, so the drain inside
    // forceSweep did NOT write files yet. Force-drain with a future now.
    const drained = forceDrainOutbox(fixture.memoryDb, fixture.memoryRoot);
    expect(drained).toBe(2);

    // Verify the summary file exists with the D11 filename shape.
    const summariesDir = path.join(fixture.memoryRoot, 'rollout_summaries');
    expect(fs.existsSync(summariesDir)).toBe(true);
    const files = fs.readdirSync(summariesDir);
    expect(files.length).toBe(1);
    const expectedFilename = deriveRolloutSummaryFilename(row);
    expect(files[0]).toBe(expectedFilename);

    // Verify raw_memories.md exists and contains the thread entry.
    const rawPath = path.join(fixture.memoryRoot, 'raw_memories.md');
    expect(fs.existsSync(rawPath)).toBe(true);
    const rawContent = fs.readFileSync(rawPath, 'utf8');
    expect(rawContent).toContain(`## Thread ${row.thread_id}`);
    expect(rawContent).toContain(`rollout_id: ${row.rollout_id}`);
  });

  it('3. first startup with orphan files — 0 written, M removed', async () => {
    // Empty DB + orphan summary file on disk → reconcile enqueues delete.
    // Use a shortid that won't match any rollout_id (DB is empty).
    const orphanFilename = '2026-01-01T00-00-00-deadbeef-orphan-test.md';
    const orphanPath = createOrphanSummaryFile(fixture.memoryRoot, orphanFilename);
    expect(fs.existsSync(orphanPath)).toBe(true);

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: true,
    });

    const result = await h.forceSweep();

    // Reconcile should plan 1 removal (the orphan file).
    expect(result.reconciled).not.toBeNull();
    expect(result.reconciled!.written).toBe(0);
    expect(result.reconciled!.removed).toBe(1);
    expect(result.reconciled!.mismatched).toBe(0);

    // Force-drain to actually delete the file.
    const drained = forceDrainOutbox(fixture.memoryDb, fixture.memoryRoot);
    expect(drained).toBe(1);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it('4. second startup (idempotent) — 0 written, 0 removed', async () => {
    // Plant a row, run first sweep + drain to write files, then run a
    // second sweep to verify reconcile finds everything in sync.
    insertStage1Output(fixture.memoryDb);

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: true,
    });

    // First sweep: enqueues 2 writes (summary + raw_memories.md).
    const first = await h.forceSweep();
    expect(first.reconciled!.written).toBe(2);

    // Drain to write files to disk.
    forceDrainOutbox(fixture.memoryDb, fixture.memoryRoot);

    // Second sweep: DB and disk are now in sync → 0 writes, 0 removes.
    // The worker's `reconciledThisInstance` flag is already true, so we
    // reset it by shutting down and starting a fresh worker (simulating
    // a process restart).
    await h.shutdown();
    _resetMemoryWorkerForTesting();

    const h2 = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: true,
    });

    const second = await h2.forceSweep();
    expect(second.reconciled).not.toBeNull();
    expect(second.reconciled!.written).toBe(0);
    expect(second.reconciled!.removed).toBe(0);
    expect(second.reconciled!.mismatched).toBe(0);

    // Outbox should have no pending rows.
    const pending = fixture.memoryDb
      .prepare('SELECT COUNT(*) as n FROM projection_outbox WHERE completed_at IS NULL')
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });
});
