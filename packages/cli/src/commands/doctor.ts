/**
 * packages/agent/src/cli/commands/doctor.ts
 *
 * `duya doctor` — read-only diagnostic that checks the health of DUYA's
 * local runtime, CLI API server, and data stores.
 *
 * Design principles (from phase-2a-doctor-audit.md):
 * - Never throws; always produces output (text or JSON)
 * - Desktop app unavailability is reported as `skipped` checks, not failure
 * - No credentials, tokens, or absolute paths in output
 * - exit 0 for ok/warning; exit 1 for error
 */

import { CliApiClient, type ProbeResult } from '../api/client.js';
import { readCliApiRuntime } from '../api/runtime-config.js';
import { isPidAlive } from '../api/runtime-config.js';
import { renderJson, type OutputFormat } from '../api/format.js';

export interface CheckResult {
  id: string;
  category: 'runtime' | 'desktop' | 'database' | 'plugin' | 'session';
  status: 'ok' | 'warning' | 'error' | 'skipped';
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  version: string;
  timestamp: number;
  overallStatus: 'ok' | 'warning' | 'error';
  profile: 'production' | 'development' | 'unknown';
  checks: CheckResult[];
  summary: {
    errors: number;
    warnings: number;
    skipped: number;
    ok: number;
  };
}

/**
 * Run all diagnostic checks and return the aggregated result.
 */
async function runDiagnostics(): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  let profile: 'production' | 'development' | 'unknown' = 'unknown';

  // ── Phase 1: Local runtime checks ───────────────────────────────────────

  // runtime_file_exists
  let runtimeLookup: Awaited<ReturnType<typeof readCliApiRuntime>> | null = null;
  try {
    runtimeLookup = await readCliApiRuntime();
  } catch {
    checks.push({
      id: 'runtime_file_exists',
      category: 'runtime',
      status: 'error',
      message: 'Cannot read runtime file',
      hint: 'Ensure DUYA has been launched at least once.',
    });
  }

  if (runtimeLookup) {
    if (runtimeLookup.kind === 'not_running') {
      checks.push({
        id: 'runtime_file_exists',
        category: 'runtime',
        status: 'warning',
        message: 'Runtime file not found',
        hint: 'Open the DUYA app to create the runtime file.',
      });
    } else if (runtimeLookup.kind === 'malformed') {
      checks.push({
        id: 'runtime_file_exists',
        category: 'runtime',
        status: 'error',
        message: 'Runtime file is malformed',
        hint: 'The runtime file is not valid JSON or has invalid fields.',
      });
      // Can't proceed with desktop checks
      return finalizeResult(checks, profile);
    } else {
      checks.push({
        id: 'runtime_file_exists',
        category: 'runtime',
        status: 'ok',
        message: 'Runtime file exists',
      });

      // runtime_file_valid
      const { runtime } = runtimeLookup;
      checks.push({
        id: 'runtime_file_valid',
        category: 'runtime',
        status: 'ok',
        message: 'Runtime file is valid',
      });

      // runtime_pid_alive
      if (runtime.pid !== undefined) {
        const alive = isPidAlive(runtime.pid);
        checks.push({
          id: 'runtime_pid_alive',
          category: 'runtime',
          status: alive ? 'ok' : 'warning',
          message: alive
            ? `Desktop process (PID ${runtime.pid}) is alive`
            : `Desktop process (PID ${runtime.pid}) is not responding`,
          hint: alive ? undefined : 'Restart DUYA if the app appears frozen.',
        });
      } else {
        checks.push({
          id: 'runtime_pid_alive',
          category: 'runtime',
          status: 'skipped',
          message: 'PID not recorded in runtime file',
        });
      }
    }
  }

  // ── Phase 2: Desktop API checks ──────────────────────────────────────────

  const client = new CliApiClient();

  // desktop_reachable
  const statusProbe = await client.probe('/v1/status');
  if (!statusProbe.reachable) {
    checks.push({
      id: 'desktop_reachable',
      category: 'desktop',
      status: 'error',
      message: 'Cannot connect to DUYA desktop app',
      hint: statusProbe.message,
    });
    // Remaining desktop checks depend on connection
    checks.push({ id: 'desktop_auth_ok', category: 'desktop', status: 'skipped', message: 'Desktop not reachable' });
    checks.push({ id: 'desktop_status_ok', category: 'desktop', status: 'skipped', message: 'Desktop not reachable' });
    checks.push({ id: 'plugin_registry_readable', category: 'plugin', status: 'skipped', message: 'Desktop not reachable' });
    checks.push({ id: 'plugin_count', category: 'plugin', status: 'skipped', message: 'Desktop not reachable' });
    checks.push({ id: 'session_query_works', category: 'session', status: 'skipped', message: 'Desktop not reachable' });
    checks.push({ id: 'session_count', category: 'session', status: 'skipped', message: 'Desktop not reachable' });
    return finalizeResult(checks, profile);
  }

  // desktop connection successful
  checks.push({
    id: 'desktop_reachable',
    category: 'desktop',
    status: 'ok',
    message: 'Desktop app is reachable',
  });

  // desktop_auth_ok
  if (statusProbe.error === 'auth_failed' || statusProbe.statusCode === 401) {
    checks.push({
      id: 'desktop_auth_ok',
      category: 'desktop',
      status: 'warning',
      message: 'Authentication failed',
      hint: 'The DUYA app may have restarted. Retry the command.',
    });
  } else if (statusProbe.error === 'server_error' || statusProbe.statusCode >= 500) {
    checks.push({
      id: 'desktop_auth_ok',
      category: 'desktop',
      status: 'error',
      message: 'Server error during authentication',
      hint: statusProbe.message,
    });
  } else {
    checks.push({
      id: 'desktop_auth_ok',
      category: 'desktop',
      status: 'ok',
      message: 'Authentication successful',
    });
  }

  // desktop_status_ok
  if (statusProbe.statusCode === 200) {
    checks.push({
      id: 'desktop_status_ok',
      category: 'desktop',
      status: 'ok',
      message: 'Desktop app reports healthy status',
    });
  } else if (statusProbe.statusCode >= 400) {
    checks.push({
      id: 'desktop_status_ok',
      category: 'desktop',
      status: 'warning',
      message: `Desktop returned HTTP ${statusProbe.statusCode}`,
      hint: statusProbe.message,
    });
  } else {
    checks.push({
      id: 'desktop_status_ok',
      category: 'desktop',
      status: 'ok',
      message: 'Desktop app is responding',
    });
  }

  // ── Phase 3: Plugin registry checks ─────────────────────────────────────

  const pluginsProbe = await client.probe('/v1/plugins');
  if (!pluginsProbe.reachable || pluginsProbe.statusCode >= 400) {
    checks.push({
      id: 'plugin_registry_readable',
      category: 'plugin',
      status: 'error',
      message: 'Cannot read plugin registry',
      hint: pluginsProbe.reachable
        ? `Server returned HTTP ${pluginsProbe.statusCode}`
        : pluginsProbe.message,
    });
    checks.push({ id: 'plugin_count', category: 'plugin', status: 'skipped', message: 'Registry not readable' });
  } else {
    checks.push({
      id: 'plugin_registry_readable',
      category: 'plugin',
      status: 'ok',
      message: 'Plugin registry is readable',
    });

    // Get plugin count
    try {
      const plugins = await client.get<{ plugins: unknown[] }>('/v1/plugins');
      const count = Array.isArray(plugins.plugins) ? plugins.plugins.length : 0;
      checks.push({
        id: 'plugin_count',
        category: 'plugin',
        status: 'ok',
        message: `${count} plugin${count !== 1 ? 's' : ''} registered`,
        details: { count },
      });
    } catch {
      checks.push({
        id: 'plugin_count',
        category: 'plugin',
        status: 'skipped',
        message: 'Could not determine plugin count',
      });
    }
  }

  // ── Phase 4: Session database checks ────────────────────────────────────

  const sessionProbe = await client.probe('/v1/sessions?limit=1&offset=0');
  if (!sessionProbe.reachable || sessionProbe.statusCode >= 400) {
    checks.push({
      id: 'session_query_works',
      category: 'session',
      status: 'error',
      message: 'Cannot query session database',
      hint: sessionProbe.reachable
        ? `Server returned HTTP ${sessionProbe.statusCode}`
        : sessionProbe.message,
    });
    checks.push({ id: 'session_count', category: 'session', status: 'skipped', message: 'Query failed' });
  } else {
    checks.push({
      id: 'session_query_works',
      category: 'session',
      status: 'ok',
      message: 'Session database is queryable',
    });

    // Get session count
    try {
      const sessions = await client.get<{ sessions: unknown[] }>('/v1/sessions?limit=1&offset=0');
      // We can't get total count from this endpoint, just mark as info
      checks.push({
        id: 'session_count',
        category: 'session',
        status: 'ok',
        message: 'Session query returned successfully',
        details: { hasSessions: Array.isArray(sessions.sessions) },
      });
    } catch {
      checks.push({
        id: 'session_count',
        category: 'session',
        status: 'skipped',
        message: 'Could not determine session count',
      });
    }
  }

  return finalizeResult(checks, profile);
}

function finalizeResult(checks: CheckResult[], profile: 'production' | 'development' | 'unknown'): DoctorResult {
  const errors = checks.filter(c => c.status === 'error').length;
  const warnings = checks.filter(c => c.status === 'warning').length;
  const skipped = checks.filter(c => c.status === 'skipped').length;
  const ok = checks.filter(c => c.status === 'ok').length;

  let overallStatus: 'ok' | 'warning' | 'error' = 'ok';
  if (errors > 0) {
    overallStatus = 'error';
  } else if (warnings > 0) {
    overallStatus = 'warning';
  }

  return {
    version: '1.0.0',
    timestamp: Date.now(),
    overallStatus,
    profile,
    checks,
    summary: { errors, warnings, skipped, ok },
  };
}

/**
 * Render doctor result as human-readable text.
 */
function renderText(result: DoctorResult): string {
  const lines: string[] = [
    'DUYA Doctor — Read-Only Diagnostic Report',
    '==========================================',
    '',
  ];

  // Group by category
  const categories = ['runtime', 'desktop', 'plugin', 'session'] as const;
  for (const cat of categories) {
    const catChecks = result.checks.filter(c => c.category === cat);
    if (catChecks.length === 0) continue;

    lines.push(`[${cat}]`);
    for (const check of catChecks) {
      const prefix = check.status === 'ok' ? '[OK]' :
        check.status === 'warning' ? '[WARNING]' :
          check.status === 'error' ? '[ERROR]' : '[SKIPPED]';
      lines.push(`${prefix.padEnd(12)} ${check.message}`);
      if (check.hint) {
        lines.push(`            → ${check.hint}`);
      }
    }
    lines.push('');
  }

  lines.push(
    `Summary: ${result.summary.errors} error${result.summary.errors !== 1 ? 's' : ''}, ` +
    `${result.summary.warnings} warning${result.summary.warnings !== 1 ? 's' : ''}, ` +
    `${result.summary.skipped} skipped, ` +
    `${result.summary.ok} ok`,
  );

  return lines.join('\n');
}

/**
 * Entry point for `duya doctor` command.
 * Returns exit code: 0 for ok/warning, 1 for error.
 */
export async function runDoctorCommand(format: OutputFormat): Promise<number> {
  const result = await runDiagnostics();

  if (format === 'json') {
    process.stdout.write(renderJson(result) + '\n');
  } else {
    process.stdout.write(renderText(result) + '\n');
  }

  return result.overallStatus === 'error' ? 1 : 0;
}