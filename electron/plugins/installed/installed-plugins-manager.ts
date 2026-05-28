import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import type {
  InstalledPluginInfoV2,
  InstalledPluginsFileV2,
  PluginScope,
} from '../types';
import type { PluginRegistryFile, PluginRegistryEntry } from '../types';

const COMPONENT = 'InstalledPlugins' as LogComponent;

function atomicWriteJson(targetPath: string, payload: unknown): void {
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, targetPath);
}

export class InstalledPluginsManager {
  private readonly filePath: string;
  private readonly logger = getLogger();

  constructor() {
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'plugins', 'installed_plugins.json');
  }

  getFilePath(): string {
    return this.filePath;
  }

  read(): InstalledPluginsFileV2 {
    if (!fs.existsSync(this.filePath)) {
      return { version: 2, plugins: {} };
    }

    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8')
      ) as unknown;

      if (
        typeof raw !== 'object' ||
        raw === null ||
        (raw as InstalledPluginsFileV2).version !== 2
      ) {
        return { version: 2, plugins: {} };
      }

      const file = raw as InstalledPluginsFileV2;
      if (typeof file.plugins !== 'object' || file.plugins === null) {
        return { version: 2, plugins: {} };
      }

      return file;
    } catch {
      return { version: 2, plugins: {} };
    }
  }

  write(file: InstalledPluginsFileV2): void {
    atomicWriteJson(this.filePath, file);
  }

  getPlugin(key: string): InstalledPluginInfoV2 | undefined {
    return this.read().plugins[key];
  }

  upsertPlugin(key: string, info: InstalledPluginInfoV2): void {
    const file = this.read();
    file.plugins[key] = info;
    this.write(file);
    this.logger.info('Plugin upserted in installed_plugins.json', { key, version: info.version }, COMPONENT);
  }

  removePlugin(key: string): boolean {
    const file = this.read();
    if (!file.plugins[key]) return false;
    delete file.plugins[key];
    this.write(file);
    this.logger.info('Plugin removed from installed_plugins.json', { key }, COMPONENT);
    return true;
  }

  getAllPlugins(): Record<string, InstalledPluginInfoV2> {
    return this.read().plugins;
  }

  getPluginsByScope(scope: PluginScope): InstalledPluginInfoV2[] {
    return Object.values(this.read().plugins).filter((p) => p.scope === scope);
  }

  migrateFromV1(registryFile: PluginRegistryFile): void {
    const current = this.read();

    for (const entry of registryFile.plugins) {
      if (current.plugins[entry.id]) continue;

      current.plugins[entry.id] = this.convertV1Entry(entry);
      this.logger.info('Migrated plugin from V1 registry', { pluginId: entry.id }, COMPONENT);
    }

    this.write(current);
  }

  private convertV1Entry(entry: PluginRegistryEntry): InstalledPluginInfoV2 {
    return {
      marketplace: entry.source === 'bundled' ? 'builtin' : entry.source,
      version: entry.version,
      scope: entry.source === 'bundled' ? 'builtin' : 'user',
      installPath: entry.installPath,
      capabilities: [],
      autoUpdate: entry.source === 'bundled',
      installedAt: Math.floor(new Date(entry.installedAt).getTime() / 1000),
      source: entry.source,
    };
  }
}

let installedPluginsManagerSingleton: InstalledPluginsManager | null = null;

export function getInstalledPluginsManager(): InstalledPluginsManager {
  if (!installedPluginsManagerSingleton) {
    installedPluginsManagerSingleton = new InstalledPluginsManager();
  }
  return installedPluginsManagerSingleton;
}