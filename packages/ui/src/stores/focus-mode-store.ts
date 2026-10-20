// focus-mode-store.ts - Zustand store for the per-session "Focus" display mode.
//
// When enabled for a session, the chat collapses the whole agent round into
// ONE big action group (the usual "text breaks the group run" rule is
// suspended) and hides intermediate text outputs — only the final output
// stays visible.
//
// In-memory only, keyed by sessionId: the toggle applies to a single session
// and never becomes a global setting. Like btw-store, state survives
// open/close within the app lifetime and is dropped on restart.

import { create } from 'zustand';

interface FocusModeState {
  enabledBySession: Record<string, boolean>;
  toggle: (sessionId: string) => void;
  setEnabled: (sessionId: string, enabled: boolean) => void;
}

export const useFocusModeStore = create<FocusModeState>()((set) => ({
  enabledBySession: {},

  toggle: (sessionId) => {
    set((state) => ({
      enabledBySession: {
        ...state.enabledBySession,
        [sessionId]: !(state.enabledBySession[sessionId] ?? false),
      },
    }));
  },

  setEnabled: (sessionId, enabled) => {
    set((state) => {
      if ((state.enabledBySession[sessionId] ?? false) === enabled) return state;
      return {
        enabledBySession: {
          ...state.enabledBySession,
          [sessionId]: enabled,
        },
      };
    });
  },
}));

/** Read the toggle for one session as a stable boolean primitive. */
export function selectFocusEnabled(state: FocusModeState, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return state.enabledBySession[sessionId] ?? false;
}
