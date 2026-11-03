// layout.ts — the Desktop's view of the shared plugin package layout.
//
// The layout itself lives in `@duya/plugin-core/install/layout` (plan 631): the
// standalone Host installs plugins too, and two implementations of
// `<userData>/plugins/cache/<marketplace>/<id>/<version>` plus its installed link
// is how the two surfaces end up with two copies of one plugin. This file supplies
// the root from Electron's `userData`, which is the only thing the shared module
// could not know.
import * as path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import {
  cacheStats,
  cleanupOldVersions as coreCleanupOldVersions,
  createInstalledLink,
  ensureDir,
  installedLinkPath,
  listCachedVersions as coreListCachedVersions,
  pluginCacheRoot,
  pluginInstalledRoot,
  pluginMarketplaceCacheDir,
  pluginVersionCacheDir,
  removeInstalledLink,
  resolveInstalledLink,
  type CacheStats,
  type PluginRoots,
} from '@duya/plugin-core/install/layout';

export type { CacheStats };

const COMPONENT = 'PluginCacheLayout' as LogComponent;

function roots(): PluginRoots {
  return { rootDir: app.getPath('userData') };
}

export function getPluginCacheRoot(): string {
  return pluginCacheRoot(roots());
}

export function getPluginInstalledRoot(): string {
  return pluginInstalledRoot(roots());
}

export function getPluginMarketplaceCacheDir(marketplace: string): string {
  return pluginMarketplaceCacheDir(roots(), marketplace);
}

export function getPluginVersionCacheDir(
  marketplace: string,
  pluginId: string,
  version: string,
): string {
  return pluginVersionCacheDir(roots(), marketplace, pluginId, version);
}

export function ensurePluginCacheDir(
  marketplace: string,
  pluginId: string,
  version: string,
): string {
  const cacheDir = getPluginVersionCacheDir(marketplace, pluginId, version);
  ensureDir(cacheDir);
  return cacheDir;
}

export function listCachedVersions(marketplace: string, pluginId: string): string[] {
  return coreListCachedVersions(roots(), marketplace, pluginId);
}

export function getPluginInstalledSymlinkPath(pluginId: string): string {
  return installedLinkPath(roots(), pluginId);
}

export function createInstalledSymlink(pluginId: string, cacheDir: string): void {
  createInstalledLink(roots(), pluginId, cacheDir);
  getLogger().info('Plugin symlink created', { pluginId, cacheDir }, COMPONENT);
}

export function removeInstalledSymlink(pluginId: string): void {
  removeInstalledLink(roots(), pluginId);
}

export function resolveInstalledSymlink(pluginId: string): string | null {
  return resolveInstalledLink(roots(), pluginId);
}

export function isSymlinkValid(pluginId: string, expectedCacheDir: string): boolean {
  const resolved = resolveInstalledSymlink(pluginId);
  if (!resolved) return false;
  return path.resolve(resolved) === path.resolve(expectedCacheDir);
}

export function cleanupOldVersions(
  marketplace: string,
  pluginId: string,
  keepLatest: number,
): string[] {
  return coreCleanupOldVersions(roots(), marketplace, pluginId, keepLatest);
}

export function getCacheStats(): CacheStats {
  return cacheStats(roots());
}
