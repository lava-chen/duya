/**
 * evals/agent/runner/run-suite.ts — the runner.
 *
 * ## What this is
 *
 * A loop over the case files, each one driven through the EXISTING E4.1 harness
 * (`runLegacyLoop`, which forks the real `agent-process-entry` bundle against a
 * real loopback Anthropic SSE provider and captures real SQLite), then each
 * case's declarations evaluated by the four families, then a report.
 *
 * The runner adds no execution of its own. It does not fork, spawn, or interpret
 * a turn; every behavioural fact in a report was observed by the harness. The
 * runner's own jobs are: load and validate cases, adapt them, time them,
 * evaluate, aggregate, and write.
 *
 * ## Where the runner does NOT live
 *
 * Not in `core`, and not in any production source tree. The plan requires the
 * eval runner to stay out of core, and this file satisfies that structurally:
 * it lives under `evals/`, which no build, no package, and no tsconfig used by a
 * build includes. `production-independence.test.ts` asserts the other half — that
 * no production source imports anything under `evals/`.
 *
 * ## A case that cannot run is `skipped`, with the reason named
 *
 * Three ways a case does not reach the harness, all of them reported rather than
 * swallowed:
 *  - the case file is not valid JSON against the format → skipped, named;
 *  - the case's `formatVersion` has no migration → skipped, naming the version
 *    the loader could not read. This is the mechanism that stops an old case
 *    from quietly meaning something new;
 *  - the case needs a capability this environment lacks (a provider key) →
 *    skipped, naming the capability.
 *
 * None of the three is a pass, and all three are counted in the report's totals
 * and drive the exit code (see `./suite.ts`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLegacyLoop, type EvalRunResult } from '../../../apps/desktop/src/main/__tests__/eval-legacy-loop';
import { CaseFormatError, CURRENT_RUN_CONTRACT, migrate, type EvalCase } from '../cases/format';
import { declaredUsage, toHarnessInput, toProviderScript } from '../fixtures/to-harness-input';
import { evaluateDeclaration, type EvalEvidence } from '../evaluators/families';
import { skipped, type CheckResult } from '../evaluators/layer';
import { liveReadiness } from '../evaluators/live';
import { assembleReport, makeCaseReport, type CaseReport, type EvalReport } from '../evaluators/suite';
import { formatMatrix, matrixChecks, matrixSection } from '../matrix/section';

/**
 * Repo root, resolved from this file (`evals/agent/runner/` is three levels
 * below it).
 */
export const EVAL_REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const CASES_DIR = path.join(EVAL_REPO_ROOT, 'evals', 'agent', 'cases');

export interface SuiteSpec {
  readonly id: string;
  readonly description: string;
  readonly kind: 'fixed' | 'extended';
  /**
   * `fixed` is the small set a CI job runs. `extended` is everything, for a
   * developer or a scheduled run under the user's existing authorisation.
   */
  readonly caseIds?: readonly string[];
  readonly requireComplete: boolean;
}

/**
 * The small, fixed, high-value set.
 *
 * Chosen for coverage per second of real work, not for breadth: one case per
 * family, plus the refusal path, because a refusal that silently stopped
 * refusing is the failure that matters most and the one a green happy-path CI
 * job would never catch.
 */
export const FIXED_SUITE: SuiteSpec = {
  id: 'agent/smoke',
  description: 'the small fixed set: one case per evaluator family, plus the manifest refusal',
  kind: 'fixed',
  requireComplete: true,
};

export const EXTENDED_SUITE: SuiteSpec = {
  id: 'agent/extended',
  description: 'every case on disk; reach gaps are reported as data, not as passes',
  kind: 'extended',
  requireComplete: false,
};

export interface RunOptions {
  readonly suite: SuiteSpec;
  readonly casesDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Where to write the report. Nothing is written when omitted. */
  readonly outFile?: string;
  readonly now?: () => Date;
}

interface LoadedCase {
  readonly file: string;
  readonly id: string;
  readonly value: EvalCase | null;
  readonly problem?: { readonly reason: string; readonly detail: string };
}

async function loadCases(casesDir: string, spec: SuiteSpec): Promise<LoadedCase[]> {
  const files = (await readdir(casesDir)).filter((f) => f.endsWith('.json')).sort();
  const loaded: LoadedCase[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(casesDir, file), 'utf8')) as unknown;
    } catch (error) {
      loaded.push({
        file, id: file.replace(/\.json$/, ''), value: null,
        problem: { reason: 'the case file is not valid JSON', detail: error instanceof Error ? error.message : String(error) },
      });
      continue;
    }
    const id = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
      ? (raw as { id: string }).id
      : file.replace(/\.json$/, '');
    try {
      const outcome = migrate(raw);
      if (outcome.migrated === null) {
        loaded.push({
          file, id, value: null,
          problem: {
            reason: `case format version ${String(outcome.unsupportedFrom)} has no migration to version 1`,
            detail: 'the loader refuses to run a case whose meaning it cannot reconstruct, so this is reported as skipped rather than run under a guessed interpretation',
          },
        });
        continue;
      }
      loaded.push({ file, id, value: outcome.migrated });
    } catch (error) {
      const detail = error instanceof CaseFormatError ? error.problems.join('; ') : (error instanceof Error ? error.message : String(error));
      loaded.push({ file, id, value: null, problem: { reason: 'the case does not satisfy the case format', detail } });
    }
  }
  if (spec.caseIds !== undefined) {
    const wanted = new Set(spec.caseIds);
    return loaded.filter((c) => wanted.has(c.id));
  }
  return loaded;
}

async function runOneCase(loaded: LoadedCase, env: NodeJS.ProcessEnv): Promise<CaseReport> {
  if (loaded.value === null) {
    const problem = loaded.problem;
    const check: CheckResult = skipped(
      `case/${loaded.id}`, 'structure',
      problem?.reason ?? 'the case could not be loaded',
      problem?.detail ?? loaded.file,
    );
    return makeCaseReport({
      id: loaded.id, title: loaded.id, caseFormatVersion: -1,
      pinnedContract: 'unknown', currentContract: CURRENT_RUN_CONTRACT,
      mode: 'offline', checks: [check], environmentBlock: problem?.reason,
    });
  }

  const c = loaded.value;

  if (c.mode === 'live') {
    const readiness = liveReadiness(env);
    const check: CheckResult = skipped(
      `case/${c.id}`, 'structure',
      readiness.blockedBy ?? 'the live path is not authorised in this environment',
      'a live case is never answered by the offline provider: doing so would report a model result this run did not obtain',
    );
    return makeCaseReport({
      id: c.id, title: c.title, caseFormatVersion: c.formatVersion,
      pinnedContract: c.pinnedContract, currentContract: CURRENT_RUN_CONTRACT,
      mode: 'live', checks: [check], environmentBlock: readiness.blockedBy,
      observation: {
        determinism: 'not-claimed',
        parameters: c.live ?? null,
        metrics: {},
        // No measurement was taken, so the source is `not-measured` — not
        // `live-provider`, which would claim a provider produced numbers that
        // do not exist.
        source: 'not-measured',
        note: 'no measurement was taken: ' + String(readiness.blockedBy ?? 'the live path is not authorised here'),
      },
    });
  }

  const script = toProviderScript(c);
  const started = Date.now();
  let run: EvalRunResult;
  try {
    run = await runLegacyLoop(c.id, toHarnessInput(c));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const check: CheckResult = skipped(
      `case/${c.id}`, 'structure',
      'the harness could not start this case',
      message.slice(0, 800),
    );
    return makeCaseReport({
      id: c.id, title: c.title, caseFormatVersion: c.formatVersion,
      pinnedContract: c.pinnedContract, currentContract: CURRENT_RUN_CONTRACT,
      mode: 'offline', checks: [check], environmentBlock: 'the harness could not start this case',
    });
  }

  try {
    const evidence: EvalEvidence = {
      caseId: c.id,
      artifacts: run.artifacts,
      terminalStatus: run.terminalStatus,
      workspace: run.workspace,
      wallClockMs: Date.now() - started,
      declaredUsage: declaredUsage(script),
    };
    const checks: CheckResult[] = [
      ...c.expect.invariants.map((inv) => evaluateDeclaration(inv, evidence)),
      ...c.expect.artefacts.map((art) => evaluateDeclaration(art, evidence)),
    ];
    return makeCaseReport({
      id: c.id, title: c.title, caseFormatVersion: c.formatVersion,
      pinnedContract: c.pinnedContract, currentContract: CURRENT_RUN_CONTRACT,
      mode: 'offline', checks,
      observation: {
        head: run.artifacts.metadata.head,
        agentBundleSha256: run.artifacts.metadata.agentBundle.sha256,
        providerRequests: run.artifacts.providerRequests.length,
        toolAttempts: run.artifacts.toolAttempts.map((a) => ({ name: String(a.name), outcome: a.outcome })),
        usage: run.artifacts.usage,
        wallClockMs: evidence.wallClockMs,
      },
    });
  } finally {
    await run.dispose();
  }
}

export async function runSuite(options: RunOptions): Promise<EvalReport> {
  const casesDir = options.casesDir ?? CASES_DIR;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const loaded = await loadCases(casesDir, options.suite);

  const cases: CaseReport[] = [];
  for (const entry of loaded) {
    cases.push(await runOneCase(entry, env));
  }

  // Plan 587 E4.2: the behaviour matrix, as one case whose checks are the rows.
  //
  // It is a CASE rather than free-floating report data so the rows are counted by
  // the same tally as everything else — which is what stops a row from being
  // decorative. Every row is `skipped`, because this runner did not execute the
  // evidence (see `../matrix/section.ts`), so a matrix row can never contribute
  // to the `pass` count.
  //
  // It is added to the EXTENDED suite ONLY, and that is a load-bearing decision
  // rather than a convenience. The fixed suite is the CI gate: its contract is
  // exit 0 when every harness case is green, and every row of the matrix is
  // `skipped` by construction because this runner does not execute them. Folding
  // the matrix into the fixed suite would therefore make that gate permanently
  // red for a reason that has nothing to do with the system under test — which
  // is how a gate stops being read. The matrix is a coverage ledger, and a
  // coverage ledger belongs in the report a human reads, not in the gate a CI
  // job branches on.
  const section = matrixSection();
  if (options.suite.kind === 'extended') {
    cases.push(
      makeCaseReport({
        id: 'behaviour-matrix',
        title: 'plan 587 E4.2 — the behaviour matrix, and where each row is proved',
        caseFormatVersion: -1,
        pinnedContract: CURRENT_RUN_CONTRACT,
        currentContract: CURRENT_RUN_CONTRACT,
        mode: 'offline',
        checks: matrixChecks(),
        observation: {
          rows: section.rows,
          provedReal: section.provedReal,
          coveredByExistingSuite: section.coveredByExistingSuite,
          unsupported: section.unsupported,
          unsupportedCapabilities: [...section.unsupportedCapabilities],
        },
      }),
    );
  }

  // Proven once, from the first case that actually ran, and read from the
  // harness's own metadata rather than recomputed.
  const ranCase = cases.find((c) => c.observation !== undefined && typeof c.observation['agentBundleSha256'] === 'string');
  const obs = (ranCase?.observation ?? {}) as Record<string, unknown>;

  const readiness = liveReadiness(env);
  const unsupported = [
    'the Electron renderer / preload boundary (needs packaged Electron; not reachable from a vitest process)',
    'packaged agent bundle resolution and electron-builder output',
    ...(readiness.ready ? [] : ['live provider behaviour: ' + String(readiness.blockedBy)]),
    ...readiness.unsupported,
  ];

  const report = assembleReport({
    suiteId: options.suite.id,
    suiteDescription: options.suite.description,
    suiteKind: options.suite.kind,
    // A suite containing a live case is reported as a live report, which forces
    // `determinism: 'not-claimed'` on the whole report rather than only on the
    // live section.
    mode: cases.some((c) => c.mode === 'live') ? 'live' : 'offline',
    generatedAt: now().toISOString(),
    environment: {
      head: String(obs['head'] ?? 'unknown'),
      node: process.versions.node,
      platform: process.platform,
      agentBundleSha256: String(obs['agentBundleSha256'] ?? 'unknown'),
    },
    cases,
    unsupported,
    runnerFailed: false,
    requireComplete: options.suite.requireComplete,
    ...(options.suite.kind === 'extended' ? { matrix: section } : {}),
  });

  if (options.outFile !== undefined) {
    mkdirSync(path.dirname(options.outFile), { recursive: true });
    writeFileSync(options.outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

/** A one-line-per-case human summary, for a terminal. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`${report.suiteId}  ${report.suiteKind}  mode=${report.mode}  determinism=${report.determinism}`);
  lines.push(`head ${report.environment.head.slice(0, 12)}  node ${report.environment.node}  ${report.environment.platform}`);
  lines.push('');
  for (const c of report.cases) {
    const pin = c.stalePin ? ' (stale pin)' : '';
    lines.push(`  ${c.status.padEnd(7)} ${c.id}${pin}`);
    for (const check of c.checks) {
      lines.push(`      ${check.status.padEnd(7)} [${check.layer}] ${check.checkId} — ${check.detail}`);
    }
  }
  lines.push('');
  const t = report.totals;
  lines.push(`checks ${t.checks}  pass ${t.pass}  fail ${t.fail}  unknown ${t.unknown}  skipped ${t.skipped}`);
  const layers = Object.entries(report.byLayer).filter(([, n]) => n > 0);
  lines.push(layers.length > 0 ? `failing layers: ${layers.map(([k, n]) => `${k}=${n}`).join('  ')}` : 'failing layers: none');
  for (const u of report.unsupported) lines.push(`unsupported: ${u}`);
  if (report.matrix !== undefined) {
    lines.push('');
    lines.push('behaviour matrix (plan 587 E4.2) — R = proved on a real path, C = an existing suite owns it, U = unsupported');
    lines.push(...formatMatrix(report.matrix));
    lines.push('  every matrix row is reported as `skipped`: this runner did not execute its evidence, and a skipped check is not a pass');
  }
  lines.push(`exit ${report.exit.code}: ${report.exit.reason}`);
  return lines.join('\n');
}
