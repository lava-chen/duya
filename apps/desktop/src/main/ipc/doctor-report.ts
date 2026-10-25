/**
 * apps/desktop/src/main/ipc/doctor-report.ts
 *
 * The Desktop's `/doctor` report — the in-process counterpart of the CLI's
 * `duya doctor`.
 *
 * ## Why the Desktop does not probe an HTTP surface
 *
 * The CLI asks the Desktop over `http://127.0.0.1:<port>/v1/...` because the
 * CLI is a DIFFERENT PROCESS. The Desktop IS the Host: the plugin registry,
 * the SQLite core database and the status handler all live in this very
 * process. So the `desktop` / `plugin` / `session` categories are answered
 * here, in place, and never over HTTP. A check that says "the desktop could
 * not be reached" would be a lie on this surface — the desktop is running,
 * it is this code.
 *
 * ## This file is an ADAPTER, not an implementation
 *
 * The CHECKS live in the shared diagnostics layer
 * (`@duya/host/diagnostics`) — the same layer the CLI runs. The Desktop
 * supplies facts and a profile; the layer decides what those facts mean. If
 * the checks lived here as well, the two surfaces would eventually report
 * different things about the same install, and a comparison between two bug
 * reports would stop meaning anything.
 *
 * The report the renderer receives is the layer's `DoctorResult`, unchanged:
 * the wire is defined once, in `@duya/agent-protocol`.
 */

import {
  finalizeDoctorResult,
  resetTiming,
  runHostDiagnostics,
  runOfflineDiagnostics,
  type CheckResult,
  type DoctorHostProbe,
  type DoctorRuntimeFact,
} from '@duya/host/diagnostics';
import { resolveConfigRoot } from '@duya/host/agent-profile-config';

import type { DoctorProfile, DoctorResult } from '../../contracts/doctor';

/**
 * The config root the Desktop reads its configuration from.
 *
 * Resolved the same way the Host resolves it, so the config checks read the
 * same files the app itself reads.
 */
export function desktopConfigRoot(): string {
  return resolveConfigRoot();
}

/**
 * The runtime fact.
 *
 * The Desktop IS the running app, so the process the runtime file names is
 * this one — and it is alive by definition.
 */
export function desktopRuntimeFact(): DoctorRuntimeFact {
  return { kind: 'running', pid: process.pid, alive: true };
}

/**
 * Assemble the report.
 *
 * Split out from the handler so the shape can be exercised without an
 * Electron event, and so the reading order is explicit: the offline checks
 * first (they are the cheapest and the least likely to fail), then the
 * in-process ones, then the roll-up.
 */
export async function collectDoctorReport(
  probe: DoctorHostProbe,
  profile: DoctorProfile,
  configRoot: string = desktopConfigRoot(),
): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  // Timing starts before any work so the first check is charged for the file
  // reads that produced it rather than reporting the 1ms floor.
  resetTiming(checks);

  runOfflineDiagnostics(checks, {
    configRoot,
    runtime: desktopRuntimeFact(),
  });

  await runHostDiagnostics(checks, probe);

  return finalizeDoctorResult(checks, profile);
}
