/**
 * Plan 587 E4.3 — the runner, driving real cases through the EXISTING E4.1
 * harness.
 *
 * This is the acceptance evidence: the runner forks the real
 * `agent-process-entry` bundle against the real loopback Anthropic SSE provider,
 * on real SQLite, evaluates the four families, and produces a report whose
 * numbers came from a running system.
 *
 * The `structure-text-only`, `task-artefact-write-file` and
 * `safety-manifest-refused` cases are the small fixed high-value set: one per
 * family plus the refusal path. The live case is included on purpose — it must
 * appear as `skipped` with the missing capability named, which is what proves
 * the report never turns a missing key into a pass.
 *
 * Every case forks a real process and a real SQLite file, so the timeouts here
 * are budgets for that, not for a unit test.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENDED_SUITE, FIXED_SUITE, formatReport, runSuite } from './run-suite';
import type { EvalReport } from '../evaluators/suite';

const outDir = mkdtempSync(path.join(tmpdir(), 'duya-e43-report-'));

/** The small fixed set. No live case: a fixed CI set may not depend on a key. */
const FIXED_IDS = ['structure-text-only', 'task-artefact-write-file', 'safety-manifest-refused'] as const;

/**
 * One run of the fixed set, shared by the assertions below.
 *
 * Each case forks a real worker process and writes a real SQLite file, so
 * running the set once per assertion would triple the wall clock to re-derive a
 * report that cannot differ — the harness is deterministic by construction, and
 * the assertions are about the same report. The live case is run separately,
 * because it exercises a different branch and cannot fork at all.
 */
let fixedRun: Promise<EvalReport> | null = null;
function runFixed(): Promise<EvalReport> {
  fixedRun ??= runSuite({
    suite: { ...FIXED_SUITE, caseIds: FIXED_IDS },
    env: {},
    outFile: path.join(outDir, 'fixed.json'),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return fixedRun;
}

describe('E4.3 — the fixed set, through the real harness', () => {
  it(
    'runs the small fixed set and reports every check green',
    async () => {
      const report = await runFixed();

      // The harness really ran: a real bundle, a real loopback provider, a real
      // run row. Nothing here is a stub.
      expect(report.cases).toHaveLength(3);
      for (const c of report.cases) {
        expect(c.checks.length).toBeGreaterThan(0);
        expect(c.checks.filter((k) => k.status !== 'pass')).toEqual([]);
        expect(c.status).toBe('pass');
      }

      expect(report.totals.fail).toBe(0);
      expect(report.totals.unknown).toBe(0);
      expect(report.totals.skipped).toBe(0);
      // A fixed suite that skipped or could not decide is NOT a pass, and the
      // exit code says so.
      expect(report.exit.code).toBe(0);
      expect(report.determinism).toBe('exact-assertion');

      // The environment block is what makes the provenance readable: this
      // report proves nothing about Electron, the packaged bundle, or a live
      // provider, and it says so rather than leaving the gap implicit.
      expect(report.unsupported.join(' ')).toMatch(/Electron renderer/);
      expect(report.unsupported.join(' ')).toMatch(/live provider/);
      expect(report.environment.agentBundleSha256).toMatch(/^[0-9a-f]{64}$/);
    },
    900_000,
  );

  it(
    'the task-artefact case proved a REAL file exists, and the refusal case proved the provider was never reached',
    async () => {
      const report = await runFixed();
      const artefactCase = report.cases.find((c) => c.id === 'task-artefact-write-file');
      expect(artefactCase).toBeDefined();
      // The file check reads bytes off the temp workspace. A pass here means a
      // real write tool really wrote a real file.
      const fileCheck = artefactCase?.checks.find((k) => k.checkId === 'task-artefact/file:summary.txt');
      expect(fileCheck?.status).toBe('pass');
      expect(fileCheck?.detail).toMatch(/satisfies equals/);

      const refused = report.cases.find((c) => c.id === 'safety-manifest-refused');
      expect(refused?.status).toBe('pass');
      expect(refused?.checks.find((k) => k.checkId === 'safety/providerNotReached')?.status).toBe('pass');
      expect(refused?.checks.find((k) => k.checkId === 'structure/terminalErrorCode')?.status).toBe('pass');
    },
    900_000,
  );

  it(
    'a live case is SKIPPED with the missing capability named, and the exit code is 2 — not success',
    async () => {
      const report = await runSuite({
        suite: { ...EXTENDED_SUITE, caseIds: ['live-task-artefact-requires-key'] },
        // No credential: exactly the environment this work ran in.
        env: {} as NodeJS.ProcessEnv,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      // Selected by id, not by position. Plan 587 E4.2 appends the behaviour
      // matrix as a case of its own on the extended suite, so `cases[0]` is no
      // longer "the one case that ran" — and an assertion that counted cases
      // would have been asserting the report's shape rather than the live case's
      // behaviour, which is what this test is for.
      const live = report.cases.find((c) => c.id === 'live-task-artefact-requires-key');
      expect(live).toBeDefined();
      expect(live?.mode).toBe('live');
      expect(live?.status).toBe('skipped');
      expect(live?.environmentBlock).toMatch(/live-provider-credentials/);
      expect(live?.checks.every((k) => k.status === 'skipped')).toBe(true);

      // The matrix rides along in the same report, and it is `skipped` there too.
      // Asserting it here is what keeps E4.2's rows from being a decoration that
      // a future change could quietly turn green: if a matrix row ever became a
      // `pass`, this line would go red.
      const matrix = report.cases.find((c) => c.id === 'behaviour-matrix');
      expect(matrix).toBeDefined();
      expect(matrix?.checks.length).toBeGreaterThan(0);
      expect(matrix?.checks.every((k) => k.status === 'skipped')).toBe(true);
      expect(matrix?.checks.every((k) => k.checkId.startsWith('matrix/'))).toBe(true);

      // The whole report is a live report, so it may not claim determinism.
      expect(report.determinism).toBe('not-claimed');
      // Not success. This is the single most important line in this file.
      expect(report.exit.code).toBe(2);
      expect(report.exit.reason).toMatch(/SKIPPED/);
    },
    300_000,
  );
});

describe('E4.3 — the report is readable', () => {
  it('renders a summary that names the exit code and the unsupported capabilities', async () => {
    const report = await runSuite({
      suite: { ...EXTENDED_SUITE, caseIds: ['live-task-artefact-requires-key'] },
      env: {} as NodeJS.ProcessEnv,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const text = formatReport(report);
    expect(text).toMatch(/live-task-artefact-requires-key/);
    expect(text).toMatch(/exit 2/);
    expect(text).toMatch(/unsupported:/);
    expect(text).toMatch(/determinism=not-claimed/);
  }, 300_000);
});
