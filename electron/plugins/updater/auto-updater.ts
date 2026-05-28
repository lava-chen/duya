import fs from 'fs';
import path from 'path';
import { getLogger, LogComponent } from '../../logging/logger';
import { getInstalledPluginsManager } from '../installed/installed-plugins-manager';
import {
  ensurePluginCacheDir,
  createInstalledSymlink,
  removeInstalledSymlink,
  getPluginVersionCacheDir,
  cleanupOldVersions,
} from '../cache/layout';
import { isVersionNewer } from '../cache/version-resolver';
import { isAutoUpdateAllowed } from '../scope/scope-manager';
import type {
  AutoUpdatePolicy,
  PluginUpdateInfo,
  PluginScope,
  InstalledPluginInfoV2,
} from '../types';

const COMPONENT = 'PluginAutoUpdater' as LogComponent;

const DEFAULT_POLICY: AutoUpdatePolicy = {
  enabled: true,
  interval: 'daily',
  scope: ['managed', 'builtin'],
  prerelease: false,
};

export class PluginAutoUpdater {
  private readonly logger = getLogger();
  private policy: AutoUpdatePolicy;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(policy?: Partial<AutoUpdatePolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  updatePolicy(partial: Partial<AutoUpdatePolicy>): void {
    this.policy = { ...this.policy, ...partial };
  }

  getPolicy(): AutoUpdatePolicy {
    return { ...this.policy };
  }

  startPeriodicCheck(): void {
    if (this.timer) return;

    const intervals: Record<AutoUpdatePolicy['interval'], number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      manual: 0,
    };

    const ms = intervals[this.policy.interval];
    if (ms <= 0) return;

    this.timer = setInterval(() => {
      this.checkUpdates()
        .then((updates) => {
          if (updates.length > 0) {
            this.logger.info(
              'Plugin updates available',
              { count: updates.length },
              COMPONENT
            );
          }
        })
        .catch((err) => {
          this.logger.error('Plugin update check failed', err instanceof Error ? err : new Error(String(err)), COMPONENT);
        });
    }, ms);

    this.logger.info('Plugin auto-updater started', { interval: this.policy.interval }, COMPONENT);
  }

  stopPeriodicCheck(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Plugin auto-updater stopped', {}, COMPONENT);
    }
  }

  async checkUpdates(): Promise<PluginUpdateInfo[]> {
    if (!this.policy.enabled) return [];

    const manager = getInstalledPluginsManager();
    const allPlugins = manager.getAllPlugins();
    const updates: PluginUpdateInfo[] = [];

    for (const [name, info] of Object.entries(allPlugins)) {
      if (!isAutoUpdateAllowed(info.scope, this.policy.scope)) continue;
      if (!info.autoUpdate) continue;

      try {
        const latest = await this.fetchLatestVersion(name, info.marketplace, info.scope);
        if (!latest) continue;

        if (isVersionNewer(info.version, latest)) {
          updates.push({
            name,
            current: info.version,
            latest,
            marketplace: info.marketplace,
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to check update for plugin "${name}"`, { error: String(err) }, COMPONENT);
      }
    }

    return updates;
  }

  async updatePlugin(
    pluginId: string,
    targetVersion: string
  ): Promise<{ success: boolean; previousVersion: string; newVersion: string }> {
    const manager = getInstalledPluginsManager();
    const info = manager.getPlugin(pluginId);

    if (!info) {
      throw new Error(`Plugin not installed: ${pluginId}`);
    }

    const previousVersion = info.version;
    const cacheDir = ensurePluginCacheDir(info.marketplace, pluginId, targetVersion);

    try {
      await this.fetchAndExtractPlugin(pluginId, info.marketplace, targetVersion, cacheDir);

      createInstalledSymlink(pluginId, cacheDir);

      const updatedInfo: InstalledPluginInfoV2 = {
        ...info,
        version: targetVersion,
        installPath: cacheDir,
        installedAt: Math.floor(Date.now() / 1000),
      };
      manager.upsertPlugin(pluginId, updatedInfo);

      cleanupOldVersions(info.marketplace, pluginId, 3);

      this.logger.info(
        'Plugin updated',
        { pluginId, from: previousVersion, to: targetVersion },
        COMPONENT
      );

      return {
        success: true,
        previousVersion,
        newVersion: targetVersion,
      };
    } catch (err) {
      this.logger.error(
        `Plugin update failed: ${pluginId}`,
        err instanceof Error ? err : new Error(String(err)),
        COMPONENT
      );

      const prevCacheDir = getPluginVersionCacheDir(info.marketplace, pluginId, previousVersion);
      if (fs.existsSync(prevCacheDir)) {
        createInstalledSymlink(pluginId, prevCacheDir);
      } else {
        removeInstalledSymlink(pluginId);
      }

      throw err;
    }
  }

  async installPluginVersion(
    pluginId: string,
    marketplace: string,
    version: string,
    sourceDir: string
  ): Promise<string> {
    const cacheDir = ensurePluginCacheDir(marketplace, pluginId, version);
    this.copyDirectoryRecursive(sourceDir, cacheDir);
    return cacheDir;
  }

  private async fetchLatestVersion(
    _pluginId: string,
    _marketplace: string,
    _scope: PluginScope
  ): Promise<string | null> {
    return null;
  }

  private async fetchAndExtractPlugin(
    _pluginId: string,
    _marketplace: string,
    _targetVersion: string,
    _cacheDir: string
  ): Promise<void> {
    // Placeholder: to be implemented with actual marketplace/registry integration
  }

  private copyDirectoryRecursive(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectoryRecursive(srcPath, destPath);
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(srcPath);
        fs.symlinkSync(target, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

let autoUpdaterSingleton: PluginAutoUpdater | null = null;

export function getPluginAutoUpdater(): PluginAutoUpdater {
  if (!autoUpdaterSingleton) {
    autoUpdaterSingleton = new PluginAutoUpdater();
  }
  return autoUpdaterSingleton;
}