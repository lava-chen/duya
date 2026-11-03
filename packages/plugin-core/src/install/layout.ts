/**
 * layout.ts — the on-disk plugin package layout, with the root named by the
 * caller.
 *
 * ## The tree
 *
 *   <rootDir>/plugins/cache/<marketplace>/<id>/<version>   the package itself
 *   <rootDir>/plugins/cache/marketplaces                   marketplace clones
 *   <rootDir>/plugins/installed/<id>                       link to one version
 *   <rootDir>/plugins/staging/<uuid>                       copy lands here first
 *   <rootDir>/plugins-data/<id>                            the plugin's own state
 *
 * A consumer resolves the installed link and reads the versioned cache
 * directory, which is what lets two versions of one plugin coexist and what
 * makes "installed" a pointer rather than a copy.
 *
 * ## Why a root instead of a getter
 *
 * The Desktop resolved `rootDir` through Electron's `app.getPath('userData')`.
 * A standalone Host has no Electron, and the two surfaces must not each keep a
 * private copy of the same plugin, so every function here takes the root and
 * neither surface gets to guess.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The user-data directory that holds `plugins/` and `plugins-data/`. */
export interface PluginRoots {
  readonly rootDir: string;
}

/** A marketplace's clone cache, inside the plugin package cache. */
export const MARKETPLACES_CACHE_SEGMENT = 'marketplaces';

/** The cache segment the pre-seeded builtin plugins are stored under. */
export const BUILTIN_MARKETPLACE = 'builtin';

export function pluginsDir(roots: PluginRoots): string {
  return path.join(roots.rootDir, 'plugins');
}

export function pluginCacheRoot(roots: PluginRoots): string {
  return path.join(pluginsDir(roots), 'cache');
}

export function pluginInstalledRoot(roots: PluginRoots): string {
  return path.join(pluginsDir(roots), 'installed');
}

export function pluginStagingRoot(roots: PluginRoots): string {
  return path.join(pluginsDir(roots), 'staging');
}

export function pluginDataRoot(roots: PluginRoots): string {
  return path.join(roots.rootDir, 'plugins-data');
}

export function marketplacesCacheRoot(roots: PluginRoots): string {
  return path.join(pluginCacheRoot(roots), MARKETPLACES_CACHE_SEGMENT);
}

export function pluginMarketplaceCacheDir(roots: PluginRoots, marketplace: string): string {
  return path.join(pluginCacheRoot(roots), marketplace);
}

export function pluginVersionCacheDir(
  roots: PluginRoots,
  marketplace: string,
  pluginId: string,
  version: string,
): string {
  return path.join(pluginCacheRoot(roots), marketplace, pluginId, version);
}

export function pluginDataDir(roots: PluginRoots, pluginId: string): string {
  return path.join(pluginDataRoot(roots), pluginId);
}

export function installedLinkPath(roots: PluginRoots, pluginId: string): string {
  return path.join(pluginInstalledRoot(roots), pluginId);
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function ensurePluginRoots(roots: PluginRoots): void {
  ensureDir(pluginInstalledRoot(roots));
  ensureDir(pluginStagingRoot(roots));
  ensureDir(pluginDataRoot(roots));
}

/** Version directories cached for one plugin, sorted by name. */
export function listCachedVersions(
  roots: PluginRoots,
  marketplace: string,
  pluginId: string,
): string[] {
  const dir = path.join(pluginCacheRoot(roots), marketplace, pluginId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The newest cached version directory of a plugin, or null when nothing is
 * cached. Readers that only know the plugin id (the builtin seed layout)
 * resolve through this so they pick the same version the writer stored.
 */
export function newestCachedVersionDir(
  roots: PluginRoots,
  marketplace: string,
  pluginId: string,
): string | null {
  const versions = listCachedVersions(roots, marketplace, pluginId);
  const newest = versions[versions.length - 1];
  if (newest === undefined) return null;
  const dir = path.join(pluginCacheRoot(roots), marketplace, pluginId, newest);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * lstat-based existence check for the installed link path. `fs.existsSync`
 * follows the link, so it returns false for a dangling symlink (one whose
 * versioned cache dir is already gone) — using it here silently skipped
 * cleanup of ghost links and made every reinstall fail with EEXIST.
 */
function linkEntryExists(linkPath: string): boolean {
  try {
    fs.lstatSync(linkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point `installed/<id>` at `cacheDir`, replacing whatever link was there.
 *
 * On Windows a symlink needs elevation or Developer Mode, and a plain
 * `EPERM` there does not mean the install failed — a directory junction is
 * creatable by an ordinary user and resolves the same way through
 * `realpathSync`. So the link is the first choice and the junction is the
 * fallback, and a failure of both is the caller's to report.
 */
export function createInstalledLink(roots: PluginRoots, pluginId: string, cacheDir: string): void {
  ensureDir(pluginInstalledRoot(roots));
  const link = installedLinkPath(roots, pluginId);
  removeInstalledLink(roots, pluginId);
  try {
    fs.symlinkSync(cacheDir, link, 'dir');
  } catch (error) {
    if (!isWindowsPrivilegeError(error)) throw error;
    fs.symlinkSync(cacheDir, link, 'junction');
  }
}

function isWindowsPrivilegeError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as { code?: string } | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

export function removeInstalledLink(roots: PluginRoots, pluginId: string): void {
  const link = installedLinkPath(roots, pluginId);
  if (!linkEntryExists(link)) return;

  const stat = fs.lstatSync(link);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(link);
  } else {
    // A real directory or a Windows junction at the link path. `rmSync` on the
    // path itself does not follow either, so this cannot delete what they point
    // at — and a junction is what a non-elevated install leaves behind.
    fs.rmSync(link, { recursive: true, force: true });
  }
}

/** The versioned cache directory the installed link points at, or null. */
export function resolveInstalledLink(roots: PluginRoots, pluginId: string): string | null {
  const link = installedLinkPath(roots, pluginId);
  if (!fs.existsSync(link)) return null;
  try {
    return fs.realpathSync(link);
  } catch {
    return null;
  }
}

/** Remove versions older than the newest `keepLatest`. */
export function cleanupOldVersions(
  roots: PluginRoots,
  marketplace: string,
  pluginId: string,
  keepLatest: number,
): string[] {
  const versions = listCachedVersions(roots, marketplace, pluginId);
  if (versions.length <= keepLatest) return [];

  const toRemove = versions.slice(0, versions.length - keepLatest);
  const pluginCacheDir = path.join(pluginCacheRoot(roots), marketplace, pluginId);
  for (const version of toRemove) {
    fs.rmSync(path.join(pluginCacheDir, version), { recursive: true, force: true });
  }
  return toRemove;
}

/** What the cache holds, for a settings surface that offers to clean it. */
export interface CacheStats {
  readonly totalPlugins: number;
  readonly totalVersions: number;
  readonly totalSizeBytes: number;
}

/**
 * Walk the cache counting `<marketplace>/<plugin>/<version>` directories.
 *
 * The depth counters are the layout above expressed as numbers, so an
 * "installed size" that a surface shows cannot disagree with what a removal
 * is able to find.
 */
export function cacheStats(roots: PluginRoots): CacheStats {
  const cacheRoot = pluginCacheRoot(roots);
  if (!fs.existsSync(cacheRoot)) {
    return { totalPlugins: 0, totalVersions: 0, totalSizeBytes: 0 };
  }

  let totalPlugins = 0;
  let totalVersions = 0;
  let totalSizeBytes = 0;

  const walk = (dir: string, depth: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 1) totalPlugins++;
        if (depth === 2) totalVersions++;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          totalSizeBytes += fs.statSync(fullPath).size;
        } catch {
          // A file that cannot be stat'd is not a size anyone can act on.
        }
      }
    }
  };

  walk(cacheRoot, 0);
  return { totalPlugins, totalVersions, totalSizeBytes };
}
