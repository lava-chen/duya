/**
 * Where the standalone Host finds an installed plugin's package files.
 *
 * ## What these assertions pin
 *
 * The worker gates plugin skills and plugin MCP servers on `installPath`
 * (`packages/host/src/worker-process-entry.ts:2551`,
 * `packages/plugin-core/src/mcp/collect.ts:87`), so the Host has to resolve
 * the directory the Desktop installed the plugin into:
 *
 *  - the installed entry under `<root>/plugins/installed/<id>`;
 *  - the newest builtin version under `<root>/plugins/cache/builtin/<id>/`.
 *
 * And it must not invent a path: a plugin with nothing on disk keeps none.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectPluginInstallRoots,
  resolvePluginDataPath,
  resolvePluginInstallPath,
} from '../src/plugin-install-paths.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-plugin-paths-'));
}

function mkdirp(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('plugin install path resolution', () => {
  it('resolves the installed plugin directory', () => {
    const root = tempRoot();
    try {
      const installed = mkdirp(path.join(root, 'plugins', 'installed', 'com.duya.documents'));

      expect(resolvePluginInstallPath('com.duya.documents', { roots: [root] })).toBe(
        fs.realpathSync(installed),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the newest cached version of a builtin plugin', () => {
    const root = tempRoot();
    try {
      mkdirp(path.join(root, 'plugins', 'cache', 'builtin', 'com.duya.documents', '1.0.0'));
      mkdirp(path.join(root, 'plugins', 'cache', 'builtin', 'com.duya.documents', '2.0.0'));

      expect(resolvePluginInstallPath('com.duya.documents', { roots: [root] })).toBe(
        path.join(root, 'plugins', 'cache', 'builtin', 'com.duya.documents', '2.0.0'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the installed directory over the builtin cache', () => {
    const root = tempRoot();
    try {
      const installed = mkdirp(path.join(root, 'plugins', 'installed', 'com.duya.documents'));
      mkdirp(path.join(root, 'plugins', 'cache', 'builtin', 'com.duya.documents', '2.0.0'));

      expect(resolvePluginInstallPath('com.duya.documents', { roots: [root] })).toBe(
        fs.realpathSync(installed),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows an installed symlink to the versioned cache directory', (ctx) => {
    const root = tempRoot();
    try {
      const versionDir = mkdirp(
        path.join(root, 'plugins', 'cache', 'official', 'com.duya.documents', '1.2.3'),
      );
      const linkPath = path.join(root, 'plugins', 'installed', 'com.duya.documents');
      mkdirp(path.join(root, 'plugins', 'installed'));
      try {
        fs.symlinkSync(versionDir, linkPath, 'dir');
      } catch {
        // Creating a directory symlink needs elevated rights on Windows.
        ctx.skip();
        return;
      }

      expect(resolvePluginInstallPath('com.duya.documents', { roots: [root] })).toBe(
        fs.realpathSync(versionDir),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no path when the plugin is not on disk', () => {
    const root = tempRoot();
    try {
      expect(resolvePluginInstallPath('com.duya.documents', { roots: [root] })).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the plugin data directory when it exists', () => {
    const root = tempRoot();
    try {
      const dataPath = mkdirp(path.join(root, 'plugins-data', 'com.duya.documents'));

      expect(resolvePluginDataPath('com.duya.documents', { roots: [root] })).toBe(dataPath);
      expect(resolvePluginDataPath('com.duya.other', { roots: [root] })).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('plugin install root collection', () => {
  it('uses an explicit config root on its own', () => {
    expect(collectPluginInstallRoots('/tmp/duya-explicit-root')).toEqual([
      '/tmp/duya-explicit-root',
    ]);
  });

  it('stops at the data root in a test run', () => {
    const root = tempRoot();
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_DATA_ROOT', root);
    vi.stubEnv('DUYA_CLI_USER_DATA_DIR', '');
    try {
      expect(collectPluginInstallRoots()).toEqual([root]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
