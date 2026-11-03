import type { PluginServices } from './service.js';
import fs from 'node:fs';
import type { HostManagedPlugin, HostPluginManagementApiV1, HostPluginManagementInstallInput } from '@duya/agent-protocol/plugin-management';
import type { PluginResult } from '@duya/plugin-core';
import type { SharedPluginManager } from './PluginManager.js';
import { PluginScope } from './types.js';
import { readPluginManifest } from './manifest.js';

export class PluginManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export function requirePluginSegment(value: string): void {
  if (!value || value.length > 200 || value === '.' || value === '..' || /[\\/\x00-\x1f:]/u.test(value)) {
    throw new PluginManagementError('invalid_plugin_id', 'Invalid plugin identifier');
  }
}

function unwrap<T>(result: PluginResult<T>): T {
  if (result.success) return result.data;
  throw new PluginManagementError(result.error.type, `Plugin operation failed: ${result.error.type}`);
}

/** Both Desktop composition and the standalone Host expose this same application service. */
export function createPluginManagementApi(manager: SharedPluginManager, services?: Pick<PluginServices, 'catalog' | 'marketplaces'>): HostPluginManagementApiV1 {
  function info(id: string): HostManagedPlugin {
    requirePluginSegment(id);
    const entry = manager.listInstalled().find(plugin => plugin.id === id);
    if (!entry) throw new PluginManagementError('plugin_not_found', 'Plugin is not registered', 404);
    let manifest;
    try { manifest = readPluginManifest(entry.installPath); } catch { manifest = undefined; }
    return {
      id: entry.id, name: entry.name, version: entry.version, enabled: entry.enabled,
      installed: Boolean(entry.installPath && fs.existsSync(entry.installPath)), marketplace: entry.marketplace,
      source: entry.source, capabilities: entry.capabilityKinds ?? [], description: manifest?.description ?? '',
      permissions: (manifest?.permissions ?? []).map(permission => permission.name)
    };
  }
  return {
    async catalog() {
      if (!services) throw new PluginManagementError('plugin_catalog_unavailable', 'This Host does not provide a plugin catalog', 404);
      const installed = new Set(manager.listInstalled().map(entry => entry.id));
      return {
        plugins: services.catalog.getPluginCatalog().map(entry => ({
          id: entry.id, name: entry.name,
          version: entry.version, description: entry.description, marketplace: entry.marketplace ?? entry.source, installed: installed.has(entry.id)
        }))
      };
    },
    async listMarketplaces() {
      if (!services) throw new PluginManagementError('plugin_marketplaces_unavailable', 'This Host does not manage plugin marketplaces', 404);
      return {
        marketplaces: services.marketplaces.listMarketplaces().map(entry => ({
          name: entry.name, kind: entry.kind, hidden: entry.hidden, pluginCount: entry.pluginCount,
          ...(entry.error === undefined ? {} : { error: 'Marketplace contents are unavailable; refresh this source' })
        }))
      };
    },
    async addMarketplace(source) {
      if (!services) throw new PluginManagementError('plugin_marketplaces_unavailable', 'This Host does not manage plugin marketplaces', 404);
      const result = await services.marketplaces.addMarketplace(source);
      services.catalog.invalidatePluginCatalogCache();
      return { name: result.name };
    },
    async removeMarketplace(name) {
      requirePluginSegment(name);
      if (!services) throw new PluginManagementError('plugin_marketplaces_unavailable', 'This Host does not manage plugin marketplaces', 404);
      await services.marketplaces.removeMarketplace(name); services.catalog.invalidatePluginCatalogCache(); return { removed: true };
    },
    async refreshMarketplace(name) {
      requirePluginSegment(name);
      if (!services) throw new PluginManagementError('plugin_marketplaces_unavailable', 'This Host does not manage plugin marketplaces', 404);
      await services.marketplaces.refreshMarketplace(name); services.catalog.invalidatePluginCatalogCache(); return { refreshed: true };
    },
    async list() { return { plugins: manager.listInstalled().map(entry => info(entry.id)) }; },
    async info(id) { return info(id); },
    async doctor() {
      return {
        checks: manager.listInstalled().map(entry => ({
          id: 'plugin_package',
          pluginId: entry.id, status: info(entry.id).installed ? 'ok' as const : 'error' as const,
          message: info(entry.id).installed ? 'Plugin package is present' : 'Registered plugin package is missing'
        }))
      };
    },
    async install(input: HostPluginManagementInstallInput) {
      if (input.scope !== undefined && input.scope !== 'user') throw new PluginManagementError('unsupported_plugin_scope', 'Only user plugin scope is supported by this Host');
      if (input.pluginId) requirePluginSegment(input.pluginId);
      if (!input.fromPath && !input.pluginId) throw new PluginManagementError('invalid_plugin_install', 'Provide a plugin id or source directory');
      if (input.marketplace) requirePluginSegment(input.marketplace);
      const entry = unwrap(input.fromPath
        ? await manager.installFromPath(input.fromPath, PluginScope.User)
        : await manager.installFromCatalog(input.pluginId!, PluginScope.User, false, input.marketplace));
      return { plugin: info(entry.id) };
    },
    async setEnabled(id, enabled) { requirePluginSegment(id); unwrap(await manager.setEnabled(id, enabled)); return { plugin: info(id) }; },
    async uninstall(id, deleteData) { requirePluginSegment(id); return { id, ...unwrap(await manager.remove(id, deleteData)) }; },
    async update(id) { requirePluginSegment(id); const current = info(id); unwrap(await manager.installFromCatalog(id, PluginScope.User, false, current.marketplace)); return { plugin: info(id) }; },
  };
}
