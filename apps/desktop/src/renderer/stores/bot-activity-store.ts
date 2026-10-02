/**
 * bot-activity-store — sidebar bot row notification state (plan 483 P1.4
 * follow-up: WeChat-style avatar badges).
 *
 * Two pieces of state per bot agent id:
 *   - `lastSeenAt` — ms timestamp of when the user last had that bot's
 *     chat open. Persisted to localStorage so a restart does not mark
 *     every bot "unread". Rows derive the green "finished but unseen"
 *     badge by comparing the transcript's last message timestamp against
 *     this value.
 *   - `erroredAt`  — ms timestamp set when the bot's bound session stream
 *     transitions to the `error` phase. In-memory only (a restart also
 *     clears the stream manager, so there is nothing to show after one).
 *     Cleared — together with the unseen badge — by `markSeen` when the
 *     user opens the bot.
 */

import { create } from "zustand";

const LAST_SEEN_KEY = "sidebar.botLastSeenAt";

function readLastSeenMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
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

function writeLastSeenMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable (quota / web build) — badges stay session-local.
  }
}

interface BotActivityStore {
  lastSeenAt: Record<string, number>;
  erroredAt: Record<string, number>;
  /** User opened the bot's chat — clear the error badge and stamp seen. */
  markSeen: (agentId: string) => void;
  /** Bound session stream hit the `error` phase. */
  markErrored: (agentId: string) => void;
  /** A new run started — a stale error badge no longer applies. */
  clearError: (agentId: string) => void;
}

export const useBotActivityStore = create<BotActivityStore>((set) => ({
  lastSeenAt: readLastSeenMap(),
  erroredAt: {},
  markSeen: (agentId) =>
    set((state) => {
      const now = Date.now();
      const { [agentId]: _cleared, ...erroredAt } = state.erroredAt;
      if (state.lastSeenAt[agentId] === now && !(agentId in state.erroredAt)) {
        return state;
      }
      const lastSeenAt = { ...state.lastSeenAt, [agentId]: now };
      writeLastSeenMap(lastSeenAt);
      return { lastSeenAt, erroredAt };
    }),
  markErrored: (agentId) =>
    set((state) => {
      if (state.erroredAt[agentId]) return state;
      return { erroredAt: { ...state.erroredAt, [agentId]: Date.now() } };
    }),
  clearError: (agentId) =>
    set((state) => {
      if (!(agentId in state.erroredAt)) return state;
      const { [agentId]: _cleared, ...erroredAt } = state.erroredAt;
      return { erroredAt };
    }),
}));
