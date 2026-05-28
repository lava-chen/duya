import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { PluginLockfile, PluginRegistryEntry, PluginRegistryFile } from './types';

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(targetPath: string, payload: unknown): void {
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, targetPath);
}

export class PluginRegistryStore {
  private readonly rootDir: string;
  private readonly installedDir: string;
  private readonly dataDir: string;
  private readonly stagingDir: string;
  private readonly registryPath: string;
  private readonly lockfilePath: string;

  constructor() {
    const userData = app.getPath('userData');
    this.rootDir = path.join(userData, 'plugins');
    this.installedDir = path.join(this.rootDir, 'installed');
    this.dataDir = path.join(userData, 'plugins-data');
    this.stagingDir = path.join(this.rootDir, 'staging');
    this.registryPath = path.join(this.rootDir, 'registry.json');
    this.lockfilePath = path.join(this.rootDir, 'lockfile.json');
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
    lockfilePath: string;
  } {
    return {
      installedDir: this.installedDir,
      dataDir: this.dataDir,
      stagingDir: this.stagingDir,
      registryPath: this.registryPath,
      lockfilePath: this.lockfilePath,
    };
  }

  readRegistry(): PluginRegistryFile {
    if (!fs.existsSync(this.registryPath)) {
      return { version: 1, plugins: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as PluginRegistryFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
      return { version: 1, plugins: [] };
    }
    return parsed;
  }

  writeRegistry(file: PluginRegistryFile): void {
    atomicWriteJson(this.registryPath, file);
  }

  readLockfile(): PluginLockfile {
    if (!fs.existsSync(this.lockfilePath)) {
      return { lockfileVersion: 1, plugins: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(this.lockfilePath, 'utf8')) as PluginLockfile;
    if (parsed.lockfileVersion !== 1 || typeof parsed.plugins !== 'object' || parsed.plugins === null) {
      return { lockfileVersion: 1, plugins: {} };
    }
    return parsed;
  }

  writeLockfile(lockfile: PluginLockfile): void {
    atomicWriteJson(this.lockfilePath, lockfile);
  }

  listPlugins(): PluginRegistryEntry[] {
    return this.readRegistry().plugins;
  }

  upsertPlugin(entry: PluginRegistryEntry): void {
    const registry = this.readRegistry();
    const index = registry.plugins.findIndex((p) => p.id === entry.id);
    if (index >= 0) {
      registry.plugins[index] = entry;
    } else {
      registry.plugins.push(entry);
    }
    this.writeRegistry(registry);
  }

  removePlugin(id: string): PluginRegistryEntry | null {
    const registry = this.readRegistry();
    const existing = registry.plugins.find((p) => p.id === id) ?? null;
    if (!existing) {
      return null;
    }
    registry.plugins = registry.plugins.filter((p) => p.id !== id);
    this.writeRegistry(registry);
    return existing;
  }
}

