// terminal-appearance-store.ts - persisted look-and-feel preferences for the
// sidebar terminal (src/components/layout/panels/TerminalPanel.tsx).
//
// Both font size and colour theme are renderer-local UI preferences, so they
// live in localStorage via zustand's persist middleware (same convention as
// conversation-store). The store is global rather than per-session: the user
// picks a terminal look once and every terminal tab inherits it.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_SIZE_STEP = 1;

export type TerminalThemeId =
  | 'auto'
  | 'tokyonight'
  | 'dracula'
  | 'nord'
  | 'solarized'
  | 'gruvbox';

/** Clamp an arbitrary number into the supported font-size range. */
export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)));
}

interface TerminalAppearanceState {
  fontSize: number;
  themeId: TerminalThemeId;
  setFontSize: (size: number) => void;
  /** Nudge the font size by `delta` steps, clamped to the supported range. */
  stepFontSize: (delta: number) => void;
  resetFontSize: () => void;
  setThemeId: (id: TerminalThemeId) => void;
}

export const useTerminalAppearanceStore = create<TerminalAppearanceState>()(
  persist(
    (set) => ({
      fontSize: TERMINAL_FONT_SIZE_DEFAULT,
      themeId: 'auto',
      setFontSize: (size) => set({ fontSize: clampTerminalFontSize(size) }),
      stepFontSize: (delta) =>
        set((state) => ({ fontSize: clampTerminalFontSize(state.fontSize + delta) })),
      resetFontSize: () => set({ fontSize: TERMINAL_FONT_SIZE_DEFAULT }),
      setThemeId: (themeId) => set({ themeId }),
    }),
    {
      name: 'duya-terminal-appearance',
      version: 1,
    },
  ),
);
