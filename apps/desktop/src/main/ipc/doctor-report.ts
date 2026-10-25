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
 * That is also why `skipped` is rare here. `skipped` means "this check does
 * not apply in this environment"; it never means "this check failed". The
 * Desktop can answer every one of the six categories.
 *
 * ## This module is a LOCAL stand-in for the Host diagnostics layer
 *
 * The Host-owned diagnostics layer (`packages/host/src/diagnostics/`) is
 * being written by another worker, and it owns the CHECKS. Until it lands,
 * this module assembles the same report shape so the Desktop has a working
 * `/doctor` today.
 *
 * The three entry points below deliberately carry the Host layer's names and
 * signatures:
 *
 *   - `runOfflineDiagnostics(checks, { configRoot })`
 *   - `runDesktopDiagnostics(checks, facts)`
 *   - `finalizeDoctorResult(checks, profile)`
 *
 * so that swapping to the Host layer is a matter of deleting this file and
 * changing one import. See the handoff notes for the exact diff.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveConfigRoot } from '@duya/host/agent-profile-config';

import type {
  DoctorCategory,
  DoctorCheck,
  DoctorOverallStatus,
  DoctorProfile,
  DoctorReport,
  DoctorSummary,
} from '../../contracts/doctor';

/** The report schema version — bumped when the WIRE shape changes. */
export const DOCTOR_REPORT_VERSION = '1.0.0';

/** The categories, in the order a report presents them. */
const CATEGORY_ORDER: readonly DoctorCategory[] = [
  'config',
  'runtime',
  'desktop',
  'database',
  'plugin',
  'session',
];

/**
 * The facts only the Desktop can produce.
 *
 * Each entry is a MEASUREMENT, not a verdict: `readable: false` with a
 * `detail` saying why is what lets the report distinguish "the registry is
 * broken" from "there are no plugins".
 */
export interface DesktopFactsApi {
  /** The Desktop's own status: does the in-process health API answer? */
  readonly status: { readonly reachable: boolean; readonly detail?: string };
  /** The main window. */
  readonly window: { readonly present: boolean; readonly detail?: string };
  /** The plugin registry. */
  readonly plugins: { readonly readable: boolean; readonly count: number | null; readonly detail?: string };
  /** The session store. */
  readonly sessions: { readonly queryWorks: boolean; readonly count: number | null; readonly detail?: string };
  /** The core SQLite database. */
  readonly database: { readonly ready: boolean; readonly detail?: string };
}

// ============================================================================
// Timing
// ============================================================================

/** Smallest duration reported, so a fast check never looks unmeasured. */
const MIN_REPORTED_DURATION_MS = 1;

/**
 * One baseline per accumulator array.
 *
 * A check's duration is the work performed since the previous recorded check,
 * so timing each call site by hand would mean keeping dozens of start/stop
 * pairs in sync — the classic way a duration silently measures the wrong
 * span. Keyed by array identity so two reports built in one process (the
 * tests do exactly that) cannot leak state into each other.
 */
const timingBaselines = new WeakMap<DoctorCheck[], number>();

/** Start attributing durations to `checks`. */
export function resetTiming(checks: DoctorCheck[]): void {
  timingBaselines.set(checks, Date.now());
}

/** Append `check`, stamped with the time since the previous push. */
function pushCheck(checks: DoctorCheck[], check: DoctorCheck): void {
  const now = Date.now();
  const previous = timingBaselines.get(checks);
  timingBaselines.set(checks, now);
  if (check.durationMs !== undefined) {
    checks.push(check);
    return;
  }
  const elapsed = previous === undefined ? 0 : now - previous;
  checks.push({ ...check, durationMs: Math.max(MIN_REPORTED_DURATION_MS, elapsed) });
}

// ============================================================================
// Offline checks — config and runtime
// ============================================================================

/**
 * The checks that do not need the Desktop: the configuration files on disk
 * and the process itself.
 *
 * `configRoot` is passed in rather than resolved here so the same function
 * can be pointed at a fixture directory.
 */
export function runOfflineDiagnostics(
  checks: DoctorCheck[],
  options: { readonly configRoot: string },
): void {
  const root = options.configRoot;

  // config_root_exists
  let rootExists = false;
  let rootDetail: string | undefined;
  try {
    rootExists = fs.statSync(root).isDirectory();
    if (!rootExists) rootDetail = 'the config root exists but is not a directory';
  } catch (error) {
    rootDetail = error instanceof Error ? error.message : String(error);
  }
  pushCheck(checks, {
    id: 'config_root_exists',
    category: 'config',
    status: rootExists ? 'ok' : 'error',
    message: rootExists ? 'Config root exists' : 'Config root is missing',
    ...(rootDetail === undefined ? {} : { hint: rootDetail }),
    ...(rootExists ? {} : { details: { configRoot: root } }),
  });

  // config_file_exists
  const configPath = path.join(root, 'config.toml');
  const configExists = fs.existsSync(configPath);
  pushCheck(checks, {
    id: 'config_file_exists',
    category: 'config',
    status: configExists ? 'ok' : 'warning',
    message: configExists ? 'config.toml exists' : 'config.toml not found',
    ...(configExists ? {} : { hint: 'Launch the duya app once to generate a default config.' }),
  });

  // config_secrets_parses — JSON only, so this stays dependency-free.
  const secretsPath = path.join(root, 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    pushCheck(checks, {
      id: 'config_secrets_parses',
      category: 'config',
      status: 'warning',
      message: 'secrets.json not found',
      hint: 'Secrets live in their own file; saving a provider API key creates it.',
    });
  } else {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      pushCheck(checks, {
        id: 'config_secrets_parses',
        category: 'config',
        status: isObject ? 'ok' : 'error',
        message: isObject ? 'secrets.json parses successfully' : 'secrets.json root is not an object',
      });
    } catch (error) {
      pushCheck(checks, {
        id: 'config_secrets_parses',
        category: 'config',
        status: 'error',
        message: 'secrets.json failed to parse',
        hint: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // runtime_process — the Desktop's own process, which is the runtime the
  // user is looking at. The CLI's runtime checks answer a different question
  // (is the DESKTOP alive), which is why the ids differ.
  pushCheck(checks, {
    id: 'runtime_process',
    category: 'runtime',
    status: 'ok',
    message: `Electron ${process.versions.electron ?? 'unknown'} · Node ${process.versions.node} · pid ${process.pid}`,
    details: {
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
    },
  });
}

// ============================================================================
// Desktop checks — desktop, plugin, session, database
// ============================================================================

/**
 * The checks that need the running app, answered in place.
 *
 * Nothing here reports `skipped` for "the desktop was unreachable": on this
 * surface the desktop cannot be unreachable. A check that could not be
 * answered reports `error` with the reason.
 */
export function runDesktopDiagnostics(checks: DoctorCheck[], facts: DesktopFactsApi): void {
  // desktop_reachable
  pushCheck(checks, {
    id: 'desktop_reachable',
    category: 'desktop',
    status: facts.status.reachable ? 'ok' : 'error',
    message: facts.status.reachable ? 'Desktop app is running' : 'Desktop app did not answer',
    ...(facts.status.detail === undefined ? {} : { hint: facts.status.detail }),
  });

  // desktop_window
  pushCheck(checks, {
    id: 'desktop_window',
    category: 'desktop',
    status: facts.window.present ? 'ok' : 'warning',
    message: facts.window.present ? 'Main window is open' : 'Main window is not available',
    ...(facts.window.detail === undefined ? {} : { hint: facts.window.detail }),
  });

  // database_ready
  pushCheck(checks, {
    id: 'database_ready',
    category: 'database',
    status: facts.database.ready ? 'ok' : 'error',
    message: facts.database.ready ? 'Core database is ready' : 'Core database is not ready',
    ...(facts.database.detail === undefined ? {} : { hint: facts.database.detail }),
  });

  // plugin_registry_readable
  pushCheck(checks, {
    id: 'plugin_registry_readable',
    category: 'plugin',
    status: facts.plugins.readable ? 'ok' : 'error',
    message: facts.plugins.readable ? 'Plugin registry is readable' : 'Cannot read plugin registry',
    ...(facts.plugins.detail === undefined ? {} : { hint: facts.plugins.detail }),
  });

  // plugin_count
  pushCheck(checks, {
    id: 'plugin_count',
    category: 'plugin',
    status: facts.plugins.count === null ? 'skipped' : 'ok',
    message:
      facts.plugins.count === null
        ? 'Could not determine plugin count'
        : `${facts.plugins.count} plugin${facts.plugins.count === 1 ? '' : 's'} registered`,
    ...(facts.plugins.count === null ? {} : { details: { count: facts.plugins.count } }),
  });

  // session_query_works
  pushCheck(checks, {
    id: 'session_query_works',
    category: 'session',
    status: facts.sessions.queryWorks ? 'ok' : 'error',
    message: facts.sessions.queryWorks ? 'Session database is queryable' : 'Cannot query session database',
    ...(facts.sessions.detail === undefined ? {} : { hint: facts.sessions.detail }),
  });

  // session_count
  pushCheck(checks, {
    id: 'session_count',
    category: 'session',
    status: facts.sessions.count === null ? 'skipped' : 'ok',
    message:
      facts.sessions.count === null
        ? 'Could not determine session count'
        : `${facts.sessions.count} session${facts.sessions.count === 1 ? '' : 's'} stored`,
    ...(facts.sessions.count === null ? {} : { details: { count: facts.sessions.count } }),
  });
}

// ============================================================================
// Aggregation
// ============================================================================

/**
 * Roll the checks up into a report.
 *
 * `overallStatus` is `error` when anything failed, `warning` when only
 * warnings were raised, `ok` otherwise. Skipped checks never lower it: a
 * check that does not apply says nothing about the health of the app.
 */
export function finalizeDoctorResult(
  checks: DoctorCheck[],
  profile: DoctorProfile,
): DoctorReport {
  const summary: DoctorSummary = {
    errors: checks.filter((c) => c.status === 'error').length,
    warnings: checks.filter((c) => c.status === 'warning').length,
    skipped: checks.filter((c) => c.status === 'skipped').length,
    ok: checks.filter((c) => c.status === 'ok').length,
  };

  let overallStatus: DoctorOverallStatus = 'ok';
  if (summary.errors > 0) {
    overallStatus = 'error';
  } else if (summary.warnings > 0) {
    overallStatus = 'warning';
  }

  const ordered = [...checks].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );

  return {
    version: DOCTOR_REPORT_VERSION,
    timestamp: Date.now(),
    overallStatus,
    profile,
    checks: ordered,
    summary,
  };
}

/** The config root the Desktop reads its configuration from. */
export function desktopConfigRoot(): string {
  return resolveConfigRoot();
}
