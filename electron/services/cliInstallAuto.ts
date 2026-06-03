/**
 * electron/services/cliInstallAuto.ts
 *
 * Auto-install hook for the `duya` shell wrapper. Called from
 * the main process at app startup (after userData is known).
 *
 * Behavior:
 *  - On first launch after install: writes the wrapper script
 *  - On subsequent launches: detects existing wrapper, optionally
 *    refreshes it if the bundle path is stale
 *  - Never blocks startup; logs and continues on failure
 *  - On Windows, updates user PATH via `setx` (no admin)
 *  - On POSIX, prints a hint about PATH if needed but does not
 *    modify dotfiles silently
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { installCli, type InstallResult } from './cliInstall.js';
import { getLogger, LogComponent } from '../logging/logger';

const STAMP_FILENAME = '.duya-cli-wrapper-stamp';

/**
 * Best-effort install invoked at app startup. Resolves the
 * bundled cli.cjs from the running app's resources and calls
 * the shared install helper. Errors are logged and swallowed.
 */
export async function installCliBestEffort(userDataDir: string): Promise<InstallResult | null> {
  const log = getLogger();
  try {
    const bundle = resolveBundledCli();
    if (!bundle) {
      log.warn('cliInstallAuto: bundled cli.cjs not found; skipping', undefined, LogComponent.Skills);
      return null;
    }
    // Skip if the user explicitly disabled auto-install
    if (process.env.DUYA_DISABLE_AUTO_INSTALL_CLI === '1') {
      return null;
    }

    // If wrapper already exists with the same bundle, skip
    const platform = process.platform;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    let binDir: string;
    if (platform === 'win32') {
      binDir = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'duya', 'bin');
    } else {
      binDir = path.join(home, '.local', 'bin');
    }
    const stamp = path.join(binDir, STAMP_FILENAME);
    if (existsSync(stamp)) {
      // Already installed in a previous run; refresh only if bundle
      // path has changed (e.g. after app upgrade).
      try {
        const prev = await import('node:fs/promises').then((m) => m.readFile(stamp, 'utf-8'));
        if (prev.trim() === bundle) {
          return null; // no-op
        }
      } catch {
        // ignore read error; proceed with full install
      }
    }

    const result = await installCli(bundle, userDataDir);
    if (result.ok) {
      // Record stamp so subsequent launches can short-circuit
      try {
        await import('node:fs/promises').then((m) =>
          m.mkdir(binDir, { recursive: true }).then(() => m.writeFile(stamp, bundle, 'utf-8')),
        );
      } catch {
        // ignore stamp write failure
      }
      log.info('duya CLI wrapper auto-installed', { wrapper: result.paths.wrapper, platform: result.platform }, LogComponent.Skills);
    } else {
      log.warn('duya CLI wrapper auto-install failed', { message: result.message }, LogComponent.Skills);
    }
    return result;
  } catch (err) {
    log.warn(
      'installCliBestEffort: unexpected error',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.Skills,
    );
    return null;
  }
}

function resolveBundledCli(): string | null {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const candidate = path.join(resourcesPath, 'agent-bundle', 'cli.cjs');
    if (existsSync(candidate)) return candidate;
  }
  // Dev fallback
  const cwd = process.cwd();
  const dev = path.join(cwd, 'packages', 'agent', 'bundle', 'cli.cjs');
  if (existsSync(dev)) return dev;
  return null;
}