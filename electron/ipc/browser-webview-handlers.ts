/**
 * electron/ipc/browser-webview-handlers.ts
 *
 * IPC surface for webview-based browser fallback.
 *
 * Channels (renderer -> main, invoke):
 *   - browser:register-webview   ({ sessionId, webContentsId }) -> { ok }
 *   - browser:unregister-webview ({ sessionId })                -> { ok }
 *   - browser:close-agent-browser ({ sessionId })               -> { ok }
 *
 * Channels (main -> renderer, event):
 *   - browser:open-agent-tab     ({ sessionId }) — sent by the daemon when
 *     an agent issues a browser command but no webview is registered yet.
 *
 * The actual CDP command execution happens directly in the main process
 * (webview-bridge.ts) via webContents.debugger — no renderer round-trip.
 */

import { ipcMain } from 'electron';
import {
  closeWebviewSessionByUser,
  registerWebviewSession,
  unregisterWebviewSession,
} from '../services/browser/daemon';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

interface RegisterWebviewPayload {
  sessionId: unknown;
  webContentsId: unknown;
}

interface UnregisterWebviewPayload {
  sessionId: unknown;
}

export function registerBrowserWebviewHandlers(): void {
  ipcMain.handle(
    'browser:register-webview',
    (_event, payload: RegisterWebviewPayload) => {
      if (typeof payload?.sessionId !== 'string' || typeof payload?.webContentsId !== 'number') {
        logger.warn(
          'browser:register-webview — invalid payload',
          { sessionId: payload?.sessionId, webContentsId: payload?.webContentsId },
          LogComponent.BrowserDaemon,
        );
        return { ok: false, error: 'Invalid payload' };
      }

      registerWebviewSession(payload.sessionId, payload.webContentsId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'browser:unregister-webview',
    (_event, payload: UnregisterWebviewPayload) => {
      if (typeof payload?.sessionId !== 'string') {
        return { ok: false, error: 'Invalid payload' };
      }

      unregisterWebviewSession(payload.sessionId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'browser:close-agent-browser',
    (_event, payload: UnregisterWebviewPayload) => {
      if (typeof payload?.sessionId !== 'string') {
        return { ok: false, error: 'Invalid payload' };
      }
      closeWebviewSessionByUser(payload.sessionId);
      return { ok: true };
    },
  );
}
