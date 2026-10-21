/**
 * Plan 587 E4.3 — aggregation, and the rule that `skipped` must not read as
 * success.
 *
 * These tests are pure functions on synthetic reports, deliberately: the exit
 * code policy is the single most consequential piece of logic in the eval tree
 * (it is what a CI job reads) and it must be testable without forking a worker.
 * The load-bearing case is the one where a case's other checks passed and one
 * was skipped — the shape that a naive "did anything fail?" aggregation turns
 * into a green.
 */

import { describe, expect, it } from 'vitest';
import { decideExit, makeCaseReport, tallyChecks, worstStatus, type CaseReport, type ReportTotals } from './suite';
import { pass, skipped, type CheckResult } from './layer';

const totals = (over: Partial<ReportTotals> = {}): ReportTotals => ({
  cases: 1, checks: 0, pass: 0, fail: 0, unknown: 0, skipped: 0, ...over,
});

const mkCase = (checks: readonly CheckResult[]): CaseReport =>
  makeCaseReport({
    id: 'c', title: 'c', caseFormatVersion: 1,
    pinnedContract: 'x', currentContract: 'x', mode: 'offline', checks,
  });

describe('E4.3 — the worst status wins', () => {
  it('ranks fail above unknown above skipped above pass', () => {
    expect(worstStatus(['pass', 'pass'])).toBe('pass');
    expect(worstStatus(['pass', 'skipped'])).toBe('skipped');
    expect(worstStatus(['skipped', 'unknown'])).toBe('unknown');
    expect(worstStatus(['unknown', 'fail'])).toBe('fail');
  });

  it('treats a case with no checks as unknown, never as a pass', () => {
    expect(worstStatus([])).toBe('unknown');
  });

  it('reports a case whose other checks passed and one was skipped as SKIPPED, not pass', () => {
    const c = mkCase([
      pass('structure/terminalStatus', 'structure', 'ok', 'runs.status = completed'),
      pass('structure/runRowDurable', 'structure', 'ok', 'durable'),
      skipped('task-artefact/file:report.txt', 'task-artefact', 'no credential', 'skipped by design'),
    ]);
    // This is the assertion the whole aggregation rule exists for. A reader who
    // sees "pass" stops looking, and the skipped check is the one that never ran.
    expect(c.status).toBe('skipped');
  });
});

describe('E4.3 — the exit code policy', () => {
  it('is 0 only when everything passed and nothing was unknown or skipped', () => {
    const exit = decideExit({ totals: totals({ checks: 4, pass: 4 }), runnerFailed: false, requireComplete: true });
    expect(exit.code).toBe(0);
  });

  it('is 1 when anything failed', () => {
    const exit = decideExit({ totals: totals({ checks: 3, pass: 2, fail: 1 }), runnerFailed: false, requireComplete: true });
    expect(exit.code).toBe(1);
  });

  it('is 2 — NOT success — when a check was unknown', () => {
    const exit = decideExit({ totals: totals({ checks: 3, pass: 2, unknown: 1 }), runnerFailed: false, requireComplete: true });
    expect(exit.code).toBe(2);
    expect(exit.reason).toMatch(/UNKNOWN/);
  });

  it('is 2 — NOT success — when a check was skipped, even on an extended suite', () => {
    const exit = decideExit({ totals: totals({ checks: 3, pass: 2, skipped: 1 }), runnerFailed: false, requireComplete: false });
    expect(exit.code).toBe(2);
    expect(exit.reason).toMatch(/SKIPPED/);
  });

  it('is 2 when a fixed suite shrank, naming that as the reason', () => {
    const exit = decideExit({ totals: totals({ checks: 3, pass: 2, skipped: 1 }), runnerFailed: false, requireComplete: true });
    expect(exit.code).toBe(2);
    expect(exit.reason).toMatch(/fixed/);
  });

  it('is 2 for an empty report: no checks ran, so nothing was proven', () => {
    const exit = decideExit({ totals: totals(), runnerFailed: false, requireComplete: true });
    expect(exit.code).toBe(2);
  });

  it('is 3 when the runner could not run at all, outranking any other outcome', () => {
    const exit = decideExit({ totals: totals({ checks: 1, fail: 1 }), runnerFailed: true, requireComplete: true });
    expect(exit.code).toBe(3);
  });

  it('ranks a real failure above an unknown, so a regression is never masked by a gap', () => {
    const exit = decideExit({ totals: totals({ checks: 5, pass: 3, fail: 1, unknown: 1 }), runnerFailed: false, requireComplete: true });
    expect(exit.code).toBe(1);
  });
});

describe('E4.3 — report tallies', () => {
  it('counts every status separately and attributes non-passing checks to a layer', () => {
    const cases = [
      mkCase([pass('a', 'structure', 'ok', 'e'), pass('b', 'safety', 'ok', 'e')]),
      mkCase([skipped('c', 'task-artefact', 'no key', 'e')]),
    ];
    const { totals: t, byLayer } = tallyChecks(cases);
    expect(t.cases).toBe(2);
    expect(t.checks).toBe(3);
    expect(t.pass).toBe(2);
    expect(t.skipped).toBe(1);
    expect(t.fail).toBe(0);
    // The skipped check is attributed to `environment`, which is where the gap
    // actually is — and it is still counted as skipped, not as a pass.
    expect(byLayer.environment).toBe(1);
    expect(byLayer.unknown).toBe(0);
  });

  it('surfaces a case whose contract pin is behind the current contract', () => {
    const c = makeCaseReport({
      id: 'c', title: 'c', caseFormatVersion: 1,
      pinnedContract: 'run-layer/old', currentContract: 'run-layer/new',
      mode: 'offline', checks: [pass('a', 'structure', 'ok', 'e')],
    });
    // A stale pin is NOT a failure — it is a prompt to re-read the expectation.
    expect(c.status).toBe('pass');
    expect(c.stalePin).toBe(true);
  });
});
