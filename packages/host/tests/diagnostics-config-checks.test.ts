/**
 * The config root is INJECTED.
 *
 * ## Why this matters
 *
 * The checks used to resolve the config root themselves, hardcoding
 * `join(homedir(), '.duya')`. That is wrong for every caller but one: the
 * real root is `resolveDataRoot()`, which honours `DUYA_DATA_ROOT` and the
 * test namespace. A run under a test namespace therefore read — and reported
 * on — the user's REAL `~/.duya`.
 *
 * The root is a parameter now, so a test can point the checks at a fixture
 * directory and a Desktop run can point them at its own root.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runConfigChecks, type CheckResult } from '../src/diagnostics/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-doctor-config-'));
  roots.push(dir);
  return dir;
}

const CONFIG_TOML = [
  '_config_version = 1',
  '',
  '[storage]',
  '',
  '[model]',
  'provider = "p1"',
  'default = "m1"',
  '',
  '[providers.p1]',
  'baseUrl = "https://example.invalid"',
  '',
  '[memory]',
  '',
  '[agent]',
  '',
  '[channels]',
  '',
  '[mcp_servers]',
  '',
  '[plugins]',
  '',
  '[security]',
  '',
].join('\n');

function checkById(checks: CheckResult[], id: string): CheckResult | undefined {
  return checks.find((check) => check.id === id);
}

describe('config checks take the root as a parameter', () => {
  it('reports a missing config.toml in the directory it was given', () => {
    const checks: CheckResult[] = [];
    runConfigChecks(checks, tempRoot());

    const exists = checkById(checks, 'config_file_exists');
    expect(exists?.status).toBe('warning');
    expect(exists?.message).toBe('config.toml not found');
  });

  it('reports the config.toml in the directory it was given', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), CONFIG_TOML, 'utf8');

    const checks: CheckResult[] = [];
    runConfigChecks(checks, root);

    expect(checkById(checks, 'config_file_exists')?.status).toBe('ok');
    expect(checkById(checks, 'config_file_parses')?.status).toBe('ok');
  });

  it('reads two different roots in one process without mixing them up', () => {
    // The property the hardcoded root could not have: the checks follow the
    // parameter, not a module-level decision.
    const populated = tempRoot();
    fs.writeFileSync(path.join(populated, 'config.toml'), CONFIG_TOML, 'utf8');
    const empty = tempRoot();

    const first: CheckResult[] = [];
    runConfigChecks(first, populated);
    const second: CheckResult[] = [];
    runConfigChecks(second, empty);

    expect(checkById(first, 'config_file_exists')?.status).toBe('ok');
    expect(checkById(second, 'config_file_exists')?.status).toBe('warning');
  });

  it('does not read the real home directory when pointed at a fixture', () => {
    // The load-bearing consequence: a run under a test namespace must not
    // report on the user's real install.
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), '[providers.p1]\n', 'utf8');

    const checks: CheckResult[] = [];
    runConfigChecks(checks, root);

    for (const check of checks) {
      const serialized = JSON.stringify(check);
      expect(serialized, check.id).not.toContain(path.join(os.homedir(), '.duya'));
    }
  });
});
