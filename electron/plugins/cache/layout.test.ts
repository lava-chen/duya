// electron/plugins/cache/layout.test.ts
// Installed-symlink lifecycle regression tests. Covers the dangling-symlink
// bug: uninstall deleted the versioned cache before unlinking the installed
// link, and an existsSync-based cleanup skipped the resulting dangling link,
// so every reinstall failed with EEXIST on `fs.symlinkSync`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  lstatSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const state = vi.hoisted(() => ({ tempRoot: '' as string }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.tempRoot,
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: { Main: 'Main' },
}));

import {
  createInstalledSymlink,
  removeInstalledSymlink,
  getPluginInstalledSymlinkPath,
  getPluginVersionCacheDir,
} from './layout';

const PLUGIN_ID = 'com.duya.test';

function buildCacheDir(): string {
  const cacheDir = getPluginVersionCacheDir('official', PLUGIN_ID, '0.1.0');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'marker.txt'), 'cache');
  return cacheDir;
}

describe('plugin cache layout — installed symlink', () => {
  beforeEach(() => {
    state.tempRoot = mkdtempSync(join(tmpdir(), 'duya-plugin-layout-'));
  });

  afterEach(() => {
    if (state.tempRoot) rmSync(state.tempRoot, { recursive: true, force: true });
  });

  it('creates and removes a valid installed symlink', () => {
    const cacheDir = buildCacheDir();
    const linkPath = getPluginInstalledSymlinkPath(PLUGIN_ID);

    createInstalledSymlink(PLUGIN_ID, cacheDir);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    removeInstalledSymlink(PLUGIN_ID);
    expect(lstatSync(linkPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('re-creates the link over a dangling symlink (reinstall after uninstall)', () => {
    const cacheDir = buildCacheDir();
    const linkPath = getPluginInstalledSymlinkPath(PLUGIN_ID);

    createInstalledSymlink(PLUGIN_ID, cacheDir);

    // Simulate the uninstall order that used to leave a ghost link: the
    // versioned cache is deleted while the installed link still points at it.
    rmSync(cacheDir, { recursive: true, force: true });
    expect(existsSync(linkPath)).toBe(false); // dangling — target gone
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true); // but link remains

    // Reinstall must not throw EEXIST on the leftover dangling link.
    buildCacheDir();
    expect(() => createInstalledSymlink(PLUGIN_ID, cacheDir)).not.toThrow();
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(linkPath)).toBe(true);
  });

  it('removes a dangling installed symlink', () => {
    const cacheDir = buildCacheDir();
    const linkPath = getPluginInstalledSymlinkPath(PLUGIN_ID);

    createInstalledSymlink(PLUGIN_ID, cacheDir);
    rmSync(cacheDir, { recursive: true, force: true });

    removeInstalledSymlink(PLUGIN_ID);
    expect(lstatSync(linkPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('replaces a real directory left at the link path', () => {
    const cacheDir = buildCacheDir();
    const linkPath = getPluginInstalledSymlinkPath(PLUGIN_ID);

    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'stale.txt'), 'stale');

    expect(() => createInstalledSymlink(PLUGIN_ID, cacheDir)).not.toThrow();
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(linkPath, 'stale.txt'))).toBe(false);
  });
});
