/**
 * packages/agent/src/cli/api/runtime-config.ts
 *
 * Read userData/runtime/cli-api.json produced by the Electron main process.
 * The CLI client uses this to discover the loopback port + bearer token.
 *
 * Path resolution rules (per Phase 0 decision):
 *   1. If DUYA_CLI_USER_DATA_DIR is set, use it verbatim. This is the only
 *      escape hatch for dev / test environments; we never guess -dev
 *      suffixes, never read NODE_ENV, and never infer the dev userData.
 *   2. Otherwise resolve by platform, matching Electron's app.getPath('userData'):
 *      - Windows: %APPDATA%/DUYA
 *      - macOS:   ~/Library/Application Support/DUYA
 *      - Linux:   $XDG_DATA_HOME/DUYA  ||  ~/.local/share/DUYA
 *
 * Process liveness check: we also accept a `pid` field; if present and the
 * process is no longer alive, we treat the file as stale and report
 * "not_running" rather than triggering a connection attempt.
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir, platform } from 'os';

export interface CliApiRuntime {
  port: number;
  token: string;
  pid?: number;
  startedAt?: number;
}

export type RuntimeLookupResult =
  | { kind: 'ok'; runtime: CliApiRuntime; runtimePath: string }
  | { kind: 'not_running'; reason: string; runtimePath: string }
  | { kind: 'malformed'; reason: string; runtimePath: string };

/**
 * Resolve the userData directory the CLI should use.
 *
 *   1. DUYA_CLI_USER_DATA_DIR (explicit override; for dev / test only)
 *   2. Platform default
 *
 * Returns an absolute path. Throws if the resolved directory does not
 * exist (e.g. the desktop app has never been launched on this machine).
 */
export function resolveUserDataDir(): string {
  const override = process.env.DUYA_CLI_USER_DATA_DIR;
  if (override && override.trim().length > 0) {
    const abs = isAbsolute(override) ? override : join(process.cwd(), override);
    if (!existsSync(abs)) {
      throw new CliUserDataMissingError(abs);
    }
    return abs;
  }

  const plat = platform();
  let userData: string;
  if (plat === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new CliUserDataMissingError('%APPDATA% is not set');
    }
    userData = join(appData, 'DUYA');
  } else if (plat === 'darwin') {
    userData = join(homedir(), 'Library', 'Application Support', 'DUYA');
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    userData = xdg ? join(xdg, 'DUYA') : join(homedir(), '.local', 'share', 'DUYA');
  }

  if (!existsSync(userData)) {
    throw new CliUserDataMissingError(userData);
  }
  return userData;
}

export class CliUserDataMissingError extends Error {
  constructor(public readonly path: string) {
    super(
      `DUYA user data directory not found at ${path}. ` +
        `Open the DUYA app at least once, or set DUYA_CLI_USER_DATA_DIR to an existing directory.`,
    );
    this.name = 'CliUserDataMissingError';
  }
}

export function getRuntimeFilePath(userDataDir: string): string {
  return join(userDataDir, 'runtime', 'cli-api.json');
}

/**
 * Collect candidate userData directories for runtime probing.
 *
 * Resolution order:
 *   1. If DUYA_CLI_USER_DATA_DIR is set, return only that single path
 *      (no dev fallback — the user explicitly chose a directory).
 *      The path is returned only if it exists on disk.
 *   2. Otherwise return [platform default, platform default + '/duya-dev'],
 *      filtered by existsSync. The dev subdirectory is the userData
 *      used by `setupDevMode()` in electron/core/bootstrap.ts during
 *      development, so probing it lets the CLI talk to a dev instance
 *      without any environment variable configuration.
 *
 * Never throws. Returns an empty array if neither directory exists
 * (the caller decides how to report that).
 */
function collectCandidateUserDataDirs(): string[] {
  const override = process.env.DUYA_CLI_USER_DATA_DIR;
  if (override && override.trim().length > 0) {
    const abs = isAbsolute(override) ? override : join(process.cwd(), override);
    return existsSync(abs) ? [abs] : [];
  }

  const plat = platform();
  let prod: string;
  if (plat === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) return [];
    prod = join(appData, 'DUYA');
  } else if (plat === 'darwin') {
    prod = join(homedir(), 'Library', 'Application Support', 'DUYA');
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    prod = xdg ? join(xdg, 'DUYA') : join(homedir(), '.local', 'share', 'DUYA');
  }

  const candidates = [prod, join(prod, 'duya-dev')];
  // Deduplicate (dev dir is a subdir, so no real dupes, but be safe) and
  // filter by existence. Order matters: prod is tried first so a running
  // packaged build always wins over a stale dev runtime.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of candidates) {
    const norm = dir.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (existsSync(dir)) result.push(dir);
  }
  return result;
}

/**
 * Check whether a process with the given pid is alive.
 *
 * - On POSIX: kill(pid, 0) returns 0 if alive, ESRCH if not.
 * - On Windows: openprocess-style probe via tasklist is expensive; we use
 *   `process.kill(pid, 0)` which also works for live PIDs and rejects dead
 *   ones with ESRCH. No-op if pid is undefined.
 */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // exists but no permission — still alive
    return false;
  }
}

export async function readCliApiRuntime(): Promise<RuntimeLookupResult> {
  const candidates = collectCandidateUserDataDirs();

  // Preserve the original "userData missing" contract: if neither the prod
  // directory nor the dev subdirectory exists, the desktop app has never
  // been launched on this machine. status/session/plugin commands catch
  // this to print a friendly "launch the app first" hint.
  if (candidates.length === 0) {
    // Reuse resolveUserDataDir() to throw with the canonical prod path in
    // the error message (it throws CliUserDataMissingError when the dir
    // does not exist).
    resolveUserDataDir();
    // Defensive: resolveUserDataDir() should have thrown. If it didn't
    // (e.g. race where the dir appeared between calls), fall through with
    // the prod path as the sole candidate.
    candidates.push(resolveUserDataDir());
  }

  // Probe each candidate in order (prod first, then dev fallback).
  // Track the first "not_running" result from prod so we can return it
  // (with the prod path) if the dev fallback also fails — this keeps the
  // error message pointing at the canonical path rather than a subdir.
  let staleResult: RuntimeLookupResult | null = null;

  for (const userDataDir of candidates) {
    const runtimePath = getRuntimeFilePath(userDataDir);

    let raw: string;
    try {
      raw = await fs.readFile(runtimePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (!staleResult) {
          staleResult = { kind: 'not_running', reason: 'runtime file not found', runtimePath };
        }
        continue;
      }
      if (!staleResult) {
        staleResult = {
          kind: 'not_running',
          reason: `cannot read runtime file: ${String(err)}`,
          runtimePath,
        };
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // malformed is a data-corruption signal, not "not running". Do not
      // silently fall through to the dev candidate — surface the error so
      // the user knows the runtime file is damaged.
      return { kind: 'malformed', reason: `runtime file is not valid JSON: ${String(err)}`, runtimePath };
    }

    if (!isObject(parsed)) {
      return { kind: 'malformed', reason: 'runtime file root is not an object', runtimePath };
    }
    const { port, token, pid, startedAt } = parsed;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      return { kind: 'malformed', reason: 'runtime file has invalid port', runtimePath };
    }
    if (typeof token !== 'string' || token.length === 0) {
      return { kind: 'malformed', reason: 'runtime file has invalid token', runtimePath };
    }
    if (pid !== undefined && typeof pid !== 'number') {
      return { kind: 'malformed', reason: 'runtime file pid must be a number', runtimePath };
    }

    if (!isPidAlive(pid)) {
      // Stale runtime file (app crashed / was killed). Remember it but try
      // the next candidate — a dev instance may still be alive.
      if (!staleResult) {
        staleResult = {
          kind: 'not_running',
          reason: `runtime file pid ${String(pid)} is no longer alive`,
          runtimePath,
        };
      }
      continue;
    }

    return {
      kind: 'ok',
      runtime: {
        port,
        token,
        pid: typeof pid === 'number' ? pid : undefined,
        startedAt: typeof startedAt === 'number' ? startedAt : undefined,
      },
      runtimePath,
    };
  }

  // No live runtime found. Return the first stale/not_running result we
  // recorded (prefers the prod path's message). This branch is also
  // reached when candidates is empty, but that case is handled above by
  // resolveUserDataDir() throwing.
  return (
    staleResult ?? {
      kind: 'not_running',
      reason: 'runtime file not found',
      runtimePath: '',
    }
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
