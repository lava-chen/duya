/**
 * package.ts — materialize and remove one plugin package on disk.
 *
 * ## What this owns
 *
 * The steps an install has to get right in order: copy the source into a
 * staging directory, swap it into the versioned cache slot, point
 * `installed/<id>` at it, and create the plugin's data directory. Doing the
 * copy first is what keeps a failure mid-copy from leaving a half-populated
 * cache directory that the installed link then points at.
 *
 * ## What this deliberately does not do
 *
 * No manifest-only fallback. The Desktop's installer writes a synthetic
 * `plugin.json` when a catalog row has no source directory, because its
 * registry is also the product's install history. A package with no content is
 * not an install: the worker would gate the plugin's skills and MCP servers on
 * a directory that holds nothing, so this module reports the missing source
 * and lets the caller say so.
 *
 * ## Names are input
 *
 * `marketplace`, `pluginId` and `version` come from a remote catalog and from a
 * `config.toml` a person edits by hand, and each one becomes a path segment.
 * {@link assertPathSegment} is what stops `../../` from being a version string.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  createInstalledLink,
  ensureDir,
  ensurePluginRoots,
  installedLinkPath,
  pluginDataDir,
  pluginStagingRoot,
  pluginVersionCacheDir,
  removeInstalledLink,
  type PluginRoots,
} from './layout.js';

/** A segment that is safe to place under the plugin root. */
const SAFE_SEGMENT_PATTERN = /^[^./\\][^/\\]{0,127}$/;

/** A name that must not be able to climb out of the tree it is written into. */
export function assertPathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || !SAFE_SEGMENT_PATTERN.test(trimmed)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** Structured logging sink, optional because a test needs none. */
export interface InstallLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface InstallPackageRequest {
  readonly roots: PluginRoots;
  readonly marketplace: string;
  readonly pluginId: string;
  readonly version: string;
  /** The directory holding the plugin package, already containment-fenced. */
  readonly sourceDir: string;
  readonly log?: InstallLog;
}

export interface InstalledPackage {
  readonly pluginId: string;
  readonly marketplace: string;
  readonly version: string;
  readonly cacheDir: string;
  readonly linkPath: string;
  readonly dataPath: string;
}

/**
 * Recursive copy that preserves symlinks rather than following them, so a link
 * inside a package cannot drag files from outside the package into the install.
 */
export function copyDirectoryRecursive(src: string, dest: string): void {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSafe(target: string): void {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Copy `sourceDir` into the versioned cache slot and point the installed link
 * at it. Reinstalling the same version replaces the cache directory, so the
 * result is what the source holds now, not what it held at first install.
 */
export function installPluginPackage(request: InstallPackageRequest): InstalledPackage {
  const marketplace = assertPathSegment(request.marketplace, 'marketplace');
  const pluginId = assertPathSegment(request.pluginId, 'plugin id');
  const version = assertPathSegment(request.version, 'version');
  const { roots } = request;

  if (!fs.existsSync(request.sourceDir) || !fs.statSync(request.sourceDir).isDirectory()) {
    throw new Error(`plugin source directory not found: ${request.sourceDir}`);
  }

  ensurePluginRoots(roots);
  const cacheDir = pluginVersionCacheDir(roots, marketplace, pluginId, version);
  const stagingPath = path.join(pluginStagingRoot(roots), randomUUID());

  try {
    ensureDir(stagingPath);
    copyDirectoryRecursive(request.sourceDir, stagingPath);

    removeDirSafe(cacheDir);
    ensureDir(path.dirname(cacheDir));
    fs.renameSync(stagingPath, cacheDir);

    createInstalledLink(roots, pluginId, cacheDir);
    const dataPath = pluginDataDir(roots, pluginId);
    ensureDir(dataPath);

    request.log?.info('Plugin package installed', { pluginId, marketplace, version, cacheDir });
    return {
      pluginId,
      marketplace,
      version,
      cacheDir,
      linkPath: installedLinkPath(roots, pluginId),
      dataPath,
    };
  } catch (error) {
    removeDirSafe(stagingPath);
    throw error;
  }
}

export interface UninstallPackageRequest {
  readonly roots: PluginRoots;
  readonly marketplace: string;
  readonly pluginId: string;
  /** Omit to drop every cached version of the plugin in that marketplace. */
  readonly version?: string;
  /** Also remove the plugin's own data directory. */
  readonly deleteData?: boolean;
  readonly log?: InstallLog;
}

/**
 * Remove the installed link, then the cached package, then optionally the data
 * directory — the order the Desktop's own removal uses, so a failure partway
 * through leaves a plugin that reads as not-installed rather than one whose
 * link dangles.
 *
 * Only a link that still points inside this root's cache is unlinked: an
 * installed path the user re-pointed somewhere else is theirs to keep.
 */
export function uninstallPluginPackage(request: UninstallPackageRequest): string[] {
  const marketplace = assertPathSegment(request.marketplace, 'marketplace');
  const pluginId = assertPathSegment(request.pluginId, 'plugin id');
  const { roots } = request;
  const removed: string[] = [];

  const link = installedLinkPath(roots, pluginId);
  if (fs.existsSync(link)) {
    const target = (() => {
      try {
        return fs.realpathSync(link);
      } catch {
        return null;
      }
    })();
    const insideCache = target !== null && target.startsWith(path.resolve(roots.rootDir));
    if (insideCache || !fs.existsSync(link)) {
      removeInstalledLink(roots, pluginId);
      removed.push(link);
    } else {
      // A link to a directory outside this root is a hand-made arrangement.
      // Removing the cache below would leave it dangling, so stop here.
      request.log?.warn('Left an installed link that points outside the plugin cache', {
        pluginId,
        target,
      });
      return removed;
    }
  }

  const versions =
    request.version !== undefined
      ? [assertPathSegment(request.version, 'version')]
      : listVersionsUnder(roots, marketplace, pluginId);
  for (const version of versions) {
    const dir = pluginVersionCacheDir(roots, marketplace, pluginId, version);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  // The `<marketplace>/<id>` parent is an artifact of the layout, not content.
  const pluginCacheDir = path.join(roots.rootDir, 'plugins', 'cache', marketplace, pluginId);
  if (isDirEmpty(pluginCacheDir)) {
    fs.rmSync(pluginCacheDir, { recursive: true, force: true });
  }

  if (request.deleteData === true) {
    const dataPath = pluginDataDir(roots, pluginId);
    if (fs.existsSync(dataPath)) {
      fs.rmSync(dataPath, { recursive: true, force: true });
      removed.push(dataPath);
    }
  }

  request.log?.info('Plugin package uninstalled', { pluginId, marketplace, removed });
  return removed;
}

function listVersionsUnder(roots: PluginRoots, marketplace: string, pluginId: string): string[] {
  const dir = path.join(roots.rootDir, 'plugins', 'cache', marketplace, pluginId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function isDirEmpty(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}
