import { getPluginLogger } from './plugin-logger';
import path from 'node:path';
import { app } from 'electron';
import { createPluginServices, resolvePluginPackageRoot } from '@duya/host/plugins/service';
import { getConfigStore } from '../config/store-instance';
import { getLogger } from '../logging/logger';
import { getBuiltinSeedRoot, getBuiltinPluginsSourceDirs } from './builtin-manifest';
import { seedBuiltinPlugins } from './builtin-seed';

let services: ReturnType<typeof createPluginServices> | undefined;

export function getDesktopPluginServices() {
  const configRoot = getConfigStore().getConfigDir?.() ?? app.getPath('userData');
  services ??= createPluginServices({
    configRoot,
    packageRoot: resolvePluginPackageRoot(configRoot, app.getPath('userData')),
    config: getConfigStore(),
    logger: getPluginLogger(),
    legacyRoots: [app.getPath('userData')],
    bundledSkillsRoot: () => app.isPackaged ? path.join(process.resourcesPath, 'agent', 'skills') : path.join(app.getAppPath(), 'packages', 'host', 'skills'),
    builtinRoot: getBuiltinSeedRoot,
    builtinSources: getBuiltinPluginsSourceDirs,
    seedBuiltins: seedBuiltinPlugins,
    setupApi: () => ({
      async listPluginSetupValues() { return (await import('../cli/desktop-host-api')).getDesktopHostLocalPluginSetupApi().listPluginSetupValues(); },
      async mergePluginSetupValues(id: string, values: Record<string, string>) { return (await import('../cli/desktop-host-api')).getDesktopHostLocalPluginSetupApi().mergePluginSetupValues(id, values); },
      async clearPluginSetupValues(id: string) { return (await import('../cli/desktop-host-api')).getDesktopHostLocalPluginSetupApi().clearPluginSetupValues(id); },
    }),
    notifyMcpConfigChanged: () => import('../services/mcp-write-reload').then(module => module.notifyMcpConfigChanged()),
    notifyAppsChanged(pluginId) {
      void import('./plugin-app-host').then(({ invalidatePluginAppSessions }) => invalidatePluginAppSessions(pluginId)).catch(error => getLogger().warn('Failed to invalidate plugin app sessions', { pluginId, error: String(error) }));
    },
  });
  return services;
}
