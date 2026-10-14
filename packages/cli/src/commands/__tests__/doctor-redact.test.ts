/**
 * doctor --json redaction.
 *
 * The load-bearing case is the one the module header promises against: a check
 * that puts an absolute path into a message, a hint, or a detail. If any of
 * these regress, `duya doctor --json` leaks the user's name into a bug report.
 */

import { describe, it, expect } from 'vitest';
import { redactPathInText, redactDoctorJson } from '../doctor-redact.js';
import type { DoctorResult } from '../doctor.js';

const HOME = 'C:\\Users\\lavachen';

function report(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    version: '1.0.0',
    timestamp: 1,
    overallStatus: 'warning',
    profile: 'production',
    summary: { errors: 0, warnings: 1, skipped: 0, ok: 0 },
    checks: [],
    ...overrides,
  };
}

describe('redactPathInText', () => {
  it('collapses the detected home directory to ~', () => {
    expect(redactPathInText(`${HOME}\\.duya\\secrets.json`, HOME)).toBe(String.raw`~\.duya\secrets.json`);
  });

  it('collapses a home path written with the other separator', () => {
    // A message may carry the forward-slash form of a Windows path.
    expect(redactPathInText('C:/Users/lavachen/.duya/config.toml', HOME)).toBe('~/.duya/config.toml');
  });

  it('collapses a path embedded in a sentence, not just one at the start', () => {
    // This is the only shape the permission check emits.
    expect(redactPathInText(`Run: chmod 600 "${HOME}\\.duya\\secrets.json"`, HOME))
      .toBe(String.raw`Run: chmod 600 "~\.duya\secrets.json"`);
  });

  it('masks, but does not abbreviate, a home it did not confirm', () => {
    // The detected home is a Windows path, so these fall through to the generic
    // rule, which replaces the user segment with `…` rather than claiming the
    // directory is the home.
    expect(redactPathInText('/home/lavachen/.duya/config.toml', HOME)).toBe('/home/…/.duya/config.toml');
    expect(redactPathInText('/Users/lavachen/.duya/config.toml', HOME)).toBe('/Users/…/.duya/config.toml');
  });

  it('collapses another user segment when the detected home does not match', () => {
    expect(redactPathInText('C:\\Users\\someone-else\\.duya\\config.toml', HOME))
      .toBe('C:\\Users\\…\\.duya\\config.toml');
  });

  it('leaves text with no home prefix untouched', () => {
    const text = 'Provider "deepseek" has no apiKey in secrets.json';
    expect(redactPathInText(text, HOME)).toBe(text);
  });

  it('does not mangle a route that merely looks like a path', () => {
    // The report contains things like /v1/sessions; blanket path matching would
    // corrupt them.
    const text = 'Cannot query session database (GET /v1/sessions?limit=1)';
    expect(redactPathInText(text, HOME)).toBe(text);
  });

  it('does not mangle a URL whose path contains a home-shaped segment', () => {
    // `docs` here is a URL segment, not a user name. The boundary rule is what
    // keeps this intact — the `/Users/` is preceded by a host name character.
    const text = 'see http://example.com/Users/docs for details';
    expect(redactPathInText(text, HOME)).toBe(text);
  });

  it('is a no-op for an empty home, so a misconfigured environment cannot loop', () => {
    expect(redactPathInText('C:\\Users\\lavachen\\.duya\\config.toml', ''))
      .toBe('C:\\Users\\…\\.duya\\config.toml');
  });
});

describe('redactDoctorJson', () => {
  it('redacts message and hint', () => {
    const json = redactDoctorJson(report({
      checks: [{
        id: 'config_secrets_permissions',
        category: 'config',
        status: 'warning',
        message: 'secrets.json permissions are 644 (expected 600)',
        hint: `Run: chmod 600 "${HOME}\\.duya\\secrets.json"`,
      }],
    }), { home: HOME }) as { checks: Array<Record<string, unknown>> };

    expect(json.checks[0]?.hint).toBe(String.raw`Run: chmod 600 "~\.duya\secrets.json"`);
    expect(JSON.stringify(json)).not.toContain('lavachen');
  });

  it('recurses into details, including nested objects and arrays', () => {
    // details is caller-supplied. Redacting only message/hint would leave the
    // invariant resting on the discipline of whoever fills the field.
    const json = redactDoctorJson(report({
      checks: [{
        id: 'runtime_probe',
        category: 'runtime',
        status: 'error',
        message: 'probe failed',
        details: {
          file: `${HOME}\\.duya\\config.toml`,
          nested: { also: [`${HOME}\\deep.json`, 'plain'] },
          count: 3,
          flag: true,
        },
      }],
    }), { home: HOME }) as { checks: Array<{ details: Record<string, unknown> }> };

    expect(json.checks[0]?.details.file).toBe(String.raw`~\.duya\config.toml`);
    const nested = json.checks[0]?.details.nested as { also: string[] };
    expect(nested.also[0]).toBe(String.raw`~\deep.json`);
    expect(nested.also[1]).toBe('plain');
    // Non-string values must survive untouched rather than become "redacted".
    expect(json.checks[0]?.details.count).toBe(3);
    expect(json.checks[0]?.details.flag).toBe(true);
  });

  it('omits absent optional fields rather than emitting undefined', () => {
    const json = redactDoctorJson(report({
      checks: [{ id: 'a', category: 'config', status: 'ok', message: 'fine' }],
    }), { home: HOME }) as { checks: Array<Record<string, unknown>> };

    expect('hint' in json.checks[0]!).toBe(false);
    expect('details' in json.checks[0]!).toBe(false);
  });

  it('carries the report metadata through unchanged', () => {
    const json = redactDoctorJson(report(), { home: HOME }) as Record<string, unknown>;
    expect(json.overallStatus).toBe('warning');
    expect(json.profile).toBe('production');
    expect(json.summary).toEqual({ errors: 0, warnings: 1, skipped: 0, ok: 0 });
    expect(json.schemaVersion).toBe('1.0.0');
  });

  it('never mutates the report it was given', () => {
    // The text renderer runs on the same object, and it must keep its paths.
    const original = report({
      checks: [{
        id: 'a',
        category: 'config',
        status: 'warning',
        message: 'm',
        hint: `Run: chmod 600 "${HOME}\\.duya\\secrets.json"`,
      }],
    });
    redactDoctorJson(original, { home: HOME });
    expect(original.checks[0]?.hint).toBe(`Run: chmod 600 "${HOME}\\.duya\\secrets.json"`);
  });
});