/**
 * packages/cli/src/api/runtime-config.ts
 *
 * Read runtime/cli-api.json produced by Desktop Main or a local Host process.
 * The CLI client uses this to discover the loopback port + bearer token.
 *
 * Path resolution rules:
 *   1. If DUYA_CLI_USER_DATA_DIR is set, use it verbatim.
 *   2. Otherwise read the shared Data root (`~/.duya` by default).
 *   3. Outside tests, fall back to legacy Electron userData directories:
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
import { resolveDataRoot } from '@duya/data/data-paths';

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
 * Resolve the canonical data directory the CLI should use.
 *
 *   1. DUYA_CLI_USER_DATA_DIR (explicit override; for dev / test only)
 *   2. DUYA_DATA_ROOT or `~/.duya`
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

  const userData = resolveDataRoot();
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
 *   2. Otherwise return the canonical Data root first, followed by the old
 *      platform userData and its `duya-dev` subdirectory. Test runs only probe
 *      the canonical root so they cannot attach to a production Desktop process.
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

  const candidates = [resolveDataRoot()];
  if (process.env.DUYA_TEST !== '1') {
    const legacyUserData = resolveLegacyUserDataDir();
    if (legacyUserData) candidates.push(legacyUserData, join(legacyUserData, 'duya-dev'));
  }

  // Preserve candidate order: the shared Data root wins over a legacy runtime.
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

function resolveLegacyUserDataDir(): string | null {
  const plat = platform();
  if (plat === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? join(appData, 'DUYA') : null;
  }
  if (plat === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DUYA');
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, 'DUYA') : join(homedir(), '.local', 'share', 'DUYA');
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

  // If neither the shared data root nor a legacy directory exists, surface a
  // friendly message pointing at the canonical root.
  if (candidates.length === 0) {
    // Reuse resolveUserDataDir() to throw with the canonical data path in
    // the error message (it throws CliUserDataMissingError when the dir
    // does not exist).
    resolveUserDataDir();
    // Defensive: resolveUserDataDir() should have thrown. If it didn't
    // (e.g. race where the dir appeared between calls), fall through with
    // the prod path as the sole candidate.
    candidates.push(resolveUserDataDir());
  }

  // Probe each candidate in order, preferring the shared root over legacy
  // Desktop paths. Keep the first failure for a useful canonical-path error.
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
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
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
