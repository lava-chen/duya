// git-source.ts — the Desktop's view of the shared marketplace git execution.
//
// The clone/sync implementation moved to `@duya/plugin-core/marketplace/git-source`
// (plan 631) because a standalone Host has no Electron to ask for a cache root.
// This file supplies that root from `app.getPath('userData')`, keeps the
// Desktop's calling shape (no root argument), and adds the structured logging
// the shared implementation receives only as an optional port.
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import { marketplacesCacheRoot, type PluginRoots } from '@duya/plugin-core/install/layout';
import {
  cloneMarketplace as coreCloneMarketplace,
  clonePluginFromGit as coreClonePluginFromGit,
  marketplaceCloneDir,
  marketplacePluginGitCacheRoot,
  marketplaceStagingRoot,
  readHeadCommit,
  removeCachedPluginClone as coreRemoveCachedPluginClone,
  removeMarketplaceClone as coreRemoveMarketplaceClone,
  resolveConfiguredMarketplaceDir as coreResolveConfiguredMarketplaceDir,
  resolveSourceUrls,
  updateMarketplace as coreUpdateMarketplace,
  type MarketplaceCloneResult,
  type MarketplaceGitLog,
  type MarketplaceSourceConfig,
} from '@duya/plugin-core/marketplace/git-source';

export type { MarketplaceCloneResult, MarketplaceSourceConfig };
export { resolveSourceUrls, readHeadCommit };

const COMPONENT = 'PluginMarketplaceGit' as LogComponent;

/** Structured logging port for the shared implementation. */
function gitLog(): MarketplaceGitLog {
  const logger = getLogger();
  return {
    info: (message, meta) => logger.info(message, meta ?? {}, COMPONENT),
    warn: (message, meta) => logger.warn(message, meta ?? {}, COMPONENT),
    debug: (message, meta) => logger.debug(message, meta ?? {}, COMPONENT),
  };
}

function desktopRoots(): PluginRoots {
  return { rootDir: app.getPath('userData') };
}

export function getMarketplacesCacheRoot(): string {
  return marketplacesCacheRoot(desktopRoots());
}

/** Clone target for a marketplace name (not guaranteed to exist). */
export function getMarketplaceCloneDir(name: string, rootOverride?: string): string {
  return marketplaceCloneDir(rootOverride ?? getMarketplacesCacheRoot(), name);
}

export function getMarketplaceStagingRoot(rootOverride?: string): string {
  return marketplaceStagingRoot(rootOverride ?? getMarketplacesCacheRoot());
}

/**
 * Resolve the on-disk dir a configured marketplace currently lives in: local
 * sources point at their own directory; git sources at the clone under the
 * cache root. Returns null when the config entry is incomplete.
 */
export function resolveConfiguredMarketplaceDir(
  name: string,
  source: MarketplaceSourceConfig,
  rootOverride?: string,
): string | null {
  return coreResolveConfiguredMarketplaceDir(
    rootOverride ?? getMarketplacesCacheRoot(),
    name,
    source,
  );
}

export async function cloneMarketplace(opts: {
  urls: string[];
  name: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  return coreCloneMarketplace({
    root: opts.rootOverride ?? getMarketplacesCacheRoot(),
    urls: opts.urls,
    name: opts.name,
    ref: opts.ref,
    log: gitLog(),
  });
}

export async function updateMarketplace(opts: {
  dir: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  return coreUpdateMarketplace({
    root: opts.rootOverride ?? getMarketplacesCacheRoot(),
    dir: opts.dir,
    ref: opts.ref,
  });
}

/**
 * The cache root for individual plugin clones from marketplace git sources.
 * Path: `<marketplacesCacheRoot>/plugins/<marketplace>/<pluginName>/`
 */
export function getPluginGitCacheRoot(rootOverride?: string): string {
  return marketplacePluginGitCacheRoot(rootOverride ?? getMarketplacesCacheRoot());
}

export async function clonePluginFromGit(opts: {
  url: string;
  marketplace: string;
  pluginName: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  return coreClonePluginFromGit({
    root: opts.rootOverride ?? getMarketplacesCacheRoot(),
    url: opts.url,
    marketplace: opts.marketplace,
    pluginName: opts.pluginName,
    ref: opts.ref,
    log: gitLog(),
  });
}

/** Remove a cached git plugin clone. Only ever touches the plugin cache subtree. */
export function removeCachedPluginClone(
  marketplace: string,
  pluginName: string,
  rootOverride?: string,
): void {
  coreRemoveCachedPluginClone(rootOverride ?? getMarketplacesCacheRoot(), marketplace, pluginName);
}

/** Remove a marketplace clone. Only ever touches the cache root subtree. */
export function removeMarketplaceClone(name: string, rootOverride?: string): void {
  coreRemoveMarketplaceClone(rootOverride ?? getMarketplacesCacheRoot(), name);
}
