/**
 * packages/cli/src/commands/doctor-config.ts
 *
 * The CLI's config-root policy for the doctor.
 *
 * ## Why this file still exists
 *
 * The CHECKS moved to the shared diagnostics layer
 * (`packages/host/src/diagnostics/config-checks.ts`) and are now INJECTED with
 * the config root they should read. What stayed behind is the one decision
 * that is the CLI's own: WHICH root is authoritative.
 *
 * The answer is the Host's `resolveConfigRoot()`, which delegates to
 * `resolveDataRoot()` and therefore honours `DUYA_DATA_ROOT` and the test
 * namespace. The old code hardcoded `join(homedir(), '.duya')`, which meant a
 * run under a test namespace read — and reported on — the user's REAL
 * `~/.duya`.
 *
 * ## Why the shared check takes the root as a parameter
 *
 * Because the Desktop and the CLI do not necessarily agree on it: a test
 * namespace exists precisely so that a diagnostic run does not touch the real
 * install, and the Desktop may run under a different data root than the CLI
 * does. A module that resolved the root itself could not be told to look
 * somewhere else.
 */

import { resolveConfigRoot } from '@duya/host/agent-profile-config';

/**
 * The config root the CLI's doctor reads.
 *
 * Resolved once per report so every config check in that report looks at the
 * same directory.
 */
export function resolveDoctorConfigRoot(): string {
  return resolveConfigRoot();
}
