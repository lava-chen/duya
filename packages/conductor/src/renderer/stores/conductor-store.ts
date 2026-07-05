import { create } from "zustand";
import type { ConductorCanvas, ConductorWidget, ConductorSnapshot, ConductorAction, Actor, CanvasElement, CanvasPosition } from "..//types/conductor";
import { ConductorBridge } from "..//ipc/conductor-bridge";
import { undoAction, redoAction, executeAction } from "..//ipc/conductor-ipc";
import { getConductorHostOrNull, type ModelOption, type ConductorModelInfo } from "..//host";
import { widgetToElementAdapter } from "..//ipc/widget-element-adapter";

/**
 * Normalize an incoming position to the full `CanvasPosition` shape.
 *
 * Several write paths (legacy widget JSON parsed without `w`/`h`, agent
 * output, IPC patches) may produce a partial position object. If we hand
 * that straight to renderers, `undefined * GRID_PX === NaN` and React
 * logs "NaN is an invalid value for the width css style property".
 * Defaults match the legacy widget size used by `widget.move` and
 * `widget-element-adapter.ts`.
 */
function normalizePosition(pos: Partial<CanvasPosition> | null | undefined): CanvasPosition {
  const w = typeof pos?.w === "number" && Number.isFinite(pos.w) ? pos.w : 4;
  const h = typeof pos?.h === "number" && Number.isFinite(pos.h) ? pos.h : 3;
  return {
    x: typeof pos?.x === "number" && Number.isFinite(pos.x) ? pos.x : 0,
    y: typeof pos?.y === "number" && Number.isFinite(pos.y) ? pos.y : 0,
    w,
    h,
    zIndex: typeof pos?.zIndex === "number" && Number.isFinite(pos.zIndex) ? pos.zIndex : 0,
    rotation: typeof pos?.rotation === "number" && Number.isFinite(pos.rotation) ? pos.rotation : 0,
  };
}

function normalizeElement(el: CanvasElement): CanvasElement {
  // Defensive: patches may use `kind` (LLM-friendly alias) instead of `elementKind`.
  // Map it so CanvasArea's isWidgetKind/isConnectorKind don't crash on undefined.
  const { kind, elementKind, ...rest } = el as CanvasElement & { kind?: string };
  return {
    ...rest,
    elementKind: elementKind ?? kind ?? 'native/sticky',
    position: normalizePosition(el.position),
  };
}

type ModelInfo = ConductorModelInfo;

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
  actorFilter: Actor | "all";
  widgetFilter: string | null;
  agentStatus: AgentStreamStatus;
  agentStream: AgentStreamItem[];
  uiStatus: ConductorUiStatus;
  selectedWidgetId: string | null;
  selectedElementId: string | null;
  activeTool: string | null;
  editingElementId: string | null;
  selectedElementIds: string[];
  syncStatusText: string;
  uiError: string | null;
  bridgeUnsubscribe: (() => void) | null;

  // Model selection
  conductorModels: ModelInfo[];
  conductorModel: string;
  conductorProviderId: string | null;
  conductorModelsLoading: boolean;

  // Conductor settings (persisted)
  conductorVisionModel: string;
  conductorPermissionMode: "default" | "auto" | "bypass";
  conductorSettingsOpen: boolean;
  conductorSettingsLoading: boolean;

  // Canvas zoom
  canvasZoom: number;
  setCanvasZoom: (zoom: number) => void;

  // Canvas viewport (for toolbar placement calculation)
  canvasScrollX: number;
  canvasScrollY: number;
  canvasViewportW: number;
  canvasViewportH: number;
  setCanvasScroll: (x: number, y: number) => void;
  setCanvasViewportSize: (w: number, h: number) => void;
  centerOnElement: (elementId: string) => void;

  /**
   * Element id that CanvasArea should focus on next render. Set by
   * `centerOnElement`; CanvasArea consumes it via useEffect, applies
   * the pan/zoom to its transformRef, then clears it. This avoids the
   * store ↔ transformRef sync cycle (centerOnElement used to write
   * canvasScrollX/Y directly, but CanvasArea's debounced
   * syncCanvasStateToStore would overwrite it on the next pan).
   */
  pendingFocusElementId: string | null;
  clearPendingFocus: () => void;

  // Unified canvas contents getter
  getCanvasContents: () => CanvasElement[];

  // Native element selectors
  getNativeNodes: () => CanvasElement[];
  getConnectors: () => CanvasElement[];

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

  // Undo/Redo
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  setUndoRedo: (canUndo: boolean, canRedo: boolean) => void;
  autoLayout: () => void;

  // History
  setActions: (actions: ConductorAction[]) => void;
  setActorFilter: (actor: Actor | "all") => void;
  setWidgetFilter: (widgetId: string | null) => void;

  // Agent streaming
  setAgentStatus: (status: AgentStreamStatus) => void;
  addAgentStreamItem: (item: AgentStreamItem) => void;
  clearAgentStream: () => void;
  setUiStatus: (status: ConductorUiStatus, syncStatusText?: string) => void;
  setSelectedWidgetId: (widgetId: string | null) => void;
  setSelectedElementId: (elementId: string | null) => void;
  toggleElementSelection: (elementId: string) => void;
  setSelectedElementIds: (elementIds: string[]) => void;
  setActiveTool: (tool: string | null) => void;
  setEditingElementId: (elementId: string | null) => void;
  clearSelection: () => void;
  setSyncStatusText: (text: string) => void;
  setUiError: (message: string | null) => void;

  // Model selection
  fetchConductorModels: () => Promise<void>;
  setConductorModel: (modelId: string) => void;

  // Conductor settings
  loadConductorSettings: () => Promise<void>;
  setConductorVisionModel: (modelId: string) => void;
  setConductorPermissionMode: (mode: "default" | "auto" | "bypass") => void;
  setConductorSettingsOpen: (open: boolean) => void;
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
  actorFilter: "all",
  widgetFilter: null,
  agentStatus: "idle",
  agentStream: [],
  uiStatus: "idle",
  selectedWidgetId: null,
  selectedElementId: null,
  activeTool: null,
  editingElementId: null,
  selectedElementIds: [],
  syncStatusText: "",
  uiError: null,
  bridgeUnsubscribe: null,
  conductorModels: [],
  conductorModel: "",
  conductorProviderId: null,
  conductorModelsLoading: false,
  conductorVisionModel: "",
  conductorPermissionMode: "default",
  conductorSettingsOpen: false,
  conductorSettingsLoading: false,
  canvasZoom: 1,
  canvasScrollX: 0,
  canvasScrollY: 0,
  canvasViewportW: 0,
  canvasViewportH: 0,
  pendingFocusElementId: null,

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

  setElements: (elements) => set({ elements: elements.map(normalizeElement) }),

  addElement: (element) =>
    set((state) => ({ elements: [...state.elements, normalizeElement(element)] })),

  updateElement: (elementId, patch) =>
    set((state) => ({
      elements: state.elements.map((e) => {
        if (e.id !== elementId) return e;
        // Only re-normalize position when the patch touches it; otherwise
        // preserve the existing element shape untouched.
        const merged = patch.position
          ? { ...e, ...patch, position: normalizePosition({ ...e.position, ...patch.position }) }
          : { ...e, ...patch };
        return merged;
      }),
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
            elements: [...elements, normalizeElement(incoming)],
            canUndo: true,
            canRedo: false,
            uiStatus: "idle",
            syncStatusText: "",
          });
        }
        // Dual-write handled — skip standalone element.create check below
        return;
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
        const rpPos = resultPatch.position as Partial<CanvasPosition>;
        get().updateWidget(patch.widgetId as string, {
          position: normalizePosition(rpPos),
          updatedAt: Date.now(),
        });
        const { elements: moveEls } = get();
        const existingEl = moveEls.find(e => e.id === patch.widgetId);
        get().updateElement(patch.widgetId as string, {
          // Preserve existing zIndex/rotation when the patch omits them.
          position: normalizePosition({
            ...existingEl?.position,
            ...rpPos,
          }),
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
            elements: [...elements, normalizeElement(incoming)],
            canUndo: true,
            canRedo: false,
            uiStatus: "idle",
            syncStatusText: "",
          });
          // Auto-focus on agent-created elements so the user can see
          // what the agent is working on. Skip when actor is 'user'
          // (user drags place the element where they want it).
          if (patch.actor === 'agent') {
            // Defer to next tick so the new element is committed to
            // the store before centerOnElement reads it.
            setTimeout(() => {
              get().centerOnElement(incoming.id);
            }, 0);
          }
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
  setSelectedElementId: (selectedElementId) => set({ selectedElementId, selectedElementIds: selectedElementId ? [selectedElementId] : [] }),
  toggleElementSelection: (elementId) =>
    set((state) => {
      const exists = state.selectedElementIds.includes(elementId);
      return {
        selectedElementIds: exists
          ? state.selectedElementIds.filter((id) => id !== elementId)
          : [...state.selectedElementIds, elementId],
        selectedElementId: exists ? state.selectedElementId : elementId,
      };
    }),
  setSelectedElementIds: (selectedElementIds) => set({ selectedElementIds }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setEditingElementId: (editingElementId) => set({ editingElementId }),
  clearSelection: () => set({ selectedElementIds: [], selectedElementId: null, selectedWidgetId: null, editingElementId: null }),

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
    const host = getConductorHostOrNull();
    if (!host) {
      set({ conductorModels: [], conductorModelsLoading: false });
      return;
    }
    try {
      const providers = await host.listProviders();
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
    // Persist the model selection
    const host = getConductorHostOrNull();
    host?.settings?.setString("conductor.model", modelId).catch(() => {});
  },

  loadConductorSettings: async () => {
    const host = getConductorHostOrNull();
    if (!host?.settings) return;

    set({ conductorSettingsLoading: true });
    try {
      const [model, visionModel, permissionMode] = await Promise.all([
        host.settings.getString("conductor.model"),
        host.settings.getString("conductor.visionModel"),
        host.settings.getString("conductor.permissionMode"),
      ]);

      const patch: Partial<ConductorState> = { conductorSettingsLoading: false };
      if (model) patch.conductorModel = model;
      if (visionModel) patch.conductorVisionModel = visionModel;
      if (permissionMode === "default" || permissionMode === "auto" || permissionMode === "bypass") {
        patch.conductorPermissionMode = permissionMode;
      }
      set(patch);
    } catch {
      set({ conductorSettingsLoading: false });
    }
  },

  setConductorVisionModel: (modelId) => {
    set({ conductorVisionModel: modelId });
    const host = getConductorHostOrNull();
    host?.settings?.setString("conductor.visionModel", modelId).catch(() => {});
  },

  setConductorPermissionMode: (mode) => {
    set({ conductorPermissionMode: mode });
    const host = getConductorHostOrNull();
    host?.settings?.setString("conductor.permissionMode", mode).catch(() => {});
  },

  setConductorSettingsOpen: (open) => set({ conductorSettingsOpen: open }),

  setCanvasZoom: (zoom) => set({ canvasZoom: zoom }),

  setCanvasScroll: (x, y) => set({ canvasScrollX: x, canvasScrollY: y }),

  setCanvasViewportSize: (w, h) => set({ canvasViewportW: w, canvasViewportH: h }),

  centerOnElement: (elementId) => {
    const { elements } = get();
    const el = elements.find((e) => e.id === elementId);
    if (!el) return;
    // Don't compute pan/zoom here — CanvasArea owns transformRef and
    // will apply the focus in its own effect (where it has access to
    // the live viewport size and transformRef). Setting
    // pendingFocusElementId is enough to trigger that effect.
    set({ pendingFocusElementId: elementId });
  },

  clearPendingFocus: () => set({ pendingFocusElementId: null }),

  getCanvasContents: () => {
    const { elements, widgets } = get();
    if (elements.length > 0) {
      const elementIds = new Set(elements.map(e => e.id));
      const orphanWidgets = widgets.filter(w => !elementIds.has(w.id));
      if (orphanWidgets.length === 0) return elements;
      return [...elements, ...orphanWidgets.map(w => widgetToElementAdapter(w))];
    }
    return widgets.map(w => widgetToElementAdapter(w));
  },

  getNativeNodes: () => {
    const { elements } = get();
    return elements.filter((e) => e.elementKind?.startsWith('native/') && e.elementKind !== 'native/connector');
  },

  getConnectors: () => {
    const { elements } = get();
    return elements.filter((e) => e.elementKind === 'native/connector');
  },
}));

/**
 * Resolve an element's top-left canvas position in **grid units**.
 * Returns the parent's grid-unit offset plus this node's grid-unit offset.
 * Callers that need pixel coordinates should multiply by GRID_PX.
 */
export function getAbsolutePosition(node: CanvasElement, allNodes: CanvasElement[]): { x: number; y: number } {
  if (!node.metadata?.parentId) return { x: node.position.x, y: node.position.y };
  const parent = allNodes.find((n) => n.id === node.metadata.parentId);
  if (!parent) return { x: node.position.x, y: node.position.y };
  const parentAbs = getAbsolutePosition(parent, allNodes);
  return { x: parentAbs.x + node.position.x, y: parentAbs.y + node.position.y };
}
