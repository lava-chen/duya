// apps/desktop/src/main/plugins/builtin-seed.test.ts
// Builtin plugin distribution — the hardened seed.
//
// The seed is the only thing that puts a shipped plugin on the user's disk.
// It has to be safe against a half-written copy, a plugin that lost a file
// and a second app instance racing it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import os from 'os';

const state = vi.hoisted(() => ({ appPath: '', home: '' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.appPath,
    getAppPath: () => state.appPath,
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  LogComponent: { Main: 'Main' },
}));

/** Directory the dev build reads the shipped plugins from. */
function sourceDir(): string {
  return join(state.appPath, 'packages', 'plugin-core', 'src', 'plugins', 'builtin');
}

/** Directory the dev build reads the marketplace plugins from. */
function marketplaceDir(): string {
  return join(state.appPath, 'resources', 'builtin-plugins');
}

/** Directory the seeded plugins land in. */
function seedDir(): string {
  return join(state.home, '.duya', 'plugins', 'cache', 'builtin');
}

function writePlugin(root: string, name: string, opts: { id?: string; version?: string; files?: Record<string, string> } = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.duya-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.duya-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      id: opts.id ?? `com.duya.${name}`,
      version: opts.version ?? '1.0.0',
      description: `${name} plugin`,
    }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

function writeManifest(plugins: unknown): void {
  mkdirSync(marketplaceDir(), { recursive: true });
  writeFileSync(
    join(marketplaceDir(), 'builtin-plugins.json'),
    JSON.stringify({ version: 1, plugins }),
    'utf8',
  );
}

beforeEach(() => {
  state.appPath = mkdtempSync(join(tmpdir(), 'duya-builtin-app-'));
  state.home = mkdtempSync(join(tmpdir(), 'duya-builtin-home-'));
  mkdirSync(sourceDir(), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(state.home);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state.appPath, { recursive: true, force: true });
  rmSync(state.home, { recursive: true, force: true });
});

describe('seedBuiltinPlugins', () => {
  it('copies a shipped plugin into the user-home cache', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    writePlugin(sourceDir(), 'github', { version: '0.2.0', files: { 'skills/setup/SKILL.md': '# setup' } });

    const outcome = seedBuiltinPlugins();

    expect(outcome.seeded).toEqual(['com.duya.github']);
    const cached = join(seedDir(), 'com.duya.github', '0.2.0');
    expect(existsSync(join(cached, '.duya-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(cached, 'skills', 'setup', 'SKILL.md'))).toBe(true);
  });

  it('is idempotent — a second run copies nothing', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    writePlugin(sourceDir(), 'github');

    seedBuiltinPlugins();
    const second = seedBuiltinPlugins();

    expect(second.seeded).toEqual([]);
    expect(second.unchanged).toEqual(['com.duya.github']);
  });

  it('removes a file the source dropped instead of keeping the stale copy', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    const pluginDir = writePlugin(sourceDir(), 'github', { files: { 'skills/setup/SKILL.md': '# setup' } });
    seedBuiltinPlugins();
    expect(existsSync(join(seedDir(), 'com.duya.github', '1.0.0', 'skills', 'setup', 'SKILL.md'))).toBe(true);

    rmSync(join(pluginDir, 'skills'), { recursive: true, force: true });
    seedBuiltinPlugins();

    expect(existsSync(join(seedDir(), 'com.duya.github', '1.0.0', 'skills', 'setup', 'SKILL.md'))).toBe(false);
  });

  it('refuses to seed a plugin that is missing a declared file', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    writePlugin(marketplaceDir(), 'computer-use', {
      id: 'com.duya.computer-use',
      files: { 'server.cjs': '// server' },
    });
    writeManifest([
      {
        name: 'computer-use',
        path: './computer-use',
        requiredPaths: ['.duya-plugin/plugin.json', 'server.cjs', 'missing.cjs'],
      },
    ]);

    const outcome = seedBuiltinPlugins();

    expect(outcome.seeded).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].reason).toContain('missing.cjs');
    expect(existsSync(join(seedDir(), 'com.duya.computer-use'))).toBe(false);
  });

  it('keeps the previously seeded version when the new one is incomplete', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    const pluginDir = writePlugin(marketplaceDir(), 'computer-use', {
      id: 'com.duya.computer-use',
      version: '1.0.0',
      files: { 'server.cjs': '// server' },
    });
    writeManifest([
      {
        name: 'computer-use',
        path: './computer-use',
        requiredPaths: ['.duya-plugin/plugin.json', 'server.cjs'],
      },
    ]);
    seedBuiltinPlugins();
    expect(existsSync(join(seedDir(), 'com.duya.computer-use', '1.0.0', 'server.cjs'))).toBe(true);

    // A broken 2.0.0 arrives; the working 1.0.0 must keep working.
    writeFileSync(
      join(pluginDir, '.duya-plugin', 'plugin.json'),
      JSON.stringify({ name: 'computer-use', id: 'com.duya.computer-use', version: '2.0.0' }),
      'utf8',
    );
    rmSync(join(pluginDir, 'server.cjs'), { force: true });

    const outcome = seedBuiltinPlugins();

    expect(outcome.failed).toHaveLength(1);
    expect(existsSync(join(seedDir(), 'com.duya.computer-use', '1.0.0', 'server.cjs'))).toBe(true);
    expect(existsSync(join(seedDir(), 'com.duya.computer-use', '2.0.0'))).toBe(false);
  });

  it('reports a manifest plugin that is missing from the bundle', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    writeManifest([{ name: 'computer-use', path: './computer-use' }]);

    const outcome = seedBuiltinPlugins();

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].reason).toContain('missing from the bundle');
  });

  it('skips the whole seed while another instance holds the lock', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    writePlugin(sourceDir(), 'github');

    const lockDir = join(state.home, '.duya', 'plugins', 'cache');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, '.builtin-seed.lock'), '999999', 'utf8');

    const outcome = seedBuiltinPlugins();

    expect(outcome.seeded).toEqual([]);
    expect(outcome.unchanged).toEqual([]);
    expect(existsSync(join(seedDir(), 'com.duya.github'))).toBe(false);
  });

  it('leaves no staging leftovers behind', async () => {
    const { seedBuiltinPlugins } = await import('./builtin-seed.js');
    writePlugin(sourceDir(), 'github');
    seedBuiltinPlugins();

    const staging = join(state.home, '.duya', 'plugins', 'cache', '.builtin-staging');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });
});
