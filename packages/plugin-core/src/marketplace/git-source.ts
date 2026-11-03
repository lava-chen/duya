/**
 * git-source.ts — marketplace git clone/sync with the root named by the caller.
 *
 * ## Why this lives here
 *
 * The clone is the one part of plugin management that has no opinion about the
 * product surface: it fetches a repository into a directory and keeps it
 * current. It used to live in the Desktop main process, where the only way to
 * name the directory was Electron's `app.getPath('userData')`, which meant a
 * standalone Host could not install a plugin at all. Every function here takes
 * the marketplaces cache root as a parameter and never looks one up, so both
 * surfaces share one implementation of the safety rules.
 *
 * ## The safety rules (codex parity, plan 455 doc 17.4)
 *
 * - `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo`: a private repository fails
 *   instead of hanging the caller on a credential prompt nobody can answer.
 * - Clone into a staging directory, then rename into place: a mid-clone failure
 *   never leaves a half-written marketplace.
 * - `realpathSync` + prefix check before any write: a marketplace name coming
 *   from a config file a person edited by hand cannot escape the cache root.
 * - A per-command timeout, so a stalled network read does not outlive the request.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { safeMarketplaceDirName } from './source-parse.js';

/** A git command that took too long; the child was killed. */
const GIT_TIMEOUT_MS = 120_000;

/** Structured logging sink, optional because a test needs none. */
export interface MarketplaceGitLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

export interface MarketplaceCloneResult {
  dir: string;
  /** HEAD commit after the operation (best effort, null if unreadable). */
  commit: string | null;
}

/**
 * One marketplace source as `[marketplaces.<name>]` holds it.
 *
 * The shape is the Desktop config store's contract, which is why `urls` wins
 * over `url` and why `removed` is a tombstone rather than an absent key.
 */
export interface MarketplaceSourceConfig {
  source: 'git' | 'local';
  /** Single git URL. Kept for back-compat with existing configs and UI forms. */
  url?: string;
  /**
   * Ordered list of git URLs (primary → mirror). Wins over `url` when set.
   * cloneMarketplace tries each in order; first success wins. updateMarketplace
   * always fetches from whichever URL ended up as `origin`.
   */
  urls?: string[];
  /**
   * Optional UI tab label for this marketplace source. Falls back to the
   * marketplace registry key (`name`) when unset.
   */
  displayName?: string;
  path?: string;
  ref?: string;
  /**
   * Set when the user hides the source: it stays configured and cloned, but
   * its plugins are left out of the catalog and the startup sync.
   */
  hidden?: boolean;
  /**
   * Tombstone for a removed pre-seeded official source. The entry keeps its key
   * so the seeding pass does not restore the source on the next launch;
   * everything else ignores it.
   */
  removed?: boolean;
  addedAt?: string;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Where a marketplace's staging directories live. */
export function marketplaceStagingRoot(root: string): string {
  return path.join(root, '.staging');
}

/** Clone target for a marketplace name (not guaranteed to exist). */
export function marketplaceCloneDir(root: string, name: string): string {
  return path.join(root, safeMarketplaceDirName(name));
}

/** The cache root for individual plugin clones from marketplace git sources. */
export function marketplacePluginGitCacheRoot(root: string): string {
  return path.join(root, 'plugins');
}

/**
 * Resolve the effective ordered list of clone URLs for a git source.
 * Prefers `urls` when set, falls back to `[url]` for legacy configs.
 */
export function resolveSourceUrls(source: MarketplaceSourceConfig): string[] {
  if (source.urls?.length) return source.urls;
  if (source.url) return [source.url];
  return [];
}

/**
 * Resolve the on-disk dir a configured marketplace currently lives in:
 * local sources point at their own directory; git sources at the clone
 * under `root`. Returns null when the config entry is incomplete.
 */
export function resolveConfiguredMarketplaceDir(
  root: string,
  name: string,
  source: MarketplaceSourceConfig,
): string | null {
  if (source.source === 'local') {
    return source.path ?? null;
  }
  if (resolveSourceUrls(source).length === 0) return null;
  return marketplaceCloneDir(root, name);
}

interface RunGitOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** spawn git with terminal prompts and askpass hard-disabled. */
function runGit(args: string[], opts: RunGitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out after ${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`git ${args[0]} failed (exit ${code}): ${tail}`));
      }
    });
  });
}

/**
 * Defense against path escapes: the destination must stay inside the
 * marketplaces cache root after canonicalization.
 */
function ensureInsideRoot(destination: string, root: string): void {
  ensureDir(root);
  const canonicalRoot = fs.realpathSync(root);
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
  const canonicalParent = fs.realpathSync(parent);
  if (!canonicalParent.startsWith(canonicalRoot + path.sep) && canonicalParent !== canonicalRoot) {
    throw new Error(`marketplace destination escapes cache root: ${destination}`);
  }
}

/**
 * Clone `url` (optionally at `ref`) into the marketplaces cache as a staging
 * directory, then rename it into place so a mid-clone failure never leaves a
 * half-written marketplace.
 */
async function tryCloneOne(opts: {
  url: string;
  stagingDir: string;
  destination: string;
  ref?: string;
}): Promise<void> {
  const args = ['clone', '--depth', '1'];
  if (opts.ref) {
    args.push('--branch', opts.ref);
  }
  args.push(opts.url, opts.stagingDir);
  await runGit(args);
  if (fs.existsSync(opts.destination)) {
    fs.rmSync(opts.stagingDir, { recursive: true, force: true });
    throw new Error(`marketplace directory already exists: ${opts.destination}`);
  }
  fs.renameSync(opts.stagingDir, opts.destination);
}

/**
 * Clone one of `urls` (ordered primary → mirror) into `root` as `name`. Tries
 * each URL in order; first success wins. After a success the working remote is
 * `origin`, so updateMarketplace does not care which mirror was used.
 */
export async function cloneMarketplace(opts: {
  root: string;
  urls: string[];
  name: string;
  ref?: string;
  log?: MarketplaceGitLog;
}): Promise<MarketplaceCloneResult> {
  const { root, name, ref, log } = opts;
  if (!opts.urls.length) {
    throw new Error('cloneMarketplace: at least one url is required');
  }
  ensureDir(root);
  const destination = marketplaceCloneDir(root, name);
  if (fs.existsSync(destination)) {
    throw new Error(`marketplace directory already exists: ${destination}`);
  }
  ensureInsideRoot(destination, root);
  const stagingRoot = marketplaceStagingRoot(root);
  ensureDir(stagingRoot);

  const errors: Array<{ url: string; error: string }> = [];
  for (const url of opts.urls) {
    const stagingDir = path.join(stagingRoot, `${safeMarketplaceDirName(name)}-${randomUUID()}`);
    try {
      await tryCloneOne({ url, stagingDir, destination, ref });
      const commit = await readHeadCommit(destination);
      log?.info('Marketplace cloned', {
        name,
        url,
        commit,
        triedFallback: opts.urls.length > 1 ? errors.length > 0 : false,
      });
      return { dir: destination, commit };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ url, error: message });
      log?.warn('Marketplace clone attempt failed', { name, url, error: message });
    }
  }

  throw new Error(
    `all ${opts.urls.length} marketplace mirror(s) failed for "${name}":\n` +
      errors.map((e) => `  - ${e.url}\n    ${e.error}`).join('\n'),
  );
}

/**
 * Fetch + hard-reset an existing clone to its origin ref (or FETCH_HEAD).
 * Throws on failure so callers can fall back to a fresh clone.
 */
export async function updateMarketplace(opts: {
  root: string;
  dir: string;
  ref?: string;
}): Promise<MarketplaceCloneResult> {
  ensureInsideRoot(opts.dir, opts.root);

  await runGit(['fetch', '--depth', '1', 'origin'], { cwd: opts.dir });
  const resetTarget = opts.ref ? `origin/${opts.ref}` : 'FETCH_HEAD';
  await runGit(['reset', '--hard', resetTarget], { cwd: opts.dir });

  const commit = await readHeadCommit(opts.dir);
  return { dir: opts.dir, commit };
}

export async function readHeadCommit(dir: string): Promise<string | null> {
  try {
    return await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    return null;
  }
}

/**
 * Clone a single plugin from its own git URL.
 *
 * A marketplace catalog may declare plugins that live in their own repository
 * rather than inside the marketplace clone, so the plugin content is
 * materialized on demand and cached under the marketplace's plugin subtree. An
 * existing cache entry is reused — refreshing the parent marketplace is what
 * re-clone decides.
 */
export async function clonePluginFromGit(opts: {
  /** Marketplace cache root that the plugin subtree hangs under. */
  root: string;
  /** Git URL of the plugin repository. */
  url: string;
  /** Marketplace name (for cache organization). */
  marketplace: string;
  /** Plugin name (for cache organization and staging uniqueness). */
  pluginName: string;
  /** Optional git ref (branch/tag/sha). */
  ref?: string;
  log?: MarketplaceGitLog;
}): Promise<MarketplaceCloneResult> {
  const { root, url, marketplace, pluginName, ref, log } = opts;
  ensureDir(root);

  const pluginCacheRoot = marketplacePluginGitCacheRoot(root);
  ensureDir(pluginCacheRoot);

  const marketplacePluginRoot = path.join(pluginCacheRoot, safeMarketplaceDirName(marketplace));
  ensureDir(marketplacePluginRoot);

  const destination = path.join(marketplacePluginRoot, safeMarketplaceDirName(pluginName));

  if (fs.existsSync(destination)) {
    log?.debug?.('Plugin git clone already cached, reusing', {
      marketplace,
      plugin: pluginName,
      dir: destination,
    });
    const commit = await readHeadCommit(destination);
    return { dir: destination, commit };
  }

  ensureInsideRoot(destination, root);
  const stagingRoot = marketplaceStagingRoot(root);
  ensureDir(stagingRoot);

  const stagingDir = path.join(stagingRoot, `plugin-${safeMarketplaceDirName(pluginName)}-${randomUUID()}`);

  const args = ['clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push(url, stagingDir);

  await runGit(args);
  fs.renameSync(stagingDir, destination);

  const commit = await readHeadCommit(destination);
  log?.info('Plugin cloned from git', { marketplace, plugin: pluginName, url, ref, commit });

  return { dir: destination, commit };
}

/** Remove a cached git plugin clone. Only ever touches the plugin cache subtree. */
export function removeCachedPluginClone(
  root: string,
  marketplace: string,
  pluginName: string,
): void {
  const dir = path.join(
    marketplacePluginGitCacheRoot(root),
    safeMarketplaceDirName(marketplace),
    safeMarketplaceDirName(pluginName),
  );
  if (!fs.existsSync(dir)) return;
  ensureInsideRoot(dir, root);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Remove a marketplace clone. Only ever touches the cache root subtree. */
export function removeMarketplaceClone(root: string, name: string): void {
  const dir = marketplaceCloneDir(root, name);
  if (!fs.existsSync(dir)) return;
  ensureInsideRoot(dir, root);
  fs.rmSync(dir, { recursive: true, force: true });
}
