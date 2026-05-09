import { create } from "zustand";
import type { ConductorCanvas, ConductorWidget, ConductorSnapshot, ConductorAction, Actor, CanvasElement } from "@/types/conductor";
import { ConductorBridge } from "@/lib/conductor-bridge";
import { undoAction, redoAction, executeAction } from "@/lib/conductor-ipc";
import { listProvidersIPC } from "@/lib/ipc-client";
import type { ModelOption } from "@/components/chat/ModelSelector";
import { widgetToElementAdapter } from "@/lib/widget-element-adapter";

type ModelInfo = ModelOption & { providerId?: string };

export type AgentStreamStatus = "idle" | "thinking" | "streaming" | "tool_use" | "completed" | "error";
export type ConductorUiStatus = "idle" | "editing" | "agent-editing" | "error" | "syncing";

export interface AgentStreamItem {
  id: string;
  type: "text" | "thinking" | "tool_use" | "tool_result" | "tool_progress" | "status" | "error";
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  isError?: boolean;
  ts: number;
}

interface ConductorState {
  canvases: ConductorCanvas[];
  activeCanvasId: string | null;
  widgets: ConductorWidget[];
  elements: CanvasElement[];
  snapshot: ConductorSnapshot | null;
  editMode: boolean;
  canUndo: boolean;
  canRedo: boolean;
  actions: ConductorAction[];
  historyOpen: boolean;
  actorFilter: Actor | "all";
  widgetFilter: string | null;
  agentStatus: AgentStreamStatus;
  agentStream: AgentStreamItem[];
  uiStatus: ConductorUiStatus;
  selectedWidgetId: string | null;
  selectedElementId: string | null;
  syncStatusText: string;
  uiError: string | null;
  bridgeUnsubscribe: (() => void) | null;

  // Model selection
  conductorModels: ModelInfo[];
  conductorModel: string;
  conductorProviderId: string | null;
  conductorModelsLoading: boolean;

  // Canvas zoom
  canvasZoom: number;
  setCanvasZoom: (zoom: number) => void;

  // Unified canvas contents getter
  getCanvasContents: () => CanvasElement[];

  // Canvas
  setCanvases: (canvases: ConductorCanvas[]) => void;
  addCanvas: (canvas: ConductorCanvas) => void;
  removeCanvas: (canvasId: string) => void;
  updateCanvas: (canvas: ConductorCanvas) => void;
  setActiveCanvas: (canvasId: string) => void;

  // Snapshot / widget hydration
  setSnapshot: (snapshot: ConductorSnapshot) => void;
  setWidgets: (widgets: ConductorWidget[]) => void;
  addWidget: (widget: ConductorWidget) => void;
  updateWidget: (widgetId: string, patch: Partial<ConductorWidget>) => void;
  removeWidget: (widgetId: string) => void;

  // Element operations
  setElements: (elements: CanvasElement[]) => void;
  addElement: (element: CanvasElement) => void;
  updateElement: (elementId: string, patch: Partial<CanvasElement>) => void;
  removeElement: (elementId: string) => void;

  // Bridge
  connectBridge: (canvasId: string) => void;
  disconnectBridge: () => void;

  // Edit mode
  toggleEditMode: () => void;

  // Undo/Redo
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  setUndoRedo: (canUndo: boolean, canRedo: boolean) => void;
  autoLayout: () => void;

  // History
  setActions: (actions: ConductorAction[]) => void;
  toggleHistory: () => void;
  setActorFilter: (actor: Actor | "all") => void;
  setWidgetFilter: (widgetId: string | null) => void;

  // Agent streaming
  setAgentStatus: (status: AgentStreamStatus) => void;
  addAgentStreamItem: (item: AgentStreamItem) => void;
  clearAgentStream: () => void;
  setUiStatus: (status: ConductorUiStatus, syncStatusText?: string) => void;
  setSelectedWidgetId: (widgetId: string | null) => void;
  setSelectedElementId: (elementId: string | null) => void;
  setSyncStatusText: (text: string) => void;
  setUiError: (message: string | null) => void;

  // Model selection
  fetchConductorModels: () => Promise<void>;
  setConductorModel: (modelId: string) => void;
}

export const useConductorStore = create<ConductorState>((set, get) => ({
  canvases: [],
  activeCanvasId: null,
  widgets: [],
  elements: [],
  snapshot: null,
  editMode: true,
  canUndo: false,
  canRedo: false,
  actions: [],
  historyOpen: false,
  actorFilter: "all",
  widgetFilter: null,
  agentStatus: "idle",
  agentStream: [],
  uiStatus: "idle",
  selectedWidgetId: null,
  selectedElementId: null,
  syncStatusText: "",
  uiError: null,
  bridgeUnsubscribe: null,
  conductorModels: [],
  conductorModel: "",
  conductorProviderId: null,
  conductorModelsLoading: false,
  canvasZoom: 1,

  setCanvases: (canvases) => set({ canvases }),

  addCanvas: (canvas) =>
    set((state) => ({ canvases: [...state.canvases, canvas] })),

  removeCanvas: (canvasId) =>
    set((state) => ({
      canvases: state.canvases.filter((c) => c.id !== canvasId),
      activeCanvasId:
        state.activeCanvasId === canvasId ? null : state.activeCanvasId,
    })),

  updateCanvas: (canvas) =>
    set((state) => ({
      canvases: state.canvases.map((c) => (c.id === canvas.id ? canvas : c)),
    })),

  setActiveCanvas: (canvasId) => set({ activeCanvasId: canvasId }),

  setSnapshot: (snapshot) =>
    set({
      snapshot,
      widgets: snapshot.widgets,
      elements: (snapshot as any).elements ?? [],
    }),

  setWidgets: (widgets) => set({ widgets }),

  addWidget: (widget) =>
    set((state) => ({ widgets: [...state.widgets, widget] })),

  updateWidget: (widgetId, patch) =>
    set((state) => ({
      widgets: state.widgets.map((w) =>
        w.id === widgetId ? { ...w, ...patch } : w
      ),
    })),

  removeWidget: (widgetId) =>
    set((state) => ({
      widgets: state.widgets.filter((w) => w.id !== widgetId),
    })),

  setElements: (elements) => set({ elements }),

  addElement: (element) =>
    set((state) => ({ elements: [...state.elements, element] })),

  updateElement: (elementId, patch) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.id === elementId ? { ...e, ...patch } : e
      ),
    })),

  removeElement: (elementId) =>
    set((state) => ({
      elements: state.elements.filter((e) => e.id !== elementId),
    })),

  connectBridge: (canvasId) => {
    const { bridgeUnsubscribe } = get();
    if (bridgeUnsubscribe) {
      bridgeUnsubscribe();
    }

    const unsub = ConductorBridge.connect(canvasId);

    const cleanupPatch = ConductorBridge.onStatePatch((patch) => {
      const { widgets } = get();
      const resultPatch = (patch.resultPatch as Record<string, unknown> | undefined) ?? undefined;

      // Full widget list hydration patch
      if (patch.widgets && Array.isArray(patch.widgets)) {
        set({
          widgets: patch.widgets as ConductorWidget[],
          elements: (patch as any).elements ?? [],
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
        return;
      }

      // widget.create -> append widget from resultPatch
      if (resultPatch?.widget && typeof resultPatch.widget === "object") {
        const incoming = resultPatch.widget as ConductorWidget;
        const exists = widgets.some((w) => w.id === incoming.id);
        if (!exists) {
          set({
            widgets: [...widgets, incoming],
            canUndo: true,
            canRedo: false,
            uiStatus: "idle",
            syncStatusText: "",
          });
        }
      }

      // widget.create also writes element (dual-write) -> append element from resultPatch
      if (resultPatch?.element && typeof resultPatch.element === "object") {
        const incoming = resultPatch.element as CanvasElement;
        const { elements } = get();
        const exists = elements.some((e) => e.id === incoming.id);
        if (!exists) {
          set({
            elements: [...elements, incoming],
            canUndo: true,
            canRedo: false,
            uiStatus: "idle",
            syncStatusText: "",
          });
        }
      }

      // widget.delete -> remove widget by widgetId and element by elementId
      if (resultPatch?.deletedWidget && patch.widgetId) {
        get().removeWidget(patch.widgetId as string);
        get().removeElement(patch.widgetId as string);
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
        return;
      }

      // widget.move / widget.resize
      if (patch.widgetId && resultPatch?.position && typeof resultPatch.position === "object") {
        get().updateWidget(patch.widgetId as string, {
          position: resultPatch.position as ConductorWidget["position"],
          updatedAt: Date.now(),
        });
        const rpPos = resultPatch.position as any;
        get().updateElement(patch.widgetId as string, {
          position: { x: rpPos.x ?? 0, y: rpPos.y ?? 0, w: rpPos.w ?? 4, h: rpPos.h ?? 3, zIndex: 0, rotation: 0 },
          updatedAt: Date.now(),
        });
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
        return;
      }

      // widget.update_config
      if (patch.widgetId && resultPatch?.config && typeof resultPatch.config === "object") {
        get().updateWidget(patch.widgetId as string, {
          config: resultPatch.config as Record<string, unknown>,
          updatedAt: Date.now(),
        });
        get().updateElement(patch.widgetId as string, {
          config: resultPatch.config as Record<string, unknown>,
          updatedAt: Date.now(),
        });
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
        return;
      }

      // widget.update_data (legacy and current payload shapes)
      if (patch.widgetId && (patch.data || resultPatch?.data)) {
        const dataPayload = (resultPatch?.data as Record<string, unknown> | undefined) ?? (patch.data as Record<string, unknown> | undefined);
        if (!dataPayload) return;
        const existing = widgets.find((w) => w.id === patch.widgetId);
        if (!existing) return;
        get().updateWidget(patch.widgetId as string, {
          data: dataPayload,
          dataVersion: (existing.dataVersion || 0) + 1,
          updatedAt: Date.now(),
        });
        get().updateElement(patch.widgetId as string, {
          config: dataPayload,
          dataVersion: (existing.dataVersion || 0) + 1,
          updatedAt: Date.now(),
        });
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
      }

      // element.create -> append element from resultPatch
      if (resultPatch?.element && typeof resultPatch.element === "object") {
        const incoming = resultPatch.element as CanvasElement;
        const { elements } = get();
        const exists = elements.some((e) => e.id === incoming.id);
        if (!exists) {
          set({
            elements: [...elements, incoming],
            canUndo: true,
            canRedo: false,
            uiStatus: "idle",
            syncStatusText: "",
          });
        }
        return;
      }

      // element.delete -> remove element by elementId
      if (resultPatch?.deletedElement && patch.elementId) {
        get().removeElement(patch.elementId as string);
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
        return;
      }

      // element.move
      if (patch.elementId && resultPatch?.position && typeof resultPatch.position === "object" && !patch.widgetId) {
        get().updateElement(patch.elementId as string, {
          position: resultPatch.position as CanvasElement["position"],
          updatedAt: Date.now(),
        });
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
        return;
      }

      // element.update
      if (patch.elementId && (resultPatch?.config !== undefined || resultPatch?.vizSpec !== undefined)) {
        const elementPatch: Partial<CanvasElement> = { updatedAt: Date.now() };
        if (resultPatch?.config !== undefined) {
          elementPatch.config = resultPatch.config as Record<string, unknown>;
        }
        if (resultPatch?.vizSpec !== undefined) {
          elementPatch.vizSpec = resultPatch.vizSpec as any;
        }
        get().updateElement(patch.elementId as string, elementPatch);
        set({
          canUndo: true,
          canRedo: false,
          uiStatus: "idle",
          syncStatusText: "",
        });
      }
    });

    set({ bridgeUnsubscribe: () => { unsub(); cleanupPatch(); } });
  },

  disconnectBridge: () => {
    const { bridgeUnsubscribe } = get();
    if (bridgeUnsubscribe) {
      bridgeUnsubscribe();
      set({ bridgeUnsubscribe: null });
    }
    ConductorBridge.disconnect();
  },

  toggleEditMode: () =>
    set((state) => {
      const nextEditMode = !state.editMode;
      return {
        editMode: nextEditMode,
        uiStatus: nextEditMode ? "editing" : "idle",
        syncStatusText: "",
      };
    }),

  undo: async () => {
    const { activeCanvasId, actions } = get();
    if (!activeCanvasId) return;

    try {
      set({ uiStatus: "syncing", syncStatusText: "Reverting last action..." });
      const result = await undoAction(activeCanvasId);
      if (result.success) {
        if (result.inverted && result.actionId) {
          const action = actions.find((a) => a.id === result.actionId);
          if (action) {
            const updated = actions.map((a) =>
              a.id === result.actionId ? { ...a, undoneAt: Date.now() } : a
            );
            set({ actions: updated });
          }
        }
        set({ uiStatus: "idle", syncStatusText: "" });
        get().setUiError(null);
      } else {
        set({ uiStatus: "error", syncStatusText: "Failed to revert action" });
        get().setUiError("Undo failed");
      }
      set({ canUndo: false, canRedo: true });
    } catch {
      set({ uiStatus: "error", syncStatusText: "Failed to revert action" });
      get().setUiError("Undo failed");
    }
  },

  redo: async () => {
    const { activeCanvasId } = get();
    if (!activeCanvasId) return;

    try {
      set({ uiStatus: "syncing", syncStatusText: "Reapplying action..." });
      const result = await redoAction(activeCanvasId);
      if (result.success) {
        if (result.patch && result.actionId) {
          const { actions } = get();
          const updated = actions.map((a) =>
            a.id === result.actionId ? { ...a, undoneAt: null } : a
          );
          set({ actions: updated });
        }
        set({ uiStatus: "idle", syncStatusText: "" });
        get().setUiError(null);
      } else {
        set({ uiStatus: "error", syncStatusText: "Failed to reapply action" });
        get().setUiError("Redo failed");
      }
      set({ canUndo: true, canRedo: false });
    } catch {
      set({ uiStatus: "error", syncStatusText: "Failed to reapply action" });
      get().setUiError("Redo failed");
    }
  },

  setUndoRedo: (canUndo, canRedo) => set({ canUndo, canRedo }),

  setActions: (actions) => set({ actions }),

  toggleHistory: () => set((state) => ({ historyOpen: !state.historyOpen })),

  setActorFilter: (actorFilter) => set({ actorFilter }),

  setWidgetFilter: (widgetFilter) => set({ widgetFilter }),

  setAgentStatus: (agentStatus) =>
    set((state) => {
      let uiStatus = state.uiStatus;
      let syncStatusText = state.syncStatusText;

      if (agentStatus === "thinking") {
        uiStatus = "syncing";
        syncStatusText = "Agent is thinking...";
      } else if (agentStatus === "streaming" || agentStatus === "tool_use") {
        uiStatus = "agent-editing";
        syncStatusText = "Agent is editing the canvas...";
      } else if (agentStatus === "error") {
        uiStatus = "error";
        syncStatusText = "Agent run failed";
      } else if (agentStatus === "idle" || agentStatus === "completed") {
        uiStatus = state.editMode ? "editing" : "idle";
        syncStatusText = "";
      }

      return { agentStatus, uiStatus, syncStatusText };
    }),

  addAgentStreamItem: (item) =>
    set((state) => ({
      agentStream: [...state.agentStream, item],
    })),

  clearAgentStream: () =>
    set((state) => ({
      agentStream: [],
      agentStatus: "idle",
      uiStatus: state.editMode ? "editing" : "idle",
      syncStatusText: "",
    })),

  setUiStatus: (uiStatus, syncStatusText = "") => set({ uiStatus, syncStatusText }),

  setSelectedWidgetId: (selectedWidgetId) => set({ selectedWidgetId }),
  setSelectedElementId: (selectedElementId) => set({ selectedElementId }),

  setSyncStatusText: (syncStatusText) => set({ syncStatusText }),

  setUiError: (uiError) => set({ uiError }),

  autoLayout: () => {
    const { widgets, activeCanvasId } = get();
    if (!activeCanvasId || widgets.length === 0) return;

    const cols = 12;
    let row = 0;
    let col = 0;

    const newWidgets = widgets.map((w) => {
      const pos = { ...w.position };

      if (col + pos.w > cols) {
        col = 0;
        row++;
      }

      pos.x = col;
      pos.y = row;
      col += pos.w;

      if (col >= cols) {
        col = 0;
        row++;
      }

      return { id: w.id, position: pos };
    });

    const updated = widgets.map((w) => {
      const layout = newWidgets.find((nw) => nw.id === w.id);
      return layout ? { ...w, position: layout.position, updatedAt: Date.now() } : w;
    });

    set({
      widgets: updated,
      uiStatus: "syncing",
      syncStatusText: "Applying automatic layout...",
    });

    for (const { id, position } of newWidgets) {
      executeAction({
        action: "widget.move",
        widgetId: id,
        canvasId: activeCanvasId,
        position,
      })
        .then(() => {
          set({ uiStatus: "idle", syncStatusText: "" });
          get().setUiError(null);
        })
        .catch(() => {
          set({ uiStatus: "error", syncStatusText: "Failed to apply automatic layout" });
          get().setUiError("Auto layout failed");
        });
    }
  },

  fetchConductorModels: async () => {
    set({ conductorModelsLoading: true });
    try {
      const providers = await listProvidersIPC();
      if (!providers || providers.length === 0) {
        set({ conductorModels: [], conductorModelsLoading: false });
        return;
      }

      const allModels: ModelInfo[] = [];
      const modelIds = new Set<string>();

      for (const provider of providers) {
        if (!provider.hasApiKey && provider.providerType !== 'ollama') continue;

        let enabledModels: string[] = [];
        try {
          const opts = JSON.parse(provider.options || '{}');
          if (opts.enabled_models && Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
            enabledModels = opts.enabled_models;
          }
        } catch { /* ignore */ }

        for (const id of enabledModels) {
          const cleanId = id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
          const providerName = provider.name || provider.providerType || provider.id;
          const prefixedId = `[${providerName}] ${cleanId}`;
          if (!modelIds.has(prefixedId)) {
            modelIds.add(prefixedId);
            allModels.push({
              id: prefixedId,
              display_name: cleanId,
              providerId: provider.id,
            });
          }
        }
      }

      const { conductorModel } = get();
      set({
        conductorModels: allModels,
        conductorModelsLoading: false,
        conductorModel: conductorModel || (allModels.length > 0 ? allModels[0].id : ""),
        conductorProviderId: allModels.length > 0 ? (allModels[0].providerId || null) : null,
      });
    } catch {
      set({ conductorModels: [], conductorModelsLoading: false });
    }
  },

  setConductorModel: (modelId) => {
    const { conductorModels } = get();
    const model = conductorModels.find((m) => m.id === modelId);
    set({
      conductorModel: modelId,
      conductorProviderId: model?.providerId || null,
    });
  },

  setCanvasZoom: (zoom) => set({ canvasZoom: zoom }),

  getCanvasContents: () => {
    const { elements, widgets } = get();
    if (elements.length > 0) return elements;
    return widgets.map(w => widgetToElementAdapter(w));
  },
}));
