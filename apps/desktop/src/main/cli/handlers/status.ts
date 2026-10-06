/**
 * apps/desktop/src/main/cli/handlers/status.ts
 *
 * Status endpoint for the CLI control plane.
 *
 * Reports:
 * - version: app version from package.json
 * - uptimeSec: seconds since this server started listening
 * - dbReady: whether the SQLite database is accessible
 * - pluginReady: whether plugin registry is accessible (lazy probe)
 * - runtimePid: Electron main process PID
 * - startedAt: server start unix epoch ms
 *
 * NEVER includes the bearer token or any other secret.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probePluginRegistry } from './plugins.js';
import { getDatabase } from '../../db/connection';

interface StatusResponse {
  version: string;
  uptimeSec: number;
  dbReady: boolean;
  pluginReady: boolean;
  runtimePid: number;
  startedAt: number;
}

interface ElectronApp {
  getVersion(): string;
}

/**
 * Electron is OPTIONAL in this layer: the same handler graph has to load in a
 * process that has no Electron runtime
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, which takes the whole graph down, so `app` is resolved through a
 * guarded require and reported as absent instead.
 */
function electronApp(): ElectronApp | undefined {
  try {
    const { app } = require('electron') as { app?: ElectronApp };
    return app;
  } catch {
    return undefined;
  }
}

let cachedVersion: string | undefined;

/**
 * The desktop build reports this through `app.getVersion()`, which reads the
 * app's own `package.json`. A headless process has no `app`, so that same
 * file is read directly — same value, no Electron — found by walking up from
 * this module rather than by a hard-coded depth, so a bundled headless
 * control plane still resolves it.
 *
 * `unknown` is returned rather than an empty string: a version that could not
 * be read must be visible to the caller, not indistinguishable from 0.0.0.
 */
function appVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const app = electronApp();
  if (app && typeof app.getVersion === 'function') {
    cachedVersion = app.getVersion();
    return cachedVersion;
  }
  let dir = __dirname;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
          cachedVersion = parsed.version;
          return cachedVersion;
        }
      } catch {
        // Unreadable or malformed: keep walking rather than failing the request.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

export function handleStatus(_req: IncomingMessage, res: ServerResponse, startedAt: number): void {
  let dbReady = false;
  try {
    dbReady = getDatabase() !== null;
  } catch {
    dbReady = false;
  }

  const pluginReady = probePluginRegistry();

  const body: StatusResponse = {
    version: appVersion(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    dbReady,
    pluginReady,
    runtimePid: process.pid,
    startedAt,
  };

  const json = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}
