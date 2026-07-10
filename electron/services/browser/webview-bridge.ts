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

export function registerWebviewSession(sessionId: string, webContentsId: number): void {
  webviewSessionMap.set(sessionId, webContentsId);
  logger.info(
    `Webview registered: sessionId=${sessionId}, webContentsId=${webContentsId}`,
    undefined,
    undefined,
    LogComponent.BrowserDaemon,
  );
}

export function unregisterWebviewSession(sessionId: string): void {
  const webContentsId = webviewSessionMap.get(sessionId);
  webviewSessionMap.delete(sessionId);

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

  if (wc.debugger.isAttached()) {
    return true;
  }

  try {
    wc.debugger.attach('1.3');
    attachedDebuggers.add(webContentsId);

    // Clean up if the webContents is destroyed unexpectedly
    wc.once('destroyed', () => {
      attachedDebuggers.delete(webContentsId);
      webviewSessionMap.delete(
        // Remove any session pointing at this webContentsId
        [...webviewSessionMap.entries()].find(([, id]) => id === webContentsId)?.[0] ?? '',
      );
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
    const webContentsId = webviewSessionMap.get(sessionId);

    if (webContentsId === undefined) {
      // Trigger renderer to open an agent tab for this session.
      // WebviewCDPClient will retry via HTTP polling on 404.
      if (mainWindow && !mainWindow.isDestroyed()) {
        logger.info(
          `Requesting agent browser tab for session ${sessionId}`,
          undefined,
          undefined,
          LogComponent.BrowserDaemon,
        );
        mainWindow.webContents.send('browser:open-agent-tab', { sessionId });
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
