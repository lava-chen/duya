import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import { createHostPluginAppGrantAuthority } from '@duya/host/local-plugin-app-grant-authority';
import type { HostPluginAppInvocationAuthority } from '@duya/host/local-plugin-app-invocation-api';
import type { PluginAppGrantStore } from '@duya/data/plugin-app-grant-store';

/**
 * Resolve one installed App declaration.
 *
 * Only an installed and enabled plugin's manifest is trusted, and only the
 * App declaration that plugin published for that App ID. A disabled plugin
 * has no live App to grant anything to.
 */
async function resolveInstalledApp(
  pluginId: string,
  appId: string,
): Promise<PluginAppDefinition | null> {
  // `PluginManager` imports the Host client from this package, so it is
  // loaded lazily to keep the two modules free of an import cycle.
  const { getPluginManager } = await import('./PluginManager');
  for (const entry of getPluginManager().listInstalled()) {
    if (entry.id !== pluginId || !entry.enabled) continue;
    const app = entry.apps?.find((candidate) => candidate.appId === appId);
    if (app) return app;
  }
  return null;
}

/**
 * The Desktop-owned Plugin App authority.
 *
 * It answers two questions for the Host: which App the installed plugin
 * declares, and which capabilities the user granted. The grant ledger is the
 * only source of the second answer; the manifest is the only thing a grant
 * is compared against.
 */
export function createDesktopPluginAppAuthority(
  store: PluginAppGrantStore,
): HostPluginAppInvocationAuthority {
  return createHostPluginAppGrantAuthority({ store, resolveApp: resolveInstalledApp });
}
