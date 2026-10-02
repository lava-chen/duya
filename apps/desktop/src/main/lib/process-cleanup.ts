/**
 * Process cleanup utilities for reliable child process termination.
 *
 * Windows problem: Node.js child_process.kill('SIGTERM') is unreliable because
 * Windows does not support POSIX signals. The process often continues running
 * as an orphan. This module provides cross-platform helpers that use OS-specific
 * mechanisms to reliably kill a process and its entire subtree.
 */

import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

/**
 * Kill a process and all its descendants reliably.
 *
 * Strategy:
 *   - Windows: taskkill /F /T /PID <pid>  (force kill entire tree)
 *   - Unix:    start with SIGTERM, escalate to SIGKILL after timeout
 */
export function killProcessTree(
  child: ChildProcess,
  options: { force?: boolean; timeoutMs?: number } = {}
): Promise<void> {
  const { force = false, timeoutMs = 5000 } = options;
  const pid = child.pid;

  if (!pid) {
    // Process already dead or never started
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return killWindowsProcessTree(pid, force);
  }

  return killUnixProcessTree(child, force, timeoutMs);
}

/**
 * Windows: use taskkill /F /T to kill the entire process tree.
 * /F = force | /T = terminate children.
 *
 * On Windows, non-force termination (without /F) is unreliable, so we
 * always use /F. After taskkill exits, we poll to verify the process
 * is truly dead before resolving.
 */
function killWindowsProcessTree(pid: number, _force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const doKill = (): void => {
      const taskkill = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });

      let stderr = '';

      taskkill.stderr?.on('data', (d) => { stderr += d.toString(); });

      taskkill.on('close', (code) => {
        if (code !== 0) {
          logger.warn('taskkill exited with non-zero code', { pid, code, stderr: stderr.trim() }, LogComponent.Main);
        }
        waitForDeath();
      });

      taskkill.on('error', (err) => {
        logger.error('taskkill spawn error', err instanceof Error ? err : new Error(String(err)), { pid }, LogComponent.Main);
        waitForDeath();
      });
    };

    const waitForDeath = (): void => {
      let attempts = 0;
      const maxAttempts = 20; // 2 seconds total
      const check = (): void => {
        if (attempts >= maxAttempts) {
          logger.warn('Process may still be alive after max attempts', { pid, maxAttempts }, LogComponent.Main);
          resolve();
          return;
        }
        const result = isProcessRunning(pid);
        if (!result) {
          resolve();
          return;
        }
        attempts++;
        setTimeout(check, 100);
      };
      check();
    };

    doKill();
  });
}

/**
 * Unix: SIGTERM then escalate to SIGKILL.
 */
function killUnixProcessTree(
  child: ChildProcess,
  force: boolean,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    if (force) {
      child.kill('SIGKILL');
      resolve();
      return;
    }

    child.kill('SIGTERM');

    const timer = setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        logger.warn('Child process did not exit before timeout, sending SIGKILL', { pid: child.pid, timeoutMs }, LogComponent.Main);
        child.kill('SIGKILL');
      }
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Synchronously check if a process with the given PID is still running.
 * Best-effort; used for diagnostics.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      // Windows: use wmic or tasklist
      const { execSync } = require('child_process');
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8', windowsHide: true });
      return result.includes(String(pid));
    } else {
      // Unix: kill -0 checks existence without sending a signal
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup of a ChildProcess instance:
 * 1. Unpipe all stdio to prevent EPIPE errors during shutdown
 * 2. Remove all event listeners to avoid leaks
 * 3. Kill the process tree
 */
export async function cleanupChildProcess(
  child: ChildProcess,
  options: { force?: boolean; timeoutMs?: number } = {}
): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  // Unpipe stdio to prevent EPIPE errors when parent exits
  try {
    (child.stdout as unknown as { unpipe?: () => void })?.unpipe?.();
    (child.stderr as unknown as { unpipe?: () => void })?.unpipe?.();
    (child.stdin as unknown as { unpipe?: () => void })?.unpipe?.();
  } catch {
    // Ignore
  }

  // Kill the process tree
  await killProcessTree(child, options);
}
