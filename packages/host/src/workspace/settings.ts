/**
 * `[desktop]` settings that govern managed checkouts.
 *
 * The same `config.toml` keys as codex (`git-worktree-root`,
 * `worktree-auto-cleanup-enabled`, `worktree-keep-count`), read from the
 * checkout data root. That root — not Desktop's `~/.duya` assumption — is the
 * one this layer already uses to place checkouts, and it is what Host tests
 * redirect with `DUYA_APP_DATA_PATH`; reading anywhere else would make those
 * tests observe the developer's real configuration.
 *
 * Invalid values degrade to the defaults instead of failing checkout
 * creation: a typo in a hand-edited config must not stop every session from
 * working. The problems are returned so a caller can warn; the Desktop
 * settings page validates before it writes, so the user normally never sees
 * this fallback.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from '@iarna/toml';
import { resolveCheckoutDataRoot } from './data-root.js';

export const DEFAULT_WORKTREE_KEEP_COUNT = 15;
export const MAX_WORKTREE_KEEP_COUNT = 1000;

export interface WorktreeSettings {
  /** Absolute custom root; null means the historical data-root layout. */
  readonly root: string | null;
  readonly autoCleanupEnabled: boolean;
  readonly keepCount: number;
  /** Values that were present but rejected, in human-readable form. */
  readonly problems: readonly string[];
}

const DEFAULTS: WorktreeSettings = {
  root: null,
  autoCleanupEnabled: false,
  keepCount: DEFAULT_WORKTREE_KEEP_COUNT,
  problems: [],
};

export interface ReadWorktreeSettingsOptions {
  /** Override for tests; defaults to `<checkout data root>/config.toml`. */
  readonly configPath?: string;
}

export function readWorktreeSettings(options: ReadWorktreeSettingsOptions = {}): WorktreeSettings {
  const configPath = options.configPath ?? path.join(resolveCheckoutDataRoot(), 'config.toml');
  let document: unknown;
  try {
    document = parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return DEFAULTS;
    return { ...DEFAULTS, problems: [`${configPath} could not be read or parsed`] };
  }
  if (!isRecord(document)) return { ...DEFAULTS, problems: [`${configPath} is not a TOML table`] };

  const desktop = document.desktop;
  if (desktop === undefined || desktop === null) return DEFAULTS;
  if (!isRecord(desktop)) return { ...DEFAULTS, problems: ['config.toml `desktop` is not a table'] };

  const problems: string[] = [];

  const rawRoot = desktop['git-worktree-root'];
  let root: string | null = null;
  if (typeof rawRoot === 'string') {
    const candidate = rawRoot.trim();
    if (candidate !== '') {
      if (path.isAbsolute(candidate)) root = path.resolve(candidate);
      else problems.push('desktop.git-worktree-root must be an absolute path');
    }
  } else if (rawRoot !== undefined && rawRoot !== null) {
    problems.push('desktop.git-worktree-root must be a string');
  }

  const rawEnabled = desktop['worktree-auto-cleanup-enabled'];
  let autoCleanupEnabled = DEFAULTS.autoCleanupEnabled;
  if (typeof rawEnabled === 'boolean') autoCleanupEnabled = rawEnabled;
  else if (rawEnabled !== undefined && rawEnabled !== null) {
    problems.push('desktop.worktree-auto-cleanup-enabled must be a boolean');
  }

  const rawKeepCount = desktop['worktree-keep-count'];
  let keepCount = DEFAULTS.keepCount;
  if (typeof rawKeepCount === 'number') {
    if (Number.isInteger(rawKeepCount)
      && rawKeepCount >= 1
      && rawKeepCount <= MAX_WORKTREE_KEEP_COUNT) {
      keepCount = rawKeepCount;
    } else {
      problems.push(`desktop.worktree-keep-count must be an integer between 1 and ${MAX_WORKTREE_KEEP_COUNT}`);
    }
  } else if (rawKeepCount !== undefined && rawKeepCount !== null) {
    problems.push('desktop.worktree-keep-count must be an integer');
  }

  return { root, autoCleanupEnabled, keepCount, problems };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
