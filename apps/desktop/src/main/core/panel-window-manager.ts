/**
 * panel-window-manager.ts — lifecycle of detached panel windows.
 *
 * A side panel can leave the column tree and become a REAL OS window: its
 * own title bar, its own minimise / maximise / close, its own taskbar entry.
 * This module owns that window. It does NOT own the layout.
 *
 * Two rules shape everything here:
 *
 *  1. **The main window owns the layout.** The column tree, the pane order
 *     and the column widths live in the main window's renderer. A detached
 *     window renders ONE panel and reports intent back over IPC; it never
 *     holds a second copy of the layout.
 *
 *  2. **The native X means "return to the main window".** Closing a
 *     detached window must not destroy the panel: the main window's
 *     renderer keeps the pane in its layout model the whole time, so the
 *     X only flips that pane's host back to `docked`. The column structure
 *     therefore survives a detach / return round trip untouched.
 *
 * The detached window loads the SAME renderer bundle as the main window,
 * with the same preload. It is told which pane it hosts through two
 * entry parameters — a command-line argument (`--duya-panel-id=`) and a URL
 * query parameter (`?duyaPanel=`) — so the renderer can tell "this window
 * hosts pane X" from "this is the main window" without a second panel
 * implementation.
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import { getLogger, LogComponent } from '../logging/logger';
import { getIconPath, getMainWindow, getRendererUrl } from './window-manager';
import {
  emptyPanelWindowState,
  loadPanelWindowState,
  savePanelWindowState,
  type PanelWindowState,
} from './panel-window-state';

/** Channel the main process pushes detached-panel events on. */
export const PANEL_WINDOW_EVENT_CHANNEL = 'panel-window:event';

/** Argument the preload reads the detached pane id from. */
export const PANEL_ID_ARG_PREFIX = '--duya-panel-id=';
/** Argument the preload reads the detached panel page id from. */
export const PANEL_PAGE_ARG_PREFIX = '--duya-panel-page=';
/** Query parameter the detached window's URL carries. */
export const PANEL_ID_QUERY_PARAM = 'duyaPanel';
/** Query parameter the detached window's URL carries. */
export const PANEL_PAGE_QUERY_PARAM = 'duyaPanelPage';

/** Default detached-window size. Wide enough for a terminal or a diff view. */
const DEFAULT_PANEL_WINDOW_WIDTH = 1127;
const DEFAULT_PANEL_WINDOW_HEIGHT = 876;
const MIN_PANEL_WINDOW_WIDTH = 480;
const MIN_PANEL_WINDOW_HEIGHT = 320;

/** Why a detached window went back to the main window. */
export type PanelReturnReason = 'native-close' | 'requested';

/** Events the main process pushes to the renderers. */
export type PanelWindowEvent =
  | { type: 'opened'; paneId: string; windowId: number }
  | { type: 'returned'; paneId: string; reason: PanelReturnReason }
  | { type: 'always-on-top-changed'; paneId: string; alwaysOnTop: boolean };

/** Request to detach one pane into its own window. */
export interface DetachPanelRequest {
  paneId: string;
  pageId: string;
  title?: string;
}

/** Result of a detach request. */
export interface DetachPanelResult {
  ok: boolean;
  paneId: string;
  /** Electron webContents id of the detached window. */
  windowId?: number;
  /** True when the pane was already detached and the existing window was focused. */
  alreadyOpen?: boolean;
  error?: string;
}

/** Result of a state query. */
export interface PanelWindowStateResult {
  ok: boolean;
  paneId: string;
  /** True while the pane has a live detached window. */
  detached: boolean;
  /** Effective always-on-top flag (the window's, or the persisted preference). */
  alwaysOnTop: boolean;
  error?: string;
}

/** Result of a mutating action on a detached panel window. */
export interface PanelWindowActionResult {
  ok: boolean;
  paneId: string;
  alwaysOnTop?: boolean;
  error?: string;
}

/** Who is calling a `panel-window:*` handler. */
export type PanelCaller =
  | { kind: 'main' }
  | { kind: 'detached'; paneId: string };

interface PanelWindowEntry {
  paneId: string;
  pageId: string;
  title: string;
  window: BrowserWindow;
  /**
   * Set while the window is being closed on purpose. The native close
   * handler refuses the close and turns it into a "return to main window";
   * this flag is how the deliberate second close gets through.
   */
  closing: boolean;
}

/** Live detached windows, keyed by pane id. */
const entries = new Map<string, PanelWindowEntry>();

/** Persisted preferences. Loaded lazily so importing this module is free. */
let preferences: PanelWindowState | null = null;

/**
 * True once the app started quitting.
 *
 * The native close handler turns a close into a "return to main window",
 * which would block the quit itself — Electron asks every window for
 * permission to close. This flag is set from `before-quit`, which fires
 * before any window is closed, so the quit path stays intact.
 */
let isQuitting = false;

app.on('before-quit', () => {
  isQuitting = true;
});

function getPreferences(): PanelWindowState {
  if (preferences === null) preferences = loadPanelWindowState();
  return preferences;
}

function persistPreferences(): void {
  if (preferences === null) return;
  savePanelWindowState(preferences);
}

/** Reset the module state. Test-only; keeps the singleton observable. */
export function resetPanelWindowManagerForTests(): void {
  entries.clear();
  preferences = null;
  isQuitting = false;
}

/** True when the pane currently lives in its own window. */
export function isPanelDetached(paneId: string): boolean {
  const entry = entries.get(paneId);
  return entry !== undefined && !entry.window.isDestroyed();
}

/**
 * Build the URL a detached window loads.
 *
 * Same renderer as the main window, plus the entry parameters that tell it
 * which pane it hosts. The query parameter is the one a human can read in a
 * bug report; the command-line argument is what the preload reads.
 */
export function buildDetachedPanelUrl(
  rendererUrl: string,
  paneId: string,
  pageId: string,
): string {
  const url = new URL(rendererUrl);
  url.searchParams.set(PANEL_ID_QUERY_PARAM, paneId);
  url.searchParams.set(PANEL_PAGE_QUERY_PARAM, pageId);
  return url.toString();
}

/** Cached renderer URL — resolving it probes the dev server, so do it once. */
let cachedRendererUrl: string | null = null;

async function resolveRendererUrl(): Promise<string> {
  if (cachedRendererUrl !== null) return cachedRendererUrl;
  const url = await getRendererUrl();
  cachedRendererUrl = url;
  return url;
}

/**
 * Detach one pane into its own OS window.
 *
 * Re-detaching an already-detached pane focuses the existing window instead
 * of opening a second one for the same pane — two windows showing the same
 * pane would fork the panel's state.
 */
export async function openDetachedPanel(
  request: DetachPanelRequest,
): Promise<DetachPanelResult> {
  const { paneId, pageId } = request;
  const title = request.title?.trim() || 'DUYA';

  const existing = entries.get(paneId);
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) existing.window.restore();
    existing.window.focus();
    return {
      ok: true,
      paneId,
      windowId: existing.window.webContents.id,
      alreadyOpen: true,
    };
  }

  let rendererUrl: string;
  try {
    rendererUrl = await resolveRendererUrl();
  } catch (error) {
    getLogger().error(
      'Failed to resolve renderer URL for detached panel',
      error instanceof Error ? error : new Error(String(error)),
      { paneId },
      LogComponent.Main,
    );
    return { ok: false, paneId, error: 'failed to resolve renderer url' };
  }

  const window = new BrowserWindow({
    width: DEFAULT_PANEL_WINDOW_WIDTH,
    height: DEFAULT_PANEL_WINDOW_HEIGHT,
    minWidth: MIN_PANEL_WINDOW_WIDTH,
    minHeight: MIN_PANEL_WINDOW_HEIGHT,
    title,
    icon: getIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `${PANEL_ID_ARG_PREFIX}${paneId}`,
        `${PANEL_PAGE_ARG_PREFIX}${pageId}`,
      ],
    },
  });

  const entry: PanelWindowEntry = {
    paneId,
    pageId,
    title,
    window,
    closing: false,
  };
  entries.set(paneId, entry);

  // The native close button means "return this panel to the main window".
  // Refusing the close keeps the panel alive in the layout; the return
  // path below then closes the window for real.
  window.on('close', (event) => {
    if (entry.closing || isQuitting) return;
    event.preventDefault();
    returnPanelToMain(paneId, 'native-close');
  });

  window.on('closed', () => {
    if (entries.get(paneId) === entry) entries.delete(paneId);
  });

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });

  // The renderer sets `document.title`, which would overwrite the panel
  // title in the native title bar with the app's own title. A detached
  // window is named after the panel it hosts, so the title is pinned here.
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    if (!window.isDestroyed()) window.setTitle(title);
  });

  // Restore the persisted always-on-top preference for this pane.
  const preference = getPreferences().panes[paneId];
  if (preference?.alwaysOnTop === true) {
    window.setAlwaysOnTop(true);
  }

  // The load is deliberately NOT awaited: the renderer is a full SPA, and
  // waiting for it would stall the "open in a new window" call in the main
  // window for as long as the boot takes. The window shows itself on
  // `ready-to-show`, and a failed load is reported through the log and by
  // closing the window again.
  const detachedUrl = buildDetachedPanelUrl(rendererUrl, paneId, pageId);
  void window.loadURL(detachedUrl).catch((error: unknown) => {
    getLogger().error(
      'Failed to load detached panel window',
      error instanceof Error ? error : new Error(String(error)),
      { paneId },
      LogComponent.Main,
    );
    entry.closing = true;
    entries.delete(paneId);
    if (!window.isDestroyed()) window.destroy();
  });

  broadcastPanelEvent({ type: 'opened', paneId, windowId: window.webContents.id });
  return { ok: true, paneId, windowId: window.webContents.id };
}

/**
 * Return a detached pane to the main window.
 *
 * `reason` distinguishes the native X (`native-close`) from an explicit
 * request — the detached window's "open in main window" button or the main
 * window's own request (`requested`). The main window's renderer uses it to
 * decide whether to re-dock the pane silently or with feedback.
 */
export function returnPanelToMain(paneId: string, reason: PanelReturnReason): boolean {
  const entry = entries.get(paneId);
  if (!entry) return false;

  entry.closing = true;
  entries.delete(paneId);

  broadcastPanelEvent({ type: 'returned', paneId, reason });

  // The close is DEFERRED by one tick. When the native X was the trigger,
  // this runs inside the window's own `close` event, and closing a window
  // from within its `close` handler is re-entrant. Deferring keeps the
  // two paths identical and avoids the re-entrancy entirely.
  setImmediate(() => {
    if (!entry.window.isDestroyed()) entry.window.close();
  });
  return true;
}

/**
 * Pin (or unpin) a detached panel window above the other windows.
 *
 * The flag is persisted by the main process, so it survives the window
 * closing and is known again the next time the pane is detached.
 */
export function setPanelAlwaysOnTop(
  paneId: string,
  alwaysOnTop: boolean,
): PanelWindowActionResult {
  const entry = entries.get(paneId);
  if (!entry || entry.window.isDestroyed()) {
    return { ok: false, paneId, error: 'panel is not detached' };
  }

  entry.window.setAlwaysOnTop(alwaysOnTop);

  const state = getPreferences();
  state.panes[paneId] = { pageId: entry.pageId, alwaysOnTop };
  persistPreferences();

  broadcastPanelEvent({ type: 'always-on-top-changed', paneId, alwaysOnTop });
  return { ok: true, paneId, alwaysOnTop };
}

/**
 * The current state of one pane: is it detached, and is it pinned?
 *
 * The always-on-top value comes from the live window when there is one and
 * from the persisted preference otherwise, so the main window can render
 * the toggle correctly for a pane that is currently docked.
 */
export function getPanelWindowState(paneId: string): PanelWindowStateResult {
  const entry = entries.get(paneId);
  const detached = isPanelDetached(paneId);
  const alwaysOnTop =
    detached && entry
      ? entry.window.isAlwaysOnTop()
      : getPreferences().panes[paneId]?.alwaysOnTop === true;
  return { ok: true, paneId, detached, alwaysOnTop };
}

/**
 * The facts about an IPC sender this module needs.
 *
 * A structural type rather than Electron's `IpcMainInvokeEvent` so the
 * decision can be exercised without an Electron runtime.
 */
export interface PanelSenderFacts {
  /** webContents id of the sender. */
  id?: number;
  /** The sender's own top frame. */
  mainFrame?: { routingId: number } | null;
  /** The frame that actually sent the call. */
  senderFrame?: { routingId: number } | null;
}

/**
 * Identify the caller of a `panel-window:*` handler.
 *
 * The main window may address any pane. A detached window may only address
 * the pane it hosts — otherwise a detached panel could drive the layout of
 * a panel it does not own. Anything else is refused.
 */
export function resolvePanelCaller(sender: PanelSenderFacts | null): PanelCaller | null {
  if (!sender) return null;
  const senderId = sender.id ?? -1;

  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId) {
    return { kind: 'main' };
  }

  for (const entry of entries.values()) {
    if (entry.window.isDestroyed()) continue;
    if (entry.window.webContents.id === senderId) {
      return { kind: 'detached', paneId: entry.paneId };
    }
  }
  return null;
}

/**
 * True when the sender frame is the top frame of its own webContents.
 *
 * A webview guest inside a detached window is a different frame with a
 * different routing id, so it must not be able to speak for the window.
 * The routing ids are compared instead of assuming a literal `0`: Electron
 * allocates the main frame's id per renderer process, and it changes again
 * after a reload.
 */
export function isTopLevelSenderFrame(sender: PanelSenderFacts | null): boolean {
  const mainFrame = sender?.mainFrame ?? null;
  const senderFrame = sender?.senderFrame ?? null;
  if (!mainFrame || !senderFrame) return false;
  return mainFrame.routingId === senderFrame.routingId;
}

/**
 * Push an event to every renderer that can care about it: the main window
 * (the layout owner) and every detached panel window (each one filters by
 * pane id).
 */
export function broadcastPanelEvent(event: PanelWindowEvent): void {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PANEL_WINDOW_EVENT_CHANNEL, event);
  }
  for (const entry of entries.values()) {
    if (entry.window.isDestroyed()) continue;
    entry.window.webContents.send(PANEL_WINDOW_EVENT_CHANNEL, event);
  }
}
