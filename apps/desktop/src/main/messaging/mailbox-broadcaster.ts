/**
 * mailbox-broadcaster.ts - MailboxBroadcaster for Plan 202 PR1
 *
 * Fans DB-level state changes back to the renderer as IPC events.
 * The broadcaster is authoritative for state; the IPC return is optimistic.
 *
 * PR1 events: mail:created, mail:edited, mail:cancelled
 * PR2 adds: mail:observed, mail:applied
 */

import type { BrowserWindow } from 'electron';

export type MailboxBroadcastEventType =
  | 'mail:created'
  | 'mail:edited'
  | 'mail:cancelled'
  | 'mail:observed'
  | 'mail:applied';

export interface MailboxBroadcastEvent {
  type: MailboxBroadcastEventType;
  row: Record<string, unknown>;
  prevContent?: string;
  reason?: string;
}

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { BrowserWindow } from 'electron'` is evaluated when the module is
 * and throws THERE, taking the whole graph with it, so the class is resolved
 * through a guarded require. The `import type` above is erased by the
 * compiler and can never throw.
 *
 * An absent host yields no windows. That is not a swallowed failure: the
 * broadcaster is a RENDERER fan-out, so there is nothing to fan out to, and
 * the mailbox rows this module reports on are already written to the DB by the
 * time a broadcast happens.
 */
function allBrowserWindows(): BrowserWindow[] {
  try {
    const { BrowserWindow } = require('electron') as {
      BrowserWindow?: { getAllWindows(): BrowserWindow[] };
    };
    return BrowserWindow && typeof BrowserWindow.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [];
  } catch {
    return [];
  }
}

export function broadcastMailboxEvent(event: MailboxBroadcastEvent): void {
  const windows = allBrowserWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('mailbox:event', event);
    }
  }
}

export function emitMailCreated(row: Record<string, unknown>): void {
  broadcastMailboxEvent({ type: 'mail:created', row });
}

export function emitMailEdited(row: Record<string, unknown>, prevContent: string): void {
  broadcastMailboxEvent({ type: 'mail:edited', row, prevContent });
}

export function emitMailCancelled(row: Record<string, unknown>, reason?: string): void {
  broadcastMailboxEvent({ type: 'mail:cancelled', row, reason });
}

export function emitMailObserved(row: Record<string, unknown>): void {
  broadcastMailboxEvent({ type: 'mail:observed', row });
}

export function emitMailApplied(row: Record<string, unknown>): void {
  broadcastMailboxEvent({ type: 'mail:applied', row });
}
