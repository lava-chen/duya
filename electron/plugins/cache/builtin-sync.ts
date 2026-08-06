// builtin-sync.ts — sync builtin plugins from the authoring source tree
// into the user-home cache at `~/.duya/plugins/cache/builtin/`.
//
// Plan: plugin-config-simplification. builtin plugins are authored under
// `packages/plugin-core/src/plugins/builtin/<name>/` (dev) or packaged as
// `resources/builtin-plugins/<name>/` (prod). At startup they are copied
// into the user-home cache so the catalog can read them from a single
// uniform location regardless of dev/prod. The cache is rebuildable:
// deleting `~/.duya/plugins/cache/builtin/` forces a full re-sync on next
// launch.
//
// This is intentionally separate from Plan 89's `userData/plugins/cache`
// (marketplace + local). builtin lives under the user home to align with
// Codex's `~/.codex/` convention and to decouple rebuildable builtin
// assets from user-installed plugins.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import { pickLatestVersion } from './version-resolver';
import { readPluginManifest } from '../manifest';

const COMPONENT = 'BuiltinPluginSync' as LogComponent;

const BUILTIN_SOURCE_SEGMENT = 'builtin';

/** `~/.duya/plugins/cache/builtin` — the rebuildable builtin cache root. */
export function getBuiltinCacheRoot(): string {
  return path.join(os.homedir(), '.duya', 'plugins', 'cache', BUILTIN_SOURCE_SEGMENT);
}

/**
 * Resolve the builtin plugin SOURCE directory (the authoring tree that
 * ships with the app).
 *
 * Dev: `<repo>/packages/plugin-core/src/plugins/builtin`
 * Prod: `<resourcesPath>/builtin-plugins` (electron-builder extraResource)
 */
export function getBuiltinSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'builtin-plugins');
  }
  return path.join(app.getAppPath(), 'packages', 'plugin-core', 'src', 'plugins', 'builtin');
}

interface BuiltinPluginInfo {
  name: string;
  version: string;
  id: string;
  sourceDir: string;
}

/** Read `.duya-plugin/plugin.json` from a plugin source dir. */
function readBuiltinPluginInfo(pluginDir: string): BuiltinPluginInfo | null {
  const manifestPath = path.join(pluginDir, '.duya-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  const version = typeof obj.version === 'string' ? obj.version : undefined;
  if (!name || !version) return null;
  const id = typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id : `com.duya.${name}`;
  return { name, version, id, sourceDir: pluginDir };
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function listVersionDirs(pluginCacheDir: string): string[] {
  if (!fs.existsSync(pluginCacheDir)) return [];
  return fs
    .readdirSync(pluginCacheDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Sync builtin plugins from source into `~/.duya/plugins/cache/builtin/`.
 *
 * Idempotent: a plugin whose `<name>/<version>/` dir already exists is
 * skipped, so repeat launches only copy plugins that changed version. The
 * sync never deletes old versions — that is left to a future cleanup pass
 * (Plan 89 versioned-cache retention) to avoid races with running workers.
 *
 * Cache layout uses the plugin *name* (kebab-case) as the directory segment,
 * matching Codex's `~/.codex/plugins/cache/<source>/<name>/<version>/`. The
 * plugin id (`com.duya.<name>`) is read from the manifest at runtime, not
 * encoded in the path.
 *
 * Returns the list of synced plugin roots (one per plugin name, latest
 * version). Callers (catalog) read manifests from these roots.
 */
export function syncBuiltinPlugins(): string[] {
  const logger = getLogger();
  const sourceDir = getBuiltinSourceDir();
  if (!fs.existsSync(sourceDir)) {
    logger.warn('Builtin plugin source dir not found; builtin catalog will be empty', { dir: sourceDir }, COMPONENT);
    return [];
  }

  const cacheRoot = getBuiltinCacheRoot();
  const syncedNames = new Set<string>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (err) {
    logger.warn('Failed to read builtin plugin source dir', { dir: sourceDir, error: err instanceof Error ? err.message : String(err) }, COMPONENT);
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const info = readBuiltinPluginInfo(path.join(sourceDir, entry.name));
    if (!info) continue;

    const targetDir = path.join(cacheRoot, info.name, info.version);
    if (!fs.existsSync(targetDir)) {
      try {
        copyDirSync(info.sourceDir, targetDir);
        logger.info('Synced builtin plugin to cache', { id: info.id, name: info.name, version: info.version }, COMPONENT);
      } catch (err) {
        logger.warn('Failed to sync builtin plugin', { id: info.id, name: info.name, version: info.version, error: err instanceof Error ? err.message : String(err) }, COMPONENT);
        continue;
      }
    }
    syncedNames.add(info.name);
  }

  // Resolve the latest version dir per synced name.
  const roots: string[] = [];
  for (const name of syncedNames) {
    const versions = listVersionDirs(path.join(cacheRoot, name));
    const latest = pickLatestVersion(versions);
    if (latest) roots.push(path.join(cacheRoot, name, latest));
  }
  return roots;
}

/**
 * List the cached builtin plugin roots (latest version per name) without
 * triggering a sync. Used by the catalog to read manifests from disk.
 */
export function listBuiltinCacheRoots(): string[] {
  const cacheRoot = getBuiltinCacheRoot();
  if (!fs.existsSync(cacheRoot)) return [];
  const roots: string[] = [];
  for (const idEntry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!idEntry.isDirectory()) continue;
    const versions = listVersionDirs(path.join(cacheRoot, idEntry.name));
    const latest = pickLatestVersion(versions);
    if (latest) roots.push(path.join(cacheRoot, idEntry.name, latest));
  }
  return roots;
}

export interface BuiltinCachePlugin {
  id: string;
  name: string;
  root: string;
}

/**
 * List cached builtin plugins with their manifest id and root path. This is
 * the single entry point for IPC handlers that need to locate a builtin
 * plugin's on-disk directory (for skills/workflows discovery) — they must
 * read from the cache, not the authoring source tree, so the catalog and
 * the IPC layer share one uniform read path.
 */
export function listBuiltinCachePlugins(): BuiltinCachePlugin[] {
  const logger = getLogger();
  const roots = listBuiltinCacheRoots();
  const result: BuiltinCachePlugin[] = [];
  for (const root of roots) {
    try {
      const manifest = readPluginManifest(root);
      result.push({ id: manifest.id, name: manifest.name, root });
    } catch (err) {
      logger.warn('Failed to read builtin plugin manifest from cache', {
        root,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
    }
  }
  return result;
}
