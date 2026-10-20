"use client";

import { create } from "zustand";

/**
 * Controls whether the search palette (Cmd/Ctrl+K) is open. A tiny store so
 * any entry point — the global shortcut or the sidebar search icon button —
 * can open the same palette.
 */
interface SearchPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useSearchPaletteStore = create<SearchPaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));