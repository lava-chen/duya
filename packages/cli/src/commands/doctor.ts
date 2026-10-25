/**
 * packages/cli/src/commands/doctor.ts
 *
 * `duya doctor` — read-only diagnostic that checks the health of DUYA's
 * local runtime, CLI API server, data stores, and config files.
 *
 * ## This file is a THIN SHELL
 *
 * The report shape, the checks, the timing and the redaction all live in the
 * shared diagnostics layer (`@duya/host/diagnostics`), because the Desktop
 * has to be able to run the same checks and say the same things. What stays
 * here is the CLI's part and nothing else:
 *
 *  - WHERE the config root is (`resolveConfigRoot()`);
 *  - HOW the Host is reached (the Desktop's CLI API, over HTTP);
 *  - how the result is printed (text or JSON) and what the exit code means.
 *
 * Design principles:
 * - Never throws; always produces output (text or JSON)
 * - Desktop app unavailability is reported as `skipped` checks, not failure
 * - No credentials, tokens, or absolute paths in output
 * - exit 0 for ok/warning; exit 1 for error
 */

import { renderJson, type OutputFormat } from '../api/format.js';
import {
  redactDoctorJson,
  renderText,
  runDiagnostics,
  type CheckResult,
  type DoctorIssue,
  type DoctorResult,
} from '@duya/host/diagnostics';
import { resolveDoctorConfigRoot } from './doctor-config.js';
import { createDesktopCliApiProbe, resolveRuntimeFact } from './doctor-probe.js';

export type { CheckResult, DoctorIssue, DoctorResult };
export { renderText };

/**
 * Run the CLI's doctor and return the report.
 *
 * Exported so the TUI's `/doctor` can run the SAME checks and render the same
 * result, rather than growing a second implementation.
 */
export async function runCliDiagnostics(): Promise<DoctorResult> {
  return runDiagnostics({
    configRoot: resolveDoctorConfigRoot(),
    runtime: await resolveRuntimeFact(),
    probe: createDesktopCliApiProbe(),
  });
}

/**
 * Whether the report could not reach a Host at all.
 *
 * A `skipped` `desktop_reachable` is the shared layer's way of saying "this
 * Host could not answer", which is an absence of information rather than a
 * failure — the report says so. The EXIT CODE is the CLI command's own
 * contract, and it keeps saying what it always said: a desktop app that
 * cannot be reached is a problem with the install, and `duya doctor` exits 1
 * so a script can act on it.
 */
function hostWasUnreachable(result: DoctorResult): boolean {
  return result.checks.some(
    (check) => check.id === 'desktop_reachable' && check.status === 'skipped',
  );
}

/**
 * Entry point for `duya doctor` command.
 * Returns exit code: 0 for ok/warning, 1 for error.
 */
export async function runDoctorCommand(format: OutputFormat): Promise<number> {
  const result = await runCliDiagnostics();

  if (format === 'json') {
    // The JSON view is the artifact people paste into a bug report, so it goes
    // through its own redaction pass rather than serializing the internal
    // result. The text view keeps absolute paths on purpose: a `chmod 600
    // "<path>"` hint is only actionable if the path is there.
    process.stdout.write(renderJson(redactDoctorJson(result)) + '\n');
  } else {
    process.stdout.write(renderText(result) + '\n');
  }

  return result.overallStatus === 'error' || hostWasUnreachable(result) ? 1 : 0;
}
