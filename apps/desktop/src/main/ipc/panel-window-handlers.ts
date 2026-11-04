/**
 * ipc/panel-window-handlers.ts — the `panel-window:*` channels.
 *
 * These channels are the whole contract between the renderer and the
 * detached-window lifecycle:
 *
 *   panel-window:open               → detach one pane into its own OS window
 *   panel-window:close              → return one pane to the main window
 *   panel-window:set-always-on-top  → pin / unpin a detached window
 *   panel-window:get-state          → is this pane detached, and is it pinned?
 *
 * Every parameter is a plain string / boolean. Nothing here knows about the
 * renderer's column-tree model, so the renderer side of this feature can be
 * built independently.
 *
 * ## Who may call what
 *
 * The main window owns the layout, so it may address any pane. A detached
 * window may only address the pane it hosts: a panel floating in its own
 * window has no business re-docking a different panel. The sender is
 * identified by its webContents id (the main window's, or the id of a
 * window this module created), and the call must come from that window's
 * own top frame — a webview guest inside a detached window speaks with a
 * different frame id and is refused.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import {
  getPanelWindowState,
  isTopLevelSenderFrame,
  openDetachedPanel,
  resolvePanelCaller,
  returnPanelToMain,
  setPanelAlwaysOnTop,
  type PanelCaller,
  type PanelSenderFacts,
} from '../core/panel-window-manager';
import {
  IpcContractError,
  PanelWindowAlwaysOnTopSchema,
  PanelWindowOpenSchema,
  PanelWindowPaneSchema,
  parseIpcPayload,
} from './contracts';

/** Facts about the sender of an IPC call, in the shape the manager reads. */
function senderFacts(event: IpcMainInvokeEvent): PanelSenderFacts {
  return {
    id: event.sender?.id,
    mainFrame: event.sender?.mainFrame ?? null,
    senderFrame: event.senderFrame ?? null,
  };
}

/**
 * Identify the caller, or `null` when the call must be refused.
 *
 * A refusal is logged and answered with an error envelope — never a silent
 * success, which would leave the renderer believing the panel moved.
 */
function authorize(event: IpcMainInvokeEvent, channel: string): PanelCaller | null {
  const facts = senderFacts(event);
  if (!isTopLevelSenderFrame(facts)) {
    getLogger().warn(
      'panel-window IPC rejected: sender is not a top-level frame',
      { channel },
      LogComponent.Main,
    );
    return null;
  }
  const caller = resolvePanelCaller(facts);
  if (caller === null) {
    getLogger().warn(
      'panel-window IPC rejected: unknown sender',
      { channel },
      LogComponent.Main,
    );
    return null;
  }
  return caller;
}

/** A detached window may only address the pane it hosts. */
function mayAddressPane(caller: PanelCaller, paneId: string): boolean {
  return caller.kind === 'main' || caller.paneId === paneId;
}

function errorResult(error: unknown): { ok: false; error: string } {
  if (error instanceof IpcContractError) return { ok: false, error: error.message };
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerPanelWindowHandlers(): void {
  /**
   * Detach one pane into its own OS window.
   *
   * Only the main window may do this: the detached window is a child of the
   * layout, and the layout lives in the main window.
   */
  ipcMain.handle('panel-window:open', async (event, payload: unknown) => {
    const caller = authorize(event, 'panel-window:open');
    if (caller === null) return { ok: false, error: 'untrusted sender' };
    if (caller.kind !== 'main') {
      return { ok: false, error: 'only the main window may detach a panel' };
    }

    try {
      const request = parseIpcPayload(PanelWindowOpenSchema, payload, 'panel-window:open');
      return await openDetachedPanel(request);
    } catch (error) {
      getLogger().error(
        'panel-window:open failed',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.Main,
      );
      return errorResult(error);
    }
  });

  /**
   * Return one pane to the main window.
   *
   * This is what the native X of a detached window does, and what the
   * detached window's "open in main window" button does. The pane stays in
   * the layout — only its host changes.
   */
  ipcMain.handle('panel-window:close', (event, payload: unknown) => {
    const caller = authorize(event, 'panel-window:close');
    if (caller === null) return { ok: false, error: 'untrusted sender' };

    try {
      const { paneId } = parseIpcPayload(PanelWindowPaneSchema, payload, 'panel-window:close');
      if (!mayAddressPane(caller, paneId)) {
        return { ok: false, error: 'a detached window may only return its own panel' };
      }
      const returned = returnPanelToMain(paneId, 'requested');
      return returned
        ? { ok: true, paneId }
        : { ok: false, paneId, error: 'panel is not detached' };
    } catch (error) {
      getLogger().error(
        'panel-window:close failed',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.Main,
      );
      return errorResult(error);
    }
  });

  /**
   * Pin (or unpin) the detached window of one pane.
   *
   * The flag is applied to the native window and persisted by the main
   * process, so it survives the window closing and is known again the next
   * time the pane is detached.
   */
  ipcMain.handle('panel-window:set-always-on-top', (event, payload: unknown) => {
    const caller = authorize(event, 'panel-window:set-always-on-top');
    if (caller === null) return { ok: false, error: 'untrusted sender' };

    try {
      const { paneId, alwaysOnTop } = parseIpcPayload(
        PanelWindowAlwaysOnTopSchema,
        payload,
        'panel-window:set-always-on-top',
      );
      if (!mayAddressPane(caller, paneId)) {
        return { ok: false, error: 'a detached window may only pin its own panel' };
      }
      return setPanelAlwaysOnTop(paneId, alwaysOnTop);
    } catch (error) {
      getLogger().error(
        'panel-window:set-always-on-top failed',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.Main,
      );
      return errorResult(error);
    }
  });

  /**
   * Read the detached state of one pane.
   *
   * `detached` says whether the pane currently lives in its own window;
   * `alwaysOnTop` is the effective pin state, so the header toggle reads
   * the same whether the pane is docked or detached.
   */
  ipcMain.handle('panel-window:get-state', (event, payload: unknown) => {
    const caller = authorize(event, 'panel-window:get-state');
    if (caller === null) return { ok: false, error: 'untrusted sender' };

    try {
      const { paneId } = parseIpcPayload(PanelWindowPaneSchema, payload, 'panel-window:get-state');
      if (!mayAddressPane(caller, paneId)) {
        return { ok: false, error: 'a detached window may only read its own panel state' };
      }
      return getPanelWindowState(paneId);
    } catch (error) {
      getLogger().error(
        'panel-window:get-state failed',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.Main,
      );
      return errorResult(error);
    }
  });
}
