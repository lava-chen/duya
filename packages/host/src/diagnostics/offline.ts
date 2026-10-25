/**
 * packages/host/src/diagnostics/offline.ts
 *
 * The checks that need NOTHING but the local disk: the config files, and the
 * runtime file that says where a Host is listening.
 *
 * ## Why these are separate from the Host-dependent ones
 *
 * The doctor runs in two very different situations:
 *
 *  - the Desktop, which IS the Host, and can ask itself anything;
 *  - the CLI, which may be running with no Desktop at all.
 *
 * The second case is the interesting one: a diagnostic that can only answer
 * "the desktop app is not running" is useless exactly when something is
 * wrong. So the config and runtime checks read the disk DIRECTLY and run
 * whether or not a Host answers — and the Host-dependent checks (desktop,
 * plugin, session) are the ones that degrade to `skipped`.
 *
 * ## Why the runtime file is a FACT and not a lookup
 *
 * Resolving the runtime file is transport, not policy: the CLI looks it up
 * through the runtime descriptor (with its legacy-path fallbacks) and the
 * Desktop knows its own port. What the CHECKS care about is the answer — is
 * there a runtime file, is it valid, is the recorded process alive — so that
 * is what crosses the boundary.
 *
 * The PID liveness test is the caller's too: "is this process still running"
 * is a question about the local process table, and the caller is the one that
 * knows how to ask it on this platform.
 */

import type { CheckResult } from './types.js';
import { pushCheck } from './timing.js';
import { runConfigChecks } from './config-checks.js';

/**
 * What the local runtime file says about the Host.
 *
 * `absent` covers both "there is no runtime file" and "the runtime file names
 * a process that is no longer alive" — in both cases no Host is listening.
 * The optional `reason` records which of the two it was.
 */
export type DoctorRuntimeFact =
  | { readonly kind: 'running'; readonly pid: number | undefined; readonly alive: boolean }
  | { readonly kind: 'absent'; readonly reason?: string }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The inputs the offline checks need. */
export interface OfflineDiagnosticsOptions {
  /** The directory holding `config.toml` and `secrets.json`. */
  readonly configRoot: string;
  /** What the local runtime file says. */
  readonly runtime: DoctorRuntimeFact;
}

/**
 * Run the runtime checks and append them to `checks`.
 *
 * The check ids are part of the report's contract: `runtime_file_exists`,
 * `runtime_file_valid` and `runtime_pid_alive` are what a support engineer
 * greps for.
 */
export function runRuntimeChecks(checks: CheckResult[], fact: DoctorRuntimeFact): void {
  if (fact.kind === 'unreadable') {
    pushCheck(checks, {
      id: 'runtime_file_exists',
      category: 'runtime',
      status: 'error',
      message: 'Cannot read runtime file',
      hint: 'Ensure DUYA has been launched at least once.',
      details: { reason: fact.reason },
    });
    return;
  }

  if (fact.kind === 'malformed') {
    pushCheck(checks, {
      id: 'runtime_file_exists',
      category: 'runtime',
      status: 'error',
      message: 'Runtime file is malformed',
      hint: 'The runtime file is not valid JSON or has invalid fields.',
      details: { reason: fact.reason },
      issues: [{
        cause: 'The runtime file could not be parsed, so the CLI cannot find the desktop API address',
        measured: 'runtime file is not valid JSON or is missing required fields',
        expected: 'a runtime file containing a valid port and token',
        remedy: 'Quit and relaunch the DUYA app so it rewrites the runtime file.',
      }],
    });
    return;
  }

  if (fact.kind === 'absent') {
    pushCheck(checks, {
      id: 'runtime_file_exists',
      category: 'runtime',
      status: 'warning',
      message: 'Runtime file not found',
      hint: 'Open the DUYA app to create the runtime file.',
      ...(fact.reason === undefined ? {} : { details: { reason: fact.reason } }),
    });
    return;
  }

  pushCheck(checks, {
    id: 'runtime_file_exists',
    category: 'runtime',
    status: 'ok',
    message: 'Runtime file exists',
  });

  pushCheck(checks, {
    id: 'runtime_file_valid',
    category: 'runtime',
    status: 'ok',
    message: 'Runtime file is valid',
  });

  if (fact.pid === undefined) {
    pushCheck(checks, {
      id: 'runtime_pid_alive',
      category: 'runtime',
      status: 'skipped',
      message: 'PID not recorded in runtime file',
    });
    return;
  }

  pushCheck(checks, {
    id: 'runtime_pid_alive',
    category: 'runtime',
    status: fact.alive ? 'ok' : 'warning',
    message: fact.alive
      ? `Desktop process (PID ${fact.pid}) is alive`
      : `Desktop process (PID ${fact.pid}) is not responding`,
    ...(fact.alive ? {} : { hint: 'Restart DUYA if the app appears frozen.' }),
  });
}

/**
 * Run every check that needs nothing but the local disk, and append them to
 * `checks`.
 *
 * This is the half of the doctor that still produces a useful answer when no
 * Host is running at all.
 */
export function runOfflineDiagnostics(
  checks: CheckResult[],
  options: OfflineDiagnosticsOptions,
): void {
  runConfigChecks(checks, options.configRoot);
  runRuntimeChecks(checks, options.runtime);
}
