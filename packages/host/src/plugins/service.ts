import fs from 'node:fs';
import path from 'node:path';
import type { HostLocalPluginSetupApiV1 } from '@duya/agent-protocol/plugin-setup';
import { collectPluginInstallRoots } from '../plugin-install-paths.js';
import { resolveConfigRoot } from '../agent-profile-config.js';
import { createPluginCatalog } from './catalog.js';
import { createPluginLayout } from './cache/layout.js';
import { createPluginGitSource } from './marketplace/git-source.js';
import { createMarketplaceManager } from './marketplace/manager.js';
import { SharedPluginManager } from './PluginManager.js';
import { PluginRegistryStore } from './PluginRegistryStore.js';
import { createPluginConfig } from './config.js';
import { readPluginManifest, listCapabilityKinds } from './manifest.js';
import type { PluginCatalogEnvironment, PluginConfigPort, PluginLogger, BuiltinSeedOutcome, PluginManagerEnvironment } from './ports.js';

export interface PluginServiceOptions {
  configRoot?: string;
  packageRoot?: string;
  config?: PluginConfigPort;
  logger: PluginLogger;
  setupApi(): HostLocalPluginSetupApiV1;
  notifyAppsChanged?(pluginId: string): void;
  notifyMcpConfigChanged?(): unknown;
  bundledSkillsRoot?(): string;
  legacyRoots?: readonly string[];
  builtinRoot?(): string;
  builtinSources?(): string[];
  seedBuiltins?(): BuiltinSeedOutcome;
}

/** Select existing package storage consistently, retaining the Electron layout. */
export function resolvePluginPackageRoot(configRoot: string, legacyRoot?: string): string {
  const roots = [configRoot, ...(legacyRoot ? [legacyRoot] : collectPluginInstallRoots().filter(root => root !== configRoot))];
  return roots.find(root => fs.existsSync(path.join(root, 'plugins'))) ?? configRoot;
}

/** One business implementation, composed with process-specific IO and UI notifications. */
export function createPluginServices(options: PluginServiceOptions) {
  const configRoot = options.configRoot ?? resolveConfigRoot();
  const packageRoot = options.packageRoot ?? (options.configRoot !== undefined && configRoot !== resolveConfigRoot() ? configRoot : resolvePluginPackageRoot(configRoot));
  const config = options.config ?? createPluginConfig(configRoot);
  const readRoots = options.configRoot !== undefined && configRoot !== resolveConfigRoot()
    ? [packageRoot, ...(options.legacyRoots ?? [])] : [...new Set([packageRoot, ...(options.legacyRoots ?? []), ...collectPluginInstallRoots()])];
  const files = { packageRoot, readRoots, logger: options.logger };
  const layout = createPluginLayout(files);
  const git = createPluginGitSource(files);
  const catalog = createPluginCatalog({
    ...files, config, git,
    bundledSkillsRoot: options.bundledSkillsRoot ?? (() => path.join(configRoot, 'bundled-skills')),
    builtinRoot: options.builtinRoot ?? (() => path.join(configRoot, 'plugins', 'cache', 'builtin')),
    seedBuiltins: options.seedBuiltins ?? (() => ({ seeded: [], unchanged: [], skipped: [], failed: [] })),
  });
  let dependencies: PluginManagerEnvironment | undefined;
  const getDependencies = (): PluginManagerEnvironment => dependencies ??= {
    ...layout, ...catalog, logger: options.logger, store: new PluginRegistryStore(packageRoot, config), readPluginManifest, listCapabilityKinds,
    clonePluginFromGit: git.clonePluginFromGit,
    getBuiltinPluginsSourceDirs: options.builtinSources ?? (() => []),
    setupApi: options.setupApi,
    notifyAppsChanged: options.notifyAppsChanged ?? (() => { }),
    notifyMcpConfigChanged: options.notifyMcpConfigChanged ?? (() => { }),
  };
  let manager: SharedPluginManager | undefined;
  return {
    get managerDependencies() { return getDependencies(); }, get manager() { return manager ??= new SharedPluginManager(getDependencies()); }, layout, git, catalog,
    marketplaces: createMarketplaceManager({ ...files, config, git, catalog })
  };
}

export type PluginServices = ReturnType<typeof createPluginServices>;
