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
  // curation_staging mocks
  createStaging: vi.fn(),
  deleteStaging: vi.fn(),
  // curation_agent_runner mock
  runCurationAgent: vi.fn(),
  // curation_validator mock
  validateStaging: vi.fn(),
  // curation_publisher mocks
  preparePublication: vi.fn(),
  executePublication: vi.fn(),
  recoverPublication: vi.fn(),
  readJournal: vi.fn(),
  // curation_snapshot mock
  createSnapshot: vi.fn(),
  // curation_health mock
  appendHealthReport: vi.fn(),
  // memory_entries_rebuild mock
  rebuildMemoryEntriesFromFiles: vi.fn(),
  // ad_hoc_watcher mock
  scanAdHocChanges: vi.fn(),
}));

vi.mock('../../../packages/agent/src/memory-state/curation_ledger', () => ({
  queryEligibleInputs: mocks.queryEligibleInputs,
  claimRun: mocks.claimRun,
  completeRun: mocks.completeRun,
  failRun: mocks.failRun,
  computeInputSetHash: mocks.computeInputSetHash,
}));

vi.mock('../../../packages/agent/src/memory-state/memory_entries_rebuild', () => ({
  rebuildMemoryEntriesFromFiles: mocks.rebuildMemoryEntriesFromFiles,
}));

vi.mock('../ad_hoc_watcher', () => ({
  scanAdHocChanges: mocks.scanAdHocChanges,
}));

vi.mock('../curation_staging', () => ({
  createStaging: mocks.createStaging,
  deleteStaging: mocks.deleteStaging,
}));

vi.mock('../curation_agent_runner', () => ({
  runCurationAgent: mocks.runCurationAgent,
}));

vi.mock('../../../packages/agent/src/memory-state/curation_validator', () => ({
  validateStaging: mocks.validateStaging,
}));

vi.mock('../curation_publisher', () => ({
  preparePublication: mocks.preparePublication,
  executePublication: mocks.executePublication,
  recoverPublication: mocks.recoverPublication,
  readJournal: mocks.readJournal,
}));

vi.mock('../curation_snapshot', () => ({
  createSnapshot: mocks.createSnapshot,
}));

vi.mock('../../../packages/agent/src/memory-state/curation_health', () => ({
  appendHealthReport: mocks.appendHealthReport,
}));

import { runCurationCycle, recoverAllPublications } from '../curation_publish_orchestrator';

interface OrchEnv {
  memoryRoot: string;
  configRoot: string;
  stagingRoot: string;
  snapshotRoot: string;
  cleanup: () => void;
}

function makeEnv(): OrchEnv {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cfg-'));
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stg-'));
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-snap-'));
  return {
    memoryRoot, configRoot, stagingRoot, snapshotRoot,
    cleanup: () => {
      for (const d of [memoryRoot, configRoot, stagingRoot, snapshotRoot]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

const T0 = 1_750_000_000_000;

describe('runCurationCycle', () => {
  let env: OrchEnv;
  let db: Database;

  beforeEach(() => {
    env = makeEnv();
    db = { prepare: vi.fn() } as unknown as Database;
    vi.clearAllMocks();
    mocks.computeInputSetHash.mockReturnValue('input-hash-1');
    mocks.rebuildMemoryEntriesFromFiles.mockResolvedValue({ processed: 0, skipped: 0, durationMs: 0 });
    mocks.scanAdHocChanges.mockResolvedValue([]);
  });

  afterEach(() => { env.cleanup(); });

  it('1. skips when fewer than 3 eligible inputs and no timeout', async () => {
    mocks.queryEligibleInputs.mockReturnValue([
      { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
    ]);

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.skipped).toBe(true);
    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.createStaging).not.toHaveBeenCalled();
  });

  it('2. success flow — claims, stages, runs agent, validates, snapshots, publishes, completes, health', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-1', lockToken: 'tok-1' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-1'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: {
        inputs: [
          { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', disposition: 'absorbed' },
          { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', disposition: 'no_change' },
          { inputKind: 'rollout', inputKey: 'r3', contentHash: 'h3', disposition: 'absorbed' },
        ],
        health: { added: 2, merged: 0, retired: 0, no_change: 1, rejected: 0 },
      },
    });
    mocks.validateStaging.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mocks.createSnapshot.mockResolvedValue({ snapshotDir: path.join(env.snapshotRoot, 'snap-1'), manifestHash: 'snap-hash' });
    mocks.preparePublication.mockResolvedValue({
      run_id: 'run-1', generation: 2, old_manifest_hash: 'old', new_manifest_hash: 'new',
      old_policy_version: null, new_policy_version: null, old_layout_version: null, new_layout_version: null,
      backup_dir: path.join(env.stagingRoot, 'run-1', 'backup'),
      steps: [],
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.skipped).toBeFalsy();
    expect(result.success).toBe(true);
    expect(result.runId).toBe('run-1');

    // Verify call order.
    expect(mocks.queryEligibleInputs).toHaveBeenCalled();
    expect(mocks.claimRun).toHaveBeenCalled();
    expect(mocks.createStaging).toHaveBeenCalled();
    expect(mocks.runCurationAgent).toHaveBeenCalled();
    expect(mocks.validateStaging).toHaveBeenCalled();
    expect(mocks.createSnapshot).toHaveBeenCalled();
    expect(mocks.preparePublication).toHaveBeenCalled();
    expect(mocks.executePublication).toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalled();
    expect(mocks.appendHealthReport).toHaveBeenCalled();
    expect(mocks.deleteStaging).toHaveBeenCalled();
  });

  it('3. validation failure — calls failRun, deletes staging, no publish', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-2', lockToken: 'tok-2' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-2'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: {
        inputs: [],
        health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 },
      },
    });
    mocks.validateStaging.mockReturnValue({
      valid: false,
      errors: ['invalid frontmatter in items/preference/bad.md'],
      warnings: [],
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(false);
    expect(result.runId).toBe('run-2');
    expect(result.error).toContain('invalid frontmatter');

    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), 'run-2', expect.stringContaining('invalid frontmatter'), expect.any(Number));
    expect(mocks.deleteStaging).toHaveBeenCalled();
    expect(mocks.preparePublication).not.toHaveBeenCalled();
    expect(mocks.executePublication).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it('4. agent timeout — calls failRun, deletes staging, no publish', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-3', lockToken: 'tok-3' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-3'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockRejectedValue(new Error('agent timeout'));

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(false);
    expect(result.runId).toBe('run-3');
    expect(result.error).toContain('timeout');

    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), 'run-3', expect.stringContaining('timeout'), expect.any(Number));
    expect(mocks.deleteStaging).toHaveBeenCalled();
    expect(mocks.validateStaging).not.toHaveBeenCalled();
    expect(mocks.preparePublication).not.toHaveBeenCalled();
  });

  it('5. rebuilds memory_entries cache after a successful publication', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-5', lockToken: 'tok-5' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-5'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: { inputs: [], health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 } },
    });
    mocks.validateStaging.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mocks.createSnapshot.mockResolvedValue({ snapshotDir: path.join(env.snapshotRoot, 'snap-5'), manifestHash: 'snap-hash' });
    mocks.preparePublication.mockResolvedValue({
      run_id: 'run-5', generation: 2, old_manifest_hash: 'old', new_manifest_hash: 'new',
      old_policy_version: null, new_policy_version: null, old_layout_version: null, new_layout_version: null,
      backup_dir: path.join(env.stagingRoot, 'run-5', 'backup'), steps: [],
    });
    mocks.rebuildMemoryEntriesFromFiles.mockResolvedValue({ processed: 2, skipped: 0, durationMs: 5 });

    await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(mocks.rebuildMemoryEntriesFromFiles).toHaveBeenCalledTimes(1);
    expect(mocks.rebuildMemoryEntriesFromFiles.mock.calls[0][1]).toBe(env.memoryRoot);
    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.anything(),
      'run-5',
      expect.objectContaining({ publicationStatus: 'succeeded', cacheStatus: 'ok' }),
    );
  });

  it('6. sets cache_status=cache_pending and still succeeds when rebuild fails', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-6', lockToken: 'tok-6' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-6'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: { inputs: [], health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 } },
    });
    mocks.validateStaging.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mocks.createSnapshot.mockResolvedValue({ snapshotDir: path.join(env.snapshotRoot, 'snap-6'), manifestHash: 'snap-hash' });
    mocks.preparePublication.mockResolvedValue({
      run_id: 'run-6', generation: 2, old_manifest_hash: 'old', new_manifest_hash: 'new',
      old_policy_version: null, new_policy_version: null, old_layout_version: null, new_layout_version: null,
      backup_dir: path.join(env.stagingRoot, 'run-6', 'backup'), steps: [],
    });
    mocks.rebuildMemoryEntriesFromFiles.mockRejectedValue(new Error('disk full'));

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(true);
    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.anything(),
      'run-6',
      expect.objectContaining({ publicationStatus: 'succeeded', cacheStatus: 'cache_pending' }),
    );
  });

  it('7. merges rollout and ad-hoc inputs into one batch, truncated to MAX_INPUTS', async () => {
    // 5 rollout + 4 ad-hoc = 9 eligible; truncated to MAX_INPUTS (8).
    mocks.queryEligibleInputs.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        inputKind: 'rollout' as const,
        inputKey: `r${i}`,
        contentHash: `h${i}`,
        outputUpdatedAt: T0 + i,
        rolloutSlug: `s${i}`,
        bytes: 100,
      })),
    );
    mocks.scanAdHocChanges.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({
        inputKind: 'ad_hoc' as const,
        inputKey: `extensions/ad_hoc/note-${i}.md`,
        contentHash: `h-adhoc-${i}`,
        sourcePath: path.join(env.memoryRoot, 'extensions', 'ad_hoc', `note-${i}.md`),
        outputUpdatedAt: T0 + 10 + i,
      })),
    );
    mocks.claimRun.mockReturnValue({ runId: 'run-7', lockToken: 'tok-7' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-7'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: { inputs: [], health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 } },
    });
    mocks.validateStaging.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mocks.createSnapshot.mockResolvedValue({ snapshotDir: path.join(env.snapshotRoot, 'snap-7'), manifestHash: 'snap-hash' });
    mocks.preparePublication.mockResolvedValue({
      run_id: 'run-7', generation: 2, old_manifest_hash: 'old', new_manifest_hash: 'new',
      old_policy_version: null, new_policy_version: null, old_layout_version: null, new_layout_version: null,
      backup_dir: path.join(env.stagingRoot, 'run-7', 'backup'), steps: [],
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(true);
    // 9 eligible, truncated to MAX_INPUTS (8).
    expect(mocks.claimRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inputs: expect.arrayContaining([expect.objectContaining({ inputKind: 'ad_hoc' })]) }),
    );
    const claimedInputs = (mocks.claimRun.mock.calls[0][1] as { inputs: unknown[] }).inputs;
    expect(claimedInputs).toHaveLength(8);
    // At least one ad-hoc input reaches staging with its real source path.
    const stagingInputs = (mocks.createStaging.mock.calls[0][2] as { inputs: Array<{ inputKind: string; sourcePath: string }> }).inputs;
    expect(stagingInputs.some((i) => i.inputKind === 'ad_hoc' && i.sourcePath.includes('extensions'))).toBe(true);
  });

  it('8. scans ad-hoc inputs from the extensions/ad_hoc directory', async () => {
    mocks.queryEligibleInputs.mockReturnValue([
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ]);
    mocks.scanAdHocChanges.mockResolvedValue([
      {
        inputKind: 'ad_hoc' as const,
        inputKey: 'extensions/ad_hoc/note.md',
        contentHash: 'h-note',
        sourcePath: path.join(env.memoryRoot, 'extensions', 'ad_hoc', 'note.md'),
        outputUpdatedAt: T0,
      },
    ]);
    mocks.claimRun.mockReturnValue({ runId: 'run-8', lockToken: 'tok-8' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-8'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: { inputs: [], health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 } },
    });
    mocks.validateStaging.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mocks.createSnapshot.mockResolvedValue({ snapshotDir: path.join(env.snapshotRoot, 'snap-8'), manifestHash: 'snap-hash' });
    mocks.preparePublication.mockResolvedValue({
      run_id: 'run-8', generation: 2, old_manifest_hash: 'old', new_manifest_hash: 'new',
      old_policy_version: null, new_policy_version: null, old_layout_version: null, new_layout_version: null,
      backup_dir: path.join(env.stagingRoot, 'run-8', 'backup'), steps: [],
    });

    await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(mocks.scanAdHocChanges).toHaveBeenCalledWith(
      expect.anything(),
      path.join(env.memoryRoot, 'extensions', 'ad_hoc'),
    );
  });
});

describe('recoverAllPublications', () => {
  let env: OrchEnv;

  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
  });

  afterEach(() => { env.cleanup(); });

  it('1. no staging directories — returns empty results, noop', async () => {
    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(0);
    expect(mocks.recoverPublication).not.toHaveBeenCalled();
  });

  it('2. journal not found in staging dir — skipped, not recovered', async () => {
    // Create a staging dir without a journal.
    fs.mkdirSync(path.join(env.stagingRoot, 'stale-run'), { recursive: true });
    fs.writeFileSync(path.join(env.stagingRoot, 'stale-run', 'some-file.md'), '# stale');
    mocks.readJournal.mockReturnValue(null);

    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(0);
  });

  it('3. journal found with prepared state — recovers and returns discard result', async () => {
    const stagingDir = path.join(env.stagingRoot, 'run-1');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'publication.journal.json'),
      JSON.stringify({
        run_id: 'run-1',
        generation: 2,
        old_manifest_hash: 'old',
        new_manifest_hash: 'new',
        old_policy_version: null,
        new_policy_version: null,
        old_layout_version: null,
        new_layout_version: null,
        backup_dir: path.join(stagingDir, 'backup'),
        steps: [
          { step: 'backup_old', status: 'done', ts: '2026-08-03T10:00:00Z' },
          { step: 'move_leaf', status: 'pending', ts: null },
          { step: 'move_config', status: 'pending', ts: null },
          { step: 'regenerate_indexes', status: 'pending', ts: null },
          { step: 'regenerate_MEMORY_md', status: 'pending', ts: null },
          { step: 'regenerate_summary_md', status: 'pending', ts: null },
          { step: 'swap_manifest', status: 'pending', ts: null },
        ],
      })
    );

    mocks.recoverPublication.mockResolvedValue({
      action: 'discard',
      runId: 'run-1',
    });

    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('discard');
    expect(results[0].runId).toBe('run-1');
  });

  it('4. multiple staging dirs with journals — recovers all', async () => {
    for (const runId of ['run-a', 'run-b']) {
      const stagingDir = path.join(env.stagingRoot, runId);
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(
        path.join(stagingDir, 'publication.journal.json'),
        JSON.stringify({
          run_id: runId,
          generation: 1,
          old_manifest_hash: 'old',
          new_manifest_hash: 'new',
          old_policy_version: null,
          new_policy_version: null,
          old_layout_version: null,
          new_layout_version: null,
          backup_dir: path.join(stagingDir, 'backup'),
          steps: [],
        })
      );
    }

    mocks.recoverPublication
      .mockResolvedValueOnce({ action: 'discard', runId: 'run-a' })
      .mockResolvedValueOnce({ action: 'finalize', runId: 'run-b' });

    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(2);
    expect(results[0].runId).toBe('run-a');
    expect(results[1].runId).toBe('run-b');
  });
});