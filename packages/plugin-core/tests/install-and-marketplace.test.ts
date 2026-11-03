/**
 * Install + marketplace primitives, exercised against a temporary root.
 *
 * These are the functions both the Desktop and a standalone Host now share, so
 * the assertions are about the invariants each surface used to re-implement:
 * containment, the staging→cache swap, the installed link, and a catalog that
 * refuses to read outside its own clone.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupOldVersions,
  createInstalledLink,
  ensurePluginRoots,
  installedLinkPath,
  listCachedVersions,
  marketplacesCacheRoot,
  newestCachedVersionDir,
  pluginDataDir,
  pluginMarketplaceCacheDir,
  pluginVersionCacheDir,
  removeInstalledLink,
  resolveInstalledLink,
  cacheStats,
} from '../src/install/layout';
import {
  assertPathSegment,
  copyDirectoryRecursive,
  installPluginPackage,
  uninstallPluginPackage,
} from '../src/install/package';
import {
  marketplaceCloneDir,
  removeMarketplaceClone,
  resolveConfiguredMarketplaceDir,
  resolveSourceUrls,
} from '../src/marketplace/git-source';
import {
  readMarketplaceManifest,
  resolveContainedPath,
  resolvePluginEntryDir,
} from '../src/marketplace/manifest';
import { isDefaultOfficialSource } from '../src/marketplace/official-seeds';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-plugin-install-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writePackage(dir: string, name: string, version: string): void {
  writeFile(
    path.join(dir, '.duya-plugin', 'plugin.json'),
    JSON.stringify({ name, version, description: `${name} package` }),
  );
  writeFile(path.join(dir, 'skills', `${name}.md`), `# ${name}\n`);
}

describe('install/layout — derived directories', () => {
  it('hangs every path under the root the caller names', () => {
    const roots = { rootDir: root };
    expect(marketplacesCacheRoot(roots)).toBe(path.join(root, 'plugins', 'cache', 'marketplaces'));
    expect(pluginMarketplaceCacheDir(roots, 'official')).toBe(
      path.join(root, 'plugins', 'cache', 'official'),
    );
    expect(pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.2.3')).toBe(
      path.join(root, 'plugins', 'cache', 'official', 'com.duya.pdf', '1.2.3'),
    );
    expect(pluginDataDir(roots, 'com.duya.pdf')).toBe(path.join(root, 'plugins-data', 'com.duya.pdf'));
    expect(installedLinkPath(roots, 'com.duya.pdf')).toBe(
      path.join(root, 'plugins', 'installed', 'com.duya.pdf'),
    );
  });

  it('creates the roots an install needs in one call', () => {
    ensurePluginRoots({ rootDir: root });
    // The cache root is deliberately absent: only an install writes a versioned
    // directory, and `installPluginPackage` creates its own parent. A root that
    // pre-created it would leave an empty `plugins/cache` on every machine that
    // never installed anything.
    for (const segment of ['plugins/installed', 'plugins/staging', 'plugins-data']) {
      expect(fs.statSync(path.join(root, segment)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'plugins', 'cache'))).toBe(false);
  });

  it('lists cached versions by name and treats the last as newest', () => {
    const roots = { rootDir: root };
    for (const version of ['0.9.0', '1.10.0', '1.2.0']) {
      fs.mkdirSync(pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', version), { recursive: true });
    }
    // Lexical, and that is the inherited rule: the Desktop's own cleanup has
    // always ordered version directories by name. `1.10.0` therefore sorts
    // before `1.2.0`, which is wrong for a real semver but is what every
    // existing cache on disk was written under. Changing it here would make a
    // TUI install disagree with a Desktop install of the same plugin.
    expect(listCachedVersions(roots, 'official', 'com.duya.pdf')).toEqual(['0.9.0', '1.10.0', '1.2.0']);
    expect(newestCachedVersionDir(roots, 'official', 'com.duya.pdf')).toBe(
      pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.2.0'),
    );
  });

  it('keeps the newest versions and drops the rest', () => {
    const roots = { rootDir: root };
    for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
      fs.mkdirSync(pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', version), { recursive: true });
    }
    expect(cleanupOldVersions(roots, 'official', 'com.duya.pdf', 2)).toEqual(['1.0.0', '1.1.0']);
    expect(listCachedVersions(roots, 'official', 'com.duya.pdf')).toEqual(['1.2.0', '1.3.0']);
  });

  it('resolves an installed link back to its cache directory', () => {
    const roots = { rootDir: root };
    const cacheDir = pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.0.0');
    fs.mkdirSync(cacheDir, { recursive: true });
    writeFile(path.join(cacheDir, 'plugin.json'), '{}');

    createInstalledLink(roots, 'com.duya.pdf', cacheDir);
    const resolved = resolveInstalledLink(roots, 'com.duya.pdf');
    expect(resolved).not.toBeNull();
    expect(fs.realpathSync(resolved as string)).toBe(fs.realpathSync(cacheDir));

    removeInstalledLink(roots, 'com.duya.pdf');
    expect(resolveInstalledLink(roots, 'com.duya.pdf')).toBeNull();
    // The cache it pointed at is still there: removing a link is not removing a package.
    expect(fs.existsSync(cacheDir)).toBe(true);
  });

  it('replacing a link never leaves the previous target deleted', () => {
    const roots = { rootDir: root };
    const first = pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.0.0');
    const second = pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '2.0.0');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });

    createInstalledLink(roots, 'com.duya.pdf', first);
    createInstalledLink(roots, 'com.duya.pdf', second);
    expect(fs.realpathSync((resolveInstalledLink(roots, 'com.duya.pdf')) as string)).toBe(
      fs.realpathSync(second),
    );
    expect(fs.existsSync(first)).toBe(true);
  });

  it('counts what the cache holds', () => {
    const roots = { rootDir: root };
    const dir = pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.0.0');
    fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, 'plugin.json'), '{}');
    const stats = cacheStats(roots);
    expect(stats.totalPlugins).toBe(1);
    expect(stats.totalVersions).toBe(1);
    expect(stats.totalSizeBytes).toBeGreaterThan(0);
  });
});

describe('install/package — install and uninstall', () => {
  it('copies the source into the cache and links it', () => {
    const roots = { rootDir: root };
    const source = path.join(root, 'source');
    writePackage(source, 'pdf', '1.0.0');

    const installed = installPluginPackage({
      roots,
      marketplace: 'official',
      pluginId: 'com.duya.pdf',
      version: '1.0.0',
      sourceDir: source,
    });

    expect(installed.cacheDir).toBe(pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.0.0'));
    expect(fs.readFileSync(path.join(installed.cacheDir, 'skills', 'pdf.md'), 'utf8')).toContain('# pdf');
    expect(fs.existsSync(installed.dataPath)).toBe(true);
    expect(resolveInstalledLink(roots, 'com.duya.pdf')).not.toBeNull();
    // Nothing is left in staging: the swap is the whole point of it.
    expect(fs.readdirSync(path.join(root, 'plugins', 'staging'))).toEqual([]);
  });

  it('re-installing replaces the cache instead of appending to it', () => {
    const roots = { rootDir: root };
    const first = path.join(root, 'src-a');
    const second = path.join(root, 'src-b');
    writePackage(first, 'pdf', '1.0.0');
    writeFile(path.join(first, 'gone.md'), 'stale');
    writePackage(second, 'pdf', '1.0.0');

    installPluginPackage({
      roots, marketplace: 'official', pluginId: 'com.duya.pdf', version: '1.0.0', sourceDir: first,
    });
    const installed = installPluginPackage({
      roots, marketplace: 'official', pluginId: 'com.duya.pdf', version: '1.0.0', sourceDir: second,
    });

    expect(fs.existsSync(path.join(installed.cacheDir, 'gone.md'))).toBe(false);
    expect(fs.existsSync(path.join(installed.cacheDir, 'skills', 'pdf.md'))).toBe(true);
  });

  it('refuses a missing source rather than writing a manifest-only package', () => {
    const roots = { rootDir: root };
    expect(() =>
      installPluginPackage({
        roots,
        marketplace: 'official',
        pluginId: 'com.duya.pdf',
        version: '1.0.0',
        sourceDir: path.join(root, 'nowhere'),
      }),
    ).toThrow(/source directory not found/);
    expect(fs.existsSync(pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.0.0'))).toBe(false);
    expect(resolveInstalledLink(roots, 'com.duya.pdf')).toBeNull();
  });

  it('rejects a name that would climb out of the tree', () => {
    const roots = { rootDir: root };
    const source = path.join(root, 'source');
    writePackage(source, 'pdf', '1.0.0');
    for (const bad of ['../escape', '..', 'a/b', '.']) {
      expect(() =>
        installPluginPackage({
          roots, marketplace: bad, pluginId: 'com.duya.pdf', version: '1.0.0', sourceDir: source,
        }),
      ).toThrow(/invalid marketplace/);
    }
    expect(assertPathSegment('com.duya.pdf', 'plugin id')).toBe('com.duya.pdf');
  });

  it('uninstall removes the link and the cached versions, data only when asked', () => {
    const roots = { rootDir: root };
    const source = path.join(root, 'source');
    writePackage(source, 'pdf', '1.0.0');
    installPluginPackage({
      roots, marketplace: 'official', pluginId: 'com.duya.pdf', version: '1.0.0', sourceDir: source,
    });
    writeFile(path.join(pluginDataDir(roots, 'com.duya.pdf'), 'state.json'), '{}');

    const removed = uninstallPluginPackage({ roots, marketplace: 'official', pluginId: 'com.duya.pdf' });
    expect(removed.length).toBeGreaterThan(0);
    expect(resolveInstalledLink(roots, 'com.duya.pdf')).toBeNull();
    expect(fs.existsSync(pluginVersionCacheDir(roots, 'official', 'com.duya.pdf', '1.0.0'))).toBe(false);
    expect(fs.existsSync(pluginDataDir(roots, 'com.duya.pdf'))).toBe(true);

    uninstallPluginPackage({
      roots, marketplace: 'official', pluginId: 'com.duya.pdf', deleteData: true,
    });
    expect(fs.existsSync(pluginDataDir(roots, 'com.duya.pdf'))).toBe(false);
  });

  it('preserves a symlink inside a package instead of following it', () => {
    const src = path.join(root, 'src');
    const outside = path.join(root, 'outside-secret');
    writeFile(outside, 'content');
    fs.mkdirSync(path.join(src, 'nested'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(src, 'nested', 'link'), 'dir');
    } catch {
      // A machine without symlink permission cannot test this; the copy path is
      // still covered by every other case here.
      return;
    }
    const dest = path.join(root, 'dest');
    copyDirectoryRecursive(src, dest);
    expect(fs.lstatSync(path.join(dest, 'nested', 'link')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('marketplace/git-source — configured directories', () => {
  it('prefers urls over url and falls back for legacy configs', () => {
    expect(resolveSourceUrls({ source: 'git', urls: ['https://a/x.git', 'https://b/x.git'] })).toEqual([
      'https://a/x.git',
      'https://b/x.git',
    ]);
    expect(resolveSourceUrls({ source: 'git', url: 'https://a/x.git' })).toEqual(['https://a/x.git']);
    expect(resolveSourceUrls({ source: 'git' })).toEqual([]);
  });

  it('resolves a local source to its own dir and a git source under the cache', () => {
    const cache = marketplacesCacheRoot({ rootDir: root });
    expect(resolveConfiguredMarketplaceDir(cache, 'mine', { source: 'local', path: root })).toBe(root);
    expect(resolveConfiguredMarketplaceDir(cache, 'mine', { source: 'git' })).toBeNull();
    expect(resolveConfiguredMarketplaceDir(cache, 'mine', { source: 'git', url: 'https://a/x.git' })).toBe(
      marketplaceCloneDir(cache, 'mine'),
    );
  });

  it('removes a clone that exists and tolerates one that does not', () => {
    const cache = marketplacesCacheRoot({ rootDir: root });
    const dir = marketplaceCloneDir(cache, 'mine');
    writeFile(path.join(dir, 'marketplace.json'), '{}');
    removeMarketplaceClone(cache, 'mine');
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => removeMarketplaceClone(cache, 'mine')).not.toThrow();
  });
});

describe('marketplace/manifest — reading a catalog', () => {
  const MANIFEST = {
    name: 'acme-market',
    interface: { displayName: 'Acme' },
    plugins: [
      { name: 'pdf', source: { source: 'local', path: './plugins/pdf' } },
      { name: 'remote', source: { source: 'git', url: 'https://github.com/acme/remote.git' } },
      { name: 'locked', source: { source: 'local', path: './plugins/locked' }, policy: { installation: 'NOT_AVAILABLE' } },
    ],
  };

  function materializeMarketplace(): string {
    const dir = path.join(root, 'market');
    writeFile(path.join(dir, 'marketplace.json'), JSON.stringify(MANIFEST));
    writePackage(path.join(dir, 'plugins', 'pdf'), 'pdf', '1.0.0');
    return dir;
  }

  it('reads the catalog and folds an UPPERCASE policy enum', () => {
    const manifest = readMarketplaceManifest(materializeMarketplace());
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe('acme-market');
    expect(manifest?.displayName).toBe('Acme');
    expect(manifest?.plugins).toHaveLength(3);
    // Codex spells policies in capitals; the adapter folds them so a Codex
    // catalog validates instead of being skipped whole.
    expect(manifest?.plugins[2]?.policy?.installation).toBe('not_available');
  });

  it('returns null when a real directory holds no catalog', () => {
    // The directory exists but offers none of the probed paths. A missing
    // directory is a different question — every caller probes `existsSync`
    // first, because `resolveContainedPath` canonicalises its root and a root
    // that is not there throws rather than reporting "nothing found".
    const dir = path.join(root, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    expect(readMarketplaceManifest(dir)).toBeNull();
  });

  it('throws on a malformed catalog so the caller can name the source', () => {
    const dir = path.join(root, 'broken');
    writeFile(path.join(dir, 'marketplace.json'), '{ not json');
    expect(() => readMarketplaceManifest(dir)).toThrow(/not valid JSON/);
  });

  it('fences a declared path inside the clone', () => {
    const dir = materializeMarketplace();
    expect(resolvePluginEntryDir(dir, { name: 'pdf', source: { source: 'local', path: './plugins/pdf' } })).toBe(
      path.join(dir, 'plugins', 'pdf'),
    );
    expect(() =>
      resolvePluginEntryDir(dir, { name: 'x', source: { source: 'local', path: '../../../../etc' } }),
    ).toThrow(/escapes marketplace root/);
    expect(() => resolveContainedPath(dir, path.resolve(root, 'outside'))).toThrow(
      /escapes marketplace root/,
    );
  });

  it('refuses a git entry that has not been materialized yet', () => {
    const dir = materializeMarketplace();
    const entry = {
      name: 'remote',
      source: { source: 'git' as const, url: 'https://github.com/acme/remote.git' },
    };
    expect(() => resolvePluginEntryDir(dir, entry)).toThrow(/has not been materialized/);
    const clone = path.join(root, 'clone');
    writeFile(path.join(clone, 'plugin.json'), '{"name":"remote"}');
    expect(resolvePluginEntryDir(dir, entry, clone)).toBe(fs.realpathSync(clone));
  });
});

describe('marketplace/official-seeds', () => {
  it('knows the pre-seeded sources by their registry key', () => {
    expect(isDefaultOfficialSource('official')).toBe(true);
    expect(isDefaultOfficialSource('codex-official')).toBe(true);
    expect(isDefaultOfficialSource('user-added')).toBe(false);
  });
});
