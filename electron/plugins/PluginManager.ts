import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../logging/logger';
import { getPluginCatalog, getPluginCatalogEntry, getLocalPluginPaths } from './catalog';
import { listCapabilityKinds, readPluginManifest } from './manifest';
import { getBuiltinPluginDir } from '../../packages/agent/src/plugins/builtin/_registry.js';
import { PluginRegistryStore } from './PluginRegistryStore';
import { PluginSetupStore } from './PluginSetupStore';
import { notifyMcpConfigChanged } from '../services/mcp-write-reload';
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
import {
  TrustEngine,
  PermissionService,
  PolicyEngine,
  withPluginError,
  type PluginResult,
} from '../../packages/plugin-core/src';
import { PathSafetyValidator } from '../../packages/plugin-core/src/security/path-validator';
import {
  getPluginErrorMessage,
  getPluginErrorSeverity,
  isRetryable,
  getSuggestedAction,
} from '../../src/lib/plugin-error-messages';
import type {
  PluginCatalogEntry,
  PluginManifest,
  PluginRegistryEntry,
  PluginViewItem,
  PluginScope,
  PluginSetupState,
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
  private readonly setupStore = new PluginSetupStore();
  private readonly pathValidator = new PathSafetyValidator();
  private readonly trustEngine = new TrustEngine();
  private readonly permissionService = new PermissionService();
  private readonly policyEngine = new PolicyEngine();

  constructor() {
    this.migrateLegacyInstalledFile();
  }

  /**
   * P2 migration: the legacy `installed_plugins.json` has been merged
   * into `registry.json` (single source of truth). If the legacy file
   * still exists, rename it to `.bak` so it is preserved for debugging
   * but never read again. registry.json is authoritative.
   */
  private migrateLegacyInstalledFile(): void {
    try {
      const { registryPath } = this.store.getPaths();
      const pluginsDir = path.dirname(registryPath);
      const legacyPath = path.join(pluginsDir, 'installed_plugins.json');
      if (fs.existsSync(legacyPath)) {
        const backupPath = path.join(pluginsDir, 'installed_plugins.json.bak');
        fs.renameSync(legacyPath, backupPath);
        this.logger.info(
          'Migrated legacy installed_plugins.json to .bak (registry.json is source of truth)',
          { legacyPath, backupPath },
          LogComponent.Main,
        );
      }
    } catch (err) {
      this.logger.warn(
        'Failed to migrate legacy installed_plugins.json (non-fatal)',
        { error: String(err) },
        LogComponent.Main,
      );
    }
  }

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

  /**
   * Compute the dynamic setup state for a plugin by checking the manifest's
   * required setup fields against the values actually stored in
   * `PluginSetupStore`. `app-connection` fields are skipped — their
   * satisfaction comes from the OAuth connection status, not this store.
   *
   * Returns `'complete'` when the plugin has no required setup fields, or
   * when every required text/secret/path/url field has a non-empty stored
   * value. Otherwise returns `'needs_setup'`.
   */
  private computeSetupState(pluginId: string, manifest: PluginManifest): PluginSetupState {
    const setupFields = manifest.setup ?? [];
    if (setupFields.length === 0) return 'complete';
    const requiredFields = setupFields.filter(
      (f) => f.required && f.type !== 'app-connection',
    );
    if (requiredFields.length === 0) return 'complete';

    let stored: Record<string, string>;
    try {
      stored = this.setupStore.getAll(pluginId);
    } catch {
      // DB unavailable (safe mode) — fall back to needs_setup so the user
      // is prompted to fill values once the DB comes back online.
      return 'needs_setup';
    }
    const allSatisfied = requiredFields.every((f) => {
      const v = stored[f.id];
      return v !== undefined && v !== '';
    });
    return allSatisfied ? 'complete' : 'needs_setup';
  }

  /**
   * Read all stored setup values for a plugin. Returns a shallow copy so
   * callers can mutate freely. Secrets are returned as-is here; masking
   * for IPC transport is the responsibility of the handler layer.
   */
  getSetupValues(pluginId: string): Record<string, string> {
    try {
      return this.setupStore.getAll(pluginId);
    } catch {
      return {};
    }
  }

  /**
   * Persist user-supplied setup values and refresh the plugin's setupState.
   *
   * Merge semantics: the incoming `values` are merged on top of the
   * existing stored values. This lets the UI omit unchanged secret fields
   * (which it cannot know) without wiping them — only keys present in
   * `values` are overwritten. After persisting, the setupState is
   * recomputed against the manifest's required fields, the registry entry
   * is updated, and the agent server is notified so workers reload MCP
   * with the new `${setup.X}` substitutions.
   */
  saveSetupValues(pluginId: string, values: Record<string, string>): void {
    const existing = this.getSetupValues(pluginId);
    const merged: Record<string, string> = { ...existing, ...values };
    this.setupStore.setAll(pluginId, merged);

    const catalog = getPluginCatalogEntry(pluginId);
    const manifest = catalog?.manifest;
    const setupState = manifest ? this.computeSetupState(pluginId, manifest) : 'complete';

    const entry = this.store.listPlugins().find((p) => p.id === pluginId);
    if (entry) {
      const now = new Date().toISOString();
      const healthStatus = entry.enabled
        ? (setupState === 'complete' ? 'ready' : 'needs_setup')
        : 'disabled';
      const updated: PluginRegistryEntry = {
        ...entry,
        setupState,
        updatedAt: now,
        health: {
          ...entry.health,
          status: healthStatus,
          checkedAt: now,
        },
      };
      this.store.upsertPlugin(updated);
    }

    this.logger.info(
      'Plugin setup values saved',
      { pluginId, fieldCount: Object.keys(values).length, setupState },
      LogComponent.Main,
    );

    // Best-effort: ask the agent server to broadcast reload:mcp so workers
    // pick up the new `${setup.X}` substitutions. Swallowed if the server
    // is not running.
    void notifyMcpConfigChanged();
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
        // Bundled catalog rows are backed by real package directories. Without
        // these assets an install only contains plugin.json, which leaves the
        // marketplace advertising skills and MCP declarations that the runtime
        // can never discover.
        const builtinDirName = catalogEntry.id.replace(/^com\.duya\./, '');
        const bundledSourceDir =
          catalogEntry.source === 'bundled'
            ? getBuiltinPluginDir(builtinDirName)
            : undefined;
        if (bundledSourceDir && fs.existsSync(bundledSourceDir)) {
          copyBundledPluginAssets(bundledSourceDir, stagingPath);
        }

        const manifestPath = path.join(stagingPath, 'plugin.json');
        fs.writeFileSync(manifestPath, JSON.stringify(catalogEntry.manifest, null, 2), 'utf8');

        // Skill marketplace entries ship a single skill directory alongside
        // the synthetic plugin.json. Copy the bundled skill source into
        // `skills/<name>/` so the existing skill loader can discover it via
        // the plugin install path.
        if (catalogEntry.kind === 'skill' && catalogEntry.skillSourceDir) {
          const skillName = catalogEntry.manifest.components?.skills?.[0] || catalogEntry.name;
          if (fs.existsSync(catalogEntry.skillSourceDir)) {
            const skillDestDir = path.join(stagingPath, 'skills', skillName);
            copyDirectoryRecursive(catalogEntry.skillSourceDir, skillDestDir);
          } else {
            this.logger.warn('Skill source directory not found, installing manifest only', {
              pluginId: catalogEntry.id,
              skillSourceDir: catalogEntry.skillSourceDir,
            }, LogComponent.Main);
          }
        }
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
        await this.permissionService.recordGrantedPermissions(pluginId, perms);
      }

      const now = new Date().toISOString();
      const setupState = this.computeSetupState(catalogEntry.id, catalogEntry.manifest);
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
        setupState,
        health: {
          status: setupState === 'needs_setup' ? 'needs_setup' : 'ready',
          reasons: [],
          checkedAt: now,
        },
      };

      this.store.upsertPlugin(entry);

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
        await this.permissionService.recordGrantedPermissions(pluginId, perms);
      }

      const now = new Date().toISOString();
      const setupState = this.computeSetupState(pluginId, manifest);
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
        setupState,
        health: {
          status: setupState === 'needs_setup' ? 'needs_setup' : 'ready',
          reasons: [],
          checkedAt: now,
        },
      };

      this.store.upsertPlugin(entry);

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
        // Also purge stored setup values so a reinstall does not resurrect
        // stale secrets from a previous install of the same plugin id.
        try {
          this.setupStore.clear(pluginId);
        } catch (err) {
          this.logger.warn(
            'Failed to clear plugin setup values on remove (non-fatal)',
            { pluginId, error: String(err) },
            LogComponent.Main,
          );
        }
      }

      this.permissionService.revokeAllPermissions(pluginId);

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
}

let pluginManagerSingleton: PluginManager | null = null;

export function getPluginManager(): PluginManager {
  if (!pluginManagerSingleton) {
    pluginManagerSingleton = new PluginManager();
  }
  return pluginManagerSingleton;
}

/**
 * Copy a bundled package's capability assets while retaining the catalog
 * manifest as the installation manifest. The package's authoring manifest is
 * v2 and is not yet the main-process runtime contract.
 */
function copyBundledPluginAssets(sourceDir: string, destDir: string): void {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === 'plugin.json') continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}
