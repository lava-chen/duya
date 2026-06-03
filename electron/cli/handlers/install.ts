/**
 * electron/cli/handlers/install.ts
 *
 * CLI API handlers for `duya install-cli` / `duya uninstall-cli`.
 *
 * The handlers invoke the install/uninstall services in the main
 * process and return the result. The wrapper script invokes the
 * bundled `cli.cjs` (already in `resources/agent-bundle/`).
 */

import * as http from 'http';
import * as path from 'node:path';
import {
  installCli,
  uninstallCli,
  type InstallResult,
} from '../../services/cliInstall.js';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Resolve the path of the bundled `cli.cjs` shipped with the
 * running app. In dev (no extraResources), this falls back to
 * the repo's build output so the install still works.
 */
function resolveBundledCli(): string {
  // Production: process.resourcesPath/agent-bundle/cli.cjs
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const candidate = path.join(resourcesPath, 'agent-bundle', 'cli.cjs');
    if (require('node:fs').existsSync(candidate)) return candidate;
  }
  // Dev: <repo>/packages/agent/bundle/cli.cjs
  const cwd = process.cwd();
  const dev = path.join(cwd, 'packages', 'agent', 'bundle', 'cli.cjs');
  if (require('node:fs').existsSync(dev)) return dev;

  // Fallback: best-effort guess from the running app dir.
  return path.join(cwd, 'packages', 'agent', 'bundle', 'cli.cjs');
}

function getUserDataDir(): string {
  // Production: app.getPath('userData')
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {
    // not in electron context
  }
  return process.env.DUYA_CLI_USER_DATA_DIR ?? '';
}

export async function handleInstallCli(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const bundle = resolveBundledCli();
    const userDataDir = getUserDataDir();
    const result: InstallResult = await installCli(bundle, userDataDir);
    sendJson(res, result.ok ? 200 : 500, result);
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleUninstallCli(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const result: InstallResult = await uninstallCli();
    sendJson(res, result.ok ? 200 : 500, result);
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}