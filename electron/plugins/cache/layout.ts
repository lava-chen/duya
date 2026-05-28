import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';

const COMPONENT = 'PluginCacheLayout' as LogComponent;

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getPluginCacheRoot(): string {
  const userData = app.getPath('userData');
  return path.join(userData, 'plugins', 'cache');
}

export function getPluginInstalledRoot(): string {
  const userData = app.getPath('userData');
  return path.join(userData, 'plugins', 'installed');
}

export function getPluginMarketplaceCacheDir(marketplace: string): string {
  return path.join(getPluginCacheRoot(), marketplace);
}

export function getPluginVersionCacheDir(
  marketplace: string,
  pluginId: string,
  version: string
): string {
  return path.join(getPluginCacheRoot(), marketplace, pluginId, version);
}

export function ensurePluginCacheDir(
  marketplace: string,
  pluginId: string,
  version: string
): string {
  const cacheDir = getPluginVersionCacheDir(marketplace, pluginId, version);
  ensureDir(cacheDir);
  return cacheDir;
}

export function listCachedVersions(
  marketplace: string,
  pluginId: string
): string[] {
  const pluginCacheDir = path.join(getPluginCacheRoot(), marketplace, pluginId);
  if (!fs.existsSync(pluginCacheDir)) return [];

  return fs
    .readdirSync(pluginCacheDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();
}

export function getPluginInstalledSymlinkPath(pluginId: string): string {
  return path.join(getPluginInstalledRoot(), pluginId);
}

export function createInstalledSymlink(
  pluginId: string,
  cacheDir: string
): void {
  const logger = getLogger();
  const installedDir = getPluginInstalledRoot();
  ensureDir(installedDir);

  const linkPath = getPluginInstalledSymlinkPath(pluginId);

  if (fs.existsSync(linkPath)) {
    if (fs.lstatSync(linkPath).isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }

  fs.symlinkSync(cacheDir, linkPath, 'dir');
  logger.info('Plugin symlink created', { pluginId, cacheDir }, COMPONENT);
}

export function removeInstalledSymlink(pluginId: string): void {
  const linkPath = getPluginInstalledSymlinkPath(pluginId);
  if (fs.existsSync(linkPath)) {
    fs.unlinkSync(linkPath);
  }
}

export function resolveInstalledSymlink(pluginId: string): string | null {
  const linkPath = getPluginInstalledSymlinkPath(pluginId);
  if (!fs.existsSync(linkPath)) return null;

  try {
    return fs.realpathSync(linkPath);
  } catch {
    return null;
  }
}

export function isSymlinkValid(pluginId: string, expectedCacheDir: string): boolean {
  const resolved = resolveInstalledSymlink(pluginId);
  if (!resolved) return false;
  return path.resolve(resolved) === path.resolve(expectedCacheDir);
}

export function cleanupOldVersions(
  marketplace: string,
  pluginId: string,
  keepLatest: number
): string[] {
  const logger = getLogger();
  const versions = listCachedVersions(marketplace, pluginId);

  if (versions.length <= keepLatest) return [];

  const toRemove = versions.slice(0, versions.length - keepLatest);
  const pluginCacheDir = path.join(getPluginCacheRoot(), marketplace, pluginId);

  for (const version of toRemove) {
    const versionDir = path.join(pluginCacheDir, version);
    fs.rmSync(versionDir, { recursive: true, force: true });
    logger.info('Cleaned up old plugin version', { pluginId, version }, COMPONENT);
  }

  return toRemove;
}

export function getCacheStats(): {
  totalPlugins: number;
  totalVersions: number;
  totalSizeBytes: number;
} {
  const cacheRoot = getPluginCacheRoot();
  if (!fs.existsSync(cacheRoot)) {
    return { totalPlugins: 0, totalVersions: 0, totalSizeBytes: 0 };
  }

  let totalPlugins = 0;
  let totalVersions = 0;
  let totalSizeBytes = 0;

  function walk(dir: string, depth: number): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 2) totalVersions++;
        if (depth === 1) totalPlugins++;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          totalSizeBytes += fs.statSync(fullPath).size;
        } catch {
          // skip inaccessible files
        }
      }
    }
  }

  walk(cacheRoot, 0);
  return { totalPlugins, totalVersions, totalSizeBytes };
}