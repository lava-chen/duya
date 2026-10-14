/**
 * Structured doctor issues and check durations.
 *
 * Two separate claims are pinned here:
 *
 * 1. An issue is useful — the human report prints measured/expected/remedy, so
 *    a user can act on a check without reading the JSON view.
 * 2. An issue is safe — every string in it is redacted on the way to `--json`.
 *    `issues` is caller-authored free text, so failing to redact it would open
 *    a leak channel that the `doctor-redact` module header explicitly promises
 *    does not exist. The permission-check shape below is the realistic case: its
 *    remedy is a copy-pasteable `chmod` carrying an absolute path.
 */

import { describe, it, expect } from 'vitest';
import { redactDoctorJson } from '../doctor-redact.js';
import { renderText } from '../doctor.js';
import { pushCheck, resetTiming } from '../doctor-timing.js';
import type { CheckResult, DoctorIssue, DoctorResult } from '../doctor.js';

const HOME = 'C:\\Users\\lavachen';
const SECRETS = `${HOME}\\.duya\\secrets.json`;

function report(checks: CheckResult[]): DoctorResult {
  return {
    version: '1.0.0',
    timestamp: 1,
    overallStatus: 'warning',
    profile: 'production',
    summary: { errors: 0, warnings: 1, skipped: 0, ok: 0 },
    checks,
  };
}

/** A permission check as the migrated code actually emits it. */
function permissionCheck(issues?: readonly DoctorIssue[]): CheckResult {
  const chmod = `Run: chmod 600 "${SECRETS}"`;
  return {
    id: 'config_secrets_permissions',
    category: 'config',
    status: 'warning',
    message: 'secrets.json permissions are 644 (expected 600)',
    hint: chmod,
    issues: issues ?? [{
      cause: 'secrets.json is readable or writable by group/other',
      measured: `mode 0644 at ${SECRETS}`,
      expected: 'mode 0600',
      remedy: chmod,
    }],
    durationMs: 4,
  };
}

describe('issue redaction', () => {
  it('redacts an absolute path out of every issue string field', () => {
    // The load-bearing case. Each of the four fields gets its own path so a
    // guard that covers only `cause` cannot pass by accident.
    const json = redactDoctorJson(report([permissionCheck([{
      cause: `group/other can read ${SECRETS}`,
      measured: `mode 0644 at ${SECRETS}`,
      expected: `mode 0600 at ${SECRETS}`,
      remedy: `Run: chmod 600 "${SECRETS}"`,
    }])]), { home: HOME }) as { checks: Array<{ issues: Array<Record<string, string>> }> };

    const issue = json.checks[0]!.issues[0]!;
    expect(issue.cause).toBe(String.raw`group/other can read ~\.duya\secrets.json`);
    expect(issue.measured).toBe(String.raw`mode 0644 at ~\.duya\secrets.json`);
    expect(issue.expected).toBe(String.raw`mode 0600 at ~\.duya\secrets.json`);
    expect(issue.remedy).toBe(String.raw`Run: chmod 600 "~\.duya\secrets.json"`);
    // The invariant is about the whole serialized artifact, not one field.
    expect(JSON.stringify(json)).not.toContain('lavachen');
  });

  it('redacts the user segment of a path it did not confirm is home', () => {
    const json = redactDoctorJson(report([permissionCheck([{
      cause: 'unreadable runtime file',
      measured: 'mode 0644 at /home/someone-else/.duya/secrets.json',
      expected: 'mode 0600',
      remedy: 'Check the file owner',
    }])]), { home: HOME }) as { checks: Array<{ issues: Array<{ measured: string }> }> };

    expect(json.checks[0]!.issues[0]!.measured)
      .toBe('mode 0644 at /home/…/.duya/secrets.json');
  });

  it('carries durationMs through unredacted, because it is a number', () => {
    const json = redactDoctorJson(report([permissionCheck()]), { home: HOME }) as {
      checks: Array<{ durationMs: unknown; issues: Array<Record<string, unknown>> }>;
    };

    expect(json.checks[0]!.durationMs).toBe(4);
    // A number must not be routed through string redaction and come back as a
    // string, which would break any consumer typing it as durationMs.
    expect(typeof json.checks[0]!.durationMs).toBe('number');
    expect(typeof json.checks[0]!.issues[0]!.measured).toBe('string');
  });

  it('omits issues and durationMs when a check has neither', () => {
    const json = redactDoctorJson(report([{
      id: 'runtime_file_exists',
      category: 'runtime',
      status: 'ok',
      message: 'Runtime file exists',
    }]), { home: HOME }) as { checks: Array<Record<string, unknown>> };

    expect('issues' in json.checks[0]!).toBe(false);
    expect('durationMs' in json.checks[0]!).toBe(false);
  });

  it('does not mutate the report it was given', () => {
    // The text renderer runs on the same object and keeps absolute paths on
    // purpose, so redaction must not write back through it.
    const original = report([permissionCheck()]);
    redactDoctorJson(original, { home: HOME });
    expect(original.checks[0]!.issues![0]!.measured).toBe(`mode 0644 at ${SECRETS}`);
  });
});

describe('human-readable report', () => {
  it('prints measured and expected so the text report improves, not just the JSON', () => {
    const text = renderText(report([permissionCheck()]));

    expect(text).toContain('measured: mode 0644');
    expect(text).toContain('expected: mode 0600');
    // The text view keeps the absolute path ON PURPOSE: a `chmod` hint the user
    // cannot copy and run is not a hint. Redaction is the JSON view's job, and
    // it is asserted separately above. Do not "fix" this to `~`.
    expect(text).toContain(`chmod 600 "${SECRETS}"`);
  });

  it('does not print a remedy twice when it duplicates the hint', () => {
    const text = renderText(report([permissionCheck()]));
    const occurrences = text.split('chmod 600').length - 1;
    expect(occurrences).toBe(1);
  });

  it('still prints the remedy when it differs from the hint', () => {
    const text = renderText(report([permissionCheck([{
      cause: 'config.toml failed to parse',
      measured: 'TOML syntax error at line 12',
      expected: 'valid TOML',
      remedy: 'Fix line 12 of ~/.duya/config.toml',
    }])]));

    expect(text).toContain('measured: TOML syntax error at line 12');
    expect(text).toContain('fix: Fix line 12 of ~/.duya/config.toml');
  });

  it('leaves an unmigrated check rendering exactly as before', () => {
    // Optional means optional: a check with no issues must not gain blank rows
    // or placeholder text.
    const text = renderText(report([{
      id: 'runtime_file_exists',
      category: 'runtime',
      status: 'ok',
      message: 'Runtime file exists',
      durationMs: 3,
    }]));

    expect(text).toContain('[OK]         Runtime file exists');
    expect(text).not.toContain('measured:');
    expect(text).not.toContain('expected:');
    expect(text).not.toContain('fix:');
  });
});

describe('check duration', () => {
  it('stamps every pushed check with a positive duration', () => {
    const checks: CheckResult[] = [];
    resetTiming(checks);
    pushCheck(checks, { id: 'a', category: 'config', status: 'ok', message: 'a' });
    pushCheck(checks, { id: 'b', category: 'config', status: 'ok', message: 'b' });
    pushCheck(checks, { id: 'c', category: 'config', status: 'ok', message: 'c' });

    expect(checks.map(c => c.durationMs)).toHaveLength(3);
    for (const check of checks) {
      expect(check.durationMs).toBeGreaterThan(0);
    }
  });

  it('attributes the work done between two pushes to the later check', () => {
    // A busy-wait between pushes must land on the second check, not the first.
    const checks: CheckResult[] = [];
    resetTiming(checks);
    pushCheck(checks, { id: 'fast', category: 'config', status: 'ok', message: 'fast' });
    const until = Date.now() + 25;
    while (Date.now() < until) { /* occupy the clock the way a stat would */ }
    pushCheck(checks, { id: 'slow', category: 'config', status: 'ok', message: 'slow' });

    expect(checks[1]!.durationMs!).toBeGreaterThanOrEqual(20);
  });

  it('keeps an explicitly supplied duration instead of overwriting it', () => {
    const checks: CheckResult[] = [];
    resetTiming(checks);
    pushCheck(checks, { id: 'a', category: 'config', status: 'ok', message: 'a', durationMs: 99 });
    expect(checks[0]!.durationMs).toBe(99);
  });

  it('reports sub-millisecond work as 1ms rather than 0', () => {
    // 0 would read as "not measured" to support tooling.
    const checks: CheckResult[] = [];
    resetTiming(checks);
    pushCheck(checks, { id: 'a', category: 'config', status: 'ok', message: 'a' });
    pushCheck(checks, { id: 'b', category: 'config', status: 'ok', message: 'b' });

    for (const check of checks) {
      expect(check.durationMs).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps timing state separate per report', () => {
    // Two reports built in one process (as tests and long-lived hosts do) must
    // not charge the second report for the first one's work.
    const first: CheckResult[] = [];
    resetTiming(first);
    pushCheck(first, { id: 'a', category: 'config', status: 'ok', message: 'a' });

    const second: CheckResult[] = [];
    resetTiming(second);
    pushCheck(second, { id: 'a', category: 'config', status: 'ok', message: 'a' });

    expect(second[0]!.durationMs).toBeGreaterThanOrEqual(1);
    expect(second).toHaveLength(1);
  });

  it('falls back to the floor instead of throwing when resetTiming was skipped', () => {
    // Forgetting `resetTiming` is a mistake, but it is a silent one: the first
    // push has no baseline, so the elapsed time is 0 and the floor turns it into
    // 1ms. Pinning that behaviour here means a future refactor cannot quietly
    // turn "reports 1ms" into "throws", which would take down every caller that
    // happens to build a report without the reset.
    const checks: CheckResult[] = [];
    pushCheck(checks, { id: 'no-baseline', category: 'config', status: 'ok', message: 'no baseline' });

    expect(checks[0]!.durationMs).toBe(1);

    // A later push on the same array still measures normally, because the first
    // push installed a baseline.
    const until = Date.now() + 25;
    while (Date.now() < until) { /* occupy the clock */ }
    pushCheck(checks, { id: 'after', category: 'config', status: 'ok', message: 'after' });

    expect(checks[1]!.durationMs!).toBeGreaterThanOrEqual(20);
  });
});