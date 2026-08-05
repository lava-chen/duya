/**
 * Unit tests for the Phase 2 curation path in memory-worker (Plan 406
 * Tasks 8 + 9). Verifies the DUYA_MEMORY_PHASE2_ENABLED switch, the
 * Hybrid scheduler dispatch, and startup publication recovery.
 *
 * The orchestrator, ledger, and ad-hoc watcher are mocked so the test
 * asserts which path the worker takes without running the real LLM
 * curation pipeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
const agentRequire = createRequire(
  path.resolve(__dirname, '../../../packages/agent/package.json'),
);
const Database = agentRequire('better-sqlite3') as typeof import('better-sqlite3');
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { AIClient } from '@duya/ai';
import { migration0001 } from '../../memory-state/migrations/0001_init.sql';
import { migration0002 } from '../../memory-state/migrations/0002_lease_stage1.sql';
import { migration0003 } from '../../memory-state/migrations/0003_outbox.sql';
import { migration0005 } from '../../memory-state/migrations/0005_phase2.sql';
import { migration0006 } from '../../memory-state/migrations/0006_people_areas.sql';
import { migration0007 } from '../../memory-state/migrations/0007_lifecycle_scope.sql';
import { migration0008 } from '../../memory-state/migrations/0008_curation_runs.sql';
import {
  startMemoryWorker,
  _resetMemoryWorkerForTesting,
  type MemoryWorkerDeps,
} from '../memory-worker';

// Hoisted mocks — shared between the vi.mock factories and test bodies.
const mocks = vi.hoisted(() => ({
  runCurationCycle: vi.fn(),
  recoverAllPublications: vi.fn(),
  queryEligibleInputs: vi.fn(),
  scanAdHocChanges: vi.fn(),
}));

vi.mock('../curation_publish_orchestrator', () => ({
  runCurationCycle: mocks.runCurationCycle,
  recoverAllPublications: mocks.recoverAllPublications,
}));

vi.mock('../../../packages/agent/src/memory-state/curation_ledger', () => ({
  queryEligibleInputs: mocks.queryEligibleInputs,
}));

vi.mock('../ad_hoc_watcher', () => ({
  scanAdHocChanges: mocks.scanAdHocChanges,
}));

interface CurationFixture {
  memoryDb: BetterSqlite3Database;
  mainDb: BetterSqlite3Database;
  memoryRoot: string;
  dbDir: string;
  configRoot: string;
  stagingRoot: string;
  snapshotRoot: string;
  llmClient: AIClient;
  cleanup: () => void;
}

function createCurationFixture(): CurationFixture {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cur-db-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cur-root-'));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cur-cfg-'));
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cur-stg-'));
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cur-snap-'));
  const memoryDb = new Database(path.join(dbDir, 'memory-state.db'));
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');
  memoryDb.pragma('busy_timeout = 5000');
  for (const m of [migration0001, migration0002, migration0003, migration0005, migration0006, migration0007, migration0008]) {
    memoryDb.exec(m.sql);
  }

  const mainDb = new Database(path.join(dbDir, 'main.db'));
  mainDb.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_name TEXT, tool_input TEXT,
      msg_type TEXT, seq_index INTEGER, created_at INTEGER, status TEXT
    );
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER,
      model TEXT, system_prompt TEXT, working_directory TEXT, project_name TEXT,
      status TEXT, mode TEXT, permission_profile TEXT, provider_id TEXT,
      context_summary TEXT, context_summary_updated_at INTEGER, is_deleted INTEGER,
      generation INTEGER, agent_profile_id TEXT, parent_id TEXT, agent_type TEXT,
      agent_name TEXT, conductor_mode_enabled INTEGER, conductor_canvas_id TEXT
    );
  `);

  const llmClient: AIClient = {
    streamChat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', data: '{"job_status":"succeeded_no_output","rollout_slug":"noop"}' };
      yield { type: 'done' };
    }),
    chat: vi.fn().mockResolvedValue({ content: '{"job_status":"succeeded_no_output","rollout_slug":"noop"}' }),
  };

  return {
    memoryDb, mainDb, memoryRoot, dbDir, configRoot, stagingRoot, snapshotRoot, llmClient,
    cleanup: () => {
      try { memoryDb.close(); } catch { /* already closed */ }
      try { mainDb.close(); } catch { /* already closed */ }
      for (const dir of [dbDir, memoryRoot, configRoot, stagingRoot, snapshotRoot]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

function toDeps(f: CurationFixture): MemoryWorkerDeps {
  return {
    memoryDb: f.memoryDb,
    mainDb: f.mainDb,
    llmClient: f.llmClient,
    rootDir: f.memoryRoot,
    curation: {
      configRoot: f.configRoot,
      stagingRoot: f.stagingRoot,
      snapshotRoot: f.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: f.memoryRoot,
      pool: {} as never,
    },
  };
}

describe('memory-worker curation path (Plan 406)', () => {
  let f: CurationFixture;

  beforeEach(() => {
    f = createCurationFixture();
    vi.clearAllMocks();
    mocks.recoverAllPublications.mockResolvedValue([]);
    mocks.scanAdHocChanges.mockResolvedValue([]);
    process.env.DUYA_MEMORY_PHASE2_ENABLED = '1';
  });

  afterEach(() => {
    delete process.env.DUYA_MEMORY_PHASE2_ENABLED;
    _resetMemoryWorkerForTesting();
    f.cleanup();
  });

  it('calls runCurationCycle when Phase 2 enabled and quorum met', async () => {
    mocks.queryEligibleInputs.mockReturnValue([
      { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: Date.now() - 10_000, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: Date.now() - 10_000, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout', inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: Date.now() - 10_000, rolloutSlug: 's3', bytes: 100 },
    ]);
    mocks.runCurationCycle.mockResolvedValue({ skipped: false, success: true, runId: 'run-1', durationMs: 5 });

    const h = startMemoryWorker(toDeps(f), { instancesPerMinute: 1 });
    const result = await h.forceSweep();

    expect(mocks.runCurationCycle).toHaveBeenCalledTimes(1);
    expect(result.curated?.ran).toBe(true);
    expect(mocks.runCurationCycle.mock.calls[0][1].memoryRoot).toBe(f.memoryRoot);
  });

  it('does NOT call runCurationCycle when quorum is not met (N<3, age<30min)', async () => {
    mocks.queryEligibleInputs.mockReturnValue([
      { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: Date.now() - 60_000, rolloutSlug: 's1', bytes: 100 },
    ]);

    const h = startMemoryWorker(toDeps(f), { instancesPerMinute: 1 });
    const result = await h.curationTickForTest();

    expect(mocks.runCurationCycle).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped_no_quorum');
  });

  it('fires on a forceSweep even when the quorum is not met (force override)', async () => {
    mocks.queryEligibleInputs.mockReturnValue([
      { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: Date.now() - 60_000, rolloutSlug: 's1', bytes: 100 },
    ]);
    mocks.runCurationCycle.mockResolvedValue({ skipped: false, success: true, runId: 'run-1', durationMs: 5 });

    const h = startMemoryWorker(toDeps(f), { instancesPerMinute: 1 });
    const result = await h.forceSweep();

    expect(mocks.runCurationCycle).toHaveBeenCalledTimes(1);
    expect(result.curated?.ran).toBe(true);
  });

  it('calls recoverAllPublications on the first tick when Phase 2 enabled', async () => {
    mocks.queryEligibleInputs.mockReturnValue([]);
    const h = startMemoryWorker(toDeps(f), { instancesPerMinute: 1 });
    await h.forceSweep();

    expect(mocks.recoverAllPublications).toHaveBeenCalledTimes(1);
    expect(mocks.recoverAllPublications.mock.calls[0][0].stagingRoot).toBe(f.stagingRoot);
  });

  it('Phase 2 is always-on by default — recoverAllPublications is called even when the env var is unset', async () => {
    delete process.env.DUYA_MEMORY_PHASE2_ENABLED;
    mocks.queryEligibleInputs.mockReturnValue([]);
    const h = startMemoryWorker(toDeps(f), { instancesPerMinute: 1 });
    await h.forceSweep();

    expect(mocks.recoverAllPublications).toHaveBeenCalledTimes(1);
  });
});