import { create } from "zustand";
import type { RefineSession } from "..//refine/types";

interface RefineState {
  activeSession: RefineSession | null;
  pendingOpenWidgetId: string | null;
  captureRegistry: Map<string, HTMLElement>;

  openRefinePanel: (widgetId: string) => void;
  consumePendingOpenWidgetId: () => string | null;
  closeRefinePanel: () => void;
  setCaptureTarget: (widgetId: string, el: HTMLElement | null) => void;
  getCaptureTarget: (widgetId: string) => HTMLElement | undefined;
  setSession: (session: RefineSession | null) => void;
  patchSession: (patch: Partial<RefineSession>) => void;
}

export const useRefineStore = create<RefineState>((set, get) => ({
  activeSession: null,
  pendingOpenWidgetId: null,
  captureRegistry: new Map(),

  openRefinePanel: (widgetId) => {
    set({ pendingOpenWidgetId: widgetId });
  },

  consumePendingOpenWidgetId: () => {
    const id = get().pendingOpenWidgetId;
    if (id !== null) set({ pendingOpenWidgetId: null });
    return id;
  },

  closeRefinePanel: () => {
    set({ activeSession: null });
  },

  setCaptureTarget: (widgetId, el) => {
    const reg = new Map(get().captureRegistry);
    if (el) reg.set(widgetId, el);
    else reg.delete(widgetId);
    set({ captureRegistry: reg });
  },

  getCaptureTarget: (widgetId) => {
    return get().captureRegistry.get(widgetId);
  },

  setSession: (session) => set({ activeSession: session }),

  patchSession: (patch) => {
    const cur = get().activeSession;
    if (!cur) return;
    set({ activeSession: { ...cur, ...patch } });
  },
}));