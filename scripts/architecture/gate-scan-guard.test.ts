/**
 * gate-scan-guard.test.ts — plan 610 CI wiring.
 *
 * ## Why this file exists
 *
 * `gate-scan-guard.mjs` was added to CI as the thing that distinguishes a
 * clean gate from a blind one. That makes the guard itself a gate, and a gate
 * with no test is a claim: edit `checks` down to an empty array one day and it
 * passes every run forever while enforcing nothing. Nothing else in the repo
 * would notice — the two gates it guards are unaffected by their own guard.
 *
 * So the checks are pinned here against SYNTHETIC reports, which is the only
 * way to reach the blind states: on the live tree both gates are clean, and a
 * test that can only ever see a clean tree cannot tell a working check from a
 * check that matches nothing.
 *
 * ## The two fixtures are not invented
 *
 * Each blind fixture below reproduces, field for field, a state that was
 * MEASURED on this repository by mutating the real gate and observing it go
 * green while blind:
 *
 *   - `blankBrowserReport` is what `browser-closure-gate.mjs` produced when
 *     `seedsFor` was made to return `[]`: `PASS 0/0`, exit 0.
 *   - `blankHeadlessReport` is what `headless-load-gate.mjs` produced when
 *     `handlerLayerModules` was made to return `[]`: `0/0 modules — GREEN`,
 *     exit 0.
 *
 * Both mutations were reverted. These fixtures are the standing record of why
 * the guard steps exist in `test.yml`.
 *
 * Nothing here edits the live source tree: the shared checkout is under active
 * modification by other agents.
 */

import { describe, expect, it } from 'vitest';

import { BROWSER_CLOSURE_CHECKS, HEADLESS_LOAD_CHECKS } from './gate-scan-guard.mjs';

/** The mutation-M1 shape: entries found, resolver followed nothing. */
const blankBrowserReport = {
  entries: [{ rel: 'apps/desktop/src/renderer', seeds: 0, closure: 0 }],
  absentEntries: ['apps/web/src/main.tsx'],
  findings: [],
  walked: 0,
};

/** The mutation-M2 shape: handler layer empty, every verdict list empty. */
const blankHeadlessReport = {
  a1a: { scope: 0, hard: [], unexplained: [] },
  a1b: { scope: 0, patchArmed: true, probeError: null, attributed: [] },
};

/** A healthy report of the same shape, so the fixtures above are not trivially red. */
const healthyBrowserReport = {
  entries: [{ rel: 'apps/desktop/src/renderer', seeds: 591, closure: 789 }],
  absentEntries: ['apps/web/src/main.tsx'],
  findings: [],
  walked: 789,
};

const healthyHeadlessReport = {
  a1a: { scope: 23, hard: [], unexplained: [] },
  a1b: { scope: 23, patchArmed: true, probeError: null, attributed: [] },
};

const failedChecks = (result: { checks: { ok: boolean }[] }) =>
  result.checks.filter((c) => !c.ok).map((c) => c.what);

describe('gate-scan-guard — browser closure (G10)', () => {
  it('accepts a healthy report, so the blank fixtures are not trivially red', () => {
    const result = BROWSER_CLOSURE_CHECKS.fromReport(healthyBrowserReport);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(failedChecks(result)).toEqual([]);
    expect(result.scope).toContain('789');
  });

  it('rejects a closure that walked zero files even though an entry was present', () => {
    const result = BROWSER_CLOSURE_CHECKS.fromReport(blankBrowserReport);
    expect(failedChecks(result)).toContain('the value-import closure followed at least one edge');
    expect(failedChecks(result)).toContain('each present entry contributed seeds');
  });

  it('rejects a tree with no browser entry at all', () => {
    const result = BROWSER_CLOSURE_CHECKS.fromReport({
      ...healthyBrowserReport,
      entries: [],
      walked: 0,
    });
    expect(failedChecks(result)).toContain('at least one browser entry is present on this tree');
  });
});

describe('gate-scan-guard — headless load (A1)', () => {
  it('accepts a healthy report, so the blank fixture is not trivially red', () => {
    const result = HEADLESS_LOAD_CHECKS.fromReport(healthyHeadlessReport);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(failedChecks(result)).toEqual([]);
    expect(result.scope).toContain('23');
  });

  it('rejects an empty handler layer, which the gate itself calls GREEN', () => {
    const result = HEADLESS_LOAD_CHECKS.fromReport(blankHeadlessReport);
    expect(failedChecks(result)).toContain('the handler layer is non-empty');
    expect(failedChecks(result)).toContain('the probe actually ran against modules');
  });

  it('rejects a disarmed refusal patch', () => {
    const result = HEADLESS_LOAD_CHECKS.fromReport({
      ...healthyHeadlessReport,
      a1b: { ...healthyHeadlessReport.a1b, patchArmed: false },
    });
    expect(failedChecks(result)).toContain("the require('electron') refusal patch was armed");
  });

  it('rejects a probe that errored instead of measuring', () => {
    const result = HEADLESS_LOAD_CHECKS.fromReport({
      ...healthyHeadlessReport,
      a1b: { ...healthyHeadlessReport.a1b, probeError: 'spawn ENOENT' },
    });
    expect(failedChecks(result)).toContain('the probe reported no error');
  });
});

describe('gate-scan-guard — the guard cannot be emptied', () => {
  it('still emits checks for a blank report instead of short-circuiting to none', () => {
    // The failure mode this file exists for: a check list reduced to `[]`, which
    // makes `failed.length === 0` and the guard exits 0 on every input.
    expect(BROWSER_CLOSURE_CHECKS.fromReport(blankBrowserReport).checks.length).toBeGreaterThan(0);
    expect(HEADLESS_LOAD_CHECKS.fromReport(blankHeadlessReport).checks.length).toBeGreaterThan(0);
  });
});
