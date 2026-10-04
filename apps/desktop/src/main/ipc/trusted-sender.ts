// electron/ipc/trusted-sender.ts
// Plan 583 / ISS-30: the ADAPTER half of the trusted-sender decision.
//
// Every `ipcMain.handle` in this app used to accept a call from ANY renderer
// frame. The main window's navigation is pinned to the app origin, but that
// protects the top-level document only: the app also creates auxiliary windows
// (overlay, recorder badge, computer-use overlay, the Conductor link-snapshot
// capture window), and `webviewTag` is still enabled, so a guest frame is a
// live question. A handler that takes a filesystem path is exactly the kind of
// handler that must not be reachable from an untrusted frame.
//
// The decision is split in two on purpose:
//   - `evaluateTrustedSender` is PURE and lives in `trusted-sender-core.ts`, so
//     it can be exercised without an Electron runtime — and so the Control
//     Plane (plan 587 C6.1) can reuse the SAME decision for its `db:request`
//     sender check without importing `electron` through `window-manager`.
//   - `assertTrustedSender` is this file: the thin adapter that reads those
//     facts off an `IpcMainInvokeEvent` and throws on rejection.
//
// A handler that fails this check must fail CLOSED. Anything that turns a
// rejection into a silent `return` has re-opened the hole.

import type { IpcMainInvokeEvent } from 'electron';

import { getLogger, type LogComponentName } from '../logging/logger';
import { getMainWindow } from '../core/window-manager';
import {
  evaluateTrustedSender,
  type TrustedSenderConfig,
  type TrustedSenderFacts,
  type TrustedSenderOptions,
  type TrustedSenderRejection,
  type TrustedSenderVerdict,
} from './trusted-sender-core';

const COMPONENT = 'IPC' as LogComponentName;

// Re-exported so every existing call site and test keeps importing from this
// path, and so the pure decision is still declared in exactly one place.
export {
  evaluateTrustedSender,
  type TrustedSenderConfig,
  type TrustedSenderFacts,
  type TrustedSenderOptions,
  type TrustedSenderRejection,
  type TrustedSenderVerdict,
};

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
