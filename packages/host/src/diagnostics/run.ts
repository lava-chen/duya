/**
 * packages/host/src/diagnostics/run.ts
 *
 * The orchestration: run every check, in order, and roll the results up.
 *
 * ## Why this is the entry point
 *
 * The timing baseline is per-accumulator-array, and it must be installed
 * BEFORE the first check runs — otherwise the first check reports the 1ms
 * floor and every later check measures from the wrong origin. Owning the
 * array here is what makes that impossible to get wrong: a caller cannot
 * forget the reset, because it never creates the array.
 *
 * The two phase functions (`runOfflineDiagnostics`, `runHostDiagnostics`)
 * remain separately callable for a caller that wants only one half — the
 * Desktop, for instance, already knows its own runtime facts and may want to
 * skip the disk half entirely.
 */

import type { CheckResult, DoctorProfile, DoctorResult } from './types.js';
import { resetTiming } from './timing.js';
import { runOfflineDiagnostics, type DoctorRuntimeFact } from './offline.js';
import { runHostDiagnostics, type DoctorHostProbe } from './host-facts.js';

/** The report schema version. Bumped when the report shape changes. */
export const DOCTOR_REPORT_VERSION = '1.0.0';

/** Everything a full doctor run needs. */
export interface DiagnosticsOptions {
  /** The directory holding `config.toml` and `secrets.json`. */
  readonly configRoot: string;
  /** What the local runtime file says. */
  readonly runtime: DoctorRuntimeFact;
  /** How to reach the Host for the desktop / plugin / session facts. */
  readonly probe: DoctorHostProbe;
}

/**
 * Roll a list of checks up into a report.
 *
 * `overallStatus` is the WORST status that is not `skipped`: a skipped check
 * is an absence of information and must not turn a healthy report into a
 * failing one.
 */
export function finalizeDoctorResult(
  checks: CheckResult[],
  profile: DoctorProfile = 'unknown',
): DoctorResult {
  const errors = checks.filter((c) => c.status === 'error').length;
  const warnings = checks.filter((c) => c.status === 'warning').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const ok = checks.filter((c) => c.status === 'ok').length;

  let overallStatus: DoctorResult['overallStatus'] = 'ok';
  if (errors > 0) {
    overallStatus = 'error';
  } else if (warnings > 0) {
    overallStatus = 'warning';
  }

  return {
    version: DOCTOR_REPORT_VERSION,
    timestamp: Date.now(),
    overallStatus,
    profile,
    checks,
    summary: { errors, warnings, skipped, ok },
  };
}

/**
 * Run every doctor check and return the aggregated result.
 *
 * The offline checks run first and unconditionally: they are the ones that
 * still say something useful when no Host is running at all.
 */
export async function runDiagnostics(options: DiagnosticsOptions): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  // Timing starts before any work so the first check is charged for the file
  // reads that produced it rather than reporting the 1ms floor.
  resetTiming(checks);

  runOfflineDiagnostics(checks, {
    configRoot: options.configRoot,
    runtime: options.runtime,
  });

  await runHostDiagnostics(checks, options.probe);

  return finalizeDoctorResult(checks);
}
