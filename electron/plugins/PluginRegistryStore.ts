import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { PluginRegistryEntry, PluginRegistryFile } from './types';
import { getConfigStore } from '../config/store-instance';

// Plan 334 decision 11: installed-plugins storage is migrged from
// `registry.json` into the ConfigStore `plugins` block. The TOML key is a
// composite `<pluginId>@<marketplace>` and only the user-intent field
// (`enabled`) is persisted; every other field is derived at read time by
// `PluginManager.listInstalled()`.

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Composite key: "<pluginId>@<marketplace>". Marketplace defaults to
// 'builtin' for entries that predate source attribution.
function toConfigKey(id: string, marketplace: string): string {
  return `${id}@${marketplace || 'builtin'}`;
}

function parseConfigKey(key: string): { id: string; marketplace: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) {
    return { id: key, marketplace: 'builtin' };
  }
  return { id: key.slice(0, at), marketplace: key.slice(at + 1) };
}

export class PluginRegistryStore {
  private readonly rootDir: string;
  private readonly installedDir: string;
  private readonly dataDir: string;
  private readonly stagingDir: string;
  private readonly registryPath: string;

  constructor() {
    const userData = app.getPath('userData');
    this.rootDir = path.join(userData, 'plugins');
    this.installedDir = path.join(this.rootDir, 'installed');
    this.dataDir = path.join(userData, 'plugins-data');
    this.stagingDir = path.join(this.rootDir, 'staging');
    this.registryPath = path.join(this.rootDir, 'registry.json');
    ensureDir(this.rootDir);
    ensureDir(this.installedDir);
    ensureDir(this.dataDir);
    ensureDir(this.stagingDir);
  }

  getPaths(): {
    installedDir: string;
    dataDir: string;
    stagingDir: string;
    registryPath: string;
  } {
    return {
      installedDir: this.installedDir,
      dataDir: this.dataDir,
      stagingDir: this.stagingDir,
      registryPath: this.registryPath,
    };
  }

  private readConfigPlugins(): Record<string, { enabled?: boolean }> {
    const plugins = getConfigStore().getByPath('plugins');
    if (plugins && typeof plugins === 'object') {
      return plugins as Record<string, { enabled?: boolean }>;
    }
    return {};
  }

  private writeConfigPlugins(plugins: Record<string, { enabled: boolean }>): void {
    getConfigStore().set('plugins', plugins);
  }

  // Build a minimal entry from the composite key. Only `id`/`enabled`/
  // `marketplace` are known from config; the remaining fields are filled by
  // the single merge entry point in `PluginManager.hydrateViewItem`.
  private minimalEntry(id: string, enabled: boolean, marketplace: string): PluginRegistryEntry {
    return { id, enabled, marketplace } as unknown as PluginRegistryEntry;
  }

  readRegistry(): PluginRegistryFile {
    const plugins = this.readConfigPlugins();
    const entries: PluginRegistryEntry[] = [];
    for (const [key, val] of Object.entries(plugins)) {
      const { id, marketplace } = parseConfigKey(key);
      entries.push(this.minimalEntry(id, val?.enabled ?? true, marketplace));
    }
    return { version: 1, plugins: entries };
  }

  writeRegistry(file: PluginRegistryFile): void {
    const plugins: Record<string, { enabled: boolean }> = {};
    for (const entry of file.plugins) {
      const key = toConfigKey(entry.id, entry.marketplace);
      plugins[key] = { enabled: entry.enabled };
    }
    this.writeConfigPlugins(plugins);
  }

  listPlugins(): PluginRegistryEntry[] {
    return this.readRegistry().plugins;
  }

  upsertPlugin(entry: PluginRegistryEntry): void {
    const plugins = this.readConfigPlugins();
    const key = toConfigKey(entry.id, entry.marketplace);
    plugins[key] = { enabled: entry.enabled };
    this.writeConfigPlugins(plugins as Record<string, { enabled: boolean }>);
  }

  removePlugin(id: string): PluginRegistryEntry | null {
    const plugins = this.readConfigPlugins();
    const key = Object.keys(plugins).find((k) => parseConfigKey(k).id === id);
    if (!key) {
      return null;
    }
    const { marketplace } = parseConfigKey(key);
    const removed = this.minimalEntry(id, plugins[key]?.enabled ?? true, marketplace);
    delete plugins[key];
    this.writeConfigPlugins(plugins as Record<string, { enabled: boolean }>);
    return removed;
  }
}