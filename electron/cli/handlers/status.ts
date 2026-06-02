/**
 * electron/cli/handlers/status.ts
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
import { app } from 'electron';
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

export function handleStatus(_req: IncomingMessage, res: ServerResponse, startedAt: number): void {
  let dbReady = false;
  try {
    dbReady = getDatabase() !== null;
  } catch {
    dbReady = false;
  }

  const pluginReady = probePluginRegistry();

  const body: StatusResponse = {
    version: app.getVersion(),
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
