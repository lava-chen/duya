import { getPluginLogger } from './plugin-logger';
import { getLogger, LogComponent } from '../logging/logger';
import { getPluginCatalog, getPluginCatalogEntry, getLocalPluginPaths, resolveIconUrl } from './catalog';
import { getBuiltinPluginsSourceDirs } from './builtin-manifest';
import { listCapabilityKinds, readPluginManifest } from './manifest';
import { clonePluginFromGit } from './marketplace/git-source';
import { PluginRegistryStore } from './PluginRegistryStore';
import { getDesktopHostLocalPluginSetupApi } from '../cli/desktop-host-api';
import { notifyMcpConfigChanged } from '../services/mcp-write-reload';
import {
  assertManagedPath,
  resolvePluginDataPath,
  ensurePluginCacheDir,
  createInstalledSymlink,
  removeInstalledSymlink,
  getPluginVersionCacheDir,
  getPluginInstalledRoot,
  cleanupOldVersions,
  resolveInstalledSymlink,
} from './cache/layout';
import {
  getPluginErrorMessage,
  getPluginErrorSeverity,
  isRetryable,
  getSuggestedAction,
} from '../../renderer/lib/plugin-error-messages';
import type { PluginError } from '@duya/plugin-core/types';


import { SharedPluginManager } from '@duya/host/plugins/PluginManager';

export class PluginManager extends SharedPluginManager {
  constructor() {
    super({
      resolvePluginDataPath: (...args) => resolvePluginDataPath(...args),
      assertManagedPath: (...args) => assertManagedPath(...args),
      getPluginCatalog: (...args) => getPluginCatalog(...args),
      getPluginCatalogEntry: (...args) => getPluginCatalogEntry(...args),
      getLocalPluginPaths: (...args) => getLocalPluginPaths(...args),
      resolveIconUrl: (...args) => resolveIconUrl(...args),
      getBuiltinPluginsSourceDirs: (...args) => getBuiltinPluginsSourceDirs(...args),
      readPluginManifest: (...args) => readPluginManifest(...args),
      listCapabilityKinds: (...args) => listCapabilityKinds(...args),
      clonePluginFromGit: (...args) => clonePluginFromGit(...args),
      ensurePluginCacheDir: (...args) => ensurePluginCacheDir(...args),
      createInstalledSymlink: (...args) => createInstalledSymlink(...args),
      removeInstalledSymlink: (...args) => removeInstalledSymlink(...args),
      getPluginVersionCacheDir: (...args) => getPluginVersionCacheDir(...args),
      getPluginInstalledRoot: (...args) => getPluginInstalledRoot(...args),
      cleanupOldVersions: (...args) => cleanupOldVersions(...args),
      resolveInstalledSymlink: (...args) => resolveInstalledSymlink(...args),
      store: new PluginRegistryStore(), logger: getPluginLogger(), setupApi: getDesktopHostLocalPluginSetupApi, notifyMcpConfigChanged,
      notifyAppsChanged(pluginId) { void import('./plugin-app-host').then(({ invalidatePluginAppSessions }) => invalidatePluginAppSessions(pluginId)).catch(error => getLogger().warn('Failed to invalidate plugin app sessions', { pluginId, error: String(error) })); },
    });
  }
  buildHealthIssue(err: PluginError) {
    return {
      error: err,
      severity: getPluginErrorSeverity(err),
      humanMessage: getPluginErrorMessage(err),
      technicalDetails: err.type === 'generic-error' ? err.stack : undefined,
      actionable: isRetryable(err) || !!getSuggestedAction(err),
      suggestedAction: getSuggestedAction(err),
      timestamp: Date.now(),
    };
  }


}
let pluginManagerSingleton: PluginManager | null = null;
export function getPluginManager(): PluginManager { return pluginManagerSingleton ??= new PluginManager(); }
