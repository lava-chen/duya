/**
 * evals/agent/evaluators/suite.ts — aggregation, and the rule that `skipped`
 * must not read as success.
 *
 * ## The aggregation rule
 *
 * A case's status is the WORST of its checks, under a fixed severity order:
 *
 *     fail  >  unknown  >  skipped  >  pass
 *
 * `skipped` outranks `pass` on purpose. A case whose other four checks passed
 * and whose fifth could not run is `skipped`, not `pass` — because the reader
 * who sees `pass` stops looking, and the fifth check is exactly the one that was
 * never exercised. Under-reporting reach is the failure mode that compounds.
 *
 * `unknown` outranks `skipped` for the mirror-image reason: "the system would
 * not tell me" is a more important fact than "I could not ask".
 *
 * A case with NO checks cannot be a pass either. The validator requires a
 * non-empty `expect.invariants`, so a check-less case is a validation failure,
 * not a quiet success.
 *
 * ## The exit code policy
 *
 *   0  every check passed; nothing unknown, nothing skipped
 *   1  at least one check failed
 *   2  nothing failed, but something was unknown or skipped  ← NOT success
 *   3  the suite could not run at all (the environment, not the system)
 *
 * `fail` outranks `unknown`/`skipped` so a real regression is never masked by
 * an unrelated gap, and 2 is deliberately distinct from 0 so a CI job that runs
 * the fixed set cannot go green on a set that silently shrank.
 *
 * For the FIXED set that CI runs, `requireComplete` is on, so any unknown or
 * skipped check is a failure of the gate. For the extended set, which needs
 * capabilities a developer machine may not have, `requireComplete` is off and
 * the report carries the gaps as data with exit 2.
 */

import { CHECK_STATUSES, type AttributedLayer, type CheckResult, type CheckStatus, type EvalFamily } from './layer';
import type { MatrixSection } from '../matrix/section';

const SEVERITY: Readonly<Record<CheckStatus, number>> = {
  pass: 0,
  skipped: 1,
  unknown: 2,
  fail: 3,
};

export function worseStatus(a: CheckStatus, b: CheckStatus): CheckStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce<CheckStatus>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'pass');
}

export interface CaseReport {
  readonly id: string;
  readonly title: string;
  readonly caseFormatVersion: number;
  /** The run-layer contract these expectations were written against. */
  readonly pinnedContract: string;
  /** True when the pin is behind the contract the runner is running today. */
  readonly stalePin: boolean;
  readonly mode: 'offline' | 'live';
  readonly status: CheckStatus;
  readonly checks: readonly CheckResult[];
  /** The distinct layers this case's non-passing checks attributed to. */
  readonly failingLayers: readonly AttributedLayer[];
  /** Set when the case could not run here. Named, never empty-stringed. */
  readonly environmentBlock?: string;
  readonly observation?: Record<string, unknown>;
}

export interface ReportTotals {
  readonly cases: number;
  readonly checks: number;
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly skipped: number;
}

export type ExitCode = 0 | 1 | 2 | 3;

export interface EvalReport {
  readonly reportVersion: 1;
  readonly suiteId: string;
  readonly suiteDescription: string;
  /** `fixed` is the small set CI runs; `extended` is the wider set. */
  readonly suiteKind: 'fixed' | 'extended';
  readonly mode: 'offline' | 'live';
  /**
   * `exact-assertion` for the offline path, `not-claimed` for live. A live run
   * reports a sample and its spread; it never claims per-token determinism, and
   * this field is on every report so that claim cannot be made by omission.
   */
  readonly determinism: 'exact-assertion' | 'not-claimed';
  readonly generatedAt: string;
  readonly environment: {
    readonly head: string;
    readonly node: string;
    readonly platform: string;
    readonly agentBundleSha256: string;
  };
  readonly totals: ReportTotals;
  /** How many non-passing checks attributed to each layer. */
  readonly byLayer: Readonly<Record<AttributedLayer, number>>;
  readonly cases: readonly CaseReport[];
  /**
   * Plan 587 E4.2: the behaviour matrix, as report data.
   *
   * Optional and additive. The matrix is a CLAIM about what is proved, not a
   * check that ran, so it is reported beside the checks rather than folded into
   * them: a row this runner did not execute must never be able to raise the
   * `pass` count. Every matrix row also appears as a `skipped` check (see
   * `../matrix/section.ts`), which is what makes the totals count it.
   */
  readonly matrix?: MatrixSection;
  /** Capabilities this report does NOT prove, named. */
  readonly unsupported: readonly string[];
  readonly exit: { readonly code: ExitCode; readonly reason: string };
}

function emptyLayerTally(): Record<AttributedLayer, number> {
  return {
    contract: 0, 'host-adapter': 0, 'model-decision': 0, tool: 0, storage: 0, policy: 0, environment: 0, unknown: 0,
  };
}

export function tallyChecks(cases: readonly CaseReport[]): { totals: ReportTotals; byLayer: Record<AttributedLayer, number> } {
  // A mutable accumulator, accumulated into a readonly shape on return: the
  // report type stays immutable for consumers while the tally is still a plain
  // counter rather than a reduce over string keys.
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, unknown: 0, skipped: 0 };
  const byLayer = emptyLayerTally();
  let checks = 0;
  for (const c of cases) {
    for (const check of c.checks) {
      checks++;
      counts[check.status]++;
      if (check.status !== 'pass') byLayer[check.layer]++;
    }
  }
  const totals: ReportTotals = { cases: cases.length, checks, ...counts };
  return { totals, byLayer };
}

/**
 * The exit code. Split out so it can be tested on synthetic reports without
 * forking a real worker process, and so the policy is one readable function
 * rather than a rule scattered across the runner.
 */
export function decideExit(input: {
  readonly totals: ReportTotals;
  readonly runnerFailed: boolean;
  readonly requireComplete: boolean;
}): { code: ExitCode; reason: string } {
  if (input.runnerFailed) {
    return { code: 3, reason: 'the suite could not run: the environment prevented execution, not the system under test' };
  }
  if (input.totals.fail > 0) {
    return { code: 1, reason: `${input.totals.fail} check(s) failed` };
  }
  if (input.totals.unknown > 0) {
    return { code: 2, reason: `${input.totals.unknown} check(s) were UNKNOWN: the system did not decide, and that is not success` };
  }
  if (input.totals.skipped > 0) {
    return input.requireComplete
      ? { code: 2, reason: `${input.totals.skipped} check(s) were SKIPPED and this suite is fixed: a fixed set that shrinks is a red gate` }
      : { code: 2, reason: `${input.totals.skipped} check(s) were SKIPPED: reach was not proven, and that is not success` };
  }
  if (input.totals.checks === 0) {
    return { code: 2, reason: 'no check ran: an empty report is not a passing report' };
  }
  return { code: 0, reason: `all ${input.totals.checks} check(s) passed; nothing unknown, nothing skipped` };
}

export interface AssembleInput {
  readonly suiteId: string;
  readonly suiteDescription: string;
  readonly suiteKind: 'fixed' | 'extended';
  readonly mode: 'offline' | 'live';
  readonly generatedAt: string;
  readonly environment: EvalReport['environment'];
  readonly cases: readonly CaseReport[];
  readonly unsupported: readonly string[];
  readonly runnerFailed: boolean;
  readonly requireComplete: boolean;
  readonly matrix?: MatrixSection;
}

export function assembleReport(input: AssembleInput): EvalReport {
  const { totals, byLayer } = tallyChecks(input.cases);
  const exit = decideExit({
    totals, runnerFailed: input.runnerFailed, requireComplete: input.requireComplete,
  });
  return {
    reportVersion: 1,
    suiteId: input.suiteId,
    suiteDescription: input.suiteDescription,
    suiteKind: input.suiteKind,
    mode: input.mode,
    // A live report never claims exact assertion, whatever the numbers look like.
    determinism: input.mode === 'live' ? 'not-claimed' : 'exact-assertion',
    generatedAt: input.generatedAt,
    environment: input.environment,
    totals,
    byLayer,
    cases: input.cases,
    ...(input.matrix === undefined ? {} : { matrix: input.matrix }),
    unsupported: input.unsupported,
    exit,
  };
}

export function makeCaseReport(input: {
  id: string;
  title: string;
  caseFormatVersion: number;
  pinnedContract: string;
  currentContract: string;
  mode: 'offline' | 'live';
  checks: readonly CheckResult[];
  environmentBlock?: string;
  observation?: Record<string, unknown>;
}): CaseReport {
  const status = worstStatus(input.checks.map((c) => c.status));
  const layers = new Set<AttributedLayer>();
  for (const check of input.checks) {
    if (check.status !== 'pass') layers.add(check.layer);
  }
  return {
    id: input.id,
    title: input.title,
    caseFormatVersion: input.caseFormatVersion,
    pinnedContract: input.pinnedContract,
    stalePin: input.pinnedContract !== input.currentContract,
    mode: input.mode,
    status,
    checks: input.checks,
    failingLayers: [...layers].sort(),
    environmentBlock: input.environmentBlock,
    observation: input.observation,
  };
}

/** Every status, exported so a report's own shape can be validated in a test. */
export { CHECK_STATUSES };
