/**
 * The Host seam: what the three Host-dependent categories report, and how.
 *
 * ## The distinction under test
 *
 * "This Host could not answer" and "this check did not pass" are different
 * claims. The CLI is routinely used with no desktop app running — that is
 * the normal case for a CLI-only install — and reporting that as an error
 * would make a healthy install look broken while training the reader to
 * ignore the errors.
 *
 * So:
 *
 *  - `unavailable` → the checks are SKIPPED, and the reason is carried;
 *  - `failed`     → the check is an ERROR, and the observation is carried.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runHostDiagnostics,
  type CheckResult,
  type DoctorHostProbe,
} from '../src/diagnostics/index.js';

function probe(overrides: Partial<DoctorHostProbe> = {}): DoctorHostProbe {
  return {
    probeStatus: vi.fn(async () => ({
      kind: 'known' as const,
      value: { statusCode: 200, authFailed: false, serverError: false },
    })),
    listPlugins: vi.fn(async () => ({
      kind: 'known' as const,
      value: { count: 3 },
    })),
    querySessions: vi.fn(async () => ({
      kind: 'known' as const,
      value: { hasSessions: true },
    })),
    ...overrides,
  };
}

async function run(host: DoctorHostProbe): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  await runHostDiagnostics(checks, host);
  return checks;
}

describe('host diagnostics — unreachable', () => {
  it('skips every Host-dependent check instead of failing them', async () => {
    const checks = await run(probe({
      probeStatus: vi.fn(async () => ({
        kind: 'unavailable' as const,
        reason: 'DUYA is not running. Open the DUYA app and retry.',
      })),
    }));

    expect(checks).toHaveLength(7);
    for (const check of checks) {
      expect(check.status, check.id).toBe('skipped');
    }
    // Nothing in these three categories is an error.
    expect(checks.filter((check) => check.status === 'error')).toHaveLength(0);
  });

  it('carries the reason the Host could not be reached', async () => {
    const checks = await run(probe({
      probeStatus: vi.fn(async () => ({
        kind: 'unavailable' as const,
        reason: 'DUYA is not running. Open the DUYA app and retry.',
      })),
    }));

    const reachable = checks.find((check) => check.id === 'desktop_reachable');
    expect(reachable?.status).toBe('skipped');
    expect(reachable?.hint).toContain('DUYA is not running');
  });

  it('does not ask a Host that cannot answer for its plugins or sessions', async () => {
    // Two more timeouts and no new information.
    const listPlugins = vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'x' }));
    const querySessions = vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'x' }));

    await run(probe({
      probeStatus: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'x' })),
      listPlugins,
      querySessions,
    }));

    expect(listPlugins).not.toHaveBeenCalled();
    expect(querySessions).not.toHaveBeenCalled();
  });
});

describe('host diagnostics — a Host that answered wrongly', () => {
  it('fails the status check and skips the ones that depend on it', async () => {
    const checks = await run(probe({
      probeStatus: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'Server returned HTTP 500',
        measured: 'HTTP 500 from GET /v1/status',
      })),
    }));

    const reachable = checks.find((check) => check.id === 'desktop_reachable');
    expect(reachable?.status).toBe('error');
    expect(reachable?.issues?.[0]?.measured).toBe('HTTP 500 from GET /v1/status');
    // The dependent checks were not verified, so they are skipped, not failed.
    for (const id of ['desktop_auth_ok', 'desktop_status_ok', 'plugin_count', 'session_count']) {
      expect(checks.find((check) => check.id === id)?.status, id).toBe('skipped');
    }
  });

  it('fails the plugin registry read but only skips the count', async () => {
    const checks = await run(probe({
      listPlugins: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'Server returned HTTP 403',
        measured: 'HTTP 403 from GET /v1/plugins',
      })),
    }));

    expect(checks.find((check) => check.id === 'plugin_registry_readable')?.status).toBe('error');
    expect(checks.find((check) => check.id === 'plugin_count')?.status).toBe('skipped');
  });

  it('fails the session query and states the observation that proves it', async () => {
    const checks = await run(probe({
      querySessions: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'Server returned HTTP 500',
        measured: 'HTTP 500 from GET /v1/sessions',
      })),
    }));

    const query = checks.find((check) => check.id === 'session_query_works');
    expect(query?.status).toBe('error');
    expect(query?.issues?.[0]?.measured).toBe('HTTP 500 from GET /v1/sessions');
    expect(query?.issues?.[0]?.expected).toContain('successful');
    expect(checks.find((check) => check.id === 'session_count')?.status).toBe('skipped');
  });
});

describe('host diagnostics — a healthy Host', () => {
  it('reports the reachable Host and the facts it returned', async () => {
    const checks = await run(probe());

    expect(checks.find((check) => check.id === 'desktop_reachable')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'desktop_auth_ok')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'desktop_status_ok')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'plugin_registry_readable')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'plugin_count')?.message).toBe('3 plugins registered');
    expect(checks.find((check) => check.id === 'session_query_works')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'session_count')?.status).toBe('ok');
  });

  it('reports a rejected credential as a warning, not an error', async () => {
    // The token is stale because the app restarted. That is worth a warning
    // and a retry, not a failure of the install.
    const checks = await run(probe({
      probeStatus: vi.fn(async () => ({
        kind: 'known' as const,
        value: { statusCode: 401, authFailed: true, serverError: false },
      })),
    }));

    expect(checks.find((check) => check.id === 'desktop_auth_ok')?.status).toBe('warning');
    expect(checks.find((check) => check.id === 'desktop_reachable')?.status).toBe('ok');
  });

  it('reports a server error during authentication as an error', async () => {
    const checks = await run(probe({
      probeStatus: vi.fn(async () => ({
        kind: 'known' as const,
        value: { statusCode: 500, authFailed: false, serverError: true },
      })),
    }));

    expect(checks.find((check) => check.id === 'desktop_auth_ok')?.status).toBe('error');
  });
});
