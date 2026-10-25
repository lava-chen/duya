/**
 * Executor tests for `/doctor` (doctor.ts).
 *
 * The command is driven through the domain executor directly, the way the
 * surface executors are: the shared catalog does not name `doctor` yet, and
 * the thing under test is what the command DOES with the report — not the
 * catalog's metadata.
 *
 * The rendering is the part with a real contract: a skipped check ("this does
 * not apply here") must not read like a failed one ("this did not pass"), or
 * a user would go looking for a problem that does not exist.
 */

import { describe, expect, it, vi } from 'vitest';

import { DOCTOR_EXECUTORS, renderDoctorReport } from '../doctor';
import type { CommandContext, CommandResult } from '../../types';
import type { DoctorReport } from '@/contracts/doctor';

function makeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    version: '1.0.0',
    timestamp: 1_700_000_000_000,
    overallStatus: 'warning',
    profile: 'development',
    checks: [],
    summary: { errors: 0, warnings: 0, skipped: 0, ok: 0 },
    ...overrides,
  };
}

function makeCtx(bridge: Partial<CommandContext['app']>): CommandContext {
  return { args: [], raw: '/doctor', app: bridge as CommandContext['app'] };
}

describe('renderDoctorReport', () => {
  const report = makeReport({
    checks: [
      {
        id: 'database_ready',
        category: 'database',
        status: 'error',
        message: 'Core database is not ready',
        hint: 'check the data directory permissions',
        issues: [
          {
            cause: 'the core database did not open',
            measured: 'SQLITE_CANTOPEN',
            expected: 'an open core database',
            remedy: 'check the data directory permissions',
          },
        ],
      },
      {
        id: 'config_file_exists',
        category: 'config',
        status: 'warning',
        message: 'config.toml not found',
      },
      {
        id: 'plugin_count',
        category: 'plugin',
        status: 'skipped',
        message: 'Could not determine plugin count',
      },
      {
        id: 'runtime_process',
        category: 'runtime',
        status: 'ok',
        message: 'Electron 44.0.0',
      },
    ],
    summary: { errors: 1, warnings: 1, skipped: 1, ok: 1 },
  });

  it('counts every status in the summary line', () => {
    const text = renderDoctorReport(report);
    expect(text).toContain('1 错误 · 1 警告 · 1 通过 · 1 跳过');
  });

  it('marks a failed check and a skipped check differently', () => {
    const text = renderDoctorReport(report);
    // The whole point: "does not apply here" must not look like "did not pass".
    expect(text).toContain('✕ database_ready · Core database is not ready');
    expect(text).toContain('○ plugin_count · Could not determine plugin count');
    expect(text).not.toContain('✕ plugin_count');
  });

  it('prints the remedy of a failed check under it', () => {
    const text = renderDoctorReport(report);
    expect(text).toContain('→ check the data directory permissions');
    expect(text).toContain('the core database did not open');
    expect(text).toContain('实测：SQLITE_CANTOPEN');
    expect(text).toContain('期望：an open core database');
  });

  it('groups the checks by category', () => {
    const text = renderDoctorReport(report);
    expect(text).toContain('[database]');
    expect(text).toContain('[config]');
    expect(text).toContain('[plugin]');
    expect(text).toContain('[runtime]');
  });
});

describe('/doctor executor', () => {
  it('returns the rendered report', async () => {
    const report = makeReport({
      checks: [{ id: 'runtime_process', category: 'runtime', status: 'ok', message: 'Electron 44.0.0' }],
      summary: { errors: 0, warnings: 0, skipped: 0, ok: 1 },
    });
    const runDoctor = vi.fn(async () => report);

    const result = (await DOCTOR_EXECUTORS.doctor(
      makeCtx({ runDoctor }),
    )) as CommandResult;

    expect(result.type).toBe('text');
    expect(runDoctor).toHaveBeenCalledTimes(1);
    expect(result.type === 'text' ? result.content : '').toContain('Electron 44.0.0');
  });

  it('refuses when the composer has no diagnostics channel', async () => {
    const result = (await DOCTOR_EXECUTORS.doctor(makeCtx({}))) as CommandResult;
    expect(result.type).toBe('error');
  });

  it('surfaces a failed channel as an error, not as a crash', async () => {
    const runDoctor = vi.fn(async () => {
      throw new Error('channel exploded');
    });

    const result = (await DOCTOR_EXECUTORS.doctor(makeCtx({ runDoctor }))) as CommandResult;

    expect(result.type).toBe('error');
    expect(result.type === 'error' ? result.message : '').toContain('channel exploded');
  });
});
