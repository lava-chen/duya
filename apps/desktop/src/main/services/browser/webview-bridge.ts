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
 * renderer so it can auto-open a panel tab. Commands that ask for
 * `waitRegistration` are held until the webview registers (bounded window);
 * others get an immediate 404 and WebviewCDPClient polls on its own.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { webContents, type BrowserWindow, type WebContents } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import { releaseBrowserMemory, setWebviewIdProvider } from './webview-memory';

const logger = getLogger();

/** sessionId -> webContentsId */
const webviewSessionMap = new Map<string, number>();

// Let the webview memory manager enumerate live guests without importing this
// module (keeps the dependency one-way and avoids an import cycle).
setWebviewIdProvider(() =>
  Array.from(webviewSessionMap, ([sessionId, webContentsId]) => ({ sessionId, webContentsId })),
);
/** webContentsIds that currently have the debugger attached */
const attachedDebuggers = new Set<number>();
/** webContentsIds whose CDP Network events are observed by this bridge */
const networkListeners = new Set<number>();
const networkCaptures = new Map<string, { pattern: string; requests: unknown[] }>();
/** Briefly suppress late CDP retries after the user explicitly closes a tab. */
const userClosedSessions = new Map<string, number>();
const USER_CLOSE_COOLDOWN_MS = 15_000;

/**
 * Commands arriving before the renderer registered the session's webview can
 * be held server-side until registration lands, instead of bouncing 404s
 * between WebviewCDPClient and the daemon. Keyed by sessionId; each entry is
 * the list of resolver callbacks waiting for that session to register.
 */
const registrationWaiters = new Map<string, Array<() => void>>();
export const REGISTRATION_HOLD_TIMEOUT_MS = 10_000;
let registrationHoldTimeoutMs = REGISTRATION_HOLD_TIMEOUT_MS;

/** Test-only override for the registration hold window. */
export function setRegistrationHoldTimeoutForTest(ms: number): void {
  registrationHoldTimeoutMs = ms;
}

/** Resolve every held command waiting for this session to register. */
function resolveRegistrationWaiters(sessionId: string): void {
  const waiters = registrationWaiters.get(sessionId);
  if (!waiters) return;
  registrationWaiters.delete(sessionId);
  for (const waiter of waiters) waiter();
}

/**
 * Wait until `registerWebviewSession(sessionId)` is called, or timeout.
 * Resolves true when registration landed, false on timeout.
 */
function waitForRegistration(sessionId: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let waiter: (() => void) | undefined;

    const finish = (registered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (waiter) {
        const list = registrationWaiters.get(sessionId);
        if (list) {
          const index = list.indexOf(waiter);
          if (index >= 0) list.splice(index, 1);
          if (list.length === 0) registrationWaiters.delete(sessionId);
        }
      }
      resolve(registered);
    };

    waiter = () => finish(true);
    const list = registrationWaiters.get(sessionId) ?? [];
    list.push(waiter);
    registrationWaiters.set(sessionId, list);

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Upper bound on how many agent browser sessions (pages) may be open at once
 * in the built-in webview backend. Enforced here in the daemon so the cap
 * applies regardless of which agent/session requests the page. Mirrored in
 * the Chrome extension via a `config` WS message pushed by the daemon.
 * Configurable by the user through DUYA settings (`browserMaxTabs`).
 */
export const DEFAULT_MAX_WEBVIEW_SESSIONS = 10;
let maxWebviewSessions = DEFAULT_MAX_WEBVIEW_SESSIONS;

function normalizeMaxTabs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_WEBVIEW_SESSIONS;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

export function setMaxWebviewSessions(value: number): void {
  maxWebviewSessions = normalizeMaxTabs(value);
}

export function getMaxWebviewSessions(): number {
  return maxWebviewSessions;
}

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
  const isNewRegistration = !webviewSessionMap.has(sessionId);
  webviewSessionMap.set(sessionId, webContentsId);
  if (isNewRegistration) resolveRegistrationWaiters(sessionId);
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

  // Last tab gone → strictly discard the partition's caches so the guest's
  // footprint does not persist into the next browser session. Fire-and-forget;
  // cookies/localStorage are preserved (see webview-memory.ts).
  if (webviewSessionMap.size === 0) {
    void releaseBrowserMemory('last-webview-unregistered');
  }
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

// ─── Page-load wait ──────────────────────────────────────────────────

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait for one webview's page to finish loading entirely inside the daemon.
 * Subscribes to `Page.loadEventFired` on the attached debugger, with a
 * readyState poll as a safety net for events that raced or were missed, so
 * the agent pays a single HTTP call instead of polling document.readyState
 * over HTTP every 200ms.
 */
async function waitForLoadInProcess(
  wc: WebContents,
  timeoutMs: number,
): Promise<{ timedOut: boolean; readyState: string }> {
  const readReadyState = async (): Promise<string> => {
    try {
      const result = (await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      })) as { result?: { value?: unknown } } | undefined;
      return typeof result?.result?.value === 'string' ? result.result.value : '';
    } catch {
      return '';
    }
  };

  // Fast path: the page already finished loading before we subscribed. The
  // double-check guards against catching a transient complete state.
  if ((await readReadyState()) === 'complete') {
    await delay(100);
    if ((await readReadyState()) === 'complete') {
      return { timedOut: false, readyState: 'complete' };
    }
  }

  return new Promise(resolve => {
    let settled = false;
    let settling = false;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      clearInterval(pollTimer);
      wc.removeListener('destroyed', onDestroyed);
      try {
        wc.debugger.removeListener('message', onMessage);
      } catch {
        // webContents destroyed mid-wait — nothing left to remove
      }
    };
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void readReadyState()
        .then(readyState => resolve({ timedOut, readyState }))
        .catch(() => resolve({ timedOut, readyState: '' }));
    };
    const maybeLoaded = async (): Promise<void> => {
      if (settled || settling) return;
      settling = true;
      await delay(100);
      settling = false;
      if (settled) return;
      if ((await readReadyState()) === 'complete') finish(false);
    };
    const onMessage = (_event: unknown, method: string): void => {
      if (method === 'Page.loadEventFired') void maybeLoaded();
    };
    const onDestroyed = (): void => finish(true);

    wc.debugger.on('message', onMessage);
    wc.once('destroyed', onDestroyed);
    const pollTimer = setInterval(() => void maybeLoaded(), 250);
    const timeoutTimer = setTimeout(() => finish(true), timeoutMs);
  });
}

/**
 * HTTP handler for POST /webview-wait-load.
 *
 * Body: `{ sessionId, timeoutMs? }`. Waits for the session's page to finish
 * loading inside the daemon process and reports `{ ok, timedOut, readyState }`.
 *
 * Returns true if the request was handled (route matched), false otherwise.
 */
export async function handleWebviewWaitLoad(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (req.method !== 'POST' || url.pathname !== '/webview-wait-load') return false;

  try {
    const body = JSON.parse(await readBody(req)) as {
      sessionId?: unknown;
      timeoutMs?: unknown;
    };
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
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      jsonResponse(res, 404, { ok: false, error: 'WebContents not found' });
      return true;
    }

    const requestedTimeout = typeof body.timeoutMs === 'number' ? body.timeoutMs : 10_000;
    const timeoutMs = Math.min(30_000, Math.max(0, requestedTimeout));
    try {
      // Idempotent; required for Page.loadEventFired below.
      await wc.debugger.sendCommand('Page.enable');
    } catch {
      // Already enabled or racing enable — the readyState fallback still works.
    }
    const outcome = await waitForLoadInProcess(wc, timeoutMs);
    jsonResponse(res, 200, {
      ok: true,
      timedOut: outcome.timedOut,
      readyState: outcome.readyState,
    });
  } catch (err) {
    jsonResponse(res, 200, {
      ok: false,
      error: err instanceof Error ? err.message : 'Webview wait-load failed',
    });
  }
  return true;
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
    let webContentsId = webviewSessionMap.get(sessionId);

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
      // Enforce the user-configurable page cap: refuse to spawn yet another
      // agent browser session when the limit is reached. The agent receives a
      // clear error instead of silently opening an unbounded number of pages.
      if (webviewSessionMap.size >= maxWebviewSessions) {
        logger.warn(
          `Browser page limit reached (${maxWebviewSessions}) for session ${sessionId}; refusing to open a new agent browser tab`,
          undefined,
          LogComponent.BrowserDaemon,
        );
        jsonResponse(res, 429, {
          id: body.id,
          ok: false,
          error: `BROWSER_MAX_TABS_REACHED: maximum browser pages reached (${maxWebviewSessions}). Close some pages or raise the browser page limit in DUYA settings.`,
        });
        return true;
      }
      // Trigger renderer to open an agent tab for this session.
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
        jsonResponse(res, 404, {
          id: body.id,
          ok: false,
          error: 'WEBVIEW_SESSION_NOT_REGISTERED',
        });
        return true;
      }

      // Hold the request until the renderer registers the new tab's webview
      // (or the hold window expires) so the first command executes as soon as
      // the webview is ready instead of bouncing 404 retries between client
      // and daemon. Clients that don't ask for this still get the plain 404
      // and poll on their own.
      if (body.waitRegistration !== true) {
        jsonResponse(res, 404, {
          id: body.id,
          ok: false,
          error: 'WEBVIEW_SESSION_NOT_REGISTERED',
        });
        return true;
      }
      const registeredInTime = await waitForRegistration(sessionId, registrationHoldTimeoutMs);
      const heldWebContentsId = webviewSessionMap.get(sessionId);
      if (!registeredInTime || heldWebContentsId === undefined) {
        jsonResponse(res, 404, {
          id: body.id,
          ok: false,
          error: 'WEBVIEW_SESSION_NOT_REGISTERED',
          held: true,
        });
        return true;
      }
      webContentsId = heldWebContentsId;
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
