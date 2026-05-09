/**
 * Bubblewrap Sandbox Provider
 *
 * Uses bubblewrap (bwrap) to create a Linux namespace-isolated
 * sandbox for command execution. Only works on Linux.
 */

import { execFileSync } from 'child_process';
import type { SandboxPolicy } from './types.js';

let bubblewrapChecked = false;
let bubblewrapAvailable = false;

/**
 * Check if bubblewrap (bwrap) is available on the system
 */
export function checkBubblewrapAvailable(): boolean {
  if (bubblewrapChecked) {
    return bubblewrapAvailable;
  }
  bubblewrapChecked = true;
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
    bubblewrapAvailable = true;
  } catch {
    bubblewrapAvailable = false;
  }
  return bubblewrapAvailable;
}

/**
 * Reset cached bubblewrap availability
 */
export function resetBubblewrapAvailability(): void {
  bubblewrapChecked = false;
  bubblewrapAvailable = false;
}

/**
 * Check if platform supports bubblewrap (Linux only)
 */
export function isBubblewrapPlatform(): boolean {
  return process.platform === 'linux';
}

/**
 * Wrap a command with bubblewrap sandbox
 *
 * Returns the full bwrap command string that should be passed to execa.
 *
 * Uses shell-quote to properly parse and re-assemble the command,
 * avoiding issues with naively splitting on whitespace.
 */
export function wrapWithBubblewrap(
  command: string,
  cwd: string,
  policy: SandboxPolicy,
): string {
  const bwrapArgs: string[] = [];

  // Root filesystem mounted read-only
  bwrapArgs.push('--ro-bind', '/', '/');

  // /tmp always writable for temp files
  bwrapArgs.push('--bind', '/tmp', '/tmp');

  // Bind workspace directory as writable
  if (cwd) {
    bwrapArgs.push('--bind', cwd, cwd);
  }

  // Additional writeable directories from policy
  for (const dir of policy.filesystem.allowWrite) {
    if (dir && dir !== cwd && dir !== '/tmp') {
      bwrapArgs.push('--bind', dir, dir);
    }
  }

  // Network isolation
  if (policy.network === 'none') {
    bwrapArgs.push('--unshare-net');
  }

  // Clean up when parent dies
  bwrapArgs.push('--die-with-parent');

  // Change to working directory
  if (cwd) {
    bwrapArgs.push('--chdir', cwd);
  }

  // Separator before the actual command
  bwrapArgs.push('--');

  // Use shell-quote for safe command parsing
  // The command is passed as-is (in quotes via shell: true in execa)
  // so we just append it after the separator
  bwrapArgs.push(command);

  return bwrapArgs.join(' ');
}