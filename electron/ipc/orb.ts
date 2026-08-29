/**
 * ipc/orb.ts — IPC handlers for the Wake Agent orb.
 *
 * Channels (plan §5 Task E):
 *   - automation:orb:show-input   orb → main  (no payload; main uses
 *                                  orbWindow.webContents.send)
 *   - automation:orb:submit       orb → main  (user pressed Enter)
 *   - automation:orb:show-loading main → orb  (via orbWindow.send)
 *   - automation:orb:update-progress main → orb
 *   - automation:orb:show-result  main → orb
 *   - automation:orb:insert-tab   orb → main  (Insert Tab action)
 *   - automation:orb:hide         main → orb
 *   - automation:orb:chunk        main → orb  (SSE stream chunks)
 *
 * The orb BrowserWindow is owned by WakeService (created lazily on
 * first wake()). We send `main → orb` messages via the wake
 * service's helper which looks up the window by reference. This
 * keeps IPC registration decoupled from window creation.
 *
 * Plan 453 Task E.
 */

import { BrowserWindow, ipcMain } from 'electron';

import { getLogger, LogComponent } from '../logging/logger.js';
import { getWakeService, type OrbState } from '../services/wake.js';

const logger = getLogger();

export function registerOrbHandlers(): void {
  // ------------------------------------------------------------------------
  // orb → main
  // ------------------------------------------------------------------------

  ipcMain.handle(
    'automation:orb:submit',
    async (_event, payload: { prompt: string }) => {
      logger.info(
        'orb:submit received',
        { promptLength: payload.prompt?.length ?? 0 },
        LogComponent.Orb,
      );
      getWakeService().setState('LOADING');
      sendOrbShowLoading({ stage: 'thinking' });

      // Plan 453 Task G: kick off a wakeless chat session. The agent
      // worker streams text deltas via the regular chat:text event;
      // the agent communicator routes them through here when the
      // sessionId starts with `wakeless-`.
      try {
        const { startWakelessChat } = await import(
          '../services/orb-wakeless-chat'
        );
        const result = await startWakelessChat(payload.prompt);
        return result;
      } catch (err) {
        logger.warn(
          'orb:submit failed to start wakeless chat',
          {
            error: err instanceof Error ? err.message : String(err),
          },
          LogComponent.Orb,
        );
        return {
          accepted: false,
          note:
            'wakeless chat start failed; orb submit rejected. ' +
            'See agent logs.',
        };
      }
    },
  );

  ipcMain.handle('automation:orb:show-input', async () => {
    getWakeService().setState('INPUT');
    return { ok: true };
  });

  ipcMain.handle(
    'automation:orb:insert-tab',
    async (_event, payload: { text: string }) => {
      // Plan 453 Task I: actual nut.js wiring. The service reads
      // OSContextBridge to refuse password / redaction, then types
      // into the focused field. Returns a structured result so the
      // renderer can show an error inline.
      const { insertTabToFocusedField } = await import(
        '../services/orb-insert-tab'
      );
      const result = await insertTabToFocusedField(payload.text);
      if (!result.ok) {
        logger.warn(
          'orb:insert-tab rejected',
          { reason: result.reason, length: payload.text?.length ?? 0 },
          LogComponent.Orb,
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    'automation:orb:set-position',
    async (_event, payload: { x: number; y: number; displayId: number }) => {
      getWakeService().setPosition(payload);
      return { ok: true };
    },
  );

  ipcMain.handle('automation:orb:state', async () => {
    return { state: getWakeService().getState() };
  });

  ipcMain.handle('automation:orb:collapse', async () => {
    getWakeService().collapse();
    return { ok: true };
  });
}

/**
 * Send `automation:orb:chunk` for SSE stream deltas. Convenience
 * wrapper used by the renderer-facing IPC and by tests.
 */
export function sendOrbChunk(chunk: { delta: string; turnId: string }): void {
  const win = getOrbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:orb:chunk', chunk);
  }
}

/**
 * Push a progress update to the orb (loading bubble content).
 */
export function sendOrbProgress(
  progress: { stage: 'thinking' | 'tool' | 'finalizing'; label: string },
): void {
  const win = getOrbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:orb:update-progress', progress);
  }
}

/**
 * Push the loading-state trigger to the orb.
 */
export function sendOrbShowLoading(payload: { stage: 'thinking' | 'tool' | 'finalizing' }): void {
  const win = getOrbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:orb:show-loading', payload);
  }
}

/**
 * Push the final result to the orb (LOADING → RESULT).
 */
export function sendOrbResult(payload: {
  turnId: string;
  text: string;
  finishedAt: string;
}): void {
  const win = getOrbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:orb:show-result', payload);
  }
}

/**
 * Hide the orb content (state → DORMANT, but window stays).
 */
export function sendOrbHide(): void {
  const win = getOrbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:orb:hide');
  }
}

/** Internal: peek at the orb window owned by wake service. The
 *  WakeService doesn't expose the window directly, but since this
 *  module sits next to it in the IPC layer, we use a lightweight
 *  accessor that the wake service injects at registration time.
 *
 *  For tests, the accessor is overridable via
 *  `__setOrbWindowAccessorForTest`.
 */
let windowAccessor: () => BrowserWindow | null = () => null;

export function setOrbWindowAccessor(
  fn: () => BrowserWindow | null,
): void {
  windowAccessor = fn;
}

function getOrbWindow(): BrowserWindow | null {
  return windowAccessor();
}

/** Lookup the current orb state — exposed for tests + UI observers. */
export function getCurrentOrbState(): OrbState {
  return getWakeService().getState();
}