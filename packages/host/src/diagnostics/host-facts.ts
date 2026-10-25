/**
 * packages/host/src/diagnostics/host-facts.ts
 *
 * The seam between "what the doctor checks" and "how the facts are obtained".
 *
 * ## The problem this file exists to solve
 *
 * Three of the six categories — `desktop`, `plugin`, `session` — need a Host
 * to answer. But the two surfaces that run the doctor obtain those answers in
 * completely different ways:
 *
 *  - the CLI asks a Host that may be on another machine, over HTTP, and that
 *    may simply not be running;
 *  - the Desktop IS the Host, so it reads its own plugin registry, its own
 *    SQLite file and its own status handler IN-PROCESS. Going out over HTTP to
 *    ask itself would be absurd.
 *
 * If the CHECKS lived in each surface, the two would drift: the Desktop would
 * eventually learn to report "plugin registry readable" where the CLI reports
 * "cannot read plugin registry", and a comparison between two bug reports
 * would stop meaning anything.
 *
 * So the checks live HERE, and only the transport differs. This file declares
 * the port ({@link DoctorHostProbe}); the CLI implements it with an HTTP
 * client, the Desktop implements it in-process.
 *
 * ## Why the answer is THREE-valued, not a boolean
 *
 * The single most important distinction a diagnostic can draw is:
 *
 *   "the check did not pass"   ≠   "the check could not run"
 *
 * A Host that is not running has not FAILED anything — it simply could not be
 * asked. Reporting that as an error would train the reader to ignore the
 * errors, and would make a perfectly healthy CLI-only install look broken.
 *
 * Hence {@link DoctorFact}:
 *
 *  - `known`      — the Host answered, and here is the fact;
 *  - `failed`     — the Host answered, and the answer was wrong;
 *  - `unavailable`— the Host could not answer at all.
 *
 * `unavailable` is what turns the dependent checks into `skipped`.
 */

import type { CheckResult } from './types.js';
import { pushCheck } from './timing.js';

/**
 * How one fact was obtained.
 *
 * - `known` — the Host answered; the value is the fact.
 * - `failed` — the Host answered, but the answer was wrong (HTTP 500, an
 *   unreadable registry, a failing query). The `reason` says what went wrong
 *   and `measured` carries the observation that proves it.
 * - `unavailable` — the Host could not be reached at all. Nothing was
 *   checked, so nothing may be reported as failed.
 */
export type DoctorFact<T> =
  | { readonly kind: 'known'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string; readonly measured?: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** What the Host's status endpoint said. */
export interface DoctorStatusValue {
  /** The HTTP status the Host answered with. */
  readonly statusCode: number;
  /** Whether the Host rejected the credentials. */
  readonly authFailed: boolean;
  /** Whether the Host answered with a server error. */
  readonly serverError: boolean;
}

/** What the Host's plugin registry says. */
export interface DoctorPluginValue {
  /** How many plugins the registry lists. */
  readonly count: number;
}

/** What the Host's session store says. */
export interface DoctorSessionValue {
  /** Whether the session query returned at least one session. */
  readonly hasSessions: boolean;
}

/**
 * The facts the three Host-dependent categories need, obtained somehow.
 *
 * An implementation decides HOW; this interface fixes WHAT. The CLI's
 * implementation probes the Desktop's CLI API over HTTP. The Desktop's
 * implementation reads its own registries in-process.
 */
export interface DoctorHostProbe {
  /** Ask the Host whether it is there, and how it is doing. */
  probeStatus(): Promise<DoctorFact<DoctorStatusValue>>;
  /** Ask the Host for its plugin registry. */
  listPlugins(): Promise<DoctorFact<DoctorPluginValue>>;
  /** Ask the Host for one row of its session store. */
  querySessions(): Promise<DoctorFact<DoctorSessionValue>>;
}

/**
 * The checks skipped because the Host could not answer.
 *
 * One place, so the seven rows stay consistent with each other and a future
 * category cannot forget the wording.
 */
function pushUnavailable(checks: CheckResult[], reason: string, reasonText: string): void {
  pushCheck(checks, {
    id: 'desktop_reachable',
    category: 'desktop',
    status: 'skipped',
    message: 'Desktop app is not reachable',
    hint: reason,
  });
  pushCheck(checks, { id: 'desktop_auth_ok', category: 'desktop', status: 'skipped', message: reasonText });
  pushCheck(checks, { id: 'desktop_status_ok', category: 'desktop', status: 'skipped', message: reasonText });
  pushCheck(checks, { id: 'plugin_registry_readable', category: 'plugin', status: 'skipped', message: reasonText });
  pushCheck(checks, { id: 'plugin_count', category: 'plugin', status: 'skipped', message: reasonText });
  pushCheck(checks, { id: 'session_query_works', category: 'session', status: 'skipped', message: reasonText });
  pushCheck(checks, { id: 'session_count', category: 'session', status: 'skipped', message: reasonText });
}

/**
 * Run the Host-dependent checks and append them to `checks`.
 *
 * The status probe runs FIRST and short-circuits the rest: if the Host cannot
 * be reached, asking it for its plugin registry and its sessions as well would
 * produce two more timeouts and no new information. The dependent checks are
 * still RECORDED — as `skipped`, so the reader can see that they were not
 * verified rather than that they passed.
 */
export async function runHostDiagnostics(
  checks: CheckResult[],
  probe: DoctorHostProbe,
): Promise<void> {
  const status = await probe.probeStatus();

  if (status.kind === 'unavailable') {
    pushUnavailable(checks, status.reason, 'Desktop not reachable');
    return;
  }

  if (status.kind === 'failed') {
    pushCheck(checks, {
      id: 'desktop_reachable',
      category: 'desktop',
      status: 'error',
      message: 'Cannot read the desktop app status',
      hint: status.reason,
      issues: [{
        cause: 'The desktop app answered the status probe with an error',
        measured: status.measured ?? status.reason,
        expected: 'a successful status response from the desktop app',
        remedy: 'Restart the DUYA app and run the diagnostic again.',
      }],
    });
    pushCheck(checks, { id: 'desktop_auth_ok', category: 'desktop', status: 'skipped', message: 'Desktop status unavailable' });
    pushCheck(checks, { id: 'desktop_status_ok', category: 'desktop', status: 'skipped', message: 'Desktop status unavailable' });
    pushCheck(checks, { id: 'plugin_registry_readable', category: 'plugin', status: 'skipped', message: 'Desktop status unavailable' });
    pushCheck(checks, { id: 'plugin_count', category: 'plugin', status: 'skipped', message: 'Desktop status unavailable' });
    pushCheck(checks, { id: 'session_query_works', category: 'session', status: 'skipped', message: 'Desktop status unavailable' });
    pushCheck(checks, { id: 'session_count', category: 'session', status: 'skipped', message: 'Desktop status unavailable' });
    return;
  }

  const { statusCode, authFailed, serverError } = status.value;

  pushCheck(checks, {
    id: 'desktop_reachable',
    category: 'desktop',
    status: 'ok',
    message: 'Desktop app is reachable',
  });

  if (authFailed) {
    pushCheck(checks, {
      id: 'desktop_auth_ok',
      category: 'desktop',
      status: 'warning',
      message: 'Authentication failed',
      hint: 'The DUYA app may have restarted. Retry the command.',
    });
  } else if (serverError) {
    pushCheck(checks, {
      id: 'desktop_auth_ok',
      category: 'desktop',
      status: 'error',
      message: 'Server error during authentication',
      hint: `The desktop app returned an error (HTTP ${statusCode}).`,
    });
  } else {
    pushCheck(checks, {
      id: 'desktop_auth_ok',
      category: 'desktop',
      status: 'ok',
      message: 'Authentication successful',
    });
  }

  if (statusCode === 200) {
    pushCheck(checks, {
      id: 'desktop_status_ok',
      category: 'desktop',
      status: 'ok',
      message: 'Desktop app reports healthy status',
    });
  } else if (statusCode >= 400) {
    pushCheck(checks, {
      id: 'desktop_status_ok',
      category: 'desktop',
      status: 'warning',
      message: `Desktop returned HTTP ${statusCode}`,
      hint: 'The desktop app answered, but not with a healthy status.',
    });
  } else {
    pushCheck(checks, {
      id: 'desktop_status_ok',
      category: 'desktop',
      status: 'ok',
      message: 'Desktop app is responding',
    });
  }

  const plugins = await probe.listPlugins();
  if (plugins.kind === 'unavailable') {
    pushCheck(checks, { id: 'plugin_registry_readable', category: 'plugin', status: 'skipped', message: 'Desktop not reachable' });
    pushCheck(checks, { id: 'plugin_count', category: 'plugin', status: 'skipped', message: 'Desktop not reachable' });
  } else if (plugins.kind === 'failed') {
    pushCheck(checks, {
      id: 'plugin_registry_readable',
      category: 'plugin',
      status: 'error',
      message: 'Cannot read plugin registry',
      hint: plugins.reason,
      issues: [{
        cause: 'The desktop app could not read its plugin registry',
        measured: plugins.measured ?? plugins.reason,
        expected: 'a readable plugin registry',
        remedy: 'Restart the DUYA app; if it persists, check app.log for a plugin error.',
      }],
    });
    pushCheck(checks, { id: 'plugin_count', category: 'plugin', status: 'skipped', message: 'Registry not readable' });
  } else {
    pushCheck(checks, {
      id: 'plugin_registry_readable',
      category: 'plugin',
      status: 'ok',
      message: 'Plugin registry is readable',
    });
    const count = plugins.value.count;
    pushCheck(checks, {
      id: 'plugin_count',
      category: 'plugin',
      status: 'ok',
      message: `${count} plugin${count !== 1 ? 's' : ''} registered`,
      details: { count },
    });
  }

  const sessions = await probe.querySessions();
  if (sessions.kind === 'unavailable') {
    pushCheck(checks, { id: 'session_query_works', category: 'session', status: 'skipped', message: 'Desktop not reachable' });
    pushCheck(checks, { id: 'session_count', category: 'session', status: 'skipped', message: 'Desktop not reachable' });
  } else if (sessions.kind === 'failed') {
    pushCheck(checks, {
      id: 'session_query_works',
      category: 'session',
      status: 'error',
      message: 'Cannot query session database',
      hint: sessions.reason,
      // The observation is the measured value here, and it separates a server
      // that is answering wrongly from one that is not answering at all.
      issues: [{
        cause: sessions.measured === undefined
          ? 'The desktop app did not answer the session query'
          : `The desktop app rejected the session query with ${sessions.measured}`,
        measured: sessions.measured ?? sessions.reason,
        expected: 'a successful response from the session query',
        remedy: 'Restart the DUYA app; if it persists, check app.log for a database error.',
      }],
    });
    pushCheck(checks, { id: 'session_count', category: 'session', status: 'skipped', message: 'Query failed' });
  } else {
    pushCheck(checks, {
      id: 'session_query_works',
      category: 'session',
      status: 'ok',
      message: 'Session database is queryable',
    });
    pushCheck(checks, {
      id: 'session_count',
      category: 'session',
      status: 'ok',
      message: 'Session query returned successfully',
      details: { hasSessions: sessions.value.hasSessions },
    });
  }
}
