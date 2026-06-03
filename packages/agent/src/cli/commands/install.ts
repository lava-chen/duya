/**
 * packages/agent/src/cli/commands/install.ts
 *
 * `duya install-cli` / `duya uninstall-cli` — install or remove
 * the `duya` shell wrapper that invokes the bundled cli.cjs.
 *
 * The wrapper is created in the main process and lives at:
 *   - Windows: %LOCALAPPDATA%\duya\bin\duya.cmd (+ duya.ps1)
 *   - macOS:   $HOME/.local/bin/duya
 *   - Linux:   $HOME/.local/bin/duya
 *
 * On Windows, the user PATH is updated via `setx` (no admin).
 * On POSIX, the user is instructed to add ~/.local/bin to PATH
 * if it is not already there.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';

interface InstallResultDTO {
  ok: boolean;
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  paths: {
    binDir: string;
    wrapper: string;
    bundle: string;
    userDataDir: string;
  };
  message: string;
}

function renderText(r: InstallResultDTO, action: 'install' | 'uninstall'): string {
  const lines: string[] = [];
  if (r.ok) {
    lines.push(`${action === 'install' ? 'Installed' : 'Uninstalled'} duya CLI`);
  } else {
    lines.push(`Failed to ${action} duya CLI`);
  }
  lines.push(`  platform: ${r.platform}`);
  lines.push(`  wrapper:  ${r.paths.wrapper}`);
  if (r.paths.bundle) lines.push(`  bundle:   ${r.paths.bundle}`);
  lines.push(`  message:  ${r.message}`);
  return lines.join('\n');
}

async function runInstall(format: OutputFormat): Promise<number> {
  const client = await CliApiClient.connect();
  try {
    const r = await client.post<InstallResultDTO>('/v1/install-cli', {}, {});
    if (format === 'json') {
      process.stdout.write(renderJson(r) + '\n');
    } else {
      process.stdout.write(renderText(r, 'install') + '\n');
    }
    return r.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

async function runUninstall(format: OutputFormat): Promise<number> {
  const client = await CliApiClient.connect();
  try {
    const r = await client.post<InstallResultDTO>('/v1/uninstall-cli', {}, {});
    if (format === 'json') {
      process.stdout.write(renderJson(r) + '\n');
    } else {
      process.stdout.write(renderText(r, 'uninstall') + '\n');
    }
    return r.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

export async function runInstallCliCommand(format: OutputFormat): Promise<number> {
  return runInstall(format);
}

export async function runUninstallCliCommand(format: OutputFormat): Promise<number> {
  return runUninstall(format);
}