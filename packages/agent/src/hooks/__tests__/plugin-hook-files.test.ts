/**
 * Plan 583 phase G2 — plugin-contributed hook files.
 *
 * Before this, a plugin's `hooks/hooks.json` was discovered and counted in the
 * plugin catalog but never reached the agent's hook config, so it never fired.
 * These tests cover the merge that makes them real:
 *
 *   - plugin files apply even when the user has **no config.toml at all**,
 *     which is the case that would silently drop them;
 *   - they merge *with* the user's own `[hooks] files` rather than replacing
 *     them, and fire after them for the same event;
 *   - a missing or malformed plugin file contributes nothing and never throws,
 *     preserving the fail-open contract of the hook system.
 *
 * The extra-file list is module state, so every test resets it.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readHooksConfig,
  setExtraHookFiles,
  getExtraHookFiles,
} from '../config.js';

const TEST_NS = 'hooks-plugin-test';

function configRoot(): string {
  return path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
}

function writeConfigToml(content: string): void {
  fs.mkdirSync(configRoot(), { recursive: true });
  fs.writeFileSync(path.join(configRoot(), 'config.toml'), content, 'utf-8');
}

function writePluginHookFile(name: string, body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-plugin-hooks-'));
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, 'hooks.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
  tmpDirs.push(dir);
  return file;
}

const tmpDirs: string[] = [];

beforeEach(() => {
  // `resolveConfigRoot()` only honours the namespaced root when DUYA_TEST=1
  // *and* DUYA_TEST_NAMESPACE are both set. Without the first flag these
  // tests would read the real ~/.duya instead.
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  fs.rmSync(configRoot(), { recursive: true, force: true });
  setExtraHookFiles([]);
});

afterEach(() => {
  setExtraHookFiles([]);
  fs.rmSync(configRoot(), { recursive: true, force: true });
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const ECHO_HOOK = (command: string) => ({
  hooks: { PostTurn: [{ hooks: [{ type: 'command', command }] }] },
});

describe('plugin hook files (plan 583 G2)', () => {
  it('applies a plugin hook when the user has no config.toml at all', () => {
    // The regression this whole change exists for: a user with no
    // `[hooks]` section must still get their plugins' hooks. The previous
    // readHooksConfig returned undefined immediately when config.toml was
    // absent, which would have dropped every plugin hook.
    const file = writePluginHookFile('p1', ECHO_HOOK('plugin-hook'));
    setExtraHookFiles([file]);

    const settings = readHooksConfig();
    expect(settings?.PostTurn).toHaveLength(1);
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ command: 'plugin-hook' });
  });

  it('applies a plugin hook when config.toml exists but has no [hooks] section', () => {
    writeConfigToml('[goal]\nenabled = true\n');
    setExtraHookFiles([writePluginHookFile('p1', ECHO_HOOK('plugin-hook'))]);

    const settings = readHooksConfig();
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ command: 'plugin-hook' });
  });

  it('merges with the user hook files, plugin hooks firing after them', () => {
    writeConfigToml('[hooks]\nfiles = ["user-hooks.json"]\n');
    fs.writeFileSync(
      path.join(configRoot(), 'user-hooks.json'),
      JSON.stringify(ECHO_HOOK('user-hook')),
      'utf-8',
    );
    setExtraHookFiles([writePluginHookFile('p1', ECHO_HOOK('plugin-hook'))]);

    const settings = readHooksConfig();
    expect(settings?.PostTurn).toHaveLength(2);
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ command: 'user-hook' });
    expect(settings?.PostTurn?.[1].hooks[0]).toMatchObject({ command: 'plugin-hook' });
  });

  it('keeps distinct events from different plugins apart', () => {
    setExtraHookFiles([
      writePluginHookFile('p1', { hooks: { PostTurn: [{ hooks: [{ type: 'command', command: 'a' }] }] } }),
      writePluginHookFile('p2', { hooks: { PreTurn: [{ hooks: [{ type: 'command', command: 'b' }] }] } }),
    ]);
    const settings = readHooksConfig();
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ command: 'a' });
    expect(settings?.PreTurn?.[0].hooks[0]).toMatchObject({ command: 'b' });
  });

  it('honors [hooks] disabled for user files while plugin files still load', () => {
    // `[hooks] disabled` is keyed on the config.toml entry string, so it cannot
    // address a plugin file. User entries must still be filterable.
    writeConfigToml(
      '[hooks]\nfiles = ["user-hooks.json"]\ndisabled = ["file:user-hooks.json:PostTurn:0:0"]\n',
    );
    fs.writeFileSync(
      path.join(configRoot(), 'user-hooks.json'),
      JSON.stringify(ECHO_HOOK('user-hook')),
      'utf-8',
    );
    setExtraHookFiles([writePluginHookFile('p1', ECHO_HOOK('plugin-hook'))]);

    const settings = readHooksConfig();
    expect(settings?.PostTurn).toHaveLength(1);
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ command: 'plugin-hook' });
  });

  it('drops only the unreadable or malformed file and keeps the rest', () => {
    setExtraHookFiles([
      path.join(os.tmpdir(), 'duya-does-not-exist-hooks.json'),
      writePluginHookFile('bad', '{ not json'),
      writePluginHookFile('good', ECHO_HOOK('survivor')),
    ]);
    const settings = readHooksConfig();
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ command: 'survivor' });
  });

  it('returns undefined when there is nothing configured at all', () => {
    expect(readHooksConfig()).toBeUndefined();
  });
});

describe('setExtraHookFiles', () => {
  it('round-trips and drops empty entries', () => {
    setExtraHookFiles(['/a/hooks.json', '', '/b/hooks.json']);
    expect(getExtraHookFiles()).toEqual(['/a/hooks.json', '/b/hooks.json']);
  });

  it('resets to empty so a disabled plugin contributes nothing', () => {
    setExtraHookFiles(['/a/hooks.json']);
    setExtraHookFiles([]);
    expect(getExtraHookFiles()).toEqual([]);
    expect(readHooksConfig()).toBeUndefined();
  });
});
