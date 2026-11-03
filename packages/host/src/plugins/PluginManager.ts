import { assertPluginStorageSegment } from './identity.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { listCapabilityKinds, readPluginManifest } from './manifest.js';
import { resolvePluginVersion } from './cache/version-resolver.js';
import {
  TrustEngine,
  PermissionService,
  PolicyEngine,
  withPluginError,
  withPluginErrorSync,
  type PluginResult,
} from '@duya/plugin-core';
import { PathSafetyValidator } from '@duya/plugin-core/security/path-validator';
import type {
  PluginCatalogEntry,
  PluginManifest,
  PluginRegistryEntry,
  PluginViewItem,
  PluginSetupState,
  PluginRuntimeHealth,
} from './types.js';
import { PluginScope } from './types.js';
import type { PluginError } from '@duya/plugin-core/types';
import type { PluginManagerEnvironment, PluginLogger } from './ports.js';
import type { PluginRegistryStore } from './PluginRegistryStore.js';
const LogComponent = { Main: 'Main' };
function removeDirSafe(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function publishPackage(stagingPath: string, cacheDir: string): void {
  const backup = cacheDir + '.previous-' + randomUUID();
  if (fs.existsSync(cacheDir)) fs.renameSync(cacheDir, backup);
  try { fs.renameSync(stagingPath, cacheDir); }
  catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, cacheDir); throw error; }
  removeDirSafe(backup);
}
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyDirectoryRecursive(src: string, dest: string, sourceRoot = fs.realpathSync(src)): void {
  if (path.resolve(dest) === path.resolve(src) || path.resolve(dest).startsWith(path.resolve(src) + path.sep)) throw new Error('Plugin destination is inside its source');
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, sourceRoot);
    } else if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(srcPath);
      if (resolved !== sourceRoot && !resolved.startsWith(sourceRoot + path.sep)) throw new Error('Plugin symlink escapes its package');
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Check if a plugin directory contains a valid plugin manifest.
 * Returns true if the directory has at least one valid plugin.json file.
 */
function hasPluginManifest(pluginDir: string): boolean {
  try {
    readPluginManifest(pluginDir);
    return true;
  } catch {
    return false;
  }
}

export class SharedPluginManager {
  private readonly logger: PluginLogger;
  private readonly store: PluginManagerEnvironment['store'];
  private operationQueue: Promise<unknown> = Promise.resolve();
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  private readonly setupValuesCache = new Map<string, Record<string, string>>();
  private setupValuesCacheReady = false;
  private readonly pathValidator = new PathSafetyValidator();
  private readonly trustEngine = new TrustEngine();
  private readonly permissionService = new PermissionService();
  private readonly policyEngine = new PolicyEngine();

  constructor(private readonly dependencies: PluginManagerEnvironment) {
    this.logger = dependencies.logger;
    this.store = dependencies.store;
    this.migrateLegacyInstalledFile();
  }

  private notifyAppsChanged(pluginId: string): void { this.dependencies.notifyAppsChanged(pluginId); }

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
    return this.dependencies.getPluginCatalog();
  }

  listInstalled(): PluginViewItem[] {
    const registry = this.store.listPlugins();
    return registry.map((entry) => this.hydrateViewItem(entry));
  }

  /** Prime the synchronous plugin view from the Host-owned setup-value API. */
  async refreshSetupValuesCache(): Promise<boolean> {
    try {
      const values = await this.dependencies.setupApi().listPluginSetupValues();
      this.setupValuesCache.clear();
      for (const [pluginId, pluginValues] of Object.entries(values)) {
        this.setupValuesCache.set(pluginId, pluginValues);
      }
      this.setupValuesCacheReady = true;
      return true;
    } catch (error) {
      this.setupValuesCache.clear();
      this.setupValuesCacheReady = false;
      this.logger.warn(
        'Failed to refresh plugin setup state from Host (non-fatal)',
        { error: String(error) },
        LogComponent.Main,
      );
      return false;
    }
  }

  /**
   * Merge a minimal registry entry into a full `PluginViewItem`.
   *
   * Plan 334 decision 11: config persists only the user intent field
   * (`enabled`); everything else is derived. This single merge entry point
   * fills every field from the best available source, in priority order:
   *
   *  - `name`/`version`/`source`/`trustLevel`  -> marketplace catalog entry
   *  - `marketplace`/`autoUpdate`              -> derived from entry key / default
   *  - `installPath`                           -> entry, else resolved installed symlink
   *  - `dataPath`                              -> `plugins-data/<id>` (derived from store layout)
   *  - `grantedPermissions`                    -> catalog manifest permissions
   *  - `setupState`                            -> recomputed from manifest + Host-owned setup values
   *  - `health`                                -> derived from `enabled`/`setupState`
   *  - `capabilityKinds`                       -> catalog manifest
   *
   * Because the persisted entry now carries only `enabled` (plus `id` and
   * `marketplace` parsed from the composite key), the derived sources win
   * over the entry for every field that config no longer stores.
   */
  private hydrateViewItem(entry: PluginRegistryEntry): PluginViewItem {
    const catalogEntry = this.dependencies.getPluginCatalogEntry(entry.id);
    const installPath = entry.installPath || this.dependencies.resolveInstalledSymlink(entry.id) || '';
    let manifest: PluginManifest | undefined;
    if (installPath) {
      try {
        manifest = this.dependencies.readPluginManifest(installPath);
      } catch {
        manifest = undefined;
      }
    }
    manifest ??= catalogEntry?.manifest;

    const name = manifest?.name ?? catalogEntry?.name ?? entry.name ?? entry.id;
    const version = manifest?.version ?? catalogEntry?.version ?? entry.version ?? '0.1.0';
    const source = catalogEntry?.source ?? entry.source ?? 'local';
    const trustLevel = catalogEntry?.trustLevel ?? entry.trustLevel ?? 'local';
    const scope = entry.scope ?? 'user';
    const marketplace = entry.marketplace || catalogEntry?.source || 'official';
    const autoUpdate = entry.autoUpdate ?? false;

    const dataPath = entry.dataPath || this.dependencies.resolvePluginDataPath(entry.id) || path.join(this.store.getPaths().dataDir, entry.id);

    const grantedPermissions =
      entry.grantedPermissions && entry.grantedPermissions.length > 0
        ? entry.grantedPermissions
        : manifest?.permissions ?? [];

    const setupState = entry.setupState ?? (manifest ? this.computeSetupState(entry.id, manifest) : 'complete');

    const health: PluginRuntimeHealth = entry.health ?? {
      status: !entry.enabled ? 'disabled' : setupState === 'needs_setup' ? 'needs_setup' : 'ready',
      reasons: [],
      checkedAt: new Date().toISOString(),
    };

    return {
      ...entry,
      name,
      version,
      source,
      trustLevel,
      scope,
      marketplace,
      autoUpdate,
      // Resolved duya-file:// icon from the catalog entry (plan 455
      // follow-up) — installed lists can render the brand icon. When the
      // catalog is unavailable, fall back to reading the manifest interface.
      icon:
        catalogEntry?.icon ??
        (manifest?.interface?.icon && installPath
          ? this.dependencies.resolveIconUrl(manifest, installPath)
          : undefined),
      installPath,
      dataPath,
      grantedPermissions,
      setupState,
      health,
      capabilityKinds: manifest ? this.dependencies.listCapabilityKinds(manifest) : [],
      apps: manifest?.apps?.map((app) => ({
        ...app,
        requiredCapabilities: [...app.requiredCapabilities],
      })),
    };
  }

  getDetail(pluginId: string): { entry: PluginRegistryEntry | null; catalog: PluginCatalogEntry | null } {
    const entry = this.store.listPlugins().find((p) => p.id === pluginId) ?? null;
    const catalog = this.dependencies.getPluginCatalogEntry(pluginId) ?? null;
    return { entry, catalog };
  }

  /**
   * Compute the dynamic setup state for a plugin by checking the manifest's
   * required setup fields against the values actually stored in
   * Host's Data-backed plugin setup store. `app-connection` fields are skipped — their
   * satisfaction comes from the OAuth connection status, not this store.
   *
   * Returns `'complete'` when the plugin has no required setup fields, or
   * when every required text/secret/path/url field has a non-empty stored
   * value. Otherwise returns `'needs_setup'`.
   */
  private computeSetupState(
    pluginId: string,
    manifest: PluginManifest,
    storedValues?: Record<string, string>,
  ): PluginSetupState {
    const setupFields = manifest.setup ?? [];
    if (setupFields.length === 0) return 'complete';
    const requiredFields = setupFields.filter(
      (f) => f.required && f.type !== 'app-connection',
    );
    if (requiredFields.length === 0) return 'complete';

    if (!this.setupValuesCacheReady && storedValues === undefined) {
      // Until the Host cache has been populated, fail closed and ask the user
      // to review setup rather than implying required values are present.
      return 'needs_setup';
    }
    const stored = storedValues ?? this.setupValuesCache.get(pluginId) ?? {};
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
  async getSetupValues(pluginId: string): Promise<Record<string, string>> {
    if (!(await this.refreshSetupValuesCache())) return {};
    return { ...(this.setupValuesCache.get(pluginId) ?? {}) };
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
  async saveSetupValues(pluginId: string, values: Record<string, string>): Promise<void> {
    await this.dependencies.setupApi().mergePluginSetupValues(pluginId, values);
    await this.refreshSetupValuesCache();

    const catalog = this.dependencies.getPluginCatalogEntry(pluginId);
    const manifest = catalog?.manifest;
    const setupState = manifest ? this.computeSetupState(pluginId, manifest) : 'complete';

    assertPluginStorageSegment(pluginId);
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
    void this.dependencies.notifyMcpConfigChanged();
    this.notifyAppsChanged(pluginId);
  }

  async installFromCatalog(
    pluginId: string,
    scope: PluginScope = PluginScope.User,
    autoUpdate: boolean = false,
    /** Plan 455 — disambiguates the same plugin id across marketplaces. */
    marketplace?: string,
  ): Promise<PluginResult<PluginRegistryEntry>> {
    return this.serialize(async () => withPluginError(pluginId, 'install', async () => {
      assertPluginStorageSegment(pluginId);
      if (marketplace) assertPluginStorageSegment(marketplace);
      this.store.listPlugins();
      const catalogEntry = this.dependencies.getPluginCatalogEntry(pluginId, marketplace);
      if (!catalogEntry) {
        const err: PluginError = {
          type: 'plugin-not-found',
          plugin: pluginId,
          marketplace: marketplace ?? 'bundled',
        };
        throw err;
      }

      const policyCheck = this.policyEngine.isPluginBlocked(pluginId);
      if (!policyCheck.allowed) {
        const err: PluginError = {
          type: 'marketplace-blocked-by-policy',
          marketplace: catalogEntry.marketplace ?? 'bundled',
          policy: policyCheck.reason!,
        };
        throw err;
      }

      // Plan 455 — catalog-declared installation policy (codex 17.3.1).
      if (catalogEntry.installPolicy === 'not_available') {
        const err: PluginError = {
          type: 'marketplace-blocked-by-policy',
          marketplace: catalogEntry.marketplace ?? 'bundled',
          policy: 'plugin installation is marked not_available by its marketplace',
        };
        throw err;
      }

      const trustInfo = this.trustEngine.determineTrustLevel(
        catalogEntry.source,
        catalogEntry.marketplace,
      );

      const version = resolvePluginVersion('', catalogEntry.manifest);
      const marketplaceName = catalogEntry.marketplace ?? catalogEntry.source;
      assertPluginStorageSegment(marketplaceName);
      assertPluginStorageSegment(version);
      const cacheDir = this.dependencies.ensurePluginCacheDir(marketplaceName, pluginId, version);

      const { installedDir, dataDir, stagingDir } = this.store.getPaths();
      const pluginDataPath = path.join(dataDir, pluginId);
      const operationId = randomUUID();
      const stagingPath = path.join(stagingDir, operationId);

      try {
        ensureDir(stagingPath);

        if (catalogEntry.gitSourceUrl) {
          // Plan 531 — git-source marketplace plugin: materialize the plugin
          // by cloning its repo into the cache. The clone is cached so
          // subsequent installs of the same plugin don't re-clone.
          const cloneResult = await this.dependencies.clonePluginFromGit({
            url: catalogEntry.gitSourceUrl,
            marketplace: catalogEntry.marketplace ?? 'unknown',
            pluginName: catalogEntry.name,
            ref: catalogEntry.gitSourceRef,
          });
          if (fs.existsSync(cloneResult.dir)) {
            copyDirectoryRecursive(cloneResult.dir, stagingPath);
          } else {
            this.logger.warn('Git-source plugin clone missing, installing manifest only', {
              pluginId: catalogEntry.id,
              url: catalogEntry.gitSourceUrl,
            }, LogComponent.Main);
            const manifestPath = path.join(stagingPath, 'plugin.json');
            fs.writeFileSync(manifestPath, JSON.stringify(catalogEntry.manifest, null, 2), 'utf8');
          }
        } else if (catalogEntry.marketplacePluginDir && fs.existsSync(catalogEntry.marketplacePluginDir)) {
          // Plan 455 — marketplace install: copy the plugin directory out of
          // its (containment-fenced) marketplace clone into the versioned
          // cache. Installed plugins stay independent of later marketplace
          // refreshes; upgrades are an explicit re-install (decision D5).
          if (hasPluginManifest(catalogEntry.marketplacePluginDir)) {
            copyDirectoryRecursive(catalogEntry.marketplacePluginDir, stagingPath);
          } else {
            // Marketplace clone is empty/missing; fall back to the shipped
            // builtin sources if one of them holds this plugin.
            const builtinPluginDir = this.dependencies.getBuiltinPluginsSourceDirs()
              .map((dir) => path.join(dir, catalogEntry.name))
              .find((dir) => fs.existsSync(dir) && hasPluginManifest(dir));
            if (builtinPluginDir) {
              this.logger.info('Marketplace plugin dir empty, falling back to builtin source', {
                pluginId: catalogEntry.id,
                marketplaceDir: catalogEntry.marketplacePluginDir,
                builtinDir: builtinPluginDir,
              }, LogComponent.Main);
              copyDirectoryRecursive(builtinPluginDir, stagingPath);
            } else {
              // Neither marketplace nor builtin source available; write manifest only
              this.logger.warn('Marketplace plugin dir empty and no builtin source found', {
                pluginId: catalogEntry.id,
                marketplaceDir: catalogEntry.marketplacePluginDir,
              }, LogComponent.Main);
              const manifestPath = path.join(stagingPath, 'plugin.json');
              fs.writeFileSync(manifestPath, JSON.stringify(catalogEntry.manifest, null, 2), 'utf8');
            }
          }
        } else if (catalogEntry.source === 'local') {
          const localPaths = this.dependencies.getLocalPluginPaths();
          const sourceDir = localPaths.get(catalogEntry.name) || localPaths.get(pluginId);
          if (sourceDir && fs.existsSync(sourceDir)) {
            copyDirectoryRecursive(sourceDir, stagingPath);
          } else {
            const manifestPath = path.join(stagingPath, 'plugin.json');
            fs.writeFileSync(manifestPath, JSON.stringify(catalogEntry.manifest, null, 2), 'utf8');
          }
        } else {
          // Manifest-only fallback: no marketplace/local source directory
          // resolves for this entry (e.g. a stale catalog row). The install
          // proceeds with a synthetic plugin.json so the registry stays
          // consistent with what the user asked for.
          this.logger.warn('No plugin source directory found; installing manifest only', {
            pluginId: catalogEntry.id,
            source: catalogEntry.source,
          }, LogComponent.Main);
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

        publishPackage(stagingPath, cacheDir);

        this.dependencies.createInstalledSymlink(pluginId, cacheDir);
        ensureDir(pluginDataPath);

        if (catalogEntry.manifest.permissions?.length) {
          const perms = catalogEntry.manifest.permissions.map((p) => ({
            name: p.name,
            ...(p.scope === undefined ? {} : { scope: p.scope as 'plugin' | 'project' | 'system' }),
            ...(p.domains === undefined ? {} : { domains: p.domains }),
          }));
          await this.permissionService.recordGrantedPermissions(pluginId, perms);
        }

        const now = new Date().toISOString();
        const setupState = await this.computeSetupStateFromHost(catalogEntry.id, catalogEntry.manifest);
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
          marketplace: marketplaceName,
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
        this.notifyAppsChanged(pluginId);

        this.logger.info('Plugin installed from catalog', { pluginId, version, scope, marketplace: marketplaceName }, LogComponent.Main);
        return entry;
      } finally { removeDirSafe(stagingPath); }
    }));
  }

  async installFromPath(
    pluginPath: string,
    scope: PluginScope = PluginScope.User,
    autoUpdate: boolean = false,
  ): Promise<PluginResult<PluginRegistryEntry>> {
    const resolvedPath = path.resolve(pluginPath);
    return this.serialize(async () => withPluginError(resolvedPath, 'install', async () => {
      if (!fs.existsSync(resolvedPath)) {
        const err: PluginError = {
          type: 'path-not-found',
          plugin: resolvedPath,
          path: resolvedPath,
        };
        throw err;
      }

      const manifest = this.dependencies.readPluginManifest(resolvedPath);
      const pluginId = manifest.id;
      assertPluginStorageSegment(pluginId);
      this.store.listPlugins();
      if (this.policyEngine.isManagedPluginLocked(pluginId) || !this.policyEngine.isPluginBlocked(pluginId).allowed) throw new Error('Plugin is locked by policy');
      const version = resolvePluginVersion('', manifest);
      assertPluginStorageSegment(version);
      const pluginName = manifest.name;

      const trustInfo = this.trustEngine.determineTrustLevel('local', undefined);
      const marketplace = 'local';
      const cacheDir = this.dependencies.ensurePluginCacheDir(marketplace, pluginId, version);

      const { dataDir, stagingDir } = this.store.getPaths();
      const pluginDataPath = path.join(dataDir, pluginId);
      const operationId = randomUUID();
      const stagingPath = path.join(stagingDir, operationId);

      try {
        ensureDir(stagingPath);
        copyDirectoryRecursive(resolvedPath, stagingPath);

        publishPackage(stagingPath, cacheDir);

        this.dependencies.createInstalledSymlink(pluginId, cacheDir);
        ensureDir(pluginDataPath);

        if (manifest.permissions?.length) {
          const perms = manifest.permissions.map((p) => ({
            name: p.name,
            ...(p.scope === undefined ? {} : { scope: p.scope as 'plugin' | 'project' | 'system' }),
            ...(p.domains === undefined ? {} : { domains: p.domains }),
          }));
          await this.permissionService.recordGrantedPermissions(pluginId, perms);
        }

        const now = new Date().toISOString();
        const setupState = await this.computeSetupStateFromHost(pluginId, manifest);
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
        this.notifyAppsChanged(pluginId);

        this.logger.info('Plugin installed from path', { pluginId, version, path: resolvedPath }, LogComponent.Main);
        return entry;
      } finally { removeDirSafe(stagingPath); }
    }));
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginResult<PluginRegistryEntry>> {
    return this.serialize(async () => withPluginErrorSync(pluginId, 'setEnabled', () => {
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
      this.notifyAppsChanged(pluginId);
      return updated;
    }));
  }

  async remove(pluginId: string, deleteData: boolean): Promise<PluginResult<{ removed: boolean }>> {
    return this.serialize(async () => withPluginError(pluginId, 'remove', async () => {
      if (this.policyEngine.isManagedPluginLocked(pluginId)) {
        const err: PluginError = {
          type: 'generic-error',
          plugin: pluginId,
          message: `Plugin "${pluginId}" is managed by enterprise policy and cannot be removed`,
        };
        throw err;
      }

      assertPluginStorageSegment(pluginId);
      const existing = this.store.listPlugins().find(plugin => plugin.id === pluginId);
      const resolvedInstall = existing?.installPath || this.dependencies.resolveInstalledSymlink(pluginId) || '';
      const resolvedData = existing?.dataPath || this.dependencies.resolvePluginDataPath(pluginId) || path.join(this.store.getPaths().dataDir, pluginId);
      if (resolvedInstall) this.dependencies.assertManagedPath(resolvedInstall, 'package');
      if (deleteData) this.dependencies.assertManagedPath(resolvedData, 'data');
      const removed = this.store.removePlugin(pluginId);
      if (!removed) {
        return { removed: false };
      }
      this.notifyAppsChanged(pluginId);

      // Plan 334 decision 11 — config stores only `enabled`, so the removed
      // entry no longer carries the on-disk paths. Re-derive them from the
      // cache layout (installed symlink) and the data layout.
      const installPath = removed.installPath || this.dependencies.resolveInstalledSymlink(pluginId) || '';
      const dataPath = removed.dataPath || this.dependencies.resolvePluginDataPath(pluginId) || path.join(this.store.getPaths().dataDir, pluginId);

      // Unlink the installed link BEFORE deleting the versioned cache: deleting
      // the cache first leaves the link dangling, and a link-following existence
      // check then skips cleanup, leaving a ghost link that breaks reinstalls.
      this.dependencies.removeInstalledSymlink(pluginId);
      removeDirSafe(installPath);
      if (deleteData) {
        removeDirSafe(dataPath);
        // Also purge stored setup values so a reinstall does not resurrect
        // stale secrets from a previous install of the same plugin id.
        try {
          await this.dependencies.setupApi().clearPluginSetupValues(pluginId);
          this.setupValuesCache.delete(pluginId);
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
    }));
  }

  private async computeSetupStateFromHost(
    pluginId: string,
    manifest: PluginManifest,
  ): Promise<PluginSetupState> {
    const requiredFields = (manifest.setup ?? []).filter(
      (field) => field.required && field.type !== 'app-connection',
    );
    if (requiredFields.length === 0) return 'complete';
    const stored = await this.getSetupValues(pluginId);
    return this.computeSetupState(pluginId, manifest, stored);
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
