/**
 * workspace-lifecycle-handlers.ts — the renderer's narrow window onto the
 * Host's checkout / integration API (plan 621, slice F).
 *
 * The renderer asks the main process; the main process asks the Host through
 * the Host client it already uses for everything else. Nothing here observes,
 * decides or re-derives anything: every answer is the Host's DTO, returned
 * verbatim.
 *
 * Two rules the handlers keep, because both are contract rules and neither is
 * the renderer's to bend:
 *
 *   - An integration observation that says `unknown` stays `unknown`. The
 *     renderer is told what the Host saw, not a tidier version of it.
 *   - A reclaim that says `removed: false` is a NORMAL answer, not a failure.
 *     It is the Host's verdict on "may this be deleted", and nothing was
 *     deleted. Only a transport or I/O failure rejects.
 */

import { ipcMain } from 'electron';
import { getDesktopHostWorkspaceLifecycleApi } from '../cli/desktop-host-api';

/** The same bounds the Host's own routes enforce. */
const MAX_SESSION_ID_LENGTH = 4096;
const MAX_ROOT_LENGTH = 4096;

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`workspace-lifecycle: ${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

export function registerWorkspaceLifecycleHandlers(): void {
  ipcMain.handle(
    'workspace-lifecycle:checkout:observe-for-session',
    async (_event, sessionId: unknown): Promise<unknown> => {
      const id = requireText(sessionId, 'sessionId', MAX_SESSION_ID_LENGTH);
      return await getDesktopHostWorkspaceLifecycleApi().observeCheckoutForSession(id);
    },
  );

  ipcMain.handle(
    'workspace-lifecycle:checkout:observe',
    async (_event, root: unknown): Promise<unknown> => {
      const path = requireText(root, 'root', MAX_ROOT_LENGTH);
      return await getDesktopHostWorkspaceLifecycleApi().observeCheckoutByRoot(path);
    },
  );

  ipcMain.handle(
    'workspace-lifecycle:checkout:reclaim',
    async (_event, root: unknown): Promise<unknown> => {
      const path = requireText(root, 'root', MAX_ROOT_LENGTH);
      return await getDesktopHostWorkspaceLifecycleApi().requestCheckoutReclaim(path);
    },
  );

  ipcMain.handle(
    'workspace-lifecycle:integration:observe-for-session',
    async (_event, sessionId: unknown): Promise<unknown> => {
      const id = requireText(sessionId, 'sessionId', MAX_SESSION_ID_LENGTH);
      return await getDesktopHostWorkspaceLifecycleApi().observeIntegrationsForSession(id);
    },
  );

  ipcMain.handle(
    'workspace-lifecycle:integration:refresh-for-session',
    async (_event, sessionId: unknown): Promise<unknown> => {
      const id = requireText(sessionId, 'sessionId', MAX_SESSION_ID_LENGTH);
      return await getDesktopHostWorkspaceLifecycleApi().syncIntegrations(id);
    },
  );
}
