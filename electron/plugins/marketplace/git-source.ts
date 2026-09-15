// git-source.ts — marketplace git clone/sync with codex-parity safety
// (Plan 455, doc 17.4): GIT_TERMINAL_PROMPT=0, staging dir + atomic rename,
// canonicalize().startsWith() containment checks, 120s timeout.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import { safeMarketplaceDirName } from '../../../packages/plugin-core/src/marketplace/source-parse';

const COMPONENT = 'PluginMarketplaceGit' as LogComponent;
const GIT_TIMEOUT_MS = 120_000;

export interface MarketplaceCloneResult {
  dir: string;
  /** HEAD commit after the operation (best effort, null if unreadable). */
  commit: string | null;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getMarketplacesCacheRoot(): string {
  return path.join(app.getPath('userData'), 'plugins', 'cache', 'marketplaces');
}

export function getMarketplaceStagingRoot(rootOverride?: string): string {
  return path.join(rootOverride ?? getMarketplacesCacheRoot(), '.staging');
}

/** Clone target for a marketplace name (not guaranteed to exist). */
export function getMarketplaceCloneDir(name: string, rootOverride?: string): string {
  return path.join(rootOverride ?? getMarketplacesCacheRoot(), safeMarketplaceDirName(name));
}

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
   * marketplace registry key (`name`) when unset. plan 529.
   */
  displayName?: string;
  path?: string;
  ref?: string;
}

/** Resolve the effective ordered list of clone URLs for a git source.
 *  Prefers `urls` when set, falls back to `[url]` for legacy configs. */
export function resolveSourceUrls(source: MarketplaceSourceConfig): string[] {
  if (source.urls?.length) return source.urls;
  if (source.url) return [source.url];
  return [];
}

/**
 * Resolve the on-disk dir a configured marketplace currently lives in:
 * local sources point at their own directory; git sources at the clone
 * under the cache root. Returns null when the config entry is incomplete.
 */
export function resolveConfiguredMarketplaceDir(
  name: string,
  source: MarketplaceSourceConfig,
): string | null {
  if (source.source === 'local') {
    return source.path ?? null;
  }
  if (resolveSourceUrls(source).length === 0) return null;
  return getMarketplaceCloneDir(name);
}

interface RunGitOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** spawn git with terminal prompts and askpass hard-disabled. */
function runGit(args: string[], opts: RunGitOptions = {}): Promise<string> {
  const logger = getLogger();
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
        logger.warn('git command failed', { args: args[0], code, tail }, COMPONENT);
        reject(new Error(`git ${args[0]} failed (exit ${code}): ${tail}`));
      }
    });
  });
}

/**
 * Defense against path escapes (codex 17.4.3): the destination must stay
 * inside the marketplaces cache root after canonicalization.
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
 * Clone `url` (optionally at `ref`) into the marketplaces cache as `name`,
 * staging first and renaming into place so a mid-clone failure never
 * leaves a half-written marketplace directory. After a successful clone,
 * the working URL is set as `origin` so updateMarketplace can
 * fetch/reset against it without caring which mirror was used.
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
 * Clone one of `urls` (ordered primary → mirror) into the marketplaces
 * cache as `name`. Tries each URL in order; first success wins. After a
 * success the working URL is renamed to `origin` so updateMarketplace
 * just works without caring which mirror was used.
 */
export async function cloneMarketplace(opts: {
  urls: string[];
  name: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  const logger = getLogger();
  if (!opts.urls.length) {
    throw new Error('cloneMarketplace: at least one url is required');
  }
  const root = opts.rootOverride ?? getMarketplacesCacheRoot();
  ensureDir(root);
  const destination = getMarketplaceCloneDir(opts.name, opts.rootOverride);
  if (fs.existsSync(destination)) {
    throw new Error(`marketplace directory already exists: ${destination}`);
  }
  ensureInsideRoot(destination, root);
  ensureDir(getMarketplaceStagingRoot(opts.rootOverride));

  const errors: Array<{ url: string; error: string }> = [];
  for (const url of opts.urls) {
    const stagingDir = path.join(
      getMarketplaceStagingRoot(opts.rootOverride),
      `${safeMarketplaceDirName(opts.name)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      await tryCloneOne({ url, stagingDir, destination, ref: opts.ref });
      const commit = await readHeadCommit(destination);
      logger.info('Marketplace cloned', {
        name: opts.name,
        url,
        commit,
        triedFallback: opts.urls.length > 1 ? errors.length > 0 : false,
      }, COMPONENT);
      return { dir: destination, commit };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ url, error: message });
      logger.warn('Marketplace clone attempt failed', {
        name: opts.name,
        url,
        error: message,
      }, COMPONENT);
    }
  }

  throw new Error(
    `all ${opts.urls.length} marketplace mirror(s) failed for "${opts.name}":\n` +
      errors.map((e) => `  - ${e.url}\n    ${e.error}`).join('\n'),
  );
}

/**
 * Fetch + hard-reset an existing clone to its origin ref (or FETCH_HEAD).
 * Throws on failure so callers can fall back to a fresh clone.
 */
export async function updateMarketplace(opts: {
  dir: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  const root = opts.rootOverride ?? getMarketplacesCacheRoot();
  ensureInsideRoot(opts.dir, root);

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
 * Get the cache root for individual plugin clones from marketplace git sources.
 * Path: `<cacheRoot>/plugins/<marketplace>/<pluginName>/`
 */
export function getPluginGitCacheRoot(rootOverride?: string): string {
  return path.join(rootOverride ?? getMarketplacesCacheRoot(), 'plugins');
}

/**
 * Clone a single plugin from a git URL (Plan 455 extension: git-source
 * plugins in marketplace catalogs). The plugin is cloned into a versioned
 * subdirectory under the marketplace's plugin cache root.
 *
 * Plan 531: marketplace catalogs can declare plugins with `source: 'git'`
 * pointing to their own repos. Rather than requiring the user to add the
 * plugin repo as a separate marketplace, we materialize the plugin clone
 * on-demand during catalog build. The clone is cached and refreshed
 * alongside its parent marketplace.
 */
export async function clonePluginFromGit(opts: {
  /** Git URL of the plugin repository. */
  url: string;
  /** Marketplace name (for cache organization). */
  marketplace: string;
  /** Plugin name (for cache organization and staging uniqueness). */
  pluginName: string;
  /** Optional git ref (branch/tag/sha). */
  ref?: string;
  /** Override the cache root (for testing). */
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  const logger = getLogger();
  const { url, marketplace, pluginName, ref, rootOverride } = opts;
  const root = rootOverride ?? getMarketplacesCacheRoot();
  ensureDir(root);

  const pluginCacheRoot = getPluginGitCacheRoot(rootOverride);
  ensureDir(pluginCacheRoot);

  const marketplacePluginRoot = path.join(pluginCacheRoot, safeMarketplaceDirName(marketplace));
  ensureDir(marketplacePluginRoot);

  const destination = path.join(marketplacePluginRoot, safeMarketplaceDirName(pluginName));

  if (fs.existsSync(destination)) {
    logger.debug('Plugin git clone already cached, reusing', {
      marketplace,
      plugin: pluginName,
      dir: destination,
    }, COMPONENT);
    const commit = await readHeadCommit(destination);
    return { dir: destination, commit };
  }

  ensureInsideRoot(destination, root);
  const stagingRoot = getMarketplaceStagingRoot(rootOverride);
  ensureDir(stagingRoot);

  const stagingDir = path.join(
    stagingRoot,
    `plugin-${safeMarketplaceDirName(pluginName)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const args = ['clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push(url, stagingDir);

  await runGit(args);
  fs.renameSync(stagingDir, destination);

  const commit = await readHeadCommit(destination);
  logger.info('Plugin cloned from git', {
    marketplace,
    plugin: pluginName,
    url,
    ref,
    commit,
  }, COMPONENT);

  return { dir: destination, commit };
}

/**
 * Remove a cached git plugin clone. Only ever touches the plugin cache subtree.
 */
export function removeCachedPluginClone(marketplace: string, pluginName: string, rootOverride?: string): void {
  const dir = path.join(
    getPluginGitCacheRoot(rootOverride),
    safeMarketplaceDirName(marketplace),
    safeMarketplaceDirName(pluginName),
  );
  const root = rootOverride ?? getMarketplacesCacheRoot();
  ensureInsideRoot(dir, root);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Remove a marketplace clone. Only ever touches the cache root subtree. */
export function removeMarketplaceClone(name: string, rootOverride?: string): void {
  const dir = getMarketplaceCloneDir(name, rootOverride);
  ensureInsideRoot(dir, rootOverride ?? getMarketplacesCacheRoot());
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
