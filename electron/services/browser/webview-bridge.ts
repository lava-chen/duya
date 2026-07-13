/**
 * Webview Bridge - Daemon-side handler for webview-based CDP commands.
 *
 * Maintains sessionId -> webContentsId mapping (populated by renderer via IPC).
 * Executes CDP commands directly on the webview's webContents.debugger in the
 * main process — no renderer IPC round-trip needed.
 *
 * Data flow:
 *   Agent HTTP POST /webview-command -> handleWebviewCommand
 *   -> webContents.fromId(webContentsId).debugger.sendCommand(method, params)
 *   -> HTTP response
 *
 * When sessionId is not registered, sends 'browser:open-agent-tab' IPC to the
 * renderer so it can auto-open a panel tab, then returns 404 to let
 * WebviewCDPClient retry.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { webContents, type BrowserWindow } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';

const logger = getLogger();

/** sessionId -> webContentsId */
const webviewSessionMap = new Map<string, number>();
/** webContentsIds that currently have the debugger attached */
const attachedDebuggers = new Set<number>();
/** webContentsIds whose CDP Network events are observed by this bridge */
const networkListeners = new Set<number>();
const networkCaptures = new Map<string, { pattern: string; requests: unknown[] }>();
/** Briefly suppress late CDP retries after the user explicitly closes a tab. */
const userClosedSessions = new Map<string, number>();
const USER_CLOSE_COOLDOWN_MS = 15_000;

function isUserClosedSession(sessionId: string): boolean {
  const until = userClosedSessions.get(sessionId);
  if (!until) return false;
  if (until <= Date.now()) {
    userClosedSessions.delete(sessionId);
    return false;
  }
  return true;
}

export function registerWebviewSession(sessionId: string, webContentsId: number): void {
  if (isUserClosedSession(sessionId)) return;
  webviewSessionMap.set(sessionId, webContentsId);
  logger.info(
    `Webview registered: sessionId=${sessionId}, webContentsId=${webContentsId}`,
    undefined,
    undefined,
    LogComponent.BrowserDaemon,
  );
}

/** Stop a live agent browser because the user closed its sidebar tab. */
export function closeWebviewSessionByUser(sessionId: string): void {
  userClosedSessions.set(sessionId, Date.now() + USER_CLOSE_COOLDOWN_MS);
  unregisterWebviewSession(sessionId);
}

export function unregisterWebviewSession(sessionId: string): void {
  const webContentsId = webviewSessionMap.get(sessionId);
  webviewSessionMap.delete(sessionId);
  networkCaptures.delete(sessionId);

  // Detach debugger if we attached it
  if (webContentsId !== undefined && attachedDebuggers.has(webContentsId)) {
    try {
      const wc = webContents.fromId(webContentsId);
      if (wc && !wc.isDestroyed()) {
        wc.debugger.detach();
      }
    } catch {
      // Best-effort — webContents may already be gone
    }
    attachedDebuggers.delete(webContentsId);
    networkListeners.delete(webContentsId);
  }

  logger.info(
    `Webview unregistered: sessionId=${sessionId}`,
    undefined,
    undefined,
    LogComponent.BrowserDaemon,
  );
}

export function getWebviewIdForSession(sessionId: string): number | undefined {
  return webviewSessionMap.get(sessionId);
}

/**
 * Ensure the debugger is attached to the given webContents.
 * Returns true on success, or an error string on failure.
 * Detects DevTools conflicts → returns 'DEBUGGER_CONFLICT'.
 */
function ensureDebuggerAttached(webContentsId: number): true | string {
  const wc = webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    return `WebContents not found or destroyed: ${webContentsId}`;
  }

  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedDebuggers.add(webContentsId);
    }

    if (networkListeners.has(webContentsId)) return true;
    networkListeners.add(webContentsId);
    wc.debugger.on('message', (_event, method, params) => {
      if (method !== 'Network.requestWillBeSent' && method !== 'Network.responseReceived') return;
      for (const [sessionId, mappedWebContentsId] of webviewSessionMap) {
        if (mappedWebContentsId !== webContentsId) continue;
        const capture = networkCaptures.get(sessionId);
        const event = params as {
          requestId?: string;
          request?: { url?: string; method?: string; headers?: unknown };
          response?: { url?: string; status?: number; mimeType?: string };
          type?: string;
          timestamp?: number;
        };
        const requestUrl = event.request?.url ?? event.response?.url ?? '';
        if (!capture || (capture.pattern && !requestUrl.includes(capture.pattern))) continue;
        if (capture.requests.length >= 500) capture.requests.shift();
        capture.requests.push({
          url: requestUrl,
          method: event.request?.method ?? 'GET',
          phase: method === 'Network.responseReceived' ? 'response' : 'request',
          requestId: event.requestId,
          type: event.type,
          status: event.response?.status,
          mimeType: event.response?.mimeType,
          timestamp: event.timestamp,
        });
      }
    });

    // Clean up if the webContents is destroyed unexpectedly
    wc.once('destroyed', () => {
      attachedDebuggers.delete(webContentsId);
      networkListeners.delete(webContentsId);
      for (const [sessionId, mappedWebContentsId] of webviewSessionMap) {
        if (mappedWebContentsId === webContentsId) {
          webviewSessionMap.delete(sessionId);
          networkCaptures.delete(sessionId);
        }
      }
    });

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Electron throws when another debugger (DevTools) is already attached
    if (message.includes('Another debugger') || message.includes('already attached')) {
      return 'DEBUGGER_CONFLICT';
    }
    return message;
  }
}

export async function handleWebviewNetworkCommand(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (req.method !== 'POST' || !['/webview-network-start', '/webview-network-read'].includes(url.pathname)) {
    return false;
  }
  try {
    const body = JSON.parse(await readBody(req)) as { sessionId?: unknown; pattern?: unknown };
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      jsonResponse(res, 400, { ok: false, error: 'Missing webview session id' });
      return true;
    }
    const webContentsId = webviewSessionMap.get(body.sessionId);
    if (webContentsId === undefined) {
      jsonResponse(res, 404, { ok: false, error: 'WEBVIEW_SESSION_NOT_REGISTERED' });
      return true;
    }
    const attachResult = ensureDebuggerAttached(webContentsId);
    if (attachResult !== true) {
      jsonResponse(res, 200, { ok: false, error: attachResult });
      return true;
    }
    if (url.pathname === '/webview-network-start') {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) {
        jsonResponse(res, 404, { ok: false, error: 'WebContents not found' });
        return true;
      }
      networkCaptures.set(body.sessionId, {
        pattern: typeof body.pattern === 'string' ? body.pattern : '',
        requests: [],
      });
      // Register before enabling Network: enabling can immediately emit
      // cached/service-worker requests, which must not be lost.
      await wc.debugger.sendCommand('Network.enable');
      jsonResponse(res, 200, { ok: true });
      return true;
    }
    jsonResponse(res, 200, { ok: true, data: networkCaptures.get(body.sessionId)?.requests ?? [] });
    return true;
  } catch (err) {
    jsonResponse(res, 200, { ok: false, error: err instanceof Error ? err.message : 'Network command failed' });
    return true;
  }
}

export async function handleWebviewTabControl(
  req: IncomingMessage,
  res: ServerResponse,
  mainWindow: BrowserWindow | null,
): Promise<boolean> {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (req.method !== 'POST' || !['/webview-close', '/webview-activate'].includes(url.pathname)) return false;
  const body = JSON.parse(await readBody(req)) as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    jsonResponse(res, 400, { ok: false, error: 'Missing webview session id' });
    return true;
  }
  if (url.pathname === '/webview-close') unregisterWebviewSession(body.sessionId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      url.pathname === '/webview-close' ? 'browser:close-agent-tab' : 'browser:activate-agent-tab',
      { sessionId: body.sessionId },
    );
  }
  jsonResponse(res, 200, { ok: true });
  return true;
}

/**
 * HTTP handler for POST /webview-command.
 * Executes the CDP command directly on the webview's debugger.
 *
 * Returns 404 if sessionId is not registered (triggers WebviewCDPClient retry).
 * Also sends 'browser:open-agent-tab' IPC so the renderer can auto-open a tab.
 *
 * Returns true if the request was handled (route matched), false otherwise.
 */
export async function handleWebviewCommand(
  req: IncomingMessage,
  res: ServerResponse,
  mainWindow: BrowserWindow | null,
): Promise<boolean> {
  const url = new URL(req.url ?? '', `http://localhost`);
  if (req.method !== 'POST' || url.pathname !== '/webview-command') {
    return false; // Not our route
  }

  try {
    const body = JSON.parse(await readBody(req));
    if (!body.id) {
      jsonResponse(res, 400, { ok: false, error: 'Missing command id' });
      return true;
    }

    const sessionId = body.sessionId as string;
    const focus = body.background !== true;
    const webContentsId = webviewSessionMap.get(sessionId);

    if (webContentsId === undefined) {
      if (isUserClosedSession(sessionId)) {
        // A tool request can arrive after the UI tab was closed because the
        // client retries its prior 404. Do not recreate a blank browser tab.
        jsonResponse(res, 410, {
          id: body.id,
          ok: false,
          error: 'WEBVIEW_SESSION_CLOSED_BY_USER',
        });
        return true;
      }
      // Trigger renderer to open an agent tab for this session.
      // WebviewCDPClient will retry via HTTP polling on 404.
      if (mainWindow && !mainWindow.isDestroyed()) {
        logger.info(
          `Requesting agent browser tab for session ${sessionId}`,
          undefined,
          undefined,
          LogComponent.BrowserDaemon,
        );
        mainWindow.webContents.send('browser:open-agent-tab', { sessionId, focus });
      } else {
        logger.warn(
          `Cannot open agent browser tab: main window unavailable for session ${sessionId}`,
          undefined,
          undefined,
          LogComponent.BrowserDaemon,
        );
      }
      jsonResponse(res, 404, {
        id: body.id,
        ok: false,
        error: 'WEBVIEW_SESSION_NOT_REGISTERED',
      });
      return true;
    }

    // Focus the exact side-panel tab the agent is operating. Inactive browser
    // guests remain mounted in the renderer, preventing tab switches from
    // recreating a blank webview or showing a previous page.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:activate-agent-tab', { sessionId, focus });
    }

    // Attach debugger if needed
    const attachResult = ensureDebuggerAttached(webContentsId);
    if (attachResult !== true) {
      jsonResponse(res, 200, {
        id: body.id,
        ok: false,
        error: attachResult,
      });
      return true;
    }

    // Execute CDP command
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      jsonResponse(res, 200, {
        id: body.id,
        ok: false,
        error: `WebContents not found or destroyed: ${webContentsId}`,
      });
      return true;
    }

    const result = await wc.debugger.sendCommand(body.method, body.params ?? {});
    jsonResponse(res, 200, { id: body.id, ok: true, result });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webview command failed';
    // Detect debugger conflict from sendCommand as well
    const error = message.includes('Another debugger') || message.includes('not attached')
      ? 'DEBUGGER_CONFLICT'
      : message;
    jsonResponse(res, 200, {
      ok: false,
      error,
    });
    return true;
  }
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
