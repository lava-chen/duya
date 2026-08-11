import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import type { AgentProcessPool } from '../../agents/process-pool/agent-process-pool';

// Hoisted mock state — shared between vi.mock factories and test bodies.
const mocks = vi.hoisted(() => ({
  // curation_ledger mocks
  queryEligibleInputs: vi.fn(),
  claimRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  computeInputSetHash: vi.fn(),
  abandonExpiredRuns: vi.fn(),
  // curation_agent_runner mock
  runCurationAgent: vi.fn(),
  // memory_git_backup mock
  backupMemoryBeforeRun: vi.fn(),
}));

vi.mock('../../../packages/agent/src/memory-state/curation_ledger', () => ({
  queryEligibleInputs: mocks.queryEligibleInputs,
  claimRun: mocks.claimRun,
  completeRun: mocks.completeRun,
  failRun: mocks.failRun,
  computeInputSetHash: mocks.computeInputSetHash,
  abandonExpiredRuns: mocks.abandonExpiredRuns,
}));

vi.mock('../curation_agent_runner', () => ({
  runCurationAgent: mocks.runCurationAgent,
}));

vi.mock('../memory_git_backup', () => ({
  backupMemoryBeforeRun: mocks.backupMemoryBeforeRun,
}));

import { runCurationCycle } from '../curation_publish_orchestrator';

interface OrchEnv {
  memoryRoot: string;
  configRoot: string;
  cleanup: () => void;
}

function makeEnv(): OrchEnv {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cfg-'));
  return {
    memoryRoot, configRoot,
    cleanup: () => {
      for (const d of [memoryRoot, configRoot]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

const T0 = 1_750_000_000_000;

function rollout(i: string, n: number) {
  return { inputKind: 'rollout' as const, inputKey: i, contentHash: `h${n}`, outputUpdatedAt: T0, rolloutSlug: `s${n}`, generatedAt: T0, bytes: 100 };
}

describe('runCurationCycle', () => {
  let env: OrchEnv;
  let db: Database;

  beforeEach(() => {
    env = makeEnv();
    db = { prepare: vi.fn() } as unknown as Database;
    vi.clearAllMocks();
    mocks.computeInputSetHash.mockReturnValue('input-hash-1');
    mocks.abandonExpiredRuns.mockReturnValue(0);
    mocks.backupMemoryBeforeRun.mockResolvedValue(true);
  });

  afterEach(() => { env.cleanup(); });

  it('1. skips when fewer than 2 eligible inputs', async () => {
    mocks.queryEligibleInputs.mockReturnValue([rollout('r1', 1)]);

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.skipped).toBe(true);
    expect(mocks.claimRun).not.toHaveBeenCalled();
  });

  it('2. success flow — claims, git backs up, runs agent, completes with absorbed dispositions', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-1', lockToken: 'tok-1' });
    mocks.runCurationAgent.mockResolvedValue({ durationMs: 10 });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.skipped).toBeFalsy();
    expect(result.success).toBe(true);
    expect(result.runId).toBe('run-1');

    expect(mocks.queryEligibleInputs).toHaveBeenCalled();
    expect(mocks.claimRun).toHaveBeenCalled();
    // Git backup ran against the live memory root.
    expect(mocks.backupMemoryBeforeRun).toHaveBeenCalledWith(env.memoryRoot, 'run-1');
    // Agent ran directly on the memory root.
    expect(mocks.runCurationAgent).toHaveBeenCalledWith(expect.objectContaining({
      memoryRoot: env.memoryRoot,
      runId: 'run-1',
    }));
    // completeRun marks every input absorbed.
    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.anything(),
      'run-1',
      expect.objectContaining({
        publicationStatus: 'succeeded',
        dispositions: [
          { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', disposition: 'absorbed' },
          { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', disposition: 'absorbed' },
          { inputKind: 'rollout', inputKey: 'r3', contentHash: 'h3', disposition: 'absorbed' },
        ],
      }),
    );
  });

  it('3. agent failure — calls failRun, does not completeRun', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-3', lockToken: 'tok-3' });
    mocks.runCurationAgent.mockRejectedValue(new Error('agent timeout'));

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(false);
    expect(result.runId).toBe('run-3');
    expect(result.error).toContain('timeout');
    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), 'run-3', expect.stringContaining('timeout'), expect.any(Number));
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it('4. backup failure is non-fatal — run still proceeds', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-4', lockToken: 'tok-4' });
    mocks.backupMemoryBeforeRun.mockResolvedValue(false);
    mocks.runCurationAgent.mockResolvedValue({ durationMs: 5 });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(true);
    expect(mocks.runCurationAgent).toHaveBeenCalled();
  });
});
