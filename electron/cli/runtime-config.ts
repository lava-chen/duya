/**
 * electron/cli/runtime-config.ts
 *
 * Atomic write of userData/runtime/cli-api.json containing the ephemeral
 * CLI API server connection info. Written only after the HTTP server
 * successfully listens; removed on graceful shutdown.
 *
 * Security policy:
 * - Atomic write via temp file + rename
 * - File mode 0o600 on POSIX systems
 * - Token is NEVER logged or echoed back to the user
 * - Field order: { port, token, pid, startedAt } — pid enables cross-validation
 *   in future phases, but the Phase 0 CLI client ignores it
 */

import { app } from 'electron';
import { promises as fs, readdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../logging/logger';

export interface CliApiRuntime {
  /** Actual port the server is listening on (assigned by OS via listen(0)) */
  port: number;
  /** 64-char hex bearer token */
  token: string;
  /** Process ID of the Electron main process that owns this server */
  pid: number;
  /** Unix epoch ms when the server started listening */
  startedAt: number;
}

function runtimeDir(): string {
  return join(app.getPath('userData'), 'runtime');
}

function runtimeFilePath(): string {
  return join(runtimeDir(), 'cli-api.json');
}

/**
 * Best-effort cleanup of stale temp files left by previous crashed runs.
 * Called on startup so a previous crash doesn't poison the runtime dir.
 */
function cleanupStaleTempFiles(): void {
  const dir = runtimeDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet — fine
  }
  for (const name of entries) {
    if (name.startsWith('cli-api.json.tmp.')) {
      try {
        require('fs').unlinkSync(join(dir, name));
      } catch {
        // best-effort
      }
    }
  }
}

export async function writeCliApiRuntime(info: CliApiRuntime): Promise<void> {
  cleanupStaleTempFiles();
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true });

  const finalPath = runtimeFilePath();
  const tmpPath = `${finalPath}.tmp.${process.pid}`;

  const payload = JSON.stringify(info, null, 2);
  await fs.writeFile(tmpPath, payload, { mode: 0o600, encoding: 'utf8' });

  if (process.platform !== 'win32') {
    try {
      await fs.chmod(tmpPath, 0o600);
    } catch {
      // best-effort
    }
  }

  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // Clean up the temp file before re-throwing, so we don't leave a 0-byte
    // orphan behind. Use sync unlink because the async context is already
    // failing and we want to be sure the file is gone.
    try {
      require('fs').unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    getLogger().error(
      'Failed to atomically rename CLI API runtime file',
      err instanceof Error ? err : new Error(String(err)),
      { tmpPath, finalPath },
      'Main',
    );
    throw err;
  }
}

export async function removeCliApiRuntime(): Promise<void> {
  const path = runtimeFilePath();
  try {
    await fs.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  // Also clean up any orphaned temp files from a crash.
  cleanupStaleTempFiles();
}

export function getRuntimeFilePath(): string {
  return runtimeFilePath();
}
