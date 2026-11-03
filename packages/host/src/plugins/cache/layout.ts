import fs from 'fs';
import path from 'path';
import type { PluginFileEnvironment } from '../ports.js';
import { compareVersions } from './version-resolver.js';
type LogComponent = string;
export function createPluginLayout(options: PluginFileEnvironment) {
  const app = { getPath: (_name: string) => options.packageRoot };
  const getLogger = () => options.logger;
  const COMPONENT = 'PluginCacheLayout' as LogComponent;
  function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
  function getPluginCacheRoot(): string {
    const userData = app.getPath('userData');
    return path.join(userData, 'plugins', 'cache');
  }
  function getPluginInstalledRoot(): string {
    const userData = app.getPath('userData');
    return path.join(userData, 'plugins', 'installed');
  }
  function getPluginMarketplaceCacheDir(marketplace: string): string {
    return path.join(getPluginCacheRoot(), marketplace);
  }
  function getPluginVersionCacheDir(
    marketplace: string,
    pluginId: string,
    version: string
  ): string {
    return path.join(getPluginCacheRoot(), marketplace, pluginId, version);
  }
  function ensurePluginCacheDir(
    marketplace: string,
    pluginId: string,
    version: string
  ): string {
    const cacheDir = getPluginVersionCacheDir(marketplace, pluginId, version);
    ensureDir(cacheDir);
    return cacheDir;
  }
  function listCachedVersions(
    marketplace: string,
    pluginId: string
  ): string[] {
    const pluginCacheDir = path.join(getPluginCacheRoot(), marketplace, pluginId);
    if (!fs.existsSync(pluginCacheDir)) return [];

    return fs
      .readdirSync(pluginCacheDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort(compareVersions);
  }
  function getPluginInstalledSymlinkPath(pluginId: string): string {
    return path.join(getPluginInstalledRoot(), pluginId);
  }
  function linkEntryExists(linkPath: string): boolean {
    try {
      fs.lstatSync(linkPath);
      return true;
    } catch {
      return false;
    }
  }
  function createInstalledSymlink(
    pluginId: string,
    cacheDir: string
  ): void {
    const logger = getLogger();
    const installedDir = getPluginInstalledRoot();
    ensureDir(installedDir);

    const linkPath = getPluginInstalledSymlinkPath(pluginId);
    removeInstalledSymlink(pluginId);

    fs.symlinkSync(cacheDir, linkPath, 'dir');
    logger.info('Plugin symlink created', { pluginId, cacheDir }, COMPONENT);
  }
  function removeInstalledSymlink(pluginId: string): void {
    const linkPath = installedLinkPaths(pluginId).find(linkEntryExists);
    if (!linkPath) return;

    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      // Real directory at the link path (never created by this module, but
      // rmSync on the path itself does not follow it, so this is safe).
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  function installedLinkPaths(pluginId: string): string[] { return (options.readRoots ?? [options.packageRoot]).map(root => path.join(root, 'plugins', 'installed', pluginId)); }
  function resolveInstalledSymlink(pluginId: string): string | null {
    const linkPath = installedLinkPaths(pluginId).find(file => fs.existsSync(file));
    if (!linkPath) return null;

    try {
      return fs.realpathSync(linkPath);
    } catch {
      return null;
    }
  }
  function resolvePluginDataPath(pluginId: string): string | undefined {
    return (options.readRoots ?? [options.packageRoot]).map(root => path.join(root, 'plugins-data', pluginId)).find(file => fs.existsSync(file));
  }
  function isSymlinkValid(pluginId: string, expectedCacheDir: string): boolean {
    const resolved = resolveInstalledSymlink(pluginId);
    if (!resolved) return false;
    return path.resolve(resolved) === path.resolve(expectedCacheDir);
  }
  function cleanupOldVersions(
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
  function getCacheStats(): {
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
  function assertManagedPath(target: string, kind: 'package' | 'data'): void {
    const resolved = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
    const allowed = (options.readRoots ?? [options.packageRoot]).some(root => {
      const directory = kind === 'package' ? path.join(root, 'plugins', 'cache') : path.join(root, 'plugins-data');
      const absolute = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory);
      return resolved.startsWith(absolute + path.sep);
    });
    if (!allowed) throw new Error('Plugin path is outside managed storage');
  }
  return { resolvePluginDataPath, assertManagedPath, getPluginCacheRoot, getPluginInstalledRoot, getPluginMarketplaceCacheDir, getPluginVersionCacheDir, ensurePluginCacheDir, listCachedVersions, getPluginInstalledSymlinkPath, createInstalledSymlink, removeInstalledSymlink, resolveInstalledSymlink, isSymlinkValid, cleanupOldVersions, getCacheStats };
}
