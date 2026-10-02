// electron/ipc/trusted-sender.ts
// Plan 583 / ISS-30: one place that decides whether an IPC message came from
// a frame the app actually trusts.
//
// Every `ipcMain.handle` in this app used to accept a call from ANY renderer
// frame. The main window's navigation is pinned to the app origin, but that
// protects the top-level document only: the app also creates auxiliary windows
// (overlay, recorder badge, computer-use overlay, the Conductor link-snapshot
// capture window), and `webviewTag` is still enabled, so a guest frame is a
// live question. A handler that takes a filesystem path is exactly the kind
// of handler that must not be reachable from an untrusted frame.
//
// The decision is split in two on purpose:
//   - `evaluateTrustedSender` is PURE. It takes plain facts, so it can be
//     exhaustively unit-tested without an Electron runtime.
//   - `assertTrustedSender` is the thin adapter that reads those facts off an
//     `IpcMainInvokeEvent` and throws on rejection.
//
// A handler that fails this check must fail CLOSED. Anything that turns a
// rejection into a silent `return` has re-opened the hole.

import type { IpcMainInvokeEvent } from 'electron';

import { getLogger, type LogComponentName } from '../logging/logger';
import { getMainWindow } from '../core/window-manager';

const COMPONENT = 'IPC' as LogComponentName;

/** Why a sender was refused. Surfaced in the audit log, never to the renderer. */
export type TrustedSenderRejection =
  /** No main window exists, or the sender is not it (auxiliary window or guest). */
  | 'unknown_window'
  /** The message came from an iframe inside the main window, not its top frame. */
  | 'subframe'
  /** The top frame is not on the app's own origin. */
  | 'foreign_origin';

export interface TrustedSenderFacts {
  /**
   * `webContents.id` of the process that sent the message. For a `<webview>`
   * guest this is the GUEST's webContents, not the main window's — which is
   * why this single check already refuses guests and auxiliary windows.
   */
  senderId: number;
  /**
   * `WebFrameMain.routingId` of the sending frame. The main frame is always
   * 0; anything else is an iframe.
   */
  frameRoutingId: number | null;
  /** The sending frame's URL, used only to confirm the app origin. */
  frameUrl: string | null;
}

export interface TrustedSenderOptions {
  /**
   * Origins the top frame may be on. Defaults to the main window's current
   * origin, read at call time. Pass an explicit list only when a known
   * dev/preview origin is expected.
   */
  allowedOrigins?: readonly string[];
}

export interface TrustedSenderConfig {
  mainWindowId: number | null;
  allowedOrigins: readonly string[];
}

export type TrustedSenderVerdict =
  | { ok: true }
  | { ok: false; reason: TrustedSenderRejection; detail: string };

/**
 * Pure decision. Accept only the main window's own main frame on an app
 * origin.
 *
 * Every branch fails closed, including the unknown ones: a missing routing id
 * or an origin we could not determine is refused rather than optimistically
 * allowed, because "we could not tell who this is" is not evidence of trust.
 */
export function evaluateTrustedSender(
  facts: TrustedSenderFacts,
  config: TrustedSenderConfig,
): TrustedSenderVerdict {
  if (config.mainWindowId === null) {
    return { ok: false, reason: 'unknown_window', detail: 'no main window is open' };
  }
  if (facts.senderId !== config.mainWindowId) {
    return {
      ok: false,
      reason: 'unknown_window',
      detail: `sender ${facts.senderId} is not the main window (${config.mainWindowId})`,
    };
  }
  if (facts.frameRoutingId === null) {
    return {
      ok: false,
      reason: 'subframe',
      detail: 'sender frame is unavailable; cannot confirm it is the main frame',
    };
  }
  if (facts.frameRoutingId !== 0) {
    return {
      ok: false,
      reason: 'subframe',
      detail: `frame routing id ${facts.frameRoutingId} is not the main frame`,
    };
  }
  if (config.allowedOrigins.length === 0) {
    return {
      ok: false,
      reason: 'foreign_origin',
      detail: 'no app origin is available to compare against',
    };
  }
  let origin: string;
  try {
    origin = new URL(facts.frameUrl ?? '').origin;
  } catch {
    return { ok: false, reason: 'foreign_origin', detail: `unparseable frame url ${facts.frameUrl}` };
  }
  if (origin === 'null' || !config.allowedOrigins.includes(origin)) {
    return { ok: false, reason: 'foreign_origin', detail: `frame origin ${origin} is not an app origin` };
  }
  return { ok: true };
}

/** Pull the decision facts off a live Electron IPC event. */
function readFacts(event: IpcMainInvokeEvent): TrustedSenderFacts {
  const senderFrame = event.senderFrame ?? null;
  return {
    senderId: event.sender?.id ?? -1,
    frameRoutingId: senderFrame ? senderFrame.routingId : null,
    frameUrl: senderFrame ? senderFrame.url : null,
  };
}

/** The origins the main window's own top frame is currently on. */
function currentAppOrigins(mainWindowId: number | null): readonly string[] {
  if (mainWindowId === null) return [];
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== mainWindowId) {
    return [];
  }
  try {
    const origin = new URL(mainWindow.webContents.getURL()).origin;
    return origin && origin !== 'null' ? [origin] : [];
  } catch {
    // Window not loaded yet. Empty list makes the decision fail closed.
    return [];
  }
}

/**
 * Guard for a privileged handler. Throws when the sender is not trusted, so
 * the `ipcMain.handle` promise rejects and the handler body never runs.
 *
 * Usage: call this as the FIRST statement of the handler, before reading any
 * argument from the event.
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  options: TrustedSenderOptions = {},
  channel?: string,
): void {
  const mainWindow = getMainWindow();
  const mainWindowId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null;

  const config: TrustedSenderConfig = {
    mainWindowId,
    allowedOrigins: options.allowedOrigins ?? currentAppOrigins(mainWindowId),
  };
  const verdict = evaluateTrustedSender(readFacts(event), config);
  if (verdict.ok) return;

  getLogger().warn(
    'IPC rejected from untrusted sender',
    { channel: channel ?? 'unknown', reason: verdict.reason, detail: verdict.detail },
    COMPONENT,
  );
  throw new Error(`IPC rejected: untrusted sender (${verdict.reason})`);
}
