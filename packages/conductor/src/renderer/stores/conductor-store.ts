import { create } from "zustand";
import type { ConductorCanvas, ConductorCanvasGroup, ConductorWidget, ConductorSnapshot, ConductorAction, Actor, CanvasElement, CanvasPosition } from "..//types/conductor";
import { ConductorBridge } from "..//ipc/conductor-bridge";
import { undoAction, redoAction, executeAction, updateCanvas, createCanvasGroup, updateCanvasGroup, deleteCanvasGroup } from "..//ipc/conductor-ipc";
import { getConductorHostOrNull, type ModelOption, type ConductorModelInfo } from "..//host";
import { widgetToElementAdapter } from "..//ipc/widget-element-adapter";
import { CanvasSpatialIndex } from "../domain/canvas/spatialIndex";

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
  // Map it so canvas kind checks do not crash on an undefined legacy value.
  // Also fill defaults for any other required fields the patch may omit —
  // `summarizeElementForAgent` (backend) intentionally strips permissions,
  // state, dataVersion, metadata, timestamps, vizSpec, sourceCode, canvasId
  // to keep agent tool results short, but the renderer needs the full shape.
  // Without these defaults, WidgetElement crashes on `element.permissions.agentCanRead`.
  const { kind, elementKind, ...rest } = el as CanvasElement & { kind?: string };
  const DEFAULT_PERMISSIONS = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };
  const permissions =
    rest.permissions && typeof rest.permissions === 'object'
      ? {
          agentCanRead: rest.permissions.agentCanRead ?? true,
          agentCanWrite: rest.permissions.agentCanWrite ?? true,
          agentCanDelete: rest.permissions.agentCanDelete ?? true,
        }
      : DEFAULT_PERMISSIONS;
  return {
    ...rest,
    elementKind: elementKind ?? kind ?? 'native/sticky',
    position: normalizePosition(el.position),
    canvasId: rest.canvasId ?? '',
    config: rest.config ?? {},
    state: rest.state ?? 'idle',
    dataVersion: rest.dataVersion ?? 1,
    vizSpec: rest.vizSpec ?? null,
    sourceCode: rest.sourceCode ?? null,
    permissions,
    metadata:
      rest.metadata && typeof rest.metadata === 'object'
        ? rest.metadata
        : { label: elementKind ?? kind ?? 'native/sticky', tags: [], createdBy: 'user' as const },
    createdAt: rest.createdAt ?? Date.now(),
    updatedAt: rest.updatedAt ?? Date.now(),
  };
}

type ModelInfo = ConductorModelInfo;

/**
 * The single normalisation path for every element array entering the store.
 *
 * A canvas load (`setSnapshot`), a full widget-hydration patch and `setElements`
 * all deliver rows in the same shape, so all three must go through here: when
 * `setSnapshot` assigned the raw rows while `setElements` normalised them, an
 * element's position / permission / metadata defaults depended on whether it
 * arrived via a patch or via a reload, and the same canvas rendered two ways.
 */
function normalizeElements(elements: CanvasElement[]): CanvasElement[] {
  return elements.map(normalizeElement);
}

/** `set` as Zustand exposes it inside the store factory. */
type SetState = (
  partial: Partial<ConductorState> | ((state: ConductorState) => Partial<ConductorState>),
) => void;

/**
 * Undo/redo cursor. Seeded from the persisted `snapshot.actionCursor` and moved
 * only by confirmed evidence — a snapshot load, a patch for an action the
 * backend already persisted, or an IPC result that reported success.
 */
interface HistoryCursor {
  /** Actions applied and not yet reverted. */
  undoDepth: number;
  /** Actions reverted and not yet reapplied. */
  redoDepth: number;
}

/**
 * The one writer of `canUndo` / `canRedo`.
 *
 * Previously each call site set the two booleans itself, so a single undo
 * hard-disabled Undo and a *failed* undo still enabled Redo. Deriving both
 * flags from the cursor means a failed action cannot move the cursor, and the
 * flags can never disagree with each other.
 */
function commitHistory(set: SetState, mutate: (cursor: HistoryCursor) => HistoryCursor): void {
  set((state) => {
    const history = mutate(state.history);
    return {
      history,
      canUndo: history.undoDepth > 0,
      canRedo: history.redoDepth > 0,
    };
  });
}

/**
 * Cursor step for an action the backend has already persisted and broadcast.
 * A newly applied action extends the undo branch and invalidates the redo
 * branch, which is what the old unconditional `canUndo: true, canRedo: false`
 * was trying to express.
 */
function noteAppliedAction(cursor: HistoryCursor): HistoryCursor {
  return { undoDepth: cursor.undoDepth + 1, redoDepth: 0 };
}

/** Ids a connector config points at, across every persisted endpoint shape. */
function connectorEndpointNodeIds(config: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["source", "target"] as const) {
    const endpoint = config[key];
    if (!endpoint || typeof endpoint !== "object") continue;
    const nodeId = (endpoint as { nodeId?: unknown }).nodeId;
    if (typeof nodeId === "string" && nodeId) ids.push(nodeId);
  }
  return ids;
}

/** Ids a group config claims as members. */
function groupMemberIds(config: Record<string, unknown>): string[] {
  const memberIds = config.memberIds;
  return Array.isArray(memberIds) ? memberIds.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Collect every id that must disappear with `rootId`: the element itself, the
 * connectors bound to it, and any group left with no live member.
 *
 * The set is expanded to a fixed point before anything is deleted, so a
 * connector bound to a node that is itself being removed is collected exactly
 * once and never re-entered — a per-element recursive delete would visit it
 * twice and emit a second delete for an already-deleted id.
 */
function collectRemovals(elements: CanvasElement[], rootId: string): Set<string> {
  const removedIds = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of elements) {
      if (removedIds.has(el.id)) continue;
      if (el.elementKind === "native/connector") {
        // A connector whose endpoint node is gone resolves to `null` in
        // connector-renderer and draws nothing, but it stayed in `elements[]`
        // and reappeared if the id was ever reused.
        if (connectorEndpointNodeIds(el.config).some((id) => removedIds.has(id))) {
          removedIds.add(el.id);
          grew = true;
        }
        continue;
      }
      if (el.elementKind === "native/group") {
        const members = groupMemberIds(el.config);
        if (members.length === 0) continue;
        const hasLiveMember = members.some(
          (id) => !removedIds.has(id) && elements.some((m) => m.id === id),
        );
        if (!hasLiveMember) {
          removedIds.add(el.id);
          grew = true;
        }
      }
    }
  }
  return removedIds;
}

/**
 * Shared spatial index for the active canvas. Kept in sync with
 * elements[] on every create/move/resize/delete via the store
 * actions. UI reads from this index for hit-test and
 * alignment-candidate pruning.
 *
 * Module-level (not in Zustand state) because RBush is a mutable
 * class instance — Zustand's immutable updates would thrash the
 * tree on every change. The index is a derived view of elements,
 * not independent state.
 */
export const canvasSpatialIndex = new CanvasSpatialIndex();

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
  /**
   * Records who caused the most recent elements-array mutation. The canvas
   * auto-fit effect reads this so it re-fits ONLY after the agent adds or
   * removes elements (a freshly generated scene settling into view) — never
   * after the user works with canvas tools, which would otherwise yank their
   * carefully-framed zoom/pan out from under them.
   */
  lastElementMutationActor: Actor | null;
  snapshot: ConductorSnapshot | null;
  editMode: boolean;
  /**
   * Derived from `history` by `commitHistory` — the only writer. `canUndo` is
   * read by `RefinePanel`; `canRedo` has no reader yet but is kept in step with
   * the same cursor so a future redo control cannot read a stale value.
   */
  canUndo: boolean;
  canRedo: boolean;
  history: HistoryCursor;
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

  /** Rebuild the spatial index from current elements. Called after snapshot load. */
  rebuildSpatialIndex: () => void;

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

  /**
   * Element id requested by an external consumer (e.g. a chat tool-use
   * row) to be focused once the canvas is visible and the element is
   * loaded. SidebarConductorView watches this and applies the focus.
   */
  pendingChatFocusElementId: string | null;
  setPendingChatFocusElementId: (elementId: string | null) => void;
  clearPendingChatFocus: () => void;

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

  // Canvas asset library (Notion-style)
  canvasGroups: ConductorCanvasGroup[];
  setCanvasGroups: (groups: ConductorCanvasGroup[]) => void;
  canvasView: "gallery" | "table";
  setCanvasView: (view: "gallery" | "table") => void;
  canvasSort: { field: "name" | "createdAt" | "updatedAt" | "manual"; dir: "asc" | "desc" };
  setCanvasSort: (sort: { field: "name" | "createdAt" | "updatedAt" | "manual"; dir: "asc" | "desc" }) => void;
  canvasFilter: { favoritesOnly: boolean; groupId: string | null; tag: string | null; search: string };
  setCanvasFilter: (patch: Partial<{ favoritesOnly: boolean; groupId: string | null; tag: string | null; search: string }>) => void;
  toggleFavorite: (canvasId: string) => Promise<void>;
  setCanvasGroup: (canvasId: string, groupId: string | null) => Promise<void>;
  setCanvasTags: (canvasId: string, tags: string[]) => Promise<void>;
  createGroup: (name: string) => Promise<ConductorCanvasGroup | null>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;

  // Snapshot / widget hydration
  setSnapshot: (snapshot: ConductorSnapshot) => void;
  setWidgets: (widgets: ConductorWidget[]) => void;
  addWidget: (widget: ConductorWidget) => void;
  updateWidget: (widgetId: string, patch: Partial<ConductorWidget>) => void;
  removeWidget: (widgetId: string) => void;

  // Plan 570: canvas workbench runtime data. Keyed by canvasId; snapshots
  // keyed by data-source id or `handler:<name>`.
  workbenchData: Record<string, { snapshots: Record<string, unknown>; refreshedAt?: number }>;
  applyWorkbenchData: (canvasId: string, snapshots: Record<string, unknown>, refreshedAt?: number) => void;
  clearWorkbenchData: (canvasId: string) => void;

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
  lastElementMutationActor: null,
  snapshot: null,
  editMode: true,
  canUndo: false,
  canRedo: false,
  history: { undoDepth: 0, redoDepth: 0 },
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
  pendingChatFocusElementId: null,

  setCanvases: (canvases) => set({ canvases }),

  // Idempotent by canvas id. `conductor:canvas:changed` broadcasts a `create`
  // that can race the renderer's own initial list load, and a blind append
  // produced two rows with the same id — which React then reported as
  // duplicate keys in CanvasLibraryView / CanvasSelector. A repeated
  // broadcast refreshes the existing row instead of adding a second one.
  addCanvas: (canvas) =>
    set((state) => {
      const index = state.canvases.findIndex((c) => c.id === canvas.id);
      if (index === -1) return { canvases: [...state.canvases, canvas] };
      const next = [...state.canvases];
      next[index] = canvas;
      return { canvases: next };
    }),

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

  canvasGroups: [],
  setCanvasGroups: (groups) => set({ canvasGroups: groups }),

  canvasView: "gallery",
  setCanvasView: (view) => set({ canvasView: view }),

  canvasSort: { field: "updatedAt", dir: "desc" },
  setCanvasSort: (sort) => set({ canvasSort: sort }),

  canvasFilter: { favoritesOnly: false, groupId: null, tag: null, search: "" },
  setCanvasFilter: (patch) =>
    set((state) => ({ canvasFilter: { ...state.canvasFilter, ...patch } })),

  toggleFavorite: async (canvasId) => {
    const canvas = get().canvases.find((c) => c.id === canvasId);
    if (!canvas) return;
    const next = !canvas.isFavorite;
    try {
      const updated = await updateCanvas(canvasId, { isFavorite: next });
      if (updated) {
        set((state) => ({
          canvases: state.canvases.map((c) => (c.id === canvasId ? updated : c)),
        }));
      }
    } catch {
      // IPC failure — leave optimistic local state unchanged
    }
  },

  setCanvasGroup: async (canvasId, groupId) => {
    try {
      const updated = await updateCanvas(canvasId, { groupId });
      if (updated) {
        set((state) => ({
          canvases: state.canvases.map((c) => (c.id === canvasId ? updated : c)),
        }));
      }
    } catch {
      /* IPC failure */
    }
  },

  setCanvasTags: async (canvasId, tags) => {
    try {
      const updated = await updateCanvas(canvasId, { tags });
      if (updated) {
        set((state) => ({
          canvases: state.canvases.map((c) => (c.id === canvasId ? updated : c)),
        }));
      }
    } catch {
      /* IPC failure */
    }
  },

  createGroup: async (name) => {
    if (!name.trim()) return null;
    try {
      const group = await createCanvasGroup({ name: name.trim() });
      set((state) => ({ canvasGroups: [...state.canvasGroups, group] }));
      return group;
    } catch {
      return null;
    }
  },

  renameGroup: async (groupId, name) => {
    if (!name.trim()) return;
    try {
      const updated = await updateCanvasGroup(groupId, { name: name.trim() });
      if (updated) {
        set((state) => ({
          canvasGroups: state.canvasGroups.map((g) => (g.id === groupId ? updated : g)),
        }));
      }
    } catch {
      /* IPC failure */
    }
  },

  deleteGroup: async (groupId) => {
    try {
      const ok = await deleteCanvasGroup(groupId);
      if (ok) {
        set((state) => ({
          canvasGroups: state.canvasGroups.filter((g) => g.id !== groupId),
          // Clear the filter if it pointed at the deleted group
          canvasFilter:
            state.canvasFilter.groupId === groupId
              ? { ...state.canvasFilter, groupId: null }
              : state.canvasFilter,
        }));
      }
    } catch {
      /* IPC failure */
    }
  },

  setSnapshot: (snapshot) => {
    // Same normalisation path as `setElements` and the hydration patch — see
    // `normalizeElements`.
    const raw = (snapshot as ConductorSnapshot & { elements?: CanvasElement[] }).elements ?? [];
    const elements = normalizeElements(raw);
    set({ snapshot, widgets: snapshot.widgets, elements });
    canvasSpatialIndex.rebuild(elements);
    // The action log's real extent, as persisted. Nothing here moves the
    // cursor afterwards except a confirmed outcome.
    commitHistory(set, () => ({
      undoDepth: Math.max(0, snapshot.actionCursor ?? 0),
      redoDepth: 0,
    }));
  },

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

  // Plan 570: workbench runtime data — merge per-source snapshots so a
  // refresh of one source never blanks the others.
  workbenchData: {},

  applyWorkbenchData: (canvasId, snapshots, refreshedAt) =>
    set((state) => {
      const existing = state.workbenchData[canvasId] ?? { snapshots: {} };
      return {
        workbenchData: {
          ...state.workbenchData,
          [canvasId]: {
            snapshots: { ...existing.snapshots, ...snapshots },
            refreshedAt: refreshedAt ?? existing.refreshedAt,
          },
        },
      };
    }),

  clearWorkbenchData: (canvasId) =>
    set((state) => {
      if (!(canvasId in state.workbenchData)) return state;
      const next = { ...state.workbenchData };
      delete next[canvasId];
      return { workbenchData: next };
    }),

  setElements: (elements) => {
    const normalized = normalizeElements(elements);
    set({ elements: normalized });
    canvasSpatialIndex.rebuild(normalized);
  },

  addElement: (element) => {
    const normalized = normalizeElement(element);
    set((state) => ({ elements: [...state.elements, normalized] }));
    // User-local creation (canvas tools draw elements directly). Marking it
    // as a user mutation prevents the canvas auto-fit effect from resetting
    // the user's zoom/pan when they add an element themselves.
    set({ lastElementMutationActor: "user" });
    canvasSpatialIndex.upsert(normalized);
  },

  updateElement: (elementId, patch) => {
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
    }));
    const updated = get().elements.find((e) => e.id === elementId);
    if (updated) canvasSpatialIndex.upsert(updated);
  },

  removeElement: (elementId) => {
    const { elements } = get();
    const removedIds = collectRemovals(elements, elementId);
    if (removedIds.size === 0) return;
    set((state) => ({
      elements: state.elements
        .filter((e) => !removedIds.has(e.id))
        // Surviving groups drop the deleted ids from their member list, so a
        // group cannot keep listing members that no longer exist.
        .map((e) => {
          if (e.elementKind !== "native/group") return e;
          const members = groupMemberIds(e.config);
          if (!members.some((id) => removedIds.has(id))) return e;
          return {
            ...e,
            config: {
              ...e.config,
              memberIds: members.filter((id) => !removedIds.has(id)),
            },
            updatedAt: Date.now(),
          };
        }),
      selectedElementId: state.selectedElementId && removedIds.has(state.selectedElementId)
        ? null
        : state.selectedElementId,
      selectedElementIds: state.selectedElementIds.filter((id) => !removedIds.has(id)),
    }));
    for (const id of removedIds) {
      canvasSpatialIndex.remove(id);
    }
  },

  connectBridge: (canvasId) => {
    const { bridgeUnsubscribe } = get();
    if (bridgeUnsubscribe) {
      bridgeUnsubscribe();
    }

    const unsub = ConductorBridge.connect(canvasId);

    const cleanupPatch = ConductorBridge.onStatePatch((patch) => {
      const { widgets } = get();
      const resultPatch = (patch.resultPatch as Record<string, unknown> | undefined) ?? undefined;

      // Plan 570: workbench runtime data — a refreshed data source or a
      // handler result pushed by the main process. Handled before the
      // element-patch machinery which would otherwise ignore it.
      if (patch.type === "conductor:data:update" && typeof patch.canvasId === "string") {
        const dataPayload = patch as unknown as {
          canvasId: string;
          sourceId: string;
          snapshot: unknown;
          refreshedAt: number;
        };
        get().applyWorkbenchData(dataPayload.canvasId, {
          [dataPayload.sourceId]: dataPayload.snapshot,
        }, dataPayload.refreshedAt);
        return;
      }

      // Full widget list hydration patch
      if (patch.widgets && Array.isArray(patch.widgets)) {
        // Same normalisation path as a snapshot load — see `normalizeElements`.
        const hydrated = normalizeElements(
          (patch as unknown as { elements?: CanvasElement[] }).elements ?? [],
        );
        set({
          widgets: patch.widgets as ConductorWidget[],
          elements: hydrated,
          uiStatus: "idle",
          syncStatusText: "",
        });
        canvasSpatialIndex.rebuild(hydrated);
        // A re-hydration says nothing about the action log, so the cursor is
        // left as loaded rather than guessed at.
        return;
      }

      // widget.create -> append widget from resultPatch
      if (resultPatch?.widget && typeof resultPatch.widget === "object") {
        const incoming = resultPatch.widget as ConductorWidget;
        const exists = widgets.some((w) => w.id === incoming.id);
        if (!exists) {
          set({
            widgets: [...widgets, incoming],
            uiStatus: "idle",
            syncStatusText: "",
          });
          commitHistory(set, noteAppliedAction);
        }
      }

      // widget.create also writes element (dual-write) -> append element from resultPatch
      if (resultPatch?.element && typeof resultPatch.element === "object") {
        const incoming = resultPatch.element as CanvasElement;
        const { elements } = get();
        const exists = elements.some((e) => e.id === incoming.id);
        if (!exists) {
          const normalized = normalizeElement(incoming);
          set({
            elements: [...elements, normalized],
            uiStatus: "idle",
            syncStatusText: "",
            lastElementMutationActor: patch.actor === "agent" ? "agent" : "user",
          });
          canvasSpatialIndex.upsert(normalized);
          commitHistory(set, noteAppliedAction);
        }
        // Dual-write handled — skip standalone element.create check below
        return;
      }

      // widget.delete -> remove widget by widgetId and element by elementId
      if (resultPatch?.deletedWidget && patch.widgetId) {
        get().removeWidget(patch.widgetId as string);
        get().removeElement(patch.widgetId as string);
        set({
          uiStatus: "idle",
          syncStatusText: "",
        });
        commitHistory(set, noteAppliedAction);
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
          uiStatus: "idle",
          syncStatusText: "",
        });
        commitHistory(set, noteAppliedAction);
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
          uiStatus: "idle",
          syncStatusText: "",
        });
        commitHistory(set, noteAppliedAction);
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
          uiStatus: "idle",
          syncStatusText: "",
        });
        commitHistory(set, noteAppliedAction);
      }

      // element.batch_create -> append ALL elements, then focus on the
      // first one. Without this branch, batch_create patches were emitted
      // by db-service but silently dropped here, so the canvas only
      // updated on the next full snapshot reload.
      if (Array.isArray(resultPatch?.elements) && resultPatch.elements.length > 0) {
        const incoming = resultPatch.elements as CanvasElement[];
        const { elements: existing } = get();
        const existingIds = new Set(existing.map((e) => e.id));
        const fresh = incoming.filter((e) => !existingIds.has(e.id));
        if (fresh.length > 0) {
          const freshNormalized = normalizeElements(fresh);
          set({
            elements: [...existing, ...freshNormalized],
            uiStatus: "idle",
            syncStatusText: "",
            lastElementMutationActor: patch.actor === "agent" ? "agent" : "user",
          });
          for (const el of freshNormalized) {
            canvasSpatialIndex.upsert(el);
          }
          commitHistory(set, noteAppliedAction);
          // Auto-focus on the first newly created element so the user
          // sees the agent's work appear in view.
          if (patch.actor === 'agent') {
            const focusId = fresh[0].id;
            setTimeout(() => {
              get().centerOnElement(focusId);
            }, 0);
          }
        }
        return;
      }

      // element.create / connector.create / element.create_native ->
      // append single element from resultPatch.element
      if (resultPatch?.element && typeof resultPatch.element === "object") {
        const incoming = resultPatch.element as CanvasElement;
        const { elements } = get();
        const exists = elements.some((e) => e.id === incoming.id);
        if (!exists) {
          const normalized = normalizeElement(incoming);
          set({
            elements: [...elements, normalized],
            uiStatus: "idle",
            syncStatusText: "",
            lastElementMutationActor: patch.actor === "agent" ? "agent" : "user",
          });
          canvasSpatialIndex.upsert(normalized);
          commitHistory(set, noteAppliedAction);
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
          uiStatus: "idle",
          syncStatusText: "",
          lastElementMutationActor: patch.actor === "agent" ? "agent" : "user",
        });
        commitHistory(set, noteAppliedAction);
        return;
      }

      // element.arrange -> apply the persisted layout to the live elements.
      // `db-service.arrangeElements` / `layoutGridElements` write every
      // position and broadcast `resultPatch: { layout }`; without this branch
      // the arrangement was persisted and never read, so the canvas stayed
      // put until an unrelated snapshot reload. An arrange carries no single
      // `elementId` — the ids live in the array — so this keys on `layout`
      // alone and is placed before the single-element position branch.
      const layoutPatch = (resultPatch?.layout !== undefined
        ? resultPatch.layout
        : (resultPatch?.changes as Record<string, unknown> | undefined)?.layout) as
        | Array<{ elementId?: unknown; position?: unknown }>
        | undefined;
      if (Array.isArray(layoutPatch) && layoutPatch.length > 0) {
        const { elements: currentElements } = get();
        const known = new Set(currentElements.map((e) => e.id));
        let applied = 0;
        for (const item of layoutPatch) {
          const targetId = typeof item?.elementId === "string" ? item.elementId : null;
          if (!targetId || !known.has(targetId)) continue;
          const position = item.position;
          if (!position || typeof position !== "object") continue;
          get().updateElement(targetId, {
            position: normalizePosition({
              // Preserve zIndex / rotation: the layout payload only carries
              // the geometry the packer computed.
              ...currentElements.find((e) => e.id === targetId)?.position,
              ...(position as Partial<CanvasPosition>),
            }),
            updatedAt: Date.now(),
          });
          applied += 1;
        }
        if (applied > 0) {
          set({
            uiStatus: "idle",
            syncStatusText: "",
            lastElementMutationActor: patch.actor === "agent" ? "agent" : "user",
          });
          commitHistory(set, noteAppliedAction);
        }
        return;
      }

      // element.move / element.update (position) — read position from
      // either top-level (alignElement) or changes.position (updateElement).
      // The old handler only checked top-level, so canvas_move_element and
      // canvas_resize_element patches were silently dropped.
      const positionPatch =
        (resultPatch?.position && typeof resultPatch.position === "object"
          ? resultPatch.position
          : (resultPatch?.changes as Record<string, unknown> | undefined)?.position) as
          | Partial<CanvasPosition>
          | undefined;
      if (patch.elementId && positionPatch && !patch.widgetId) {
        get().updateElement(patch.elementId as string, {
          position: normalizePosition(positionPatch),
          updatedAt: Date.now(),
        });
        set({
          uiStatus: "idle",
          syncStatusText: "",
        });
        commitHistory(set, noteAppliedAction);
        return;
      }

      // element.update_content / element.update (config) — read config
      // from either top-level or changes.config. The old handler only
      // checked top-level, so canvas_fill_content and canvas_style_element
      // patches were silently dropped.
      const configPatch =
        (resultPatch?.config !== undefined
          ? resultPatch.config
          : (resultPatch?.changes as Record<string, unknown> | undefined)?.config) as
          | Record<string, unknown>
          | undefined;
      const vizSpecPatch =
        (resultPatch?.vizSpec !== undefined
          ? resultPatch.vizSpec
          : (resultPatch?.changes as Record<string, unknown> | undefined)?.vizSpec) as
          | Record<string, unknown>
          | undefined;
      const sourceCodePatch =
        (resultPatch?.sourceCode !== undefined
          ? resultPatch.sourceCode
          : (resultPatch?.changes as Record<string, unknown> | undefined)?.sourceCode) as
          | string
          | undefined;
      const metadataPatch =
        (resultPatch?.metadata !== undefined
          ? resultPatch.metadata
          : (resultPatch?.changes as Record<string, unknown> | undefined)?.metadata) as
          | CanvasElement['metadata']
          | undefined;
      if (patch.elementId && (configPatch !== undefined || vizSpecPatch !== undefined || sourceCodePatch !== undefined || metadataPatch !== undefined)) {
        const elementPatch: Partial<CanvasElement> = { updatedAt: Date.now() };
        if (configPatch !== undefined) {
          elementPatch.config = configPatch as Record<string, unknown>;
        }
        if (vizSpecPatch !== undefined) {
          elementPatch.vizSpec = vizSpecPatch as any;
        }
        if (sourceCodePatch !== undefined) {
          (elementPatch as Record<string, unknown>).sourceCode = sourceCodePatch;
        }
        if (metadataPatch !== undefined) {
          elementPatch.metadata = metadataPatch;
        }
        get().updateElement(patch.elementId as string, elementPatch);
        set({
          uiStatus: "idle",
          syncStatusText: "",
        });
        commitHistory(set, noteAppliedAction);
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
        // Only a confirmed revert moves the cursor. Previously the flags were
        // rewritten after the if/else, so one undo disabled Undo outright and
        // a *failed* undo still turned Redo on.
        commitHistory(set, (cursor) => ({
          undoDepth: Math.max(0, cursor.undoDepth - 1),
          redoDepth: cursor.redoDepth + 1,
        }));
      } else {
        set({ uiStatus: "error", syncStatusText: "Failed to revert action" });
        get().setUiError("Undo failed");
      }
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
        // Same rule as undo: the cursor follows the confirmed outcome only.
        commitHistory(set, (cursor) => ({
          undoDepth: cursor.undoDepth + 1,
          redoDepth: Math.max(0, cursor.redoDepth - 1),
        }));
      } else {
        set({ uiStatus: "error", syncStatusText: "Failed to reapply action" });
        get().setUiError("Redo failed");
      }
    } catch {
      set({ uiStatus: "error", syncStatusText: "Failed to reapply action" });
      get().setUiError("Redo failed");
    }
  },

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
  setSelectedElementIds: (selectedElementIds) => set({
    selectedElementIds,
    // Keep `selectedElementId` in sync with the array — otherwise a stale
    // value can match a different element while the array holds one id,
    // producing two toolbar portals (one anchored to the stale match,
    // one to the array match) for what is supposed to be a single-
    // element selection. For multi-select (length > 1) clear it; for
    // single-select mirror the array; for empty, clear it.
    selectedElementId: selectedElementIds.length === 1 ? selectedElementIds[0] : null,
  }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setEditingElementId: (editingElementId) => set({ editingElementId }),
  clearSelection: () => set({ selectedElementIds: [], selectedElementId: null, selectedWidgetId: null, editingElementId: null }),

  setSyncStatusText: (syncStatusText) => set({ syncStatusText }),

  setUiError: (uiError) => set({ uiError }),

  autoLayout: () => {
    const { widgets, elements, activeCanvasId } = get();
    if (!activeCanvasId) return;

    // Both collections are laid out. `elements` is what the canvas actually
    // renders (`ElementRenderer` dispatches on `native/*`); `widgets` is the
    // legacy parallel list still rendered for widget kinds. The old version
    // bailed out when `widgets` was empty and never touched `elements`, so on
    // any canvas that had migrated to elements the button did nothing at all.
    const COLS = 12;
    const pack = (items: Array<{ id: string; position: { w: number } }>) => {
      const placed: Array<{ id: string; x: number; y: number }> = [];
      let row = 0;
      let col = 0;
      for (const item of items) {
        const w = Number.isFinite(item.position.w) && item.position.w > 0 ? item.position.w : 1;
        if (col + w > COLS) {
          col = 0;
          row += 1;
        }
        placed.push({ id: item.id, x: col, y: row });
        col += w;
        if (col >= COLS) {
          col = 0;
          row += 1;
        }
      }
      return placed;
    };

    const newWidgets = pack(widgets);
    // Connectors are excluded, matching the backend layout: their geometry is
    // derived from their endpoints, so a position move is a no-op that would
    // only add an action-log entry per connector.
    const newElements = pack(elements.filter((e) => e.elementKind !== "native/connector"));
    if (newWidgets.length === 0 && newElements.length === 0) return;

    // Optimistic local move, exactly as before for widgets and now for
    // elements too, so the canvas responds without waiting for the round trip.
    const widgetMoves = new Map(newWidgets.map((m) => [m.id, m]));
    const elementMoves = new Map(newElements.map((m) => [m.id, m]));
    set({
      widgets: widgets.map((w) => {
        const move = widgetMoves.get(w.id);
        return move ? { ...w, position: { ...w.position, x: move.x, y: move.y }, updatedAt: Date.now() } : w;
      }),
      uiStatus: "syncing",
      syncStatusText: "Applying automatic layout...",
    });
    for (const move of newElements) {
      get().updateElement(move.id, {
        position: normalizePosition({
          ...elements.find((e) => e.id === move.id)?.position,
          x: move.x,
          y: move.y,
        }),
      });
    }

    // Sequential, not a concurrent burst. Every move appends to one action log
    // and broadcasts its own patch, so firing them all at once let the first
    // `.then` clear `uiStatus` while the rest were still in flight and let a
    // late rejection overwrite an already-successful run with an error state.
    const moves: Array<{ id: string; x: number; y: number }> = [...newElements, ...newWidgets];
    const run = async (): Promise<void> => {
      let failed = 0;
      for (const move of moves) {
        try {
          if (elementMoves.has(move.id)) {
            // `element.move` needs the full CanvasPosition, so normalize from
            // the stored one to keep zIndex / rotation.
            await executeAction({
              action: "element.move",
              elementId: move.id,
              canvasId: activeCanvasId,
              position: normalizePosition({
                ...elements.find((e) => e.id === move.id)?.position,
                x: move.x,
                y: move.y,
              }),
            });
          } else {
            const source = widgets.find((w) => w.id === move.id);
            await executeAction({
              action: "widget.move",
              widgetId: move.id,
              canvasId: activeCanvasId,
              position: {
                x: move.x,
                y: move.y,
                w: source?.position.w ?? 1,
                h: source?.position.h ?? 1,
              },
            });
          }
        } catch {
          failed += 1;
        }
      }
      // One status write, after the whole sequence, from the aggregate
      // outcome — nothing in flight can still clobber it.
      if (failed > 0) {
        set({ uiStatus: "error", syncStatusText: "Failed to apply automatic layout" });
        get().setUiError(`Auto layout failed for ${failed} of ${moves.length} items`);
      } else {
        set({ uiStatus: "idle", syncStatusText: "" });
        get().setUiError(null);
      }
    };
    void run();
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

  rebuildSpatialIndex: () => {
    const { elements } = get();
    canvasSpatialIndex.rebuild(elements);
  },

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

  setPendingChatFocusElementId: (elementId) =>
    set({ pendingChatFocusElementId: elementId }),

  clearPendingChatFocus: () => set({ pendingChatFocusElementId: null }),

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
