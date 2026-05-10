/**
 * DUYA Browser Daemon - HTTP + WebSocket bridge between Agent Process and Chrome Extension
 *
 * Architecture:
 *   Agent Process → HTTP POST /command → Daemon → WebSocket → Extension
 *   Extension → WebSocket result → Daemon → HTTP response → Agent Process
 *
 * Security (defense-in-depth against browser-based CSRF):
 *   1. Origin check — reject HTTP/WS from non chrome-extension:// origins
 *   2. Custom header — require X-DUYA header (browsers can't send it
 *      without CORS preflight, which we deny)
 *   3. No CORS headers on command endpoints — only /ping is readable from the
 *      Browser Bridge extension origin so the extension can probe daemon reachability
 *   4. Body size limit — 1 MB max to prevent OOM
 *   5. WebSocket verifyClient — reject upgrade before connection is established
 *
 * Lifecycle:
 *   - Started by Electron Main Process on app ready
 *   - Persistent — stays alive until app quit
 *   - Listens on localhost:19825
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { getLogger, LogComponent } from './logger';

const DEFAULT_DAEMON_PORT = 19825;
const PORT = parseInt(process.env.DUYA_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT), 10);
const MAX_BODY = 1024 * 1024; // 1 MB

// ─── Types ───────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LogEntry {
  level: string;
  msg: string;
  ts: number;
}

// ─── State ───────────────────────────────────────────────────────────

let extensionWs: WebSocket | null = null;
let extensionVersion: string | null = null;
let extensionName: string | null = null;
let extensionId: string | null = null;
const pending = new Map<string, PendingRequest>();
const LOG_BUFFER_SIZE = 200;
const logBuffer: LogEntry[] = [];
let httpServer: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let isRunning = false;

// Blocked domains from extension
let blockedDomains: string[] = [];

// Expected extension name - must match manifest.json
const EXPECTED_EXTENSION_NAME = 'DUYA Browser Bridge';

// Known DUYA Browser Bridge extension IDs (development and production)
// These are the extension IDs that are allowed to connect
const ALLOWED_EXTENSION_IDS: string[] = [
  // Add your DUYA Browser Bridge extension ID here after first connection attempt
  // The ID is shown in the logs when an extension tries to connect
];

// ─── Logger ──────────────────────────────────────────────────────────

function pushLog(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

// ─── Blocked Domains ─────────────────────────────────────────────────

function getBlockedDomainsFromExtension(): string[] {
  return blockedDomains;
}

function setBlockedDomainsFromExtension(domains: string[]): void {
  blockedDomains = domains;
  log('info', `Updated blocked domains: ${domains.length} domains`);
}

function log(level: string, msg: string): void {
  const entry = { level, msg, ts: Date.now() };
  pushLog(entry);
  const logger = getLogger();
  switch (level) {
    case 'error':
      logger.error(msg, undefined, undefined, LogComponent.BrowserDaemon);
      break;
    case 'warn':
      logger.warn(msg, undefined, LogComponent.BrowserDaemon);
      break;
    case 'debug':
      logger.debug(msg, undefined, LogComponent.BrowserDaemon);
      break;
    default:
      logger.info(msg, undefined, LogComponent.BrowserDaemon);
  }
}

// ─── HTTP Helpers ────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function getCorsHeaders(pathname: string, origin?: string): Record<string, string> | undefined {
  if (pathname !== '/ping') return undefined;
  if (!origin || !origin.startsWith('chrome-extension://')) return undefined;
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
}

// ─── HTTP Request Handler ────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Security: Origin check
  const origin = req.headers['origin'] as string | undefined;
  if (origin && !origin.startsWith('chrome-extension://')) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: cross-origin request blocked' });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  // Health check — no X-DUYA header required
  if (req.method === 'GET' && pathname === '/ping') {
    jsonResponse(res, 200, {
      ok: true,
      extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
      extensionVersion,
    }, getCorsHeaders(pathname, origin));
    return;
  }

  // Require custom header on all other requests
  if (!req.headers['x-duya']) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: missing X-DUYA header' });
    return;
  }

  if (req.method === 'GET' && pathname === '/status') {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    jsonResponse(res, 200, {
      ok: true,
      pid: process.pid,
      uptime,
      extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
      extensionVersion,
      pending: pending.size,
      memoryMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      port: PORT,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/logs') {
    const params = new URL(url, `http://localhost:${PORT}`).searchParams;
    const level = params.get('level');
    const filtered = level ? logBuffer.filter(e => e.level === level) : logBuffer;
    jsonResponse(res, 200, { ok: true, logs: filtered });
    return;
  }

  if (req.method === 'GET' && pathname === '/blocked-domains') {
    // Return blocked domains from extension (if connected)
    const domains = getBlockedDomainsFromExtension();
    jsonResponse(res, 200, { ok: true, domains });
    return;
  }

  if (req.method === 'DELETE' && pathname === '/logs') {
    logBuffer.length = 0;
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/shutdown') {
    jsonResponse(res, 200, { ok: true, message: 'Shutting down' });
    setTimeout(() => stopBrowserDaemon(), 100);
    return;
  }

  if (req.method === 'POST' && pathname === '/command') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.id) {
        jsonResponse(res, 400, { ok: false, error: 'Missing command id' });
        return;
      }

      if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
        jsonResponse(res, 503, {
          id: body.id,
          ok: false,
          error: 'Extension not connected. Please install the DUYA Browser Bridge extension.',
        });
        return;
      }

      const timeoutMs = 120000; // 120s default timeout
      if (pending.has(body.id)) {
        jsonResponse(res, 409, {
          id: body.id,
          ok: false,
          error: 'Duplicate command id already pending; retry',
        });
        return;
      }

      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(body.id);
          reject(new Error(`Command timeout (${timeoutMs / 1000}s)`));
        }, timeoutMs);
        pending.set(body.id, { resolve, reject, timer });
        extensionWs!.send(JSON.stringify(body));
      });

      jsonResponse(res, 200, result);
    } catch (err) {
      jsonResponse(res, err instanceof Error && err.message.includes('timeout') ? 408 : 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid request',
      });
    }
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

// ─── WebSocket for Extension ─────────────────────────────────────────

function setupWebSocket(server: ReturnType<typeof createServer>): void {
  wss = new WebSocketServer({
    server,
    path: '/ext',
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const origin = req.headers['origin'] as string | undefined;
      return !origin || origin.startsWith('chrome-extension://');
    },
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const origin = req.headers['origin'] as string | undefined;
    const extId = origin?.replace('chrome-extension://', '') ?? 'unknown';
    
    // Check if this extension ID is in the allowed list (if list is not empty)
    if (ALLOWED_EXTENSION_IDS.length > 0 && !ALLOWED_EXTENSION_IDS.includes(extId)) {
      log('warn', `Rejected connection from unknown extension ID: ${extId}`);
      ws.close(1008, 'Extension ID not allowed');
      return;
    }
    
    log('info', `Extension connection attempt from ${extId}`);

    // Don't accept connection immediately - wait for hello message with name
    let verified = false;

    // Heartbeat: ping every 15s, close if 2 pongs missed
    let missedPongs = 0;
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(heartbeatInterval);
        return;
      }
      if (missedPongs >= 2) {
        log('warn', 'Extension heartbeat lost, closing connection');
        clearInterval(heartbeatInterval);
        ws.terminate();
        return;
      }
      missedPongs++;
      ws.ping();
    }, 15000);

    ws.on('pong', () => {
      missedPongs = 0;
    });

    ws.on('message', (data: RawData) => {
      try {
        const rawMsg = data.toString();
        const msg = JSON.parse(rawMsg) as { id?: string; type?: string; version?: string; name?: string; level?: string; msg?: string; ts?: number; ok?: boolean; error?: string };

        // Handle hello message from extension
        if (msg.type === 'hello') {
          const receivedName = typeof msg.name === 'string' ? msg.name : null;
          extensionVersion = typeof msg.version === 'string' ? msg.version : null;

          log('info', `Received hello from extension: name="${receivedName}", version="${extensionVersion}", raw=${rawMsg.slice(0, 200)}`);

          // Verify extension name - must match exactly
          if (receivedName !== EXPECTED_EXTENSION_NAME) {
            log('warn', `Rejected connection from unknown extension: "${receivedName}" (expected: "${EXPECTED_EXTENSION_NAME}")`);
            ws.close(1008, 'Invalid extension name');
            return;
          }

          verified = true;
          extensionName = receivedName;
          extensionId = extId;
          extensionWs = ws;
          log('info', `Extension verified: ${extensionName} v${extensionVersion} (${extId})`);
          
          // Auto-add this extension ID to allowed list if not already present
          if (!ALLOWED_EXTENSION_IDS.includes(extId)) {
            ALLOWED_EXTENSION_IDS.push(extId);
            log('info', `Added extension ID to allowed list: ${extId}`);
          }
          return;
        }

        // Reject messages from unverified extensions
        if (!verified) {
          log('warn', 'Rejecting message from unverified extension');
          return;
        }

        // Handle log messages from extension
        if (msg.type === 'log') {
          const level = msg.level ?? 'info';
          const message = msg.msg ?? '';
          log(level, `[ext] ${message}`);
          return;
        }

        // Handle blocked domains update from extension
        if (msg.type === 'blocked_domains') {
          const domains = Array.isArray(msg.domains) ? msg.domains : [];
          setBlockedDomainsFromExtension(domains);
          return;
        }

        // Handle command results
        const p = pending.get(msg.id ?? '');
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id ?? '');
          p.resolve(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeatInterval);
      if (extensionWs === ws) {
        log('info', `Extension disconnected: ${extensionName} (${extensionId})`);
        extensionWs = null;
        extensionVersion = null;
        extensionName = null;
        extensionId = null;
        // Reject all pending requests
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Extension disconnected'));
        }
        pending.clear();
      }
    });

    ws.on('error', (err) => {
      log('error', `Extension WebSocket error: ${err.message}`);
      clearInterval(heartbeatInterval);
      if (extensionWs === ws) {
        extensionWs = null;
        extensionVersion = null;
        extensionName = null;
        extensionId = null;
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Extension disconnected'));
        }
        pending.clear();
      }
    });

    // Timeout: close connection if not verified within 5 seconds
    setTimeout(() => {
      if (!verified && ws.readyState === WebSocket.OPEN) {
        log('warn', 'Extension verification timeout - closing connection');
        ws.close(1008, 'Verification timeout');
      }
    }, 5000);
  });
}

// ─── Public API ──────────────────────────────────────────────────────

export function startBrowserDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isRunning) {
      resolve();
      return;
    }

    httpServer = createServer((req, res) => {
      handleRequest(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });

    setupWebSocket(httpServer);

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port is occupied by a previous instance that didn't shut down cleanly.
        // Try to connect to it and shut it down via HTTP, then retry.
        log('warn', `Port ${PORT} already in use — attempting to stop previous daemon`);
        const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/shutdown', method: 'POST', headers: { 'X-DUYA': '1' } }, (res) => {
          if (res.statusCode === 200) {
            log('info', 'Previous daemon stopped, retrying startup in 500ms');
            setTimeout(() => {
              startBrowserDaemon().then(resolve).catch(reject);
            }, 500);
          } else {
            log('error', `Previous daemon returned ${res.statusCode}, cannot reclaim port`);
            reject(new Error(`Port ${PORT} is in use and cannot be reclaimed. Please close other applications using this port or restart your computer.`));
          }
        });
        req.on('error', () => {
          log('error', `Port ${PORT} is in use but no responsive daemon found`);
          reject(new Error(`Port ${PORT} is in use by a non-responsive process. Please close other applications using this port or restart your computer.`));
        });
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error(`Port ${PORT} shutdown request timed out. Please close other applications using this port or restart your computer.`));
        });
        req.end();
        return;
      }
      log('error', `Server error: ${err.message}`);
      reject(err);
    });

    httpServer.listen(PORT, '127.0.0.1', () => {
      isRunning = true;
      log('info', `Browser Daemon listening on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

export function stopBrowserDaemon(): Promise<void> {
  return new Promise((resolve) => {
    if (!isRunning) {
      resolve();
      return;
    }

    // Reject all pending requests
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Daemon shutting down'));
    }
    pending.clear();

    // Close WebSocket server and all connections
    if (wss) {
      wss.clients.forEach((client) => {
        client.terminate();
      });
      wss.close();
      wss = null;
    }

    // Close extension WebSocket connection
    if (extensionWs) {
      extensionWs.terminate();
      extensionWs = null;
    }

    if (httpServer) {
      // Force close all active connections
      httpServer.closeAllConnections?.();
      
      httpServer.close(() => {
        isRunning = false;
        httpServer = null;
        log('info', 'Browser Daemon stopped');
        resolve();
      });
      
      // Safety timeout: force resolve after 2 seconds
      setTimeout(() => {
        if (isRunning) {
          isRunning = false;
          httpServer = null;
          log('warn', 'Browser Daemon stop timed out, forcing cleanup');
          resolve();
        }
      }, 2000);
    } else {
      isRunning = false;
      resolve();
    }
  });
}

export function isBrowserDaemonRunning(): boolean {
  return isRunning;
}

export function isExtensionConnected(): boolean {
  return extensionWs?.readyState === WebSocket.OPEN;
}

export interface BrowserExtensionStatus {
  daemonRunning: boolean;
  extensionConnected: boolean;
  extensionVersion: string | null;
  extensionName: string | null;
  extensionId: string | null;
  pendingCommands: number;
  port: number;
}

export function getBrowserExtensionStatus(): BrowserExtensionStatus {
  return {
    daemonRunning: isRunning,
    extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
    extensionVersion,
    extensionName,
    extensionId,
    pendingCommands: pending.size,
    port: PORT,
  };
}
