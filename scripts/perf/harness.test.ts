/**
 * scripts/perf/harness.test.ts — the unit tests of the performance harness.
 *
 * WHY THE TESTS LIVE HERE AND NOT IN `e2e/perf/`
 *
 * The vitest collection list (`vitest.config.ts`) does not include `e2e/**`:
 * a test file under `e2e/perf/` is a test nobody ever runs, and
 * `scripts/check-test-coverage.mjs` reports exactly that as an orphan. The
 * collected location for a script-side test is a `.test.ts` file under
 * `scripts/`, so the harness's pure functions are tested from here.
 *
 * It also closes a real CI hole: `scripts/ci/test-scope.mjs` counts the
 * `.mjs` files under `scripts/` as unit files, so a PR that only touches
 * `scripts/perf/**` used to make `vitest run --changed` fail with "No test
 * files found". There is a real test file next to those scripts now.
 *
 * WHAT IS TESTED
 *
 * The parts of the harness that decide what a report SAYS: the metric
 * aggregation, the fixture generator's determinism, the report writer, and
 * the measurement lock's mutex. Nothing here launches Electron — the
 * measurement side is exercised by the harness itself.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  frameIntervals,
  percentile,
  round,
  stability,
  summarize,
  sum,
} from '../../e2e/perf/lib/metrics.mjs';
import {
  FIXTURE_IDS,
  buildSessionMessages,
  buildToolStormRows,
  buildTypingFixture,
  fixtureDigest,
  historyRowKind,
} from '../../e2e/perf/lib/fixtures.mjs';
import { buildReport, renderMarkdown } from '../../e2e/perf/lib/report.mjs';
import {
  acquireInternalLock,
  readLockOwner,
  releaseInternalLock,
  resolveLockDir,
} from '../../e2e/perf/lib/lock.mjs';
import { closePerfElectron } from '../../e2e/perf/lib/launch.mjs';

describe('the metric aggregation', () => {
  it('reads the percentile off the sorted sample', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 5);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('ignores the values that are not numbers', () => {
    expect(percentile([1, Number.NaN, 3, null as unknown as number], 0.5)).toBe(2);
    expect(sum([1, Number.NaN, 3])).toBe(4);
  });

  it('summarizes a sample without inventing a value', () => {
    const summary = summarize([100, 200, 300]);
    expect(summary.count).toBe(3);
    expect(summary.min).toBe(100);
    expect(summary.max).toBe(300);
    expect(summary.mean).toBe(200);
    expect(summary.p50).toBe(200);
    expect(summary.spreadPct).toBe(100);
    expect(summarize([]).count).toBe(0);
    expect(summarize([]).p50).toBeNull();
  });

  it('classifies the noise level by the coefficient of variation', () => {
    // A constant metric has no variance: it is a count, not a signal.
    expect(stability([5, 5, 5]).cv).toBe(0);
    expect(stability([5, 5, 5]).level).toBe('low');
    // A spread of a few percent is quiet enough for a CI gate.
    expect(stability([100, 101, 99]).level).toBe('low');
    // A wild spread is noise.
    expect(stability([100, 200, 300]).level).toBe('high');
    // One sample cannot say anything about the noise.
    expect(stability([100]).level).toBe('unknown');
    expect(stability([]).cv).toBeNull();
  });

  it('drops the frame gaps that are not frames', () => {
    // A gap larger than two seconds is a backgrounded tab, not a frame.
    expect(frameIntervals([0, 16, 32, 4000])).toEqual([16, 16]);
    expect(frameIntervals([])).toEqual([]);
  });

  it('rounds to a stable number of decimals', () => {
    expect(round(1.005, 2)).toBe(1);
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(null)).toBeNull();
    expect(round(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('the fixture generator', () => {
  it('publishes the agreed fixture ids', () => {
    expect(FIXTURE_IDS).toEqual([
      'perf/session-100',
      'perf/session-1000',
      'perf/session-10000',
      'perf/stream-long-reply',
      'perf/stream-tool-storm',
      'perf/typing-30s',
    ]);
  });

  it('builds the requested number of rows', () => {
    expect(buildSessionMessages('perf/session-100').length).toBe(100);
    expect(buildSessionMessages('perf/session-1000').length).toBe(1000);
    expect(buildSessionMessages('perf/session-10000').length).toBe(10000);
  });

  it('keeps the documented message mix', () => {
    const rows = buildSessionMessages('perf/session-100');
    const kinds = rows.map((row: { msg_type: string }) => row.msg_type);
    const toolRows = kinds.filter((kind: string) => kind === 'tool_use' || kind === 'tool_result');
    // One 10-row block: 4 user, 4 assistant, 2 tool rows.
    expect(toolRows.length).toBe(20);
    expect(historyRowKind(0)).toBe('user');
    expect(historyRowKind(5)).toBe('tool_use');
    expect(historyRowKind(6)).toBe('tool_result');
  });

  it('is deterministic, so two runs measure the same data', () => {
    expect(fixtureDigest('perf/session-100')).toBe(fixtureDigest('perf/session-100'));
    expect(buildSessionMessages('perf/session-100')).toEqual(buildSessionMessages('perf/session-100'));
  });

  it('namespaces the row ids without changing the digest', () => {
    // The transcript store appends with INSERT OR IGNORE on the message id,
    // so two sessions of one database need different ids.
    const plain = buildSessionMessages('perf/session-100');
    const namespaced = buildSessionMessages('perf/session-100', { idPrefix: 'session-a' });
    expect(namespaced[0].id).not.toBe(plain[0].id);
    expect(namespaced[0].id.startsWith('session-a-')).toBe(true);
    // The digest is over the canonical payload, so it does not move.
    expect(fixtureDigest('perf/session-100', { idPrefix: 'session-a' })).toBe(
      fixtureDigest('perf/session-100'),
    );
  });

  it('builds the tool storm and the typing schedule', () => {
    const storm = buildToolStormRows('perf/stream-tool-storm');
    expect(storm.rows.length).toBe(400);
    expect(storm.batches.length).toBe(50);
    const typing = buildTypingFixture('perf/typing-30s');
    expect(typing.keystrokes).toBe(500);
    expect(typing.text.length).toBe(500);
  });
});

describe('the report writer', () => {
  const report = buildReport({
    results: [
      {
        scenario: 'startup',
        title: 'Electron process start to a usable composer',
        fixture: 'perf/session-100',
        fixtureDigest: 'abc123',
        status: 'ok',
        samples: [
          { index: 0, metrics: { 'startup.typeable_ms': 1200 }, observed: {} },
          { index: 1, metrics: { 'startup.typeable_ms': 1300 }, observed: {} },
        ],
        notes: { fixture: 'perf/session-100' },
      },
    ],
    environment: { buildType: 'production', cpuModel: 'test cpu', cpuCount: 8, totalMemoryMB: 1024 },
    startedAt: new Date().toISOString(),
    durationMs: 1234,
    samplesPerScenario: 2,
    lock: { enabled: true, held: true, agent: 'agentA-harness', mode: 'per-scenario' },
  });

  it('summarizes every metric of every sample', () => {
    expect(report.results[0].summary['startup.typeable_ms'].count).toBe(2);
    expect(report.results[0].summary['startup.typeable_ms'].p50).toBe(1250);
  });

  it('names the scenario and its fixture', () => {
    expect(report.results[0].scenario).toBe('startup');
    expect(report.results[0].fixture).toBe('perf/session-100');
    expect(report.results[0].fixtureDigest).toBe('abc123');
  });

  it('lists the metrics that are quiet enough for a CI gate', () => {
    // 1200 and 1300 differ, so the metric is a signal and not a constant.
    expect(report.ciCandidates.map((candidate: { metric: string }) => candidate.metric)).toContain(
      'startup.typeable_ms',
    );
  });

  it('renders a markdown summary with the environment and the lock state', () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('# Duya Desktop performance report');
    expect(markdown).toContain('production');
    expect(markdown).toContain('`startup.typeable_ms`');
    expect(markdown).toContain('measurement lock');
  });
});

describe('the measurement lock', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function lockDir(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'duya-perf-lock-'));
    temporaryDirectories.push(directory);
    return path.join(directory, 'perf-bench.lock');
  }

  it('gives the lock to exactly one holder', () => {
    const dir = lockDir();
    const first = acquireInternalLock({ lockDir: dir, agent: 'agent-a' });
    expect(first.acquired).toBe(true);
    const second = acquireInternalLock({ lockDir: dir, agent: 'agent-b' });
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain('agent-a');
    releaseInternalLock(dir);
  });

  it('records who holds it', () => {
    const dir = lockDir();
    acquireInternalLock({ lockDir: dir, agent: 'agent-a' });
    expect(readLockOwner(dir)?.agent).toBe('agent-a');
    releaseInternalLock(dir);
    expect(readLockOwner(dir)).toBeNull();
  });

  it('can be taken over when the holder went away', () => {
    const dir = lockDir();
    acquireInternalLock({ lockDir: dir, agent: 'agent-a' });
    // A crashed holder must not block the sprint forever: a lock older than
    // the timeout is stale and may be taken over.
    const takeover = acquireInternalLock({ lockDir: dir, agent: 'agent-b', timeoutMin: -1 });
    expect(takeover.acquired).toBe(true);
    expect(readLockOwner(dir)?.agent).toBe('agent-b');
    releaseInternalLock(dir);
  });

  it('resolves a lock directory inside the repository by default', () => {
    const dir = resolveLockDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe('perf-bench.lock');
  });
});

describe('the app shutdown', () => {
  it('never kills a pid that was recycled by another process', async () => {
    // When the app is already gone its pid can be handed to ANOTHER
    // process. Killing that one takes the harness down with it, so the
    // process name is checked before the tree is killed.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await closePerfElectron({
        process: () => ({ pid: child.pid }),
        close: async () => {
          throw new Error('close timeout');
        },
      });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill();
    }
  });

  it('survives a pid that is already gone', async () => {
    await expect(
      closePerfElectron({
        process: () => ({ pid: 0x7ffffff0 }),
        close: async () => {
          throw new Error('close timeout');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
