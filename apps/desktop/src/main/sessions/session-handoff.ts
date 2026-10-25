/**
 * Session handoff — "open this session in the desktop app".
 *
 * The Desktop IS the app, so nothing running inside the Desktop asks for
 * this: the request comes from OUTSIDE — a CLI running `/app` against the
 * Host the Desktop embeds. The Host owns the capability contract
 * (`HostSessionHandoffApiV1`); this module is the Desktop's answer to it:
 * bring the window forward and tell the renderer to open the session.
 *
 * The renderer answers with the store's `setActiveThread`, so the session
 * comes up exactly the way the user opens it from the sidebar — no second
 * "open session" implementation.
 *
 * The renderer listens for the window event `duya:open-session-in-app`; the
 * preload bridges the IPC channel below to that event.
 */

import { getMainWindow } from '../core/window-manager';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

/** IPC channel the preload forwards to the renderer's window event. */
export const SESSION_HANDOFF_CHANNEL = 'session:open-in-app';

export interface SessionHandoffResult {
  readonly ok: boolean;
  /** Why the handoff did not happen. Absent when it did. */
  readonly reason?: string;
}

/**
 * The shape the Host consumes. The Host treats this capability as OPTIONAL:
 * a Host that cannot reach a desktop app simply does not offer it.
 */
export interface DesktopSessionHandoffApi {
  openInDesktopApp(input: { sessionId: string }): SessionHandoffResult;
}

/**
 * Bring the app forward and ask the renderer to open `sessionId`.
 *
 * Fails (rather than throwing) when there is no window to receive it: a
 * handoff that nobody can answer is a fact the caller can report, not a
 * crash.
 */
export function openSessionInDesktopApp(sessionId: string): SessionHandoffResult {
  const targetSessionId = sessionId.trim();
  if (!targetSessionId) return { ok: false, reason: 'session_id_required' };

  const window = getMainWindow();
  if (!window || window.isDestroyed()) {
    logger.warn(
      'Session handoff asked for a session but the app has no window',
      { sessionId: targetSessionId },
      LogComponent.Main,
    );
    return { ok: false, reason: 'no_window' };
  }

  window.webContents.send(SESSION_HANDOFF_CHANNEL, { sessionId: targetSessionId });
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return { ok: true };
}

/** The adapter the Desktop hands the Host as its session-handoff capability. */
export function createDesktopSessionHandoffApi(): DesktopSessionHandoffApi {
  return {
    openInDesktopApp: (input) => openSessionInDesktopApp(input.sessionId),
  };
}
