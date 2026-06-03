/**
 * electron/cli/cli-api-server.ts
 *
 * Localhost HTTP server for the duya CLI control plane.
 *
 * - Binds 127.0.0.1 only, on an OS-assigned port via `server.listen(0)`.
 * - Bearer-token authenticated (see ./auth.ts). Token is generated at start.
 * - On successful listen, writes { port, token, pid, startedAt } to
 *   userData/runtime/cli-api.json atomically (see ./runtime-config.ts).
 * - On stop, closes the server and removes the runtime file.
 *
 * Endpoints (Phase 0):
 *   GET /v1/status
 *   GET /v1/plugins
 *   GET /v1/plugins/:name
 *
 * The server is a thin HTTP adapter — every handler delegates to existing
 * domain services (e.g. PluginManager). No business logic is implemented here.
 */

import * as http from 'http';
import { generateToken, checkBearer } from './auth';
import { writeCliApiRuntime, removeCliApiRuntime } from './runtime-config';
import { handleStatus } from './handlers/status.js';
import { handleListPlugins, handleGetPlugin } from './handlers/plugins.js';
import {
  handleListSessions,
  handleGetSession,
  parseQuery as parseSessionsQuery,
} from './handlers/sessions.js';
import { handleListSkills, handleGetSkill } from './handlers/skills.js';
import { handleListMCPs, handleGetMCP } from './handlers/mcps.js';
import { InvalidPaginationParam } from '../db/queries/sessions';
import { getLogger } from '../logging/logger';

const COMPONENT = 'CliApiServer' as const;

let server: http.Server | null = null;
let startedAt = 0;
let currentToken = '';

function sendJsonError(res: http.ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parsePath(url: string): { pathname: string; parts: string[] } {
  const pathname = url.split('?')[0] || '/';
  const parts = pathname.split('/').filter(Boolean);
  return { pathname, parts };
}

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Auth check first — every endpoint requires Bearer.
  if (!checkBearer(req.headers.authorization, currentToken)) {
    sendJsonError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
    return;
  }

  const { parts } = parsePath(req.url ?? '/');

  // /v1/status
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'status') {
    handleStatus(req, res, startedAt);
    return;
  }

  // /v1/plugins
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'plugins') {
    handleListPlugins(req, res);
    return;
  }

  // /v1/sessions
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'sessions') {
    try {
      handleListSessions(req, res, parseSessionsQuery(req.url));
    } catch (err) {
      if (err instanceof InvalidPaginationParam) {
        sendJsonError(res, 400, `invalid_${err.param}`, err.reason);
        return;
      }
      throw err;
    }
    return;
  }

  // /v1/sessions/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions') {
    handleGetSession(req, res, parts[2]);
    return;
  }

  // /v1/plugins/:name
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'plugins') {
    handleGetPlugin(req, res, parts[2]);
    return;
  }

  // /v1/skills
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'skills') {
    handleListSkills(req, res);
    return;
  }

  // /v1/skills/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'skills') {
    handleGetSkill(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // /v1/mcps
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'mcps') {
    handleListMCPs(req, res);
    return;
  }

  // /v1/mcps/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'mcps') {
    handleGetMCP(req, res, decodeURIComponent(parts[2]));
    return;
  }

  sendJsonError(res, 404, 'not_found', `No route for ${req.method} ${req.url}`);
}

export interface CliApiServerHandle {
  port: number;
  token: string;
  startedAt: number;
  stop: () => Promise<void>;
}

export async function startCliApiServer(): Promise<CliApiServerHandle> {
  if (server) {
    throw new Error('CLI API server already started');
  }

  const token = generateToken();
  currentToken = token;
  startedAt = Date.now();

  const logger = getLogger();

  server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      logger.error(
        'CLI API server route error',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        COMPONENT,
      );
      if (!res.headersSent) {
        sendJsonError(res, 500, 'internal_error', 'Unexpected server error');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', (err) => reject(err));
    server!.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('CLI API server failed to obtain a TCP address');
  }
  const port = address.port;

  // Write runtime file atomically AFTER listen succeeds.
  await writeCliApiRuntime({
    port,
    token,
    pid: process.pid,
    startedAt,
  });

  // server.headersTimeout default 60s — keep simple, no overrides for Phase 0.

  logger.info('CLI API server started', { port, pid: process.pid }, COMPONENT);

  return {
    port,
    token,
    startedAt,
    stop: async () => {
      await stopCliApiServer();
    },
  };
}

export async function stopCliApiServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  currentToken = '';

  await new Promise<void>((resolve) => {
    s.close(() => resolve());
    // close() releases the port asynchronously; if there are keep-alive
    // connections, force destroy after a short grace period.
    setTimeout(() => {
      s.closeAllConnections?.();
      resolve();
    }, 500);
  });

  await removeCliApiRuntime();
}
