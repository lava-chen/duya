// apps/desktop/src/main/plugins/builtin-manifest.ts
// Builtin plugin distribution — manifest schema and path resolution.
//
// The marketplace repo owns the plugin source of truth and publishes
// `builtin-plugins.json` next to the plugin directories. The app build
// stages both into the installer, and the runtime seeds the plugin
// directories into the user-home cache before the first window is shown.
//
// The manifest is intentionally NOT a second copy of anything the plugin
// already declares: the plugin version is read from the plugin's own
// `.duya-plugin/plugin.json`, so there is exactly one place to bump it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

/** Manifest file name, shipped next to the plugin directories. */
export const BUILTIN_MANIFEST_FILE = 'builtin-plugins.json';

/** Marketplace namespace the seeded builtin cache lives under. */
export const BUILTIN_MARKETPLACE = 'builtin';

/** One plugin declared by the builtin manifest. */
export interface BuiltinManifestPlugin {
  /** Directory name under the plugin root; also the staged directory name. */
  name: string;
  /** Source location, relative to the marketplace repo root. */
  path: string;
  /** Optional one-liner shown in the store. */
  description?: string;
  /**
   * Files that must exist for the plugin to be considered intact. The build
   * refuses to stage a plugin that is missing any of them, and the runtime
   * refuses to seed one — it keeps the previously seeded copy instead of
   * installing a broken plugin.
   */
  requiredPaths?: string[];
  /**
   * Initial enabled state. `false` ships the plugin installed but leaves it
   * off until the user turns it on in Settings.
   */
  defaultEnabled?: boolean;
}

/** Parsed builtin manifest. */
export interface BuiltinManifest {
  version: number;
  plugins: BuiltinManifestPlugin[];
}

export type BuiltinManifestResult =
  | { ok: true; manifest: BuiltinManifest }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject a path that escapes its root. The marketplace reader enforces the
 * same containment fence (`../` and absolute paths are refused); the builtin
 * manifest gets the same treatment so a hand-edited file cannot make the
 * build stage something outside the repo.
 */
export function isContainedPath(root: string, relative: string): boolean {
  if (!relative || path.isAbsolute(relative)) return false;
  const resolved = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Parse `builtin-plugins.json`.
 *
 * Every failure is reported, never thrown: a broken manifest must not stop
 * the app from starting, it must only stop the distribution it describes.
 */
export function parseBuiltinManifest(raw: string): BuiltinManifestResult {
  let parsed: unknown;
  try {
    // A Windows editor can leave a UTF-8 BOM in front of the file; JSON.parse
    // rejects it, and the manifest is not worth failing a build over.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObject(parsed)) return { ok: false, error: 'manifest root must be an object' };

  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'manifest version must be a positive integer' };
  }
  const pluginsRaw = parsed.plugins;
  if (!Array.isArray(pluginsRaw)) {
    return { ok: false, error: 'manifest plugins must be an array' };
  }

  const plugins: BuiltinManifestPlugin[] = [];
  const seen = new Set<string>();
  for (const entry of pluginsRaw) {
    if (!isObject(entry)) return { ok: false, error: 'each plugin entry must be an object' };
    const name = entry.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: 'plugin entry is missing a name' };
    }
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      return { ok: false, error: `plugin name "${name}" must be a plain directory name` };
    }
    if (seen.has(name)) return { ok: false, error: `duplicate plugin name "${name}"` };
    seen.add(name);

    const sourcePath = entry.path;
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      return { ok: false, error: `plugin "${name}" is missing a path` };
    }

    let requiredPaths: string[] | undefined;
    if (entry.requiredPaths !== undefined) {
      if (!Array.isArray(entry.requiredPaths)) {
        return { ok: false, error: `plugin "${name}" requiredPaths must be an array` };
      }
      for (const item of entry.requiredPaths) {
        if (typeof item !== 'string' || !item.trim()) {
          return { ok: false, error: `plugin "${name}" has an invalid requiredPaths entry` };
        }
      }
      requiredPaths = entry.requiredPaths as string[];
    }

    let defaultEnabled: boolean | undefined;
    if (entry.defaultEnabled !== undefined) {
      if (typeof entry.defaultEnabled !== 'boolean') {
        return { ok: false, error: `plugin "${name}" defaultEnabled must be a boolean` };
      }
      defaultEnabled = entry.defaultEnabled;
    }

    const description = typeof entry.description === 'string' ? entry.description : undefined;

    plugins.push({
      name,
      path: sourcePath,
      ...(description !== undefined ? { description } : {}),
      ...(requiredPaths !== undefined ? { requiredPaths } : {}),
      ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
    });
  }

  return { ok: true, manifest: { version, plugins } };
}

/**
 * Read the manifest from disk. Returns `null` when the file does not exist
 * (a build without the marketplace repo stages no manifest) and an error
 * result when the file exists but cannot be used.
 */
export function readBuiltinManifest(manifestPath: string): BuiltinManifestResult | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  return parseBuiltinManifest(raw);
}

/**
 * Directory the installer ships the repo's own builtin plugins in.
 * - Dev: `<appPath>/packages/plugin-core/src/plugins/builtin/`
 * - Prod: `<resourcesPath>/builtin-plugins/` (electron-builder extraResources)
 */
export function getBuiltinPluginsSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'builtin-plugins');
  }
  return path.join(app.getAppPath(), 'packages', 'plugin-core', 'src', 'plugins', 'builtin');
}

/**
 * Directory the installer ships the marketplace's builtin plugins in.
 *
 * The marketplace repo is their source of truth; the build stages them here
 * (`scripts/stage-builtin-plugins.mjs`) and the installer copies the staged
 * tree into its own resources directory. Keeping it apart from the repo's
 * own builtin plugins means the two can never collide on a directory name.
 *
 * - Dev: `<appPath>/resources/builtin-plugins/`
 * - Prod: `<resourcesPath>/builtin-marketplace-plugins/`
 */
export function getBuiltinMarketplaceSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'builtin-marketplace-plugins');
  }
  return path.join(app.getAppPath(), 'resources', 'builtin-plugins');
}

/** Every directory that may hold shipped builtin plugins. */
export function getBuiltinPluginsSourceDirs(): string[] {
  return [getBuiltinPluginsSourceDir(), getBuiltinMarketplaceSourceDir()];
}

/** Manifest shipped with the marketplace plugins. */
export function getBuiltinManifestPath(): string {
  return path.join(getBuiltinMarketplaceSourceDir(), BUILTIN_MANIFEST_FILE);
}

/** Root of the plugin cache the builtin plugins are seeded into. */
function getBuiltinCacheRoot(): string {
  return path.join(os.homedir(), '.duya', 'plugins', 'cache');
}

/** Seeded builtin cache: `<cache>/builtin/<pluginId>/<version>/`. */
export function getBuiltinSeedRoot(): string {
  return path.join(getBuiltinCacheRoot(), BUILTIN_MARKETPLACE);
}

/**
 * Seed bookkeeping, kept OUTSIDE the seed root: the catalog scanner walks
 * that directory and treats every child as a plugin id, so bookkeeping files
 * must not live there.
 */
export function getBuiltinSeedStatePath(): string {
  return path.join(getBuiltinCacheRoot(), '.builtin-seed-state.json');
}

/** Seed lock, so two app instances cannot seed at the same time. */
export function getBuiltinSeedLockPath(): string {
  return path.join(getBuiltinCacheRoot(), '.builtin-seed.lock');
}

/** Staging area for the copy-then-swap seed. */
export function getBuiltinStagingRoot(): string {
  return path.join(getBuiltinCacheRoot(), '.builtin-staging');
}
