import type { HostLocalPluginSetupApiV1 } from '@duya/agent-protocol/plugin-setup';
import type { createPluginLayout } from './cache/layout.js';
import type { createPluginGitSource } from './marketplace/git-source.js';
import type { createPluginCatalog } from './catalog.js';
import type { PluginRegistryStore } from './PluginRegistryStore.js';
import type { readPluginManifest, listCapabilityKinds } from './manifest.js';

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>, component?: string): void;
  info(message: string, data?: Record<string, unknown>, component?: string): void;
  warn(message: string, data?: Record<string, unknown>, component?: string): void;
  error(message: string, data?: Record<string, unknown>, component?: string): void;
}

/** Every operation reads current state; no client owns a second registry snapshot. */
export interface PluginConfigPort {
  getByPath(key: string): unknown;
  set(key: string, value: unknown): unknown;
}

export interface BuiltinSeedOutcome {
  seeded: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
}

export interface PluginFileEnvironment {
  packageRoot: string;
  readRoots?: readonly string[] | undefined;
  logger: PluginLogger;
}

export interface PluginCatalogEnvironment extends PluginFileEnvironment {
  config: PluginConfigPort;
  bundledSkillsRoot(): string;
  git: ReturnType<typeof createPluginGitSource>;
  builtinRoot(): string;
  seedBuiltins(): BuiltinSeedOutcome;
}

export interface MarketplaceEnvironment extends PluginFileEnvironment {
  config: PluginConfigPort;
  git: ReturnType<typeof createPluginGitSource>;
  catalog: ReturnType<typeof createPluginCatalog>;
}

export type PluginManagerEnvironment = Pick<ReturnType<typeof createPluginCatalog>,
  'getPluginCatalog' | 'getPluginCatalogEntry' | 'getLocalPluginPaths' | 'resolveIconUrl'> &
  Pick<ReturnType<typeof createPluginLayout>, 'ensurePluginCacheDir' | 'createInstalledSymlink' |
    'removeInstalledSymlink' | 'getPluginVersionCacheDir' | 'getPluginInstalledRoot' |
    'cleanupOldVersions' | 'resolveInstalledSymlink' | 'resolvePluginDataPath' | 'assertManagedPath'> & {
      logger: PluginLogger;
      readPluginManifest: typeof readPluginManifest;
      listCapabilityKinds: typeof listCapabilityKinds;
      store: Pick<PluginRegistryStore, 'getPaths' | 'listPlugins' | 'upsertPlugin' | 'removePlugin'>;
      clonePluginFromGit: ReturnType<typeof createPluginGitSource>['clonePluginFromGit'];
      getBuiltinPluginsSourceDirs(): string[];
      setupApi(): HostLocalPluginSetupApiV1;
      notifyAppsChanged(pluginId: string): void;
      notifyMcpConfigChanged(): unknown;
    };
