// apps/desktop/src/main/plugins/builtin-seed.ts
// Builtin plugin distribution — hardened seeding.
//
// The previous seeder copied the shipped plugin directories into
// `~/.duya/plugins/cache/builtin/<id>/<version>/` file by file, skipping
// files whose size and mtime matched. That is fast but it is not safe:
//
//   - a crash halfway through leaves a half-written plugin in the cache and
//     the next launch happily treats it as seeded;
//   - a file that disappeared from the source keeps its stale copy in the
//     cache forever;
//   - two app instances starting at the same time interleave their writes.
//
// This module replaces it with a copy-then-swap seed:
//
//   1. take an exclusive lock (a second instance skips the seed entirely);
//   2. hash the source tree;
//   3. copy into a staging directory and swap it in with a rename, so the
//      cache only ever contains a complete plugin;
//   4. record the hash in a state file, so the next launch can prove the
//      cache is current without re-copying.
//
// The builtin manifest adds one more gate: a plugin that is missing any of
// its declared `requiredPaths` is not seeded at all. The previously seeded
// version stays in the cache and keeps working — a broken update must not
// take a working plugin away.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLogger } from '../logging/logger';
import {
  getBuiltinManifestPath,
  getBuiltinMarketplaceSourceDir,
  getBuiltinPluginsSourceDirs,
  getBuiltinSeedLockPath,
  getBuiltinSeedRoot,
  getBuiltinSeedStatePath,
  getBuiltinStagingRoot,
  readBuiltinManifest,
  type BuiltinManifestPlugin,
} from './builtin-manifest';

const COMPONENT = 'BuiltinPluginSeed';

/** A lock older than this is considered abandoned and is taken over. */
const LOCK_STALE_MS = 60_000;

export interface BuiltinSeedOutcome {
  /** Plugins copied into the cache during this run. */
  seeded: string[];
  /** Plugins already present and provably current. */
  unchanged: string[];
  /** Plugins that were not eligible for seeding (not an error). */
  skipped: { id: string; reason: string }[];
  /** Plugins that could not be seeded. The previous copy is left in place. */
  failed: { id: string; reason: string }[];
}

interface SeedStateEntry {
  version: string;
  hash: string;
}

interface SeedState {
  version: 1;
  plugins: Record<string, SeedStateEntry>;
}

function emptyOutcome(): BuiltinSeedOutcome {
  return { seeded: [], unchanged: [], skipped: [], failed: [] };
}

function readSeedState(): SeedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(getBuiltinSeedStatePath(), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, plugins: {} };
    const plugins = (parsed as { plugins?: unknown }).plugins;
    if (typeof plugins !== 'object' || plugins === null) return { version: 1, plugins: {} };
    return { version: 1, plugins: plugins as Record<string, SeedStateEntry> };
  } catch {
    return { version: 1, plugins: {} };
  }
}

function writeSeedState(state: SeedState): void {
  const target = getBuiltinSeedStatePath();
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    getLogger().warn('Failed to write builtin seed state', {
      error: err instanceof Error ? err.message : String(err),
    }, COMPONENT);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Take the seed lock. Returns false when another instance holds it — the
 * caller then skips the seed instead of racing the other instance.
 */
function acquireSeedLock(lockPath: string): boolean {
  const take = (): boolean => {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    return take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      getLogger().warn('Failed to acquire builtin seed lock', {
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
      return false;
    }
  }

  // The lock exists. If it is older than the stale threshold the previous
  // owner died mid-seed; take it over.
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
    fs.unlinkSync(lockPath);
  } catch {
    return false;
  }
  try {
    return take();
  } catch {
    return false;
  }
}

function releaseSeedLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // best effort
  }
}

/** Every file under `root`, as sorted POSIX-style relative paths. */
function listFilesRecursive(root: string, base: string = root): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Content hash of a directory tree: path + bytes of every file. */
export function hashDirectory(dir: string): string {
  const hash = crypto.createHash('sha256');
  for (const rel of listFilesRecursive(dir).sort()) {
    hash.update(rel);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(dir, rel.split('/').join(path.sep))));
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function copyDirectory(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Swap `stagedDir` in as `targetDir`.
 *
 * The old copy is moved aside first (Windows cannot rename onto an existing
 * directory), and moved back if the swap fails — a failed seed must leave
 * the working plugin in place.
 */
function replaceDirectory(stagedDir: string, targetDir: string): void {
  const stagingRoot = getBuiltinStagingRoot();
  fs.mkdirSync(stagingRoot, { recursive: true });
  // The rename needs its destination parent to exist.
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const trashDir = path.join(
    stagingRoot,
    `old-${path.basename(path.dirname(targetDir))}-${path.basename(targetDir)}-${process.pid}-${Date.now()}`,
  );

  const hadTarget = fs.existsSync(targetDir);
  if (hadTarget) fs.renameSync(targetDir, trashDir);
  try {
    fs.renameSync(stagedDir, targetDir);
  } catch (err) {
    if (hadTarget && fs.existsSync(trashDir)) {
      try {
        fs.renameSync(trashDir, targetDir);
      } catch {
        // The trash copy stays behind; the next run will overwrite it.
      }
    }
    // The staged copy never made it into the cache; leaving it behind would
    // fill the staging area with debris.
    try {
      fs.rmSync(stagedDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    throw err;
  }
  if (hadTarget) {
    try {
      fs.rmSync(trashDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** Files the manifest declares as required but that are not on disk. */
function findMissingRequiredPaths(pluginDir: string, requiredPaths: string[]): string[] {
  return requiredPaths.filter((rel) => !fs.existsSync(path.join(pluginDir, rel)));
}

/**
 * Seed the shipped builtin plugins into the user-home cache.
 *
 * Idempotent and safe to call on every launch: nothing is copied when the
 * cached copy already matches the source, and no failure is allowed to
 * escape — a broken plugin degrades to the previously seeded copy instead of
 * taking the app down.
 */
export function seedBuiltinPlugins(): BuiltinSeedOutcome {
  const logger = getLogger();
  const outcome = emptyOutcome();

  const sourceDirs = getBuiltinPluginsSourceDirs().filter((dir) => fs.existsSync(dir));
  if (sourceDirs.length === 0) {
    // In dev the repo's own builtin plugins always exist; in prod this only
    // happens after electron-builder copied extraResources.
    if (app.isPackaged) {
      logger.warn('Builtin plugins source directory not found in production build', {
        sourceDir: getBuiltinPluginsSourceDirs().join(', '),
      }, COMPONENT);
    }
    return outcome;
  }

  const lockPath = getBuiltinSeedLockPath();
  if (!acquireSeedLock(lockPath)) {
    logger.info('Builtin plugin seed skipped; another instance is seeding', undefined, COMPONENT);
    return outcome;
  }

  try {
    return seedAll(sourceDirs, outcome);
  } catch (err) {
    logger.warn('Builtin plugin seed failed', {
      error: err instanceof Error ? err.message : String(err),
    }, COMPONENT);
    return outcome;
  } finally {
    releaseSeedLock(lockPath);
  }
}

function seedAll(sourceDirs: string[], outcome: BuiltinSeedOutcome): BuiltinSeedOutcome {
  const logger = getLogger();

  const manifestResult = readBuiltinManifest(getBuiltinManifestPath());
  let declaredByName = new Map<string, BuiltinManifestPlugin>();
  if (manifestResult === null) {
    logger.debug('No builtin manifest found; seeding without distribution defaults', undefined, COMPONENT);
  } else if (!manifestResult.ok) {
    // A broken manifest must not stop the shipped plugins from seeding, but
    // no default may be derived from a manifest we cannot read.
    logger.warn('Builtin plugin manifest is invalid; seeding without distribution defaults', {
      error: manifestResult.error,
    }, COMPONENT);
  } else {
    for (const declared of manifestResult.manifest.plugins) {
      declaredByName.set(declared.name, declared);
    }
  }

  const state = readSeedState();
  let stateChanged = false;
  const marketplaceDir = getBuiltinMarketplaceSourceDir();
  const seenDeclared = new Set<string>();

  for (const sourceDir of sourceDirs) {
    let sourceDirsEntries: fs.Dirent[];
    try {
      sourceDirsEntries = fs
        .readdirSync(sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    } catch (err) {
      logger.warn('Failed to enumerate builtin plugin source directory', {
        sourceDir,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
      continue;
    }

    for (const entry of sourceDirsEntries) {
      const pluginSourceDir = path.join(sourceDir, entry.name);
      const manifestPath = path.join(pluginSourceDir, '.duya-plugin', 'plugin.json');

      if (!fs.existsSync(manifestPath)) {
        outcome.skipped.push({ id: entry.name, reason: 'no plugin manifest' });
        continue;
      }

      let pluginManifest: { id?: string; name?: string; version?: string };
      try {
        pluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof pluginManifest;
      } catch (err) {
        outcome.failed.push({
          id: entry.name,
          reason: `unreadable plugin manifest: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const pluginId = pluginManifest.id || `com.duya.${pluginManifest.name || entry.name}`;
      const version = pluginManifest.version || '0.1.0';

      // The manifest only describes the marketplace plugins; the repo's own
      // builtin plugins are seeded without a completeness gate.
      const declared =
        sourceDir === marketplaceDir ? declaredByName.get(entry.name) : undefined;
      if (declared) seenDeclared.add(declared.name);

      if (declared?.requiredPaths?.length) {
        const missing = findMissingRequiredPaths(pluginSourceDir, declared.requiredPaths);
        if (missing.length > 0) {
          // Refuse to seed a plugin that is missing declared files. The
          // previously seeded version stays in the cache and keeps working.
          outcome.failed.push({
            id: pluginId,
            reason: `incomplete plugin, missing: ${missing.join(', ')}`,
          });
          logger.warn('Builtin plugin is incomplete; keeping the previously seeded copy', {
            plugin: pluginId,
            missing,
          }, COMPONENT);
          continue;
        }
      }

      const targetDir = path.join(getBuiltinSeedRoot(), pluginId, version);
      const sourceHash = hashDirectory(pluginSourceDir);
      const recorded = state.plugins[pluginId];

      if (
        recorded &&
        recorded.version === version &&
        recorded.hash === sourceHash &&
        fs.existsSync(targetDir)
      ) {
        outcome.unchanged.push(pluginId);
        continue;
      }

      if (fs.existsSync(targetDir) && hashDirectory(targetDir) === sourceHash) {
        // The cached copy is already correct — the state file was just missing
        // or stale (e.g. it was written by an older build).
        state.plugins[pluginId] = { version, hash: sourceHash };
        stateChanged = true;
        outcome.unchanged.push(pluginId);
        continue;
      }

      try {
        const stagingRoot = getBuiltinStagingRoot();
        fs.mkdirSync(stagingRoot, { recursive: true });
        const stagedDir = path.join(
          stagingRoot,
          `new-${pluginId}-${version}-${process.pid}-${Date.now()}`,
        );
        fs.rmSync(stagedDir, { recursive: true, force: true });
        copyDirectory(pluginSourceDir, stagedDir);
        replaceDirectory(stagedDir, targetDir);
        state.plugins[pluginId] = { version, hash: sourceHash };
        stateChanged = true;
        outcome.seeded.push(pluginId);
        logger.debug('Seeded builtin plugin', {
          plugin: pluginId,
          version,
          from: pluginSourceDir,
          to: targetDir,
        }, COMPONENT);
      } catch (err) {
        outcome.failed.push({
          id: pluginId,
          reason: err instanceof Error ? err.message : String(err),
        });
        logger.warn('Failed to seed builtin plugin', {
          plugin: pluginId,
          error: err instanceof Error ? err.message : String(err),
        }, COMPONENT);
      }
    }
  }

  for (const declared of declaredByName.values()) {
    if (!seenDeclared.has(declared.name)) {
      outcome.failed.push({
        id: declared.name,
        reason: 'declared in the builtin manifest but missing from the bundle',
      });
    }
  }

  if (stateChanged) writeSeedState(state);
  return outcome;
}
