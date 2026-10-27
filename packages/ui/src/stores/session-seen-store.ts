/**
 * session-seen-store — "finished, but the user has not looked at it" state
 * for work-session rows in the sidebar (Claude parity, 2026-10-27).
 *
 * ## Why this exists
 *
 * Claude Code marks a session row with a BLUE dot when the session finished
 * its work and the user has not opened it since. Duya had no equivalent: the
 * session list carries no unread column, and the renderer's stream phase only
 * knows what THIS renderer started or attached to. A session that ran
 * entirely in the background left no trace the sidebar could show.
 *
 * ## What is stored
 *
 * `unreadAt[sessionId]` — the moment the session last produced output the
 * user has not seen. Persisted to localStorage so an app restart does not
 * silently clear every pending badge (the same trade-off the bot row makes
 * with `sidebar.botLastSeenAt`).
 *
 * The badge is NOT a claim that the session is idle. A session that is still
 * running also has unread output; the row suppresses the dot while the agent
 * server reports the session as STREAMING (see `useSessionUnreadBadge`).
 *
 * ## What is NOT stored
 *
 * The last-seen timestamp is deliberately absent. "Seen" means "the unread
 * flag was cleared", and the flag is cleared by `markSeen` — the moment the
 * user opens the session. One map, one meaning.
 */

import { create } from "zustand";

const UNREAD_KEY = "sidebar.sessionUnreadAt";

function readUnreadMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeUnreadMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable (quota / web build) — badges stay session-local.
  }
}

interface SessionSeenStore {
  /** sessionId -> ms timestamp of the newest output the user has not seen. */
  unreadAt: Record<string, number>;
  /** The session produced output. Stamps it as unread. */
  notifyOutput: (sessionId: string) => void;
  /** The user opened the session — its pending output is seen now. */
  markSeen: (sessionId: string) => void;
}

export const useSessionSeenStore = create<SessionSeenStore>((set) => ({
  unreadAt: readUnreadMap(),
  notifyOutput: (sessionId) =>
    set((state) => {
      const now = Date.now();
      if (state.unreadAt[sessionId] === now) return state;
      const unreadAt = { ...state.unreadAt, [sessionId]: now };
      writeUnreadMap(unreadAt);
      return { unreadAt };
    }),
  markSeen: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.unreadAt)) return state;
      const { [sessionId]: _cleared, ...unreadAt } = state.unreadAt;
      writeUnreadMap(unreadAt);
      return { unreadAt };
    }),
}));
