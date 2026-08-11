/**
 * End-to-end curation integration test (Plan 417 Task G).
 *
 * Runs the full cycle with REAL modules (no mocks except the LLM client):
 *
 *   curation_ledger (real SQLite) → runSingleShotCuration (real prompt
 *   assembly + parser + file writer) → runCurationCycle (real ledger
 *   transitions) → projection refresh.
 *
 * Verifies:
 *   - input claim + disposition transitions in the DB
 *   - area files written on disk with the LLM's returned content
 *   - MEMORY.md / summary.md / index.md regenerated after success
 *   - a failed parse path marks the run failed and inputs uncertain
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const agentRequire = createRequire(
  path.resolve(__dirname, '../../../packages/agent/package.json'),
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = agentRequire('better-sqlite3') as typeof import('better-sqlite3');

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { AIClient } from '@duya/ai';
import type { AgentProcessPool } from '../../agents/process-pool/agent-process-pool';

import { migration0001 } from '../../memory-state/migrations/0001_init.sql';
import { migration0002 } from '../../memory-state/migrations/0002_lease_stage1.sql';
import { migration0003 } from '../../memory-state/migrations/0003_outbox.sql';
import { migration0005 } from '../../memory-state/migrations/0005_phase2.sql';
import { migration0006 } from '../../memory-state/migrations/0006_people_areas.sql';
import { migration0007 } from '../../memory-state/migrations/0007_lifecycle_scope.sql';
import { migration0008 } from '../../memory-state/migrations/0008_curation_runs.sql';
import { migration0009 } from '../../memory-state/migrations/0009_drop_legacy_phase2.sql';

import { runCurationCycle } from '../curation_publish_orchestrator';
import { parseCurationResponse } from '../curation_response_parser';

function createFixture() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-int-db-'));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-int-root-'));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-int-cfg-'));

  const memoryDb = new Database(path.join(dbDir, 'memory-state.db'));
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');
  for (const m of [
    migration0001, migration0002, migration0003,
    migration0005, migration0006, migration0007, migration0008, migration0009,
  ]) {
    memoryDb.exec(m.sql);
  }

  // Seed a stage1_outputs row + a catalog row so queryEligibleInputs
  // finds the input eligible.
  const now = Date.now();
  memoryDb.exec(`
    INSERT INTO rollout_catalog (
      rollout_id, scope_kind, agent_type, source_status, message_count,
      last_message_at, generation, source_fingerprint, last_seen_at, first_seen_at
    ) VALUES
      ('r-1', 'global', 'main', 'active', 12, ${now - 60_000}, 0, 'fp-1', ${now}, ${now}),
      ('r-2', 'global', 'main', 'active', 20, ${now - 90_000}, 0, 'fp-2', ${now}, ${now}),
      ('r-3', 'global', 'main', 'active', 30, ${now - 120_000}, 0, 'fp-3', ${now}, ${now});

    INSERT INTO stage1_outputs (
      rollout_id, thread_id, cwd, project_id, job_status, content_outcome,
      rollout_summary, raw_memory, rollout_slug, generated_at,
      source_updated_at, source_content_hash, output_updated_at, schema_version
    ) VALUES
      ('r-1', 't-1', '${memoryRoot.replace(/\\/g, '\\\\')}', 'p-1', 'succeeded', 'success',
       'summary 1', '{"items":[{"claim":"rule 1"}]}', 'foo', ${now - 60_000}, ${now - 60_000}, 'hash-1', ${now - 60_000}, 2),
      ('r-2', 't-2', '${memoryRoot.replace(/\\/g, '\\\\')}', 'p-2', 'succeeded', 'success',
       'summary 2', '{"items":[{"claim":"noise"}]}', 'foo', ${now - 90_000}, ${now - 90_000}, 'hash-2', ${now - 90_000}, 2),
      ('r-3', 't-3', '${memoryRoot.replace(/\\/g, '\\\\')}', 'p-3', 'succeeded', 'success',
       'summary 3', '{"items":[{"claim":"rule 3"}]}', 'bar', ${now - 120_000}, ${now - 120_000}, 'hash-3', ${now - 120_000}, 2);
  `);

  // The single-shot assembler reads rollout_summaries/<inputKey>.md.
  const rolloutDir = path.join(memoryRoot, 'rollout_summaries');
  fs.mkdirSync(rolloutDir, { recursive: true });
  for (const [id, body] of [
    ['r-1', '# summary 1\n\nrule 1: never lie'],
    ['r-2', '# summary 2\n\njust chitchat'],
    ['r-3', '# summary 3\n\nrule 3: verify'],
  ]) {
    fs.writeFileSync(path.join(rolloutDir, `${id}.md`), body, 'utf8');
  }

  const cleanup = () => {
    try { memoryDb.close(); } catch { /* closed */ }
    for (const dir of [dbDir, memoryRoot, configRoot]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  return { memoryDb, memoryRoot, configRoot, cleanup };
}

function mockLlm(reply: string): AIClient {
  return {
    chat: vi.fn().mockResolvedValue({ content: reply, usage: { input_tokens: 1, output_tokens: 1 } }),
    streamChat: vi.fn(),
  } as unknown as AIClient;
}

const EMPTY_POOL = {} as unknown as AgentProcessPool;

describe('runCurationCycle — full integration (Plan 417 Task G)', () => {
  let fx: ReturnType<typeof createFixture>;

  beforeEach(() => {
    fx = createFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('1. success: claims → LLM → writes area files → absorbed dispositions → projections refreshed', async () => {
    // LLM returns: r-1 absorbed (append to foo.md), r-2 no_signal, r-3 absorbed (append to bar.md)
    const reply = JSON.stringify({
      decisions: [
        { rollout_id: 'r-1', disposition: 'absorbed', reason: 'rule 1 durable' },
        { rollout_id: 'r-2', disposition: 'no_signal', reason: 'chitchat only' },
        { rollout_id: 'r-3', disposition: 'absorbed', reason: 'rule 3 durable' },
      ],
      actions: [
        {
          op: 'append',
          area_path: 'global/areas/foo.md',
          content: '## Rule\n- never lie (r-1)',
          reason: 'r-1 confirmed',
        },
        {
          op: 'append',
          area_path: 'global/areas/bar.md',
          content: '## Rule\n- verify before claiming (r-3)',
          reason: 'r-3 confirmed',
        },
      ],
    });
    const llm = mockLlm(reply);

    const result = await runCurationCycle(fx.memoryDb, {
      memoryRoot: fx.memoryRoot,
      configRoot: fx.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: EMPTY_POOL,
      sessionId: 'sess-1',
      llmClient: llm,
    });

    expect(result.success).toBe(true);
    expect(result.runId).toBeTruthy();

    // 1. area files written
    const fooContent = fs.readFileSync(path.join(fx.memoryRoot, 'global/areas/foo.md'), 'utf8');
    expect(fooContent).toContain('never lie');
    const barContent = fs.readFileSync(path.join(fx.memoryRoot, 'global/areas/bar.md'), 'utf8');
    expect(barContent).toContain('verify before claiming');

    // 2. run succeeded + dispositions recorded
    const run = fx.memoryDb
      .prepare('SELECT status, publication_status FROM curation_runs WHERE run_id = ?')
      .get(result.runId!) as { status: string; publication_status: string } | undefined;
    expect(run).toBeDefined();
    expect(run!.status).toBe('succeeded');
    expect(run!.publication_status).toBe('succeeded');

    const dispos = fx.memoryDb
      .prepare('SELECT input_key, disposition FROM curation_run_inputs ORDER BY input_key')
      .all() as Array<{ input_key: string; disposition: string }>;
    expect(dispos).toEqual([
      { input_key: 'r-1', disposition: 'absorbed' },
      { input_key: 'r-2', disposition: 'no_signal' },
      { input_key: 'r-3', disposition: 'absorbed' },
    ]);

    // 3. projections regenerated (MEMORY.md + summary.md + index.md)
    const memoryMd = fs.readFileSync(path.join(fx.memoryRoot, 'MEMORY.md'), 'utf8');
    expect(memoryMd).toContain('**area:foo**');
    expect(memoryMd).toContain('**area:bar**');
    const summaryMd = fs.readFileSync(path.join(fx.memoryRoot, 'summary.md'), 'utf8');
    expect(summaryMd).toContain('Memory Summary');
    const areaIndex = fs.readFileSync(path.join(fx.memoryRoot, 'global/areas/index.md'), 'utf8');
    expect(areaIndex).toContain('foo');
    expect(areaIndex).toContain('bar');

    // 4. inputs are no longer eligible (consumed)
    const remaining = fx.memoryDb
      .prepare(
        `SELECT COUNT(*) AS n FROM curation_run_inputs
          WHERE disposition IS NULL`,
      )
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('2. parse failure: run marked failed, inputs stay eligible, no files written', async () => {
    const llm = mockLlm('this is not valid json at all');
    const result = await runCurationCycle(fx.memoryDb, {
      memoryRoot: fx.memoryRoot,
      configRoot: fx.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: EMPTY_POOL,
      sessionId: 'sess-2',
      llmClient: llm,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/parse failed/);

    const run = fx.memoryDb
      .prepare('SELECT status, error FROM curation_runs WHERE run_id = ?')
      .get(result.runId!) as { status: string; error: string };
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/parse failed/);

    // failRun leaves dispositions NULL → still eligible for the next cycle.
    const dispos = fx.memoryDb
      .prepare('SELECT input_key, disposition FROM curation_run_inputs ORDER BY input_key')
      .all() as Array<{ input_key: string; disposition: string | null }>;
    expect(dispos).toHaveLength(3);
    expect(dispos.every((d) => d.disposition === null)).toBe(true);

    // No files written (only rollout_summaries dir exists).
    expect(fs.existsSync(path.join(fx.memoryRoot, 'global/areas/foo.md'))).toBe(false);
  });

  it('3. abandoned runs are recovered before claim', async () => {
    // Create a stale running run with an expired lease.
    fx.memoryDb.exec(`
      INSERT INTO curation_runs (
        run_id, input_set_hash, base_manifest_hash, lock_token, claimed_by, status,
        lease_expires_at, started_at, heartbeat_at
      ) VALUES ('stale-run', 'h', 'empty', 'stale-lock', 'old-worker', 'running',
                ${Date.now() - 10_000}, ${Date.now() - 20_000}, ${Date.now() - 20_000});
    `);

    // Now run a real cycle — abandonExpiredRuns should clear the stale one.
    const reply = JSON.stringify({
      decisions: [
        { rollout_id: 'r-1', disposition: 'no_signal', reason: 'noise' },
        { rollout_id: 'r-2', disposition: 'no_signal', reason: 'noise' },
        { rollout_id: 'r-3', disposition: 'no_signal', reason: 'noise' },
      ],
      actions: [],
    });
    const llm = mockLlm(reply);

    const result = await runCurationCycle(fx.memoryDb, {
      memoryRoot: fx.memoryRoot,
      configRoot: fx.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: EMPTY_POOL,
      sessionId: 'sess-3',
      llmClient: llm,
    });

    expect(result.success).toBe(true);

    const stale = fx.memoryDb
      .prepare("SELECT status FROM curation_runs WHERE run_id = 'stale-run'")
      .get() as { status: string };
    expect(stale.status).toBe('abandoned');
  });

  it('4. parseCurationResponse works against the exact reply the orchestrator consumes', () => {
    const reply = JSON.stringify({
      decisions: [
        { rollout_id: 'r-1', disposition: 'absorbed', reason: 'x' },
      ],
      actions: [
        { op: 'append', area_path: 'global/areas/foo.md', content: '## x\n- y', reason: 'r' },
      ],
    });
    const parsed = parseCurationResponse(reply);
    expect(parsed.actions[0].area_path).toBe('global/areas/foo.md');
  });
});