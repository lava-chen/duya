import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import type { AgentProcessPool } from '../../agents/process-pool/agent-process-pool';
import type { AIClient } from '@duya/ai';

// Hoisted mock state — shared between vi.mock factories and test bodies.
const mocks = vi.hoisted(() => ({
  // curation_ledger mocks
  queryEligibleInputs: vi.fn(),
  claimRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  computeInputSetHash: vi.fn(),
  abandonExpiredRuns: vi.fn(),
  // curation_single_shot mock (replaces legacy runCurationAgent)
  runSingleShotCuration: vi.fn(),
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

vi.mock('../curation_single_shot', () => ({
  runSingleShotCuration: mocks.runSingleShotCuration,
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

function successReply() {
  return {
    success: true,
    response: {
      decisions: [
        { rollout_id: 'r1', disposition: 'absorbed' as const, reason: 'r' },
        { rollout_id: 'r2', disposition: 'absorbed' as const, reason: 'r' },
        { rollout_id: 'r3', disposition: 'absorbed' as const, reason: 'r' },
      ],
      actions: [],
    },
    rawResponse: '{}',
    durationMs: 10,
    actionsApplied: 0,
    errors: [],
  };
}

function makeLlm(): AIClient {
  return { chat: vi.fn() } as unknown as AIClient;
}

describe('runCurationCycle', () => {
  let env: OrchEnv;
  let db: Database;
  let llm: AIClient;

  beforeEach(() => {
    env = makeEnv();
    db = { prepare: vi.fn() } as unknown as Database;
    llm = makeLlm();
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
      llmClient: llm,
      now: T0,
    });

    expect(result.skipped).toBe(true);
    expect(mocks.claimRun).not.toHaveBeenCalled();
  });

  it('2. success flow — claims, git backs up, runs single-shot, completes', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-1', lockToken: 'tok-1' });
    mocks.runSingleShotCuration.mockResolvedValue(successReply());

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      llmClient: llm,
      now: T0,
    });

    expect(result.skipped).toBeFalsy();
    expect(result.success).toBe(true);
    expect(result.runId).toBe('run-1');

    expect(mocks.queryEligibleInputs).toHaveBeenCalled();
    expect(mocks.claimRun).toHaveBeenCalled();
    expect(mocks.backupMemoryBeforeRun).toHaveBeenCalledWith(env.memoryRoot, 'run-1');
    // Single-shot runner was called with the claimed inputs and the LLM client.
    expect(mocks.runSingleShotCuration).toHaveBeenCalledWith(expect.objectContaining({
      memoryRoot: env.memoryRoot,
      llmClient: llm,
      inputs: expect.arrayContaining([
        expect.objectContaining({ inputKey: 'r1' }),
        expect.objectContaining({ inputKey: 'r2' }),
        expect.objectContaining({ inputKey: 'r3' }),
      ]),
    }));
    // completeRun marks every input absorbed (LLM said absorbed for all).
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

  it('3. failure — failRun + completeRun(published=failed), dispositions=uncertain', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-3', lockToken: 'tok-3' });
    mocks.runSingleShotCuration.mockResolvedValue({
      success: false,
      response: null,
      rawResponse: '',
      durationMs: 10,
      actionsApplied: 0,
      errors: [],
      error: 'parse failed: no JSON object found',
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      llmClient: llm,
      now: T0,
    });

    expect(result.success).toBe(false);
    expect(result.runId).toBe('run-3');
    expect(result.error).toContain('parse failed');
    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), 'run-3', expect.stringContaining('parse failed'), expect.any(Number));
    expect(mocks.completeRun).toHaveBeenCalledWith(expect.anything(), 'run-3', expect.objectContaining({
      publicationStatus: 'failed',
    }));
  });

  it('4. backup failure is non-fatal — run still proceeds', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-4', lockToken: 'tok-4' });
    mocks.backupMemoryBeforeRun.mockResolvedValue(false);
    mocks.runSingleShotCuration.mockResolvedValue(successReply());

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      llmClient: llm,
      now: T0,
    });

    expect(result.success).toBe(true);
    expect(mocks.runSingleShotCuration).toHaveBeenCalled();
  });

  it('5. partial decisions: LLM marked r1=no_signal → disposition preserved', async () => {
    const inputs = [rollout('r1', 1), rollout('r2', 2), rollout('r3', 3)];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-5', lockToken: 'tok-5' });
    mocks.runSingleShotCuration.mockResolvedValue({
      success: true,
      response: {
        decisions: [
          { rollout_id: 'r1', disposition: 'no_signal', reason: 'noise' },
          { rollout_id: 'r2', disposition: 'absorbed', reason: 'kept' },
          // r3 omitted on purpose
        ],
        actions: [],
      },
      rawResponse: '{}',
      durationMs: 5,
      actionsApplied: 0,
      errors: [],
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      llmClient: llm,
      now: T0,
    });

    expect(result.success).toBe(true);
    expect(mocks.completeRun).toHaveBeenCalledWith(expect.anything(), 'run-5', expect.objectContaining({
      dispositions: [
        { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', disposition: 'no_signal' },
        { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', disposition: 'absorbed' },
        // r3 — no decision and success=true → default absorbed
        { inputKind: 'rollout', inputKey: 'r3', contentHash: 'h3', disposition: 'absorbed' },
      ],
    }));
  });
});