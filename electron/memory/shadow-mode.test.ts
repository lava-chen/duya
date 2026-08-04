/**
 * Shadow-mode e2e suite (Plan 305 Phase D).
 *
 * Tests the full pipeline through the worker: catalog → eligibility →
 * extract (mock LLM) → stage1_outputs → projection outbox → files.
 * Verifies the D1 shadow-mode contract: v2 writes NEVER reach the
 * existing MemoryManager path or the global/projects projection dirs.
 *
 * Uses a MockLLMClient so tests run in CI without API cost.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { createRequire } from 'module';

// The root node_modules/better-sqlite3 may be compiled for a different
// Node ABI than the test runner. The agent workspace ships its own
// better-sqlite3 build; load it explicitly so the test is stable.
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
import { acquireLease } from '../../packages/agent/src/memory-state/lease.js';
import {
  deriveRolloutSummaryFilename,
} from '../../packages/agent/src/memory-state/projectionContent.js';
import { migration0001 } from '../memory-state/migrations/0001_init.sql';
import { migration0002 } from '../memory-state/migrations/0002_lease_stage1.sql';
import { migration0003 } from '../memory-state/migrations/0003_outbox.sql';
import { migration0005 } from '../memory-state/migrations/0005_phase2.sql';
import { migration0008 } from '../memory-state/migrations/0008_curation_runs.sql';

// ---------------------------------------------------------------------------
// LLM response templates
// ---------------------------------------------------------------------------

const LLM_RESPONSE_SUCCEEDED = JSON.stringify({
  job_status: 'succeeded',
  content_outcome: 'success',
  rollout_summary: 'User discussed a feature and modified a file.',
  rollout_slug: 'feature-discussion',
  raw_memory: {
    items: [
      {
        claim: 'User prefers tabs over spaces for indentation',
        claim_type: 'preference',
        scope: 'global',
        scope_id: null,
        evidence: [
          {
            source_type: 'user_message',
            source_id: 'msg-001',
            verification: 'observed',
          },
        ],
        canonical_key: 'preference:indentation-style',
        confidence: 'high',
        status: 'active',
        valid_from: null,
        valid_until: null,
        relation_to_existing: null,
        supersedes: [],
        why_future_agent_needs_this:
          'A future agent would otherwise guess the indentation style.',
        retrieval_cues: ['tabs', 'spaces', 'indentation'],
      },
    ],
  },
});

const LLM_RESPONSE_NO_OUTPUT = JSON.stringify({
  job_status: 'succeeded_no_output',
  content_outcome: null,
  rollout_summary: '',
  rollout_slug: 'noop-session',
  raw_memory: { items: [] },
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface ShadowFixture {
  memoryDb: BetterSqlite3Database;
  mainDb: BetterSqlite3Database;
  memoryRoot: string;
  dbDir: string;
  llmClient: LLMClient;
  cleanup: () => void;
}

function createShadowFixture(
  llmResponse: string = LLM_RESPONSE_SUCCEEDED,
  llmError?: Error,
): ShadowFixture {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-mode-db-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-mode-root-'));
  const memoryDb = new Database(path.join(dbDir, 'memory-state.db'));
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');
  memoryDb.pragma('busy_timeout = 5000');
  memoryDb.exec(migration0001.sql);
  memoryDb.exec(migration0002.sql);
  memoryDb.exec(migration0003.sql);
  memoryDb.exec(migration0005.sql);
  memoryDb.exec(migration0008.sql);

  // Stub main DB with messages table (what the extractor reads) and
  // chat_sessions table (what catalog sync reads).
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
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      model TEXT,
      system_prompt TEXT,
      working_directory TEXT,
      project_name TEXT,
      status TEXT,
      mode TEXT,
      permission_profile TEXT,
      provider_id TEXT,
      context_summary TEXT,
      context_summary_updated_at INTEGER,
      is_deleted INTEGER,
      generation INTEGER,
      agent_profile_id TEXT,
      parent_id TEXT,
      agent_type TEXT,
      agent_name TEXT,
      conductor_mode_enabled INTEGER,
      conductor_canvas_id TEXT
    );
  `);

  const llmClient: LLMClient = {
    streamChat: llmError
      ? vi.fn().mockImplementation(async function* () {
          throw llmError;
        })
      : vi.fn().mockImplementation(async function* () {
          yield { type: 'text', data: llmResponse };
          yield { type: 'done' };
        }),
    chat: llmError
      ? vi.fn().mockRejectedValue(llmError)
      : vi.fn().mockResolvedValue({ content: llmResponse }),
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

function toDeps(f: ShadowFixture): MemoryWorkerDeps {
  return {
    memoryDb: f.memoryDb,
    mainDb: f.mainDb,
    llmClient: f.llmClient,
    rootDir: f.memoryRoot,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertCatalogRow(
  db: BetterSqlite3Database,
  overrides: Partial<{
    rollout_id: string;
    last_message_at: number;
    source_fingerprint: string;
    agent_type: string;
    mode: string | null;
    source_status: string;
  }> = {},
): string {
  const rolloutId = overrides.rollout_id ?? crypto.randomUUID();
  const now = Date.now();
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
    overrides.agent_type ?? 'main',
    null,
    overrides.mode ?? null,
    '/tmp/workspace',
    '/tmp/workspace',
    null,
    null,
    10,
    null,
    lastMessageAt,
    overrides.source_status ?? 'active',
    null,
    null,
    0,
    overrides.source_fingerprint ?? 'fp-test-1',
    now,
    now,
  );
  return rolloutId;
}

function insertMessage(
  db: BetterSqlite3Database,
  sessionId: string,
  role: string,
  content: string,
  seqIndex: number = 0,
): string {
  const msgId = `msg-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, seq_index, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(msgId, sessionId, role, content, seqIndex, Date.now(), 'complete');
  // Insert filler messages so message_count >= minMessageCount (6).
  // Catalog sync recomputes message_count from actual messages, so the
  // value set in insertCatalogRow is overwritten.
  for (let i = 1; i < 10; i++) {
    const fillerId = `msg-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, seq_index, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(fillerId, sessionId, 'user', `filler ${i}`, seqIndex + i, Date.now() + i, 'complete');
  }
  return msgId;
}

function forceDrainOutbox(db: BetterSqlite3Database, memoryRoot: string): number {
  return drainOutbox(db, {
    batchSize: 64,
    now: Date.now() + 10_000,
    allowedRoots: [memoryRoot],
  });
}

function getStage1Output(
  db: BetterSqlite3Database,
  rolloutId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT * FROM stage1_outputs WHERE rollout_id = ?')
    .get(rolloutId) as Record<string, unknown> | undefined;
}

function getLease(
  db: BetterSqlite3Database,
  rolloutId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT * FROM rollout_leases WHERE rollout_id = ?')
    .get(rolloutId) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shadow-mode e2e (Plan 305 Phase D)', () => {
  let fixture: ShadowFixture;

  beforeEach(() => {
    fixture = createShadowFixture();
  });

  afterEach(() => {
    const h = getMemoryWorkerHandle();
    if (h) {
      void h.shutdown();
    }
    _resetMemoryWorkerForTesting();
    fixture.cleanup();
  });

  it('1. fresh DB, empty eligible set — tick returns 0', async () => {
    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 2,
      reconcileOnStart: false,
      idleMs: 1,
    });

    const result = await h.forceSweep();
    expect(result.selected).toBe(0);
    expect(result.extracted).toBe(0);
  });

  it('2. insert 1 rollout; tick — selects 1, extracts, writes stage1_outputs', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'I prefer tabs over spaces.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    const result = await h.forceSweep();
    expect(result.selected).toBe(1);
    expect(result.extracted).toBe(1);

    // stage1_outputs has 1 row with succeeded status.
    const output = getStage1Output(fixture.memoryDb, rolloutId);
    expect(output).toBeDefined();
    expect(output!.job_status).toBe('succeeded');
    expect(output!.content_outcome).toBe('success');
    expect(output!.rollout_summary).toBe('User discussed a feature and modified a file.');

    // LLM was called exactly once.
    expect(fixture.llmClient.streamChat).toHaveBeenCalledTimes(1);
  });

  it('3. after extraction, tick again — idempotent (0 selected)', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Hello world.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    // First sweep extracts.
    const first = await h.forceSweep();
    expect(first.selected).toBe(1);
    expect(first.extracted).toBe(1);

    // Second sweep: rollout now has succeeded output → not eligible.
    const second = await h.forceSweep();
    expect(second.selected).toBe(0);
    expect(second.extracted).toBe(0);

    // LLM called only once (first sweep).
    expect(fixture.llmClient.streamChat).toHaveBeenCalledTimes(1);
  });

  it('4. bump source_fingerprint — re-eligible with new output_updated_at', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb, {
      source_fingerprint: 'fp-v1',
    });
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Original message.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    // First extraction.
    await h.forceSweep();
    const firstOutput = getStage1Output(fixture.memoryDb, rolloutId);
    expect(firstOutput).toBeDefined();
    const firstUpdatedAt = firstOutput!.output_updated_at as number;

    // Bump fingerprint → source drift → re-eligible.
    fixture.memoryDb
      .prepare('UPDATE rollout_catalog SET source_fingerprint = ? WHERE rollout_id = ?')
      .run('fp-v2', rolloutId);

    // Wait a bit so output_updated_at can advance.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await h.forceSweep();
    expect(second.selected).toBe(1);
    expect(second.extracted).toBe(1);

    const secondOutput = getStage1Output(fixture.memoryDb, rolloutId);
    expect(secondOutput).toBeDefined();
    expect(secondOutput!.output_updated_at as number).toBeGreaterThan(firstUpdatedAt);
    expect(secondOutput!.source_content_hash).toBe('fp-v2');
  });

  it('5. LLM returns succeeded_no_output — content_outcome=NULL, empty body', async () => {
    // Recreate fixture with no-output LLM response.
    fixture.cleanup();
    fixture = createShadowFixture(LLM_RESPONSE_NO_OUTPUT);

    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Casual chat.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    const result = await h.forceSweep();
    expect(result.extracted).toBe(1);

    const output = getStage1Output(fixture.memoryDb, rolloutId);
    expect(output).toBeDefined();
    expect(output!.job_status).toBe('succeeded_no_output');
    expect(output!.content_outcome).toBeNull();
    expect(output!.rollout_summary).toBeNull();
    expect(output!.raw_memory).toBeNull();
  });

  it('6. LLM throws — lease state failed, next_retry_at advances', async () => {
    // Recreate fixture with LLM that throws.
    fixture.cleanup();
    fixture = createShadowFixture('', new Error('LLM service unavailable'));

    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Test message.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    const result = await h.forceSweep();
    // Extract failed — not counted as extracted.
    expect(result.extracted).toBe(0);

    const lease = getLease(fixture.memoryDb, rolloutId);
    expect(lease).toBeDefined();
    expect(lease!.job_status).toBe('failed');
    expect(lease!.next_retry_at).toBeTruthy();
    // next_retry_at should be in the future (5min backoff for attempt 1).
    expect((lease!.next_retry_at as number) > Date.now()).toBe(true);
    expect(lease!.last_error).toBeTruthy();

    // stage1_outputs should NOT have a row (extraction failed).
    const output = getStage1Output(fixture.memoryDb, rolloutId);
    expect(output).toBeUndefined();
  });

  it('7. lease running — second tick selects 0 (lease taken)', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Test.');

    // Manually acquire a lease to simulate an in-flight extract.
    const acquireResult = acquireLease(fixture.memoryDb, {
      rolloutId,
      claimedBy: 'another-worker',
    });
    expect(acquireResult.status).toBe('acquired');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    const result = await h.forceSweep();
    // The rollout is still selected by selectEligible (running leases
    // don't block eligibility), but the extract returns noop_skipped
    // because the lease is busy.
    expect(result.selected).toBe(1);
    expect(result.extracted).toBe(0);
    expect(result.skippedNoop).toBe(1);

    // LLM was never called (lease acquire failed before LLM).
    expect(fixture.llmClient.streamChat).not.toHaveBeenCalled();
  });

  it('8. reconcile with missing files — outbox writes, drain creates them', async () => {
    // Insert a stage1_outputs row directly (no projection files on disk).
    const now = Date.now();
    const rolloutId = crypto.randomUUID();
    insertCatalogRow(fixture.memoryDb, {
      rollout_id: rolloutId,
      source_fingerprint: 'fp-direct',
    });
    fixture.memoryDb
      .prepare(
        `INSERT INTO stage1_outputs (
          rollout_id, thread_id, cwd, project_id, git_branch,
          job_status, content_outcome, rollout_summary, raw_memory,
          rollout_slug, generated_at, source_updated_at, source_content_hash,
          extracted_through_seq, output_updated_at, schema_version,
          content_hash_at_write
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
      )
      .run(
        rolloutId,
        rolloutId,
        '/tmp/workspace',
        'global',
        'succeeded',
        'success',
        'Direct insert summary.',
        null,
        'direct-insert',
        now,
        now,
        'fp-direct',
        now,
        2,
      );

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: true,
      idleMs: 1,
    });

    // forceSweep runs reconcile → enqueues writes for missing files.
    const result = await h.forceSweep();
    expect(result.reconciled).not.toBeNull();
    expect(result.reconciled!.written).toBeGreaterThanOrEqual(1);

    // Drain outbox → files appear on disk.
    const drained = forceDrainOutbox(fixture.memoryDb, fixture.memoryRoot);
    expect(drained).toBeGreaterThanOrEqual(1);

    const summariesDir = path.join(fixture.memoryRoot, 'rollout_summaries');
    expect(fs.existsSync(summariesDir)).toBe(true);
    const files = fs.readdirSync(summariesDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('direct-insert');
  });

  it('9. shadow-mode contract — main DB messages table unchanged', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Original message.');

    const messagesBefore = fixture.mainDb
      .prepare('SELECT COUNT(*) as n FROM messages')
      .get() as { n: number };

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    await h.forceSweep();

    // The worker only READS from the main DB (messages table).
    // It must NEVER write to it — shadow mode.
    const messagesAfter = fixture.mainDb
      .prepare('SELECT COUNT(*) as n FROM messages')
      .get() as { n: number };
    expect(messagesAfter.n).toBe(messagesBefore.n);
  });

  it('10. shadow-mode scope — Phase 2 projections written under memory root', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'Test message.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    await h.forceSweep();
    forceDrainOutbox(fixture.memoryDb, fixture.memoryRoot);

    // Stage 1 projections (Phase 1, always written):
    expect(fs.existsSync(path.join(fixture.memoryRoot, 'rollout_summaries'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.memoryRoot, 'raw_memories.md'))).toBe(false);

    // Phase 2 projections (root MEMORY.md, summary.md, phase2_workspace_diff.md)
    // are no longer written by the worker — they are owned by the curation
    // publisher (Plan 406 Phase D retired the in-worker consolidator).
  });

  it('11. Codex filename shape + unified MEMORY.md content', async () => {
    const rolloutId = insertCatalogRow(fixture.memoryDb);
    insertMessage(fixture.mainDb, rolloutId, 'user', 'I prefer tabs over spaces.');

    const h = startMemoryWorker(toDeps(fixture), {
      instancesPerMinute: 1,
      concurrency: 1,
      reconcileOnStart: false,
      idleMs: 1,
    });

    await h.forceSweep();
    forceDrainOutbox(fixture.memoryDb, fixture.memoryRoot);

    // Verify rollout_summaries filename matches Codex shape:
    // <YYYY-MM-DD>T<HH-MM-SS>-<shortid>-<slug>.md
    const summariesDir = path.join(fixture.memoryRoot, 'rollout_summaries');
    const files = fs.readdirSync(summariesDir);
    expect(files.length).toBe(1);

    const codexShapeRe =
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{4,16}-[a-z0-9-]{3,80}\.md$/;
    expect(files[0]).toMatch(codexShapeRe);

    // The slug from the LLM response is 'feature-discussion'.
    expect(files[0]).toContain('feature-discussion');

    // The shortid is the first 8 hex chars of the rollout_id (dashes stripped).
    const expectedShortId = rolloutId.replace(/-/g, '').slice(0, 8).toLowerCase();
    expect(files[0]).toContain(expectedShortId);

    expect(fs.existsSync(path.join(fixture.memoryRoot, 'raw_memories.md'))).toBe(false);
  });
});
