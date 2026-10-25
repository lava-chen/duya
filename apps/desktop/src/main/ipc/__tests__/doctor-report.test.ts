/**
 * The Desktop's doctor adapter.
 *
 * The CHECKS are the shared layer's — they are tested there, against the
 * shared layer's own fixtures. What is under test HERE is the adapter: that
 * the Desktop's in-process facts are shaped the way the shared layer reads
 * them, and that the report the renderer receives is the shared layer's
 * report, unchanged.
 *
 * The facts are INJECTED, so the decisions are exercised without an Electron
 * runtime and without the user's real plugin registry and database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DoctorHostProbe } from '@duya/host/diagnostics';

import { collectDoctorReport } from '../doctor-report';
import type { DoctorCheck } from '../../../contracts/doctor';

let configRoot: string;

beforeEach(() => {
  configRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duya-doctor-config-')));
});

afterEach(() => {
  fs.rmSync(configRoot, { recursive: true, force: true });
});

function findCheck(checks: readonly DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`no check named ${id}`);
  return found;
}

function healthyProbe(): DoctorHostProbe {
  return {
    async probeStatus() {
      return { kind: 'known', value: { statusCode: 200, authFailed: false, serverError: false } };
    },
    async listPlugins() {
      return { kind: 'known', value: { count: 3 } };
    },
    async querySessions() {
      return { kind: 'known', value: { hasSessions: true } };
    },
  };
}

describe('the desktop doctor adapter', () => {
  it('runs the shared checks against the desktop facts', async () => {
    const report = await collectDoctorReport(healthyProbe(), 'development', configRoot);

    expect(findCheck(report.checks, 'desktop_reachable').status).toBe('ok');
    expect(findCheck(report.checks, 'desktop_status_ok').status).toBe('ok');
    expect(findCheck(report.checks, 'plugin_registry_readable').status).toBe('ok');
    expect(findCheck(report.checks, 'plugin_count').status).toBe('ok');
    expect(findCheck(report.checks, 'session_query_works').status).toBe('ok');
    expect(report.profile).toBe('development');
  });

  it('reports a broken registry as failed, never as skipped', async () => {
    const probe: DoctorHostProbe = {
      ...healthyProbe(),
      async listPlugins() {
        return { kind: 'failed', reason: 'the registry file is unreadable' };
      },
    };

    const report = await collectDoctorReport(probe, 'development', configRoot);

    // `skipped` means "this check could not run". The desktop IS running, so
    // a registry that cannot be read is a failure, not an absence of
    // information. The COUNT is skipped, though: with the registry unreadable
    // there is no count to report, and "no plugins" would be a lie.
    expect(findCheck(report.checks, 'plugin_registry_readable').status).toBe('error');
    expect(findCheck(report.checks, 'plugin_count').status).toBe('skipped');
  });

  it('produces the shared report shape the renderer renders', async () => {
    const report = await collectDoctorReport(healthyProbe(), 'development', configRoot);

    expect(report.version).toBe('1.0.0');
    expect(typeof report.timestamp).toBe('number');
    expect(['ok', 'warning', 'error']).toContain(report.overallStatus);
    expect(report.summary.ok + report.summary.warnings + report.summary.errors + report.summary.skipped)
      .toBe(report.checks.length);
  });
});
