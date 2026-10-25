/**
 * The Desktop's doctor report assembly.
 *
 * The facts are INJECTED, so the decisions under test — which check belongs
 * to which category, what a fact that could not be read means, and how the
 * checks roll up — are exercised without an Electron runtime and without the
 * user's real plugin registry and database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  finalizeDoctorResult,
  resetTiming,
  runDesktopDiagnostics,
  runOfflineDiagnostics,
  type DesktopFactsApi,
} from '../doctor-report';
import type { DoctorCheck } from '../../../contracts/doctor';

let configRoot: string;

beforeEach(() => {
  configRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duya-doctor-config-')));
});

afterEach(() => {
  fs.rmSync(configRoot, { recursive: true, force: true });
});

function findCheck(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`no check named ${id}`);
  return found;
}

function healthyFacts(): DesktopFactsApi {
  return {
    status: { reachable: true, detail: 'Host API v1' },
    window: { present: true, detail: 'window id 1' },
    plugins: { readable: true, count: 3 },
    sessions: { queryWorks: true, count: 12 },
    database: { ready: true },
  };
}

describe('runOfflineDiagnostics', () => {
  it('reports the config root and the config files', () => {
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runOfflineDiagnostics(checks, { configRoot });

    expect(findCheck(checks, 'config_root_exists').status).toBe('ok');
    // A missing config.toml is a warning, not an error: the app creates one.
    expect(findCheck(checks, 'config_file_exists').status).toBe('warning');
    expect(findCheck(checks, 'config_secrets_parses').status).toBe('warning');
    expect(findCheck(checks, 'runtime_process').status).toBe('ok');
  });

  it('reports a missing config root as an error', () => {
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runOfflineDiagnostics(checks, { configRoot: path.join(configRoot, 'nope') });

    expect(findCheck(checks, 'config_root_exists').status).toBe('error');
  });

  it('reports unparseable secrets as an error', () => {
    fs.writeFileSync(path.join(configRoot, 'secrets.json'), '{ not json', 'utf-8');
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runOfflineDiagnostics(checks, { configRoot });

    expect(findCheck(checks, 'config_secrets_parses').status).toBe('error');
  });

  it('reports a config file that exists', () => {
    fs.writeFileSync(path.join(configRoot, 'config.toml'), '_config_version = 1\n', 'utf-8');
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runOfflineDiagnostics(checks, { configRoot });

    expect(findCheck(checks, 'config_file_exists').status).toBe('ok');
  });
});

describe('runDesktopDiagnostics', () => {
  it('answers the desktop, plugin and session categories in place', () => {
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runDesktopDiagnostics(checks, healthyFacts());

    expect(findCheck(checks, 'desktop_reachable').status).toBe('ok');
    expect(findCheck(checks, 'desktop_window').status).toBe('ok');
    expect(findCheck(checks, 'database_ready').status).toBe('ok');
    expect(findCheck(checks, 'plugin_registry_readable').status).toBe('ok');
    expect(findCheck(checks, 'plugin_count').status).toBe('ok');
    expect(findCheck(checks, 'session_query_works').status).toBe('ok');
    expect(findCheck(checks, 'session_count').status).toBe('ok');
  });

  it('never reports "the desktop could not be reached" as a skip', () => {
    // On the Desktop surface the desktop IS this process, so an unreadable
    // registry is an ERROR, not a skipped check.
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runDesktopDiagnostics(checks, {
      ...healthyFacts(),
      plugins: { readable: false, count: null, detail: 'registry is corrupt' },
    });

    expect(findCheck(checks, 'plugin_registry_readable').status).toBe('error');
    expect(findCheck(checks, 'plugin_count').status).toBe('skipped');
    expect(findCheck(checks, 'plugin_registry_readable').hint).toBe('registry is corrupt');
  });

  it('counts the plugins and the sessions it was told about', () => {
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runDesktopDiagnostics(checks, healthyFacts());

    expect(findCheck(checks, 'plugin_count').message).toContain('3 plugins');
    expect(findCheck(checks, 'session_count').message).toContain('12 sessions');
  });
});

describe('finalizeDoctorResult', () => {
  it('is ok when nothing failed', () => {
    const checks: DoctorCheck[] = [];
    resetTiming(checks);
    runDesktopDiagnostics(checks, healthyFacts());

    const report = finalizeDoctorResult(checks, 'development');

    expect(report.overallStatus).toBe('ok');
    expect(report.summary.ok).toBe(7);
    expect(report.profile).toBe('development');
  });

  it('is warning when only warnings were raised, and error when something failed', () => {
    const checks: DoctorCheck[] = [
      { id: 'a', category: 'config', status: 'warning', message: 'warned' },
      { id: 'b', category: 'config', status: 'skipped', message: 'not applicable' },
    ];
    expect(finalizeDoctorResult(checks, 'unknown').overallStatus).toBe('warning');

    checks.push({ id: 'c', category: 'config', status: 'error', message: 'broken' });
    const report = finalizeDoctorResult(checks, 'unknown');
    expect(report.overallStatus).toBe('error');
    expect(report.summary).toEqual({ errors: 1, warnings: 1, skipped: 1, ok: 0 });
  });

  it('does not let a skipped check lower the overall status', () => {
    const report = finalizeDoctorResult(
      [{ id: 'a', category: 'plugin', status: 'skipped', message: 'not applicable' }],
      'unknown',
    );
    expect(report.overallStatus).toBe('ok');
  });
});
