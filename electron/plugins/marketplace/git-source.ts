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
  url?: string;
  path?: string;
  ref?: string;
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
  if (!source.url) return null;
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
 * leaves a half-written marketplace directory.
 */
export async function cloneMarketplace(opts: {
  url: string;
  name: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult> {
  const logger = getLogger();
  const root = opts.rootOverride ?? getMarketplacesCacheRoot();
  ensureDir(root);
  const destination = getMarketplaceCloneDir(opts.name, opts.rootOverride);
  if (fs.existsSync(destination)) {
    throw new Error(`marketplace directory already exists: ${destination}`);
  }
  ensureInsideRoot(destination, root);

  const stagingDir = path.join(
    getMarketplaceStagingRoot(opts.rootOverride),
    `${safeMarketplaceDirName(opts.name)}-${Date.now()}`,
  );
  ensureDir(getMarketplaceStagingRoot(opts.rootOverride));

  try {
    const args = ['clone', '--depth', '1'];
    if (opts.ref) {
      args.push('--branch', opts.ref);
    }
    args.push(opts.url, stagingDir);
    await runGit(args);

    // Clone.shallow repos cannot always be fetched from later; keep the
    // origin so updateMarketplace can fetch/reset against it.
    if (fs.existsSync(destination)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`marketplace directory already exists: ${destination}`);
    }
    fs.renameSync(stagingDir, destination);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  const commit = await readHeadCommit(destination);
  logger.info('Marketplace cloned', { name: opts.name, url: opts.url, commit }, COMPONENT);
  return { dir: destination, commit };
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

/** Remove a marketplace clone. Only ever touches the cache root subtree. */
export function removeMarketplaceClone(name: string, rootOverride?: string): void {
  const dir = getMarketplaceCloneDir(name, rootOverride);
  ensureInsideRoot(dir, rootOverride ?? getMarketplacesCacheRoot());
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
