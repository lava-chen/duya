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

import { BrowserWindow, ipcMain, screen } from 'electron';

import { getLogger, LogComponent } from '../logging/logger.js';
import {
  armOSContextBridge,
  getWakeService,
  type OrbState,
} from '../services/wake.js';

const logger = getLogger();

export function registerOrbHandlers(): void {
  // ------------------------------------------------------------------------
  // orb → main
  // ------------------------------------------------------------------------

  ipcMain.handle(
    'automation:orb:submit',
    async (
      _event,
      payload: { prompt: string; attachments?: string[] },
    ) => {
      logger.info(
        'orb:submit received',
        {
          promptLength: payload.prompt?.length ?? 0,
          attachments: payload.attachments?.length ?? 0,
        },
        LogComponent.Orb,
      );
      getWakeService().setState('LOADING');
      // Mark the turn in-flight BEFORE the window is resized (applyBounds
      // toggles `resizable`, which can momentarily drop OS focus and fire a
      // blur that would otherwise collapse the box and interrupt the worker).
      getWakeService().markWakelessTurnActive();
      sendOrbShowLoading({ stage: 'thinking' });

      // Data-URL attachments from the orb composer become wakeless files.
      const files = (payload.attachments ?? []).map((dataUrl, i) => {
        const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
        const mime = match?.[1] || 'application/octet-stream';
        const ext = mime.split('/')[1]?.split('+')[0] || 'bin';
        return {
          name: `attachment-${i + 1}.${ext}`,
          type: mime,
          url: dataUrl,
        };
      });

      // Plan 453 Task G: kick off a wakeless chat session. The agent
      // worker streams text deltas via the regular chat:text event;
      // the agent communicator routes them through here when the
      // sessionId starts with `wakeless-`.
      try {
        const { startWakelessChat } = await import(
          '../services/orb-wakeless-chat'
        );
        const result = await startWakelessChat(payload.prompt, files);
        if (!result.accepted) {
          // Don't leave the orb (main and renderer) stuck in LOADING.
          getWakeService().setState('DORMANT');
          sendOrbHide();
        }
        return result;
      } catch (err) {
        logger.warn(
          'orb:submit failed to start wakeless chat',
          {
            error: err instanceof Error ? err.message : String(err),
          },
          LogComponent.Orb,
        );
        getWakeService().setState('DORMANT');
        sendOrbHide();
        return {
          accepted: false,
          note:
            'wakeless chat start failed; orb submit rejected. ' +
            'See agent logs.',
        };
      }
    },
  );

  // Fire-and-forget signal from the renderer sent the instant the user
  // submits — BEFORE the local state transition unmounts the focused textarea.
  // It arms `wakelessTurnActive` on the main process ahead of any native blur
  // that the unmount / bounds change might deliver before the `submit` IPC is
  // even handled, closing the INPUT→LOADING focus-change race.
  ipcMain.on('automation:orb:submitting', () => {
    getWakeService().markWakelessTurnActive();
  });

  ipcMain.handle('automation:orb:show-input', async () => {
    armOSContextBridge();
    getWakeService().setState('INPUT');
    return { ok: true };
  });

  // The ball was badged with a notify-result while DORMANT; the user
  // clicked it, so grow the window into the RESULT card. The renderer
  // already holds the content.
  ipcMain.handle('automation:orb:open-result', async () => {
    // Re-arm: the gate must be open for Insert Tab on a result that was
    // delivered while the orb was collapsed.
    armOSContextBridge();
    getWakeService().setState('RESULT');
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
    const wake = getWakeService();
    const session =
      typeof wake.getSession === 'function' ? wake.getSession() : { messages: [], updatedAt: 0 };
    // Phase F (Plan session-floater): payload gained `messages` so the
    // renderer can recover the conversation across reloads. The channel
    // name is unchanged; only the payload shape grew. Both consumers
    // (useOrbState mount/focus/poll rescue) read .messages.
    return { state: wake.getState(), messages: session.messages };
  });

  // The model badge / picker in the orb composer: `model` is what the
  // wakeless turn will actually use; `options` feeds the picker.
  ipcMain.handle('automation:orb:chat-config', async () => {
    try {
      const { getActiveModelName, listModelOptions } = await import(
        '../services/orb-wakeless-chat'
      );
      return { model: getActiveModelName(), options: listModelOptions() };
    } catch {
      return { model: null, options: [] };
    }
  });

  ipcMain.handle(
    'automation:orb:set-model',
    async (_event, payload: { providerId: string; model: string }) => {
      const { setWakeModelOverride } = await import(
        '../services/orb-wakeless-chat'
      );
      setWakeModelOverride(payload);
      return { ok: true };
    },
  );

  ipcMain.handle('automation:orb:pointer', async () => {
    // Pointer mood: the renderer can't read the global cursor (sandboxed), so
    // the main process samples it and reports it relative to the orb window.
    // Returns null before the orb window exists — the renderer then treats the
    // pointer as "away" and plays its free moods.
    const win = windowAccessor();
    if (!win || win.isDestroyed()) return null;
    let cursor: Electron.Point;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch {
      return null;
    }
    const b = win.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    return {
      dx: (cursor.x - cx) / Math.max(1, b.width),
      dy: (cursor.y - cy) / Math.max(1, b.height),
      inside:
        cursor.x >= b.x &&
        cursor.x <= b.x + b.width &&
        cursor.y >= b.y &&
        cursor.y <= b.y + b.height,
      // 绝对距离（px）：距离分层（近/远/走远）用这个，与窗口大小无关。
      dist: Math.hypot(cursor.x - cx, cursor.y - cy),
      // 像素偏移（右/下为正）：眼神跟随用 bloub 的全屏尺度归一，
      // 除以窗口宽度会把增益放大到光标一离开球就打满极限角。
      ox: cursor.x - cx,
      oy: cursor.y - cy,
    };
  });

  ipcMain.handle('automation:orb:collapse', async () => {
    getWakeService().collapse();
    return { ok: true };
  });

  /**
   * Phase A (Plan session-floater): explicit new-chat reset.
   * Phase F wires this to WakeService.resetConversation() which clears
   * the persisted session in configStore. For Phase A we just clear the
   * canonical state in main and let the renderer drop its messages.
   */
  ipcMain.handle('automation:orb:reset-conversation', async () => {
    const wake = getWakeService();
    try {
      wake.resetConversation();
    } catch (err) {
      logger.warn(
        'orb:reset-conversation failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.Orb,
      );
    }
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
 *
 * If the ball is parked in DORMANT (user collapsed mid-task), don't pop a
 * 350px card over their work — badge the ball with `notify-result` instead.
 * The renderer stores the content and shows it when the user clicks the
 * ball (via `automation:orb:open-result`).
 */
export function sendOrbResult(payload: {
  turnId: string;
  text: string;
  finishedAt: string;
}): void {
  const win = getOrbWindow();
  if (!win || win.isDestroyed()) return;
  let state: OrbState;
  try {
    state = getWakeService().getState();
  } catch {
    state = 'RESULT';
  }
  if (state === 'DORMANT') {
    win.webContents.send('automation:orb:notify-result', payload);
    return;
  }
  win.webContents.send('automation:orb:show-result', payload);
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

/**
 * Phase A (Plan session-floater): hotkey wake auto-injection.
 * WakeService calls this right after `sendOrbShowInput` on DORMANT→INPUT
 * with a freshly captured screenshot + OSContext envelope. Renderer uses
 * the payload to pre-fill the input row + push an attachment chip.
 *
 * Phase A only registers the channel; Phase D wires the actual capture in
 * `electron/services/orb-wakeless-chat.ts:buildWakeAutoContext`.
 */
export function sendOrbShowInputWithContext(payload: {
  screenshotBase64: string | null;
  contextText: string;
  foreground: { pid: number; exeName: string; title: string } | null;
  redacted: boolean;
}): void {
  const win = getOrbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:orb:show-input-with-context', payload);
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