import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../logging/logger';
import { getPluginCatalog, getPluginCatalogEntry, getLocalPluginPaths } from './catalog';
import { listCapabilityKinds, readPluginManifest } from './manifest';
import { PluginRegistryStore } from './PluginRegistryStore';
import { getInstalledPluginsManager } from './installed/installed-plugins-manager';
import {
  ensurePluginCacheDir,
  createInstalledSymlink,
  removeInstalledSymlink,
  getPluginVersionCacheDir,
  getPluginInstalledRoot,
  cleanupOldVersions,
  resolveInstalledSymlink,
} from './cache/layout';
import { resolvePluginVersion } from './cache/version-resolver';
import { getPluginAutoUpdater } from './updater/auto-updater';
import {
  PathSafetyValidator,
  TrustEngine,
  PermissionService,
  PolicyEngine,
  PluginSecretStore,
  withPluginError,
  type PluginResult,
} from '../../packages/plugin-core/src';
import {
  getPluginErrorMessage,
  getPluginErrorSeverity,
  isRetryable,
  getSuggestedAction,
} from '../../src/lib/plugin-error-messages';
import type {
  PluginCatalogEntry,
  PluginRegistryEntry,
  PluginViewItem,
  PluginScope,
  InstalledPluginInfoV2,
} from './types';
import type { PluginError } from '../../packages/plugin-core/src/types';

function removeDirSafe(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyDirectoryRecursive(src: string, dest: string): void {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export class PluginManager {
  private readonly logger = getLogger();
  private readonly store = new PluginRegistryStore();
  private readonly installedMgr = getInstalledPluginsManager();
  private readonly pathValidator = new PathSafetyValidator();
  private readonly trustEngine = new TrustEngine();
  private readonly permissionService = new PermissionService();
  private readonly policyEngine = new PolicyEngine();
  private readonly secretStore = new PluginSecretStore();

  listCatalog(): PluginCatalogEntry[] {
    return getPluginCatalog();
  }

  listInstalled(): PluginViewItem[] {
    const registry = this.store.listPlugins();
    return registry.map((entry) => {
      const catalogEntry = getPluginCatalogEntry(entry.id);
      return {
        ...entry,
        capabilityKinds: catalogEntry ? listCapabilityKinds(catalogEntry.manifest) : [],
      };
    });
  }

  getDetail(pluginId: string): { entry: PluginRegistryEntry | null; catalog: PluginCatalogEntry | null } {
    const entry = this.store.listPlugins().find((p) => p.id === pluginId) ?? null;
    const catalog = getPluginCatalogEntry(pluginId) ?? null;
    return { entry, catalog };
  }

  async installFromCatalog(
    pluginId: string,
    scope: PluginScope = 'user',
    autoUpdate: boolean = false,
  ): Promise<PluginResult<PluginRegistryEntry>> {
    return withPluginError(pluginId, 'install', async () => {
      const catalogEntry = getPluginCatalogEntry(pluginId);
      if (!catalogEntry) {
        const err: PluginError = {
          type: 'plugin-not-found',
          plugin: pluginId,
          marketplace: 'bundled',
        };
        throw err;
      }

      const policyCheck = this.policyEngine.isPluginBlocked(pluginId);
      if (!policyCheck.allowed) {
        const err: PluginError = {
          type: 'marketplace-blocked-by-policy',
          marketplace: 'bundled',
          policy: policyCheck.reason!,
        };
        throw err;
      }

      const trustInfo = this.trustEngine.determineTrustLevel(
        catalogEntry.source,
        undefined,
      );

      const version = resolvePluginVersion('', catalogEntry.manifest);
      const marketplace = catalogEntry.source === 'bundled' ? 'builtin' : catalogEntry.source;
      const cacheDir = ensurePluginCacheDir(marketplace, pluginId, version);

      const { installedDir, dataDir, stagingDir } = this.store.getPaths();
      const pluginDataPath = path.join(dataDir, pluginId);
      const operationId = randomUUID();
      const stagingPath = path.join(stagingDir, operationId);

      ensureDir(stagingPath);

      if (catalogEntry.source === 'local') {
        const localPaths = getLocalPluginPaths();
        const sourceDir = localPaths.get(catalogEntry.name) || localPaths.get(pluginId);
        if (sourceDir && fs.existsSync(sourceDir)) {
          copyDirectoryRecursive(sourceDir, stagingPath);
        } else {
          const manifestPath = path.join(stagingPath, 'plugin.json');
          fs.writeFileSync(manifestPath, JSON.stringify(catalogEntry.manifest, null, 2), 'utf8');
        }
      } else {
        const manifestPath = path.join(stagingPath, 'plugin.json');
        fs.writeFileSync(manifestPath, JSON.stringify(catalogEntry.manifest, null, 2), 'utf8');
      }

      removeDirSafe(cacheDir);
      copyDirectoryRecursive(stagingPath, cacheDir);
      removeDirSafe(stagingPath);

      createInstalledSymlink(pluginId, cacheDir);
      ensureDir(pluginDataPath);

      if (catalogEntry.manifest.permissions?.length) {
        const perms = catalogEntry.manifest.permissions.map((p) => ({
          name: p.name,
          scope: p.scope as 'plugin' | 'project' | 'system' | undefined,
          domains: p.domains,
        }));
        await this.permissionService.confirmPluginPermissions(pluginId, perms);
      }

      const now = new Date().toISOString();
      const entry: PluginRegistryEntry = {
        id: catalogEntry.id,
        name: catalogEntry.name,
        version,
        enabled: true,
        installPath: cacheDir,
        dataPath: pluginDataPath,
        source: catalogEntry.source,
        trustLevel: trustInfo.level,
        scope,
        marketplace,
        autoUpdate,
        installedAt: now,
        updatedAt: now,
        grantedPermissions: catalogEntry.manifest.permissions,
        setupState: catalogEntry.manifest.setup?.some((f) => f.required) ? 'needs_setup' : 'complete',
        health: {
          status: catalogEntry.manifest.setup?.some((f) => f.required) ? 'needs_setup' : 'ready',
          reasons: [],
          checkedAt: now,
        },
      };

      this.store.upsertPlugin(entry);
      this.installedMgr.addPlugin({
        id: pluginId,
        version,
        scope,
        marketplace,
        installPath: cacheDir,
        autoUpdate,
        source: catalogEntry.source,
        installedAt: Date.now(),
      });

      this.logger.info('Plugin installed from catalog', { pluginId, version, scope }, LogComponent.Main);
      return entry;
    });
  }

  async installFromPath(
    pluginPath: string,
    scope: PluginScope = 'user',
    autoUpdate: boolean = false,
  ): Promise<PluginResult<PluginRegistryEntry>> {
    const resolvedPath = path.resolve(pluginPath);
    return withPluginError(resolvedPath, 'install', async () => {
      if (!fs.existsSync(resolvedPath)) {
        const err: PluginError = {
          type: 'path-not-found',
          plugin: resolvedPath,
          path: resolvedPath,
        };
        throw err;
      }

      const manifest = readPluginManifest(resolvedPath);
      const pluginId = manifest.id;
      const version = resolvePluginVersion('', manifest);
      const pluginName = manifest.name;

      const trustInfo = this.trustEngine.determineTrustLevel('local', undefined);
      const marketplace = 'local';
      const cacheDir = ensurePluginCacheDir(marketplace, pluginId, version);

      const { dataDir, stagingDir } = this.store.getPaths();
      const pluginDataPath = path.join(dataDir, pluginId);
      const operationId = randomUUID();
      const stagingPath = path.join(stagingDir, operationId);

      ensureDir(stagingPath);
      copyDirectoryRecursive(resolvedPath, stagingPath);

      removeDirSafe(cacheDir);
      copyDirectoryRecursive(stagingPath, cacheDir);
      removeDirSafe(stagingPath);

      createInstalledSymlink(pluginId, cacheDir);
      ensureDir(pluginDataPath);

      if (manifest.permissions?.length) {
        const perms = manifest.permissions.map((p) => ({
          name: p.name,
          scope: p.scope as 'plugin' | 'project' | 'system' | undefined,
          domains: p.domains,
        }));
        await this.permissionService.confirmPluginPermissions(pluginId, perms);
      }

      const now = new Date().toISOString();
      const entry: PluginRegistryEntry = {
        id: pluginId,
        name: pluginName,
        version,
        enabled: true,
        installPath: cacheDir,
        dataPath: pluginDataPath,
        source: 'local',
        trustLevel: trustInfo.level,
        scope,
        marketplace,
        autoUpdate,
        installedAt: now,
        updatedAt: now,
        grantedPermissions: manifest.permissions,
        setupState: manifest.setup?.some((f) => f.required) ? 'needs_setup' : 'complete',
        health: {
          status: manifest.setup?.some((f) => f.required) ? 'needs_setup' : 'ready',
          reasons: [],
          checkedAt: now,
        },
      };

      this.store.upsertPlugin(entry);
      this.installedMgr.addPlugin({
        id: pluginId,
        version,
        scope,
        marketplace,
        installPath: cacheDir,
        autoUpdate,
        source: 'local',
        installedAt: Date.now(),
      });

      this.logger.info('Plugin installed from path', { pluginId, version, path: resolvedPath }, LogComponent.Main);
      return entry;
    });
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginResult<PluginRegistryEntry>> {
    return withPluginError(pluginId, 'setEnabled', () => {
      const entry = this.store.listPlugins().find((p) => p.id === pluginId);
      if (!entry) {
        const err: PluginError = {
          type: 'plugin-not-found',
          plugin: pluginId,
          marketplace: 'local',
        };
        throw err;
      }

      if (this.policyEngine.isManagedPluginLocked(pluginId)) {
        const err: PluginError = {
          type: 'generic-error',
          plugin: pluginId,
          message: `Plugin "${pluginId}" is managed by enterprise policy and cannot be modified`,
        };
        throw err;
      }

      const now = new Date().toISOString();
      const updated: PluginRegistryEntry = {
        ...entry,
        enabled,
        updatedAt: now,
        health: {
          ...entry.health,
          status: enabled ? (entry.setupState === 'complete' ? 'ready' : 'needs_setup') : 'disabled',
          checkedAt: now,
        },
      };
      this.store.upsertPlugin(updated);
      return updated;
    });
  }

  async remove(pluginId: string, deleteData: boolean): Promise<PluginResult<{ removed: boolean }>> {
    return withPluginError(pluginId, 'remove', () => {
      if (this.policyEngine.isManagedPluginLocked(pluginId)) {
        const err: PluginError = {
          type: 'generic-error',
          plugin: pluginId,
          message: `Plugin "${pluginId}" is managed by enterprise policy and cannot be removed`,
        };
        throw err;
      }

      const removed = this.store.removePlugin(pluginId);
      if (!removed) {
        return { removed: false };
      }

      removeDirSafe(removed.installPath);
      removeInstalledSymlink(pluginId);
      if (deleteData) {
        removeDirSafe(removed.dataPath);
      }

      this.permissionService.revokeAllPermissions(pluginId);
      this.secretStore.removeAllSecrets(pluginId);
      this.installedMgr.removePlugin(pluginId);

      this.logger.info('Plugin removed', { pluginId, deleteData }, LogComponent.Main);
      return { removed: true };
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

  getPathValidator(): PathSafetyValidator {
    return this.pathValidator;
  }

  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  getTrustEngine(): TrustEngine {
    return this.trustEngine;
  }

  getPermissionService(): PermissionService {
    return this.permissionService;
  }

  getSecretStore(): PluginSecretStore {
    return this.secretStore;
  }

  getInstalledV2(): Record<string, InstalledPluginInfoV2> {
    return this.installedMgr.getAllPlugins();
  }
}

let pluginManagerSingleton: PluginManager | null = null;

export function getPluginManager(): PluginManager {
  if (!pluginManagerSingleton) {
    pluginManagerSingleton = new PluginManager();
  }
  return pluginManagerSingleton;
}