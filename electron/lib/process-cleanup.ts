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
 * /F = force | /T = terminate children
 */
function killWindowsProcessTree(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = force ? ['/F', '/T', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
    const taskkill = spawn('taskkill', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    taskkill.stdout?.on('data', (d) => { stdout += d.toString(); });
    taskkill.stderr?.on('data', (d) => { stderr += d.toString(); });

    taskkill.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[ProcessCleanup] taskkill exited with code ${code}, stderr: ${stderr.trim()}`);
        // Even if taskkill reports an error, the process may already be gone.
        // Try force kill as fallback.
        if (!force) {
          const fallback = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
          fallback.on('close', () => resolve());
          fallback.on('error', () => resolve());
          return;
        }
      }
      resolve();
    });

    taskkill.on('error', (err) => {
      console.error(`[ProcessCleanup] taskkill spawn error:`, err.message);
      resolve();
    });

    // Safety timeout
    setTimeout(() => {
      console.warn(`[ProcessCleanup] taskkill timeout for pid ${pid}, giving up`);
      resolve();
    }, 10000);
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
        console.warn(`[ProcessCleanup] Process ${child.pid} did not exit after ${timeoutMs}ms, sending SIGKILL`);
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
    child.stdout?.unpipe?.();
    child.stderr?.unpipe?.();
    child.stdin?.unpipe?.();
  } catch {
    // Ignore
  }

  // Kill the process tree
  await killProcessTree(child, options);
}
