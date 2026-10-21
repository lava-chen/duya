/**
 * Bundled ripgrep resolution.
 *
 * Packaged builds ship a prebuilt rg binary under resources/ripgrep/ (fetched
 * at build time by scripts/fetch-ripgrep.mjs and copied by electron-builder's
 * extraResources). The absolute path is published as DUYA_RIPGREP_PATH so
 * every agent child process inherits it through their process.env spreads —
 * the same pattern as DUYA_BETTER_SQLITE3_PATH for native assets outside npm.
 *
 * In dev the resources/ripgrep/ directory under the repo root is honored too,
 * so running `node scripts/fetch-ripgrep.mjs` once gives ripgrep-less dev
 * machines a real engine without touching PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export const RIPGREP_ENV_VAR = 'DUYA_RIPGREP_PATH';

/** Platform binary name inside the ripgrep directory. */
export function ripgrepBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

/**
 * Absolute path to the bundled rg binary, or undefined when absent.
 * Checks the packaged resources first, then the repo-root dev location.
 */
export function resolveBundledRipgrepPath(): string | undefined {
  const candidates: string[] = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ripgrep', ripgrepBinaryName()));
  }
  if (!app.isPackaged) {
    candidates.push(path.join(process.cwd(), 'resources', 'ripgrep', ripgrepBinaryName()));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Publish DUYA_RIPGREP_PATH into this process' environment so child spawns
 * inherit it. Idempotent; an existing value (explicit user override) wins.
 */
export function publishRipgrepEnv(): void {
  if (process.env[RIPGREP_ENV_VAR]) return;
  const resolved = resolveBundledRipgrepPath();
  if (resolved) {
    process.env[RIPGREP_ENV_VAR] = resolved;
  }
}
