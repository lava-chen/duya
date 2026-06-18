/**
 * mailbox-broadcaster.ts - MailboxBroadcaster for Plan 202 PR1
 *
 * Fans DB-level state changes back to the renderer as IPC events.
 * The broadcaster is authoritative for state; the IPC return is optimistic.
 *
 * PR1 events: mail:created, mail:edited, mail:cancelled
 * PR2 adds: mail:observed, mail:applied
 */

import { BrowserWindow } from 'electron';

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

export function broadcastMailboxEvent(event: MailboxBroadcastEvent): void {
  const windows = BrowserWindow.getAllWindows();
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
