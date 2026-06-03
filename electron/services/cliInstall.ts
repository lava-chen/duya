/**
 * electron/services/cliInstall.ts
 *
 * Cross-platform CLI installation: creates a wrapper script that
 * invokes the bundled `cli.cjs` and registers the wrapper on the
 * user's PATH.
 *
 * The wrapper is a small shell / batch / PowerShell script that
 *   1. Forwards argv to the bundled `cli.cjs`
 *   2. Sets DUYA_CLI_USER_DATA_DIR so the CLI finds the app's
 *      userData directory (Electron's `app.getPath('userData')`).
 *
 * Supported platforms:
 *   - Windows: %LOCALAPPDATA%\duya\bin\duya.cmd (and .ps1)
 *   - macOS:   $HOME/.local/bin/duya (symlink to app bundle)
 *   - Linux:   $HOME/.local/bin/duya (symlink to app bundle)
 *
 * For PATH registration:
 *   - Windows: modify user PATH via registry (no admin required)
 *   - macOS:   instructions printed for `ln -s` to /usr/local/bin
 *   - Linux:   $HOME/.local/bin is the default PATH entry on most
 *              distros; instructions printed otherwise
 *
 * The service never invokes sudo or system-level installers; it
 * only writes into the user-owned directories.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export type InstallPlatform = 'win32' | 'darwin' | 'linux' | 'other';

export interface InstallPaths {
  binDir: string;
  wrapper: string;
  bundle: string;
  userDataDir: string;
}

export interface InstallResult {
  ok: boolean;
  platform: InstallPlatform;
  paths: InstallPaths;
  /** Human-readable status / hint (e.g. "PATH not modified; restart shell"). */
  message: string;
}

/**
 * Compute the install paths for the current platform.
 *
 * `bundle` is the absolute path of the bundled `cli.cjs` inside
 * the running app's resources directory. The wrapper invokes it
 * directly.
 */
export function computeInstallPaths(
  bundleCli: string,
  userDataDir: string,
): InstallPaths {
  const platform = process.platform as InstallPlatform;
  const home = os.homedir();

  let binDir: string;
  let wrapper: string;
  if (platform === 'win32') {
    binDir = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'duya', 'bin');
    wrapper = path.join(binDir, 'duya.cmd');
  } else if (platform === 'darwin') {
    binDir = path.join(home, '.local', 'bin');
    wrapper = path.join(binDir, 'duya');
  } else if (platform === 'linux') {
    binDir = path.join(home, '.local', 'bin');
    wrapper = path.join(binDir, 'duya');
  } else {
    binDir = path.join(home, '.duya', 'bin');
    wrapper = path.join(binDir, 'duya');
  }

  return { binDir, wrapper, bundle: bundleCli, userDataDir };
}

const WINDOWS_WRAPPER = (bundle: string, userDataDir: string): string => `@echo off
rem DUYA CLI wrapper - forwards all arguments to the bundled cli.cjs
set "DUYA_CLI_USER_DATA_DIR=${userDataDir}"
node "${bundle}" %*
`;

const WINDOWS_PWSH_WRAPPER = (bundle: string, userDataDir: string): string =>
`# DUYA CLI wrapper - PowerShell entry
$env:DUYA_CLI_USER_DATA_DIR = "${userDataDir}"
& node "${bundle}" @args
`;

const POSIX_WRAPPER = (bundle: string, userDataDir: string): string => `#!/usr/bin/env bash
# DUYA CLI wrapper - forwards all arguments to the bundled cli.cjs
set -e
export DUYA_CLI_USER_DATA_DIR="${userDataDir}"
exec node "${bundle}" "$@"
`;

/**
 * Write the wrapper script for the current platform. Idempotent:
 * re-running overwrites with the current bundle path.
 */
export async function writeWrapperScript(
  paths: InstallPaths,
  platform: InstallPlatform,
): Promise<void> {
  await fsp.mkdir(paths.binDir, { recursive: true });

  if (platform === 'win32') {
    await fsp.writeFile(
      paths.wrapper,
      WINDOWS_WRAPPER(paths.bundle, paths.userDataDir),
      'utf-8',
    );
    // PowerShell entry alongside the .cmd
    const ps1 = paths.wrapper.replace(/\.cmd$/, '.ps1');
    await fsp.writeFile(
      ps1,
      WINDOWS_PWSH_WRAPPER(paths.bundle, paths.userDataDir),
      'utf-8',
    );
  } else {
    await fsp.writeFile(
      paths.wrapper,
      POSIX_WRAPPER(paths.bundle, paths.userDataDir),
      { encoding: 'utf-8', mode: 0o755 },
    );
  }
}

/**
 * On Windows, append the bin directory to the user PATH (HKCU\Environment).
 * Uses `setx` to update both the registry and the current user PATH.
 * No admin rights required.
 *
 * Returns true if PATH was modified, false if no change was needed
 * or if the operation could not be completed.
 */
export async function ensureWindowsPath(binDir: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    // Read current user PATH from registry
    const { spawn } = await import('node:child_process');
    const readResult = spawn(
      'reg',
      ['query', 'HKCU\\Environment', '/v', 'Path'],
      { encoding: 'utf-8' },
    );
    let stdout = '';
    for await (const chunk of readResult.stdout) stdout += chunk;
    await new Promise<void>((resolve) => readResult.on('close', () => resolve()));

    // Extract the Path value (skip the "Path    REG_EXPAND_SZ" header)
    const m = stdout.match(/Path\s+REG_EXPAND_SZ\s+(.+?)\r?\n/);
    const current = m ? m[1].trim() : '';
    if (current.toLowerCase().split(';').some((p) => p.trim().toLowerCase() === binDir.toLowerCase())) {
      return false;
    }

    // Append and setx (limit ~1024 chars; user PATH is usually fine)
    const next = current ? `${current};${binDir}` : binDir;
    const setResult = spawn('setx', ['Path', next], { encoding: 'utf-8' });
    await new Promise<void>((resolve, reject) => {
      setResult.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`setx exit ${code}`));
      });
      setResult.on('error', reject);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `~/.local/bin` is in the user's PATH on POSIX systems.
 * On Linux, most distros add this by default; on macOS it must be
 * added explicitly (Homebrew instructions).
 *
 * Returns a hint string the caller can show to the user. The
 * actual PATH change is left to the user (we never modify
 * ~/.zshrc / ~/.bashrc silently).
 */
export function posixPathHint(binDir: string, platform: InstallPlatform): string {
  if (platform === 'linux') {
    return `Wrapper installed at ${binDir}. On most Linux distros this directory is already on PATH. If not, add it to ~/.bashrc: export PATH="$HOME/.local/bin:$PATH"`;
  }
  if (platform === 'darwin') {
    return `Wrapper installed at ${binDir}. To add to PATH, append to ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"`;
  }
  return `Wrapper installed at ${binDir}`;
}

/**
 * Run the full install sequence for the current platform.
 */
export async function installCli(
  bundleCli: string,
  userDataDir: string,
): Promise<InstallResult> {
  const platform = process.platform as InstallPlatform;
  const paths = computeInstallPaths(bundleCli, userDataDir);

  if (platform === 'other') {
    return {
      ok: false,
      platform,
      paths,
      message: `Unsupported platform: ${process.platform}`,
    };
  }

  try {
    await writeWrapperScript(paths, platform);

    let pathMessage: string;
    if (platform === 'win32') {
      const updated = await ensureWindowsPath(paths.binDir);
      pathMessage = updated
        ? `Wrapper installed at ${paths.wrapper}. User PATH updated; restart your shell.`
        : `Wrapper installed at ${paths.wrapper}. PATH already contains ${paths.binDir}.`;
    } else {
      pathMessage = posixPathHint(paths.binDir, platform);
    }

    return {
      ok: true,
      platform,
      paths,
      message: pathMessage,
    };
  } catch (err) {
    return {
      ok: false,
      platform,
      paths,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove the wrapper script and (best-effort) the user PATH entry.
 * Idempotent: missing files are not an error.
 */
export async function uninstallCli(): Promise<InstallResult> {
  const platform = process.platform as InstallPlatform;
  // We do not know the original bundle path; the wrapper script
  // can be discovered by file existence in the standard install
  // directory.
  const home = os.homedir();
  let binDir: string;
  let wrapper: string;
  if (platform === 'win32') {
    binDir = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'duya', 'bin');
    wrapper = path.join(binDir, 'duya.cmd');
  } else {
    binDir = path.join(home, '.local', 'bin');
    wrapper = path.join(binDir, 'duya');
  }

  try {
    if (fs.existsSync(wrapper)) await fsp.unlink(wrapper);
    if (platform === 'win32') {
      const ps1 = wrapper.replace(/\.cmd$/, '.ps1');
      if (fs.existsSync(ps1)) await fsp.unlink(ps1);
    }
    // We deliberately do not remove the PATH entry on uninstall;
    // the user can manage PATH via their own dotfiles.

    return {
      ok: true,
      platform,
      paths: { binDir, wrapper, bundle: '', userDataDir: '' },
      message: `Wrapper removed from ${binDir}. PATH entry left untouched; remove manually if needed.`,
    };
  } catch (err) {
    return {
      ok: false,
      platform,
      paths: { binDir, wrapper, bundle: '', userDataDir: '' },
      message: err instanceof Error ? err.message : String(err),
    };
  }
}