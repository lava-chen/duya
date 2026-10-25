"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { getPageDescriptor, isPageId, type PageId, type PageTab } from "@/components/layout/panels/registry";
import { bashTaskOutputTabTitle } from "@/components/layout/panels/BashTaskOutputView";
import {
  layoutFromPanes,
  placePane,
  removePane,
  sanitizeLayout,
  setActivePane,
  setColumnRatios,
  setRowRatios,
  toggleExpandedPane,
  wallShapeFor,
  type PaneId,
  type WorkspaceLayout,
} from "@/components/layout/panels/layout-model";
import { useConversationStore } from "@/stores/conversation-store";

export type { PageId, PageTab } from "@/components/layout/panels/registry";

export type PanelView = "content" | "picker";

export interface PanelContextValue {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (width: number) => void;

  workspaceExpanded: boolean;
  setWorkspaceExpanded: (expanded: boolean) => void;

  panelView: PanelView;
  setPanelView: (view: PanelView) => void;

  tabs: PageTab[];
  activeTabId: string | null;

  openPanel: (pageId: PageId, params?: Record<string, unknown>) => string;
  closePanel: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabFavicon: (tabId: string, favicon: string | undefined) => void;
  /** Persist a user-dragged width for the page type (called on drag end). */
  rememberUserWidth: (pageId: PageId, width: number) => void;
  /** Forget the remembered width for a page and restore its default. */
  resetPanelWidth: (pageId: PageId) => void;
  openOrActivatePage: (pageId: PageId, params?: Record<string, unknown>) => string;
  reorderTabs: (fromId: string, toId: string, position: "before" | "after") => void;
  /** Set the pixel width of every column; the wall keeps its own width. */
  setColumnWidths: (widths: number[]) => void;
  /** Set the pixel height of every row; the wall keeps its own height. */
  setRowHeights: (heights: number[]) => void;
  /** Expand a card so it fills the wall, or collapse it back into its cell. */
  togglePaneExpanded: (paneId: string) => void;
}

/**
 * The geometry of the panel region.
 *
 * These two values change on EVERY FRAME of a drag: the region's width when
 * the outer edge is dragged, the column ratios when a wall separator is
 * dragged. They used to live in the shared panel context, which meant that
 * every consumer of that context -- the app shell, the chat view, the
 * sidebar, every panel header -- re-rendered on every pixel of the drag.
 *
 * Only the panel zone reads them, so they have their own context now: a drag
 * re-renders the zone that moves and nobody else.
 */
export interface PanelGeometryValue {
  /** The pixel width of the panel region. */
  panelWidth: number;
  /** The side panel's column tree: which column holds which pane. */
  layout: WorkspaceLayout;
}

export const PanelContext = createContext<PanelContextValue | null>(null);
export const PanelGeometryContext = createContext<PanelGeometryValue | null>(null);

const MIN_PANEL_WIDTH = 300;
// Hard ceiling keeps the panel from eating the main column on extra-wide
// windows. The real cap is the workspace ratio (see `MAX_PANEL_RATIO`).
const MAX_PANEL_WIDTH = 1120;
const DEFAULT_PANEL_WIDTH = 340;
// Allow the chat column to shrink further on small screens. The previous
// 680px floor made the minimum window width too large when a side panel
// was open; 420px keeps input readable while freeing horizontal space.
const MIN_CHAT_WIDTH = 420;
// The panel must not exceed this share of the workspace. Keeps the
// chat column readable on both 1280px and 4K windows.
const MAX_PANEL_RATIO = 0.6;
/**
 * How long the panel state waits before it is written to localStorage.
 *
 * Long enough that a drag (which changes the state on every frame) writes
 * nothing, short enough that the state is on disk before the user can
 * plausibly leave.
 */
const PERSIST_DEBOUNCE_MS = 250;
// Re-export the layout constants for siblings (e.g. PanelZone) that need
// the same caps when computing drag-resize bounds.
export { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, MAX_PANEL_RATIO, MIN_CHAT_WIDTH };

const PANEL_STORAGE_PREFIX = "duya:panel:v2:";
// Remembers the last width the user explicitly dragged a page to, keyed by
// PageId. Applied on open/activate instead of the descriptor's static
// `preferredWidth` so a manual resize survives tab switches and reloads.
const USER_WIDTHS_STORAGE_KEY = "duya:panel:user-widths:v1";
const HOME_PANEL_KEY = "__home__";

interface PersistedPanelState {
  tabs: PageTab[];
  activeTabId: string | null;
  panelOpen: boolean;
  panelView: PanelView;
  workspaceExpanded: boolean;
  /**
   * The panel wall: which card sits in which grid cell, and how the wall's
   * width and height are split. Payloads written before the wall existed do
   * not carry it, and are migrated on load (see `layoutForState`).
   */
  layout?: WorkspaceLayout;
}

function emptyPanelState(): PersistedPanelState {
  return {
    tabs: [],
    activeTabId: null,
    panelOpen: false,
    panelView: "picker",
    workspaceExpanded: false,
  };
}

function panelStorageKey(sessionKey: string): string {
  return `${PANEL_STORAGE_PREFIX}${sessionKey}`;
}

export function persistablePanelState(state: PersistedPanelState): PersistedPanelState {
  const tabs = state.tabs;
  const identities = tabs.map((tab) => ({ id: tab.id, pageId: tab.pageId }));
  const layout = state.layout ? sanitizeLayout(state.layout, identities) ?? undefined : undefined;
  return {
    ...state,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : null,
    layout,
  };
}

/**
 * The wall of a persisted state.
 *
 * A payload that already carries a wall is trusted after it is validated
 * against the tabs. A payload without one predates the wall and is
 * migrated: the cards keep the order of the old tab strip.
 */
function layoutForState(state: PersistedPanelState): WorkspaceLayout {
  const identities = state.tabs.map((tab) => ({ id: tab.id, pageId: tab.pageId }));
  const sanitized = state.layout ? sanitizeLayout(state.layout, identities) : null;
  const layout = sanitized ?? layoutFromPanes(identities);
  if (!state.activeTabId) return layout;
  return layout.panes.includes(state.activeTabId)
    ? setActivePane(layout, state.activeTabId)
    : layout;
}

/**
 * Read previously-persisted panel state. Validates `pageId` values
 * against the live registry and silently drops unknown entries so a
 * stale `localStorage` payload (e.g. after removing a page) cannot
 * crash the provider.
 */
function loadPersistedState(sessionKey: string, t: TFunc): PersistedPanelState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(panelStorageKey(sessionKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedPanelState> | null;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs: PageTab[] = [];
    for (const tab of parsed.tabs) {
      if (!tab || typeof tab.id !== "string" || !isPageId(tab.pageId)) continue;
      const normalizedTab: PageTab = {
        id: tab.id,
        pageId: tab.pageId,
        title: typeof tab.title === "string" ? tab.title : defaultPanelTitle(t, tab.pageId),
        favicon: typeof tab.favicon === "string" ? tab.favicon : undefined,
        params:
          tab.params && typeof tab.params === "object" && !Array.isArray(tab.params)
            ? (tab.params as Record<string, unknown>)
            : undefined,
      };
      tabs.push(normalizedTab);
    }
    return {
      tabs,
      activeTabId:
        typeof parsed.activeTabId === "string" &&
        tabs.some((t) => t.id === parsed.activeTabId)
          ? parsed.activeTabId
          : null,
      panelOpen: !!parsed.panelOpen,
      panelView: parsed.panelView === "picker" ? "picker" : "content",
      workspaceExpanded: parsed.workspaceExpanded === true,
      layout: parsed.layout && typeof parsed.layout === "object"
        ? (parsed.layout as WorkspaceLayout)
        : undefined,
    };
  } catch {
    return null;
  }
}

function savePersistedState(sessionKey: string, state: PersistedPanelState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(panelStorageKey(sessionKey), JSON.stringify(persistablePanelState(state)));
  } catch {
    // Quota / private mode — fail silently, the in-memory state still works.
  }
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupKey(pageId: PageId, params?: Record<string, unknown>): string {
  switch (pageId) {
    case "files":
      return `files::${(params?.workingDirectory as string | undefined) ?? ""}`;
    case "workspace":
      // A single workspace page owns the open-file tabs.
      return "workspace::__files__";
    case "review":
      // The review panel is a singleton view of one round of work. Keying on
      // the round rather than on the whole params blob means clicking two
      // different files of the same round reuses one tab; the file is
      // re-targeted through `duya:review-focus-file`, because a reused tab
      // keeps its original params. `__scoped__` is the launcher's
      // session-wide review, which is a different view from a pinned round.
      return `review::${(params?.workingDirectory as string | undefined) ?? ""}`
        + `::${(params?.sessionId as string | undefined) ?? ""}`
        + `::${(params?.reviewTurnId as string | undefined) ?? "__scoped__"}`;
    case "browser":
      return `browser::${(params?.url as string | undefined) ?? ""}`;
    case "terminal":
      // Plan 566: a background-task output viewer keys on the task id so
      // repeated clicks on the same task reuse one tab while different
      // tasks get their own. Plain PTY tabs keep the legacy params key.
      if (typeof params?.taskId === "string") {
        return `terminal::task::${params.taskId}`;
      }
      return `${pageId}::${JSON.stringify(params ?? {})}`;
    case "session-messages":
      // One tab per session: repeated opens of the same subagent /
      // workflow-node session reuse (and focus) the existing tab. The
      // reused tab keeps its original params, which is fine — the view is
      // keyed on the immutable session id. Deliberately sessionId-ONLY:
      // plan 571 added `parentSessionId` / `taskId` (stop-control context),
      // and folding them in here would stack a second tab for the same run
      // every time an emitter re-sent them.
      return `session::${(params?.sessionId as string | undefined) ?? ""}`;
    case "plugin-app":
      // Surface Apps dedup on the surface id; entry Apps carry no surface, so
      // their appId closes the key — one tab per App of a plugin either way.
      return `plugin-ui::${(params?.pluginId as string | undefined) ?? ""}`
        + `::${(params?.surfaceId as string | undefined) ?? (params?.appId as string | undefined) ?? ""}`;
    default:
      return `${pageId}::${JSON.stringify(params ?? {})}`;
  }
}

function panelMaxWidth(maxWidth?: number | null): number {
  return maxWidth === null ? Number.POSITIVE_INFINITY : maxWidth ?? MAX_PANEL_WIDTH;
}

function clampPanelWidth(width: number, maxWidth?: number | null): number {
  return Math.min(panelMaxWidth(maxWidth), Math.max(MIN_PANEL_WIDTH, width));
}

function getWorkspaceWidth(): number {
  if (typeof document === "undefined") return window.innerWidth ?? 0;
  const workspace = document.querySelector(".app-workspace-row");
  return workspace?.getBoundingClientRect().width ?? window.innerWidth;
}

interface WidthBoundsOptions {
  minWidth?: number;
  maxWidth?: number | null;
  maxWidthRatio?: number;
}

/**
 * Clamp an arbitrary width against the shared panel caps plus a page
 * descriptor's own bounds. The upper bound is the tightest of: absolute
 * ceiling, ratio cap, and chat-column protection; when the lower bound
 * exceeds it on narrow workspaces the upper bound wins so the chat column
 * never shrinks below its protected minimum.
 */
export function clampWidthToBounds(width: number, options: WidthBoundsOptions, workspaceWidth: number): number {
  const maxWidth = panelMaxWidth(options.maxWidth);
  const maxByRatio = workspaceWidth * (options.maxWidthRatio ?? MAX_PANEL_RATIO);
  const maxWithChat = workspaceWidth - MIN_CHAT_WIDTH;
  const upperBound = Math.min(maxWidth, maxByRatio, maxWithChat);
  const lowerBound = Math.max(MIN_PANEL_WIDTH, options.minWidth ?? MIN_PANEL_WIDTH);
  return Math.max(Math.min(lowerBound, upperBound), Math.min(width, upperBound));
}

function loadUserWidths(): Partial<Record<PageId, number>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(USER_WIDTHS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const widths: Partial<Record<PageId, number>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isPageId(key)) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      widths[key] = value;
    }
    return widths;
  } catch {
    return {};
  }
}

function saveUserWidths(widths: Partial<Record<PageId, number>>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(widths).length === 0) {
      window.localStorage.removeItem(USER_WIDTHS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(USER_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    }
  } catch {
    // Quota / private mode — fail silently, the in-memory map still works.
  }
}

export interface PanelWidthOptions {
  workspaceWidth: number;
  preferredWidth?: number;
  minWidth: number;
  widthRatio?: number;
  maxWidthRatio?: number;
  maxWidth?: number | null;
}

export function resolvePanelWidth({
  workspaceWidth,
  preferredWidth,
  minWidth,
  widthRatio,
  maxWidthRatio,
  maxWidth,
}: PanelWidthOptions): number {
  // Undefined preferred width falls back to the page's minimum, so we never
  // propagate NaN into setPanelWidth (CSS would silently drop `NaNpx`).
  const maximumWidth = panelMaxWidth(maxWidth);
  const fallback = clampPanelWidth(minWidth, maxWidth);

  let desired: number;
  if (typeof widthRatio === "number" && Number.isFinite(widthRatio) && widthRatio > 0) {
    // Ratio-driven sizing: panel claims `widthRatio` of the workspace and
    // the chat column gets the rest. Ignore `preferredWidth` so callers can't
    // accidentally pass a fixed pixel value and override the ratio.
    desired = clampPanelWidth(workspaceWidth * widthRatio, maxWidth);
  } else {
    desired = clampPanelWidth(
      typeof preferredWidth === "number" && Number.isFinite(preferredWidth) ? preferredWidth : minWidth,
      maxWidth,
    );
  }

  const ratioCap =
    typeof maxWidthRatio === "number" && Number.isFinite(maxWidthRatio) && maxWidthRatio > 0
      ? maxWidthRatio
      : MAX_PANEL_RATIO;
  const maxByRatio = workspaceWidth * ratioCap;
  // The chat column is always protected. When the two minimum widths cannot
  // coexist, the responsive layout overlays the panel instead of squeezing
  // the chat below this minimum.
  const maxWithChat = workspaceWidth - MIN_CHAT_WIDTH;

  // The tightest of: page ceiling, ratio cap, and chat-minimum cap.
  const upperBound = Math.min(maximumWidth, maxByRatio, maxWithChat);
  // The page's minWidth may exceed upperBound on narrow workspaces.
  // In that case we still cap at upperBound so the chat column never
  // shrinks below MIN_CHAT_WIDTH (otherwise the panel flexes past the
  // visible window). The user can resize the panel down further.
  const safeLower = Math.min(fallback, upperBound);
  return Math.max(safeLower, Math.min(desired, upperBound));
}

/**
 * Clamp a set of column widths.
 *
 * Each column stays inside its own bounds (the page's minimum width, and the
 * shared panel ceiling), and the region as a whole leaves the chat column its
 * protected minimum. When the region has to shrink, the columns shrink
 * proportionally so their relative split survives.
 */
export function clampColumnWidths(
  widths: number[],
  workspaceWidth: number,
  minWidths: number[] = [],
): number[] {
  if (widths.length === 0) return [];
  const clamped = widths.map((width, index) => {
    const min = Math.max(MIN_PANEL_WIDTH, minWidths[index] ?? MIN_PANEL_WIDTH);
    const value = Number.isFinite(width) ? width : min;
    return Math.min(MAX_PANEL_WIDTH, Math.max(min, value));
  });
  const total = clamped.reduce((sum, width) => sum + width, 0);
  const maxTotal = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(workspaceWidth - MIN_CHAT_WIDTH, workspaceWidth * MAX_PANEL_RATIO),
  );
  if (total <= maxTotal) return clamped;
  const scale = maxTotal / total;
  return clamped.map((width) => Math.max(MIN_PANEL_WIDTH, width * scale));
}

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const sessionKey = activeThreadId ?? HOME_PANEL_KEY;

  // Load persisted state exactly once. `useRef(undefined)` lets us
  // distinguish "haven't tried yet" from "loaded null" so subsequent
  // renders (e.g. React strict mode double-invoke) don't re-read
  // localStorage.
  const initialRef = useRef<PersistedPanelState | null | undefined>(undefined);
  if (initialRef.current === undefined) {
    initialRef.current = loadPersistedState(sessionKey, t);
  }
  const initial = initialRef.current ?? emptyPanelState();

  // The column tree is derived from the persisted state once, like the tab
  // list: a payload without a tree is migrated on the way in.
  const initialLayoutRef = useRef<WorkspaceLayout | null>(null);
  if (initialLayoutRef.current === null) {
    initialLayoutRef.current = layoutForState(initial);
  }
  const initialLayout = initialLayoutRef.current;

  const [userWidths, setUserWidths] = useState<Partial<Record<PageId, number>>>(loadUserWidths);
  const [panelOpen, setPanelOpen] = useState<boolean>(initial.panelOpen);
  // A two-column wall needs room for both columns, so a restored wall
  // starts with a region that can hold them.
  const [panelWidth, setPanelWidth] = useState(
    () => DEFAULT_PANEL_WIDTH * Math.max(1, initialLayout.columns),
  );
  const [panelView, setPanelView] = useState<PanelView>(initial.panelView);
  const [workspaceExpanded, setWorkspaceExpandedState] = useState(initial.workspaceExpanded);
  const [tabs, setTabs] = useState<PageTab[]>(initial.tabs);
  // The column tree. It owns WHERE a pane lives; `tabs` owns what the pane
  // shows. The active pane is the tree's focus, so the active tab id and the
  // active pane id are the same string.
  const [layout, setLayout] = useState<WorkspaceLayout>(initialLayout);
  const activeTabId = layout.activePaneId;

  const currentSessionKeyRef = useRef(sessionKey);
  const panelStateRef = useRef<PersistedPanelState>(initial);
  panelStateRef.current = { tabs, activeTabId, panelOpen, panelView, workspaceExpanded, layout };

  // Mirrors for the stable callbacks below: they read the current tree and
  // the current region width without being re-created on every render.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Keep the region inside the workspace. The chat column keeps its
  // protected minimum, so the panel may not grow past it — a window resize
  // (or a collapsing sidebar) has to pull the region back in.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const workspace = document.querySelector(".app-workspace-row");
    if (!workspace) return;
    const observer = new ResizeObserver(() => {
      const width = workspace.getBoundingClientRect().width;
      const max = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(width - MIN_CHAT_WIDTH, width * MAX_PANEL_RATIO),
      );
      if (panelWidthRef.current > max) setPanelWidth(max);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const tabsRef = useRef<PageTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Persist the slice of state that needs to survive a reload.
  // `panelWidth` is intentionally excluded — it's a transient UI
  // affordance, not part of the panel "contents".
  //
  // The write is DEBOUNCED. The wall's layout changes on every frame of a
  // separator drag, and a localStorage write is a synchronous, disk-backed
  // write: doing it per frame put a blocking write on the drag's critical
  // path. Now a drag writes nothing and the state is written once, when the
  // gesture settles.
  useEffect(() => {
    const timer = setTimeout(() => {
      savePersistedState(currentSessionKeyRef.current, { tabs, activeTabId, panelOpen, panelView, workspaceExpanded, layout });
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tabs, activeTabId, panelOpen, panelView, workspaceExpanded, layout]);

  // The debounced write must not lose the last state when the window goes
  // away before the timer fires, so the pending state is flushed on the way
  // out.
  useEffect(() => {
    const flush = () => {
      savePersistedState(currentSessionKeyRef.current, panelStateRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => {
    const previousSessionKey = currentSessionKeyRef.current;
    if (previousSessionKey === sessionKey) return;

    savePersistedState(previousSessionKey, panelStateRef.current);

    const next = loadPersistedState(sessionKey, t) ?? emptyPanelState();
    currentSessionKeyRef.current = sessionKey;

    setTabs(next.tabs);
    setLayout(layoutForState(next));
    setPanelOpen(next.panelOpen);
    setPanelView(next.panelView);
    setWorkspaceExpandedState(next.workspaceExpanded);
  }, [sessionKey]);

  const setWorkspaceExpanded = useCallback((expanded: boolean) => {
    setWorkspaceExpandedState(expanded);
    if (expanded) {
      setPanelOpen(true);
      setPanelView("content");
    }
  }, []);

  // Mirror for stable callbacks (applyPageLayout is a dependency of
  // openPanel / activateTab and must not churn when widths change).
  const userWidthsRef = useRef(userWidths);
  userWidthsRef.current = userWidths;

  /**
   * Apply a set of column widths.
   *
   * The wall's own width does not change: the columns split it, so a drag
   * only moves the boundary between two shares.
   */
  const applyColumnWidths = useCallback((widths: number[]) => {
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total <= 0) return;
    setLayout((prev) => setColumnRatios(prev, widths.map((width) => width / total)));
  }, []);

  /** The width a column for this page takes when the column is created. */
  const resolveColumnWidth = useCallback((pageId: PageId): number => {
    const descriptor = getPageDescriptor(pageId);
    const remembered = userWidthsRef.current[pageId];
    return resolvePanelWidth({
      workspaceWidth: getWorkspaceWidth(),
      // A user-dragged width wins over the descriptor default so manual
      // resizes survive opening the same page again.
      preferredWidth: remembered ?? descriptor.preferredWidth,
      minWidth: descriptor.minWidth,
      widthRatio: descriptor.widthRatio,
      maxWidthRatio: descriptor.maxWidthRatio,
      maxWidth: descriptor.maxWidth,
    });
  }, []);

  /**
   * The parts of opening a page that do not depend on the column tree: the
   * panel becomes visible and the page's default expansion is applied. The
   * WIDTH belongs to the column, not to the page, so it is settled by
   * `openPaneInLayout`.
   */
  const applyPageLayout = useCallback((pageId: PageId) => {
    const descriptor = getPageDescriptor(pageId);
    setWorkspaceExpandedState(descriptor.defaultExpanded);
    setPanelOpen(true);
    setPanelView("content");
  }, []);

  /**
   * Put a newly opened card into the wall.
   *
   * The wall grows to a second column once a third card is open, and the
   * region widens with it so both columns stay usable.
   */
  const openPaneInLayout = useCallback((paneId: PaneId) => {
    const next = placePane(layoutRef.current, paneId);
    const { columns } = wallShapeFor(next.panes.length);
    if (columns > layoutRef.current.columns) {
      const needed = columns * MIN_PANEL_WIDTH;
      if (panelWidthRef.current < needed) setPanelWidth(needed);
    }
    // Opening a card leaves any card that filled the wall with the region
    // collapse: the new card has to be visible in the wall.
    setLayout((prev) => setActivePane(
      placePane({ ...prev, expandedPaneId: null }, paneId),
      paneId,
    ));
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev;
      if (next) {
        setPanelView("content");
      }
      return next;
    });
  }, []);

  /**
   * Set the width of the whole panel region. The wall's cards split that
   * region, so the region's width is the only thing its edge drag changes.
   */
  const handleSetWidth = useCallback((width: number) => {
    setPanelWidth(clampPanelWidth(width));
  }, []);

  /** Persist a user-initiated width (drag end) for the given page type. */
  const rememberUserWidth = useCallback((pageId: PageId, width: number) => {
    if (!Number.isFinite(width)) return;
    setUserWidths((prev) => {
      const rounded = Math.round(width);
      if (prev[pageId] === rounded) return prev;
      const next = { ...prev, [pageId]: rounded };
      saveUserWidths(next);
      return next;
    });
  }, []);

  /** Drop the remembered width for a page and restore its descriptor default. */
  const resetPanelWidth = useCallback((pageId: PageId) => {
    setUserWidths((prev) => {
      if (!(pageId in prev)) return prev;
      const next = { ...prev };
      delete next[pageId];
      saveUserWidths(next);
      return next;
    });
    const descriptor = getPageDescriptor(pageId);
    const nextWidth = resolvePanelWidth({
      workspaceWidth: getWorkspaceWidth(),
      preferredWidth: descriptor.preferredWidth,
      minWidth: descriptor.minWidth,
      widthRatio: descriptor.widthRatio,
      maxWidthRatio: descriptor.maxWidthRatio,
      maxWidth: descriptor.maxWidth,
    });
    // The width belongs to the region, not to a single card.
    setPanelWidth(clampPanelWidth(nextWidth));
  }, []);

  const openPanel = useCallback<PanelContextValue["openPanel"]>((pageId, params) => {
    const id = genId();
    const newTab: PageTab = {
      id,
      pageId,
      title: typeof params?.title === "string" ? params.title : defaultPanelTitle(t, pageId),
      params,
    };
    setTabs((prev) => [...prev, newTab]);
    openPaneInLayout(id);
    applyPageLayout(pageId);
    return id;
  }, [applyPageLayout, openPaneInLayout, t]);

  const openOrActivatePage = useCallback<PanelContextValue["openOrActivatePage"]>(
    (pageId, params) => {
      const key = dedupKey(pageId, params);
      const existing = tabsRef.current.find(
        (t) => t.pageId === pageId && dedupKey(t.pageId, t.params) === key
      );
      if (existing) {
        setLayout((prev) => setActivePane(
          prev.expandedPaneId && prev.expandedPaneId !== existing.id
            ? { ...prev, expandedPaneId: null }
            : prev,
          existing.id,
        ));
        const providedTitle = typeof params?.title === "string" ? params.title : undefined;
        if (providedTitle && providedTitle !== existing.title) {
          setTabs((prev) => prev.map((tab) => (
            tab.id === existing.id ? { ...tab, title: providedTitle } : tab
          )));
        }
        applyPageLayout(pageId);
        return existing.id;
      }
      return openPanel(pageId, params);
    },
    [applyPageLayout, openPanel]
  );

  useEffect(() => {
    const handleOpenBrowserPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string; title?: string }>).detail;
      const url = typeof detail?.url === "string" ? detail.url : "";
      if (!url.trim()) return;
      openOrActivatePage("browser", {
        url,
        title: typeof detail?.title === "string" ? detail.title : undefined,
      });
    };

    window.addEventListener("duya:open-browser-panel", handleOpenBrowserPanel as EventListener);
    return () => {
      window.removeEventListener("duya:open-browser-panel", handleOpenBrowserPanel as EventListener);
    };
  }, [openOrActivatePage]);

  useEffect(() => {
    const handleOpenFilePreview = (event: Event) => {
      const detail = (event as CustomEvent<{
        filePath?: string;
        workingDirectory?: string;
        standalone?: boolean;
        lineStart?: number;
        lineEnd?: number;
      }>).detail;
      const filePath = typeof detail?.filePath === "string" ? detail.filePath : "";
      const workingDirectory = typeof detail?.workingDirectory === "string" ? detail.workingDirectory : "";
      const standalone = detail?.standalone === true;
      // Standalone mode (in-chat click to a file outside the chat
      // workspace) deliberately ships with an empty workingDirectory —
      // the renderer just wants the file's content without exposing
      // its parent directory as a project tree. Project-scoped opens
      // (sidebar markdown preview) keep the existing
      // `workingDirectory required` invariant.
      if (!filePath.trim() || (!standalone && !workingDirectory.trim())) return;
      // Forward the agent's read line range so the workspace panel can scroll
      // to and highlight the exact lines on first mount. Later opens of an
      // already-mounted file arrive through the same event, so re-focusing a
      // reused tab needs no separate channel.
      const lineStart = typeof detail?.lineStart === "number" && Number.isFinite(detail.lineStart)
        ? detail.lineStart
        : undefined;
      const lineEnd = typeof detail?.lineEnd === "number" && Number.isFinite(detail.lineEnd)
        ? detail.lineEnd
        : undefined;
      // The workspace page is a singleton: hand the file to the panel's own
      // tab strip instead of opening one page tab per file.
      openOrActivatePage("workspace", { workingDirectory });
      window.dispatchEvent(new CustomEvent("duya:workspace-open-file", {
        detail: { filePath, lineStart, lineEnd },
      }));
    };

    window.addEventListener("duya:open-file-preview-panel", handleOpenFilePreview as EventListener);
    return () => {
      window.removeEventListener("duya:open-file-preview-panel", handleOpenFilePreview as EventListener);
    };
  }, [openOrActivatePage]);

  // Turn-scoped review opens. The transcript's file-change card dispatches
  // this so a file row or its 审查 button lands in the side panel instead of
  // expanding a diff inside the message — same split ZCode makes with its
  // code-viewer pane. `turnId` pins the panel to that round; without it the
  // panel follows the session's latest round.
  useEffect(() => {
    const handleOpenReviewPanel = (event: Event) => {
      const detail = (event as CustomEvent<{
        workingDirectory?: string;
        sessionId?: string;
        turnId?: string;
        filePath?: string;
        title?: string;
      }>).detail;
      const workingDirectory = typeof detail?.workingDirectory === "string" ? detail.workingDirectory : "";
      const sessionId = typeof detail?.sessionId === "string" ? detail.sessionId : "";
      if (!workingDirectory.trim() || !sessionId.trim()) return;
      const params: Record<string, unknown> = { workingDirectory, sessionId };
      if (typeof detail?.turnId === "string" && detail.turnId.trim()) {
        params.reviewTurnId = detail.turnId.trim();
      }
      if (typeof detail?.filePath === "string" && detail.filePath.trim()) {
        params.reviewFilePath = detail.filePath.trim();
      }
      if (typeof detail?.title === "string" && detail.title.trim()) {
        params.title = detail.title.trim();
      }
      openOrActivatePage("review", params);
    };

    window.addEventListener("duya:open-review-panel", handleOpenReviewPanel as EventListener);
    return () => {
      window.removeEventListener("duya:open-review-panel", handleOpenReviewPanel as EventListener);
    };
  }, [openOrActivatePage]);

  useEffect(() => {
    const handleOpenSkillPreview = async (event: Event) => {
      const detail = (event as CustomEvent<{ skillName?: string }>).detail;
      const skillName = typeof detail?.skillName === "string" ? detail.skillName : "";
      if (!skillName.trim()) return;

      const api = (window as unknown as {
        electronAPI?: {
          skills?: {
            list: () => Promise<{ success?: boolean; skills?: unknown[]; error?: string }>;
          };
        };
      }).electronAPI;
      if (!api?.skills?.list) return;

      try {
        const result = await api.skills.list();
        if (!result.success || !Array.isArray(result.skills)) return;

        const skill = result.skills.find((s): s is { name: string; skillRoot: string } => {
          const maybe = s as Record<string, unknown> | undefined;
          return (
            maybe != null &&
            typeof maybe.name === "string" &&
            maybe.name === skillName &&
            typeof maybe.skillRoot === "string" &&
            maybe.skillRoot.length > 0
          );
        });
        if (!skill) return;

        const filePath = `${skill.skillRoot.replace(/[\\/]+$/, "")}/SKILL.md`;
        window.dispatchEvent(new CustomEvent("duya:open-file-preview-panel", {
          detail: {
            filePath,
            workingDirectory: skill.skillRoot,
          },
        }));
      } catch {
        // Ignore skill lookup failures.
      }
    };

    window.addEventListener("duya:open-skill-preview", handleOpenSkillPreview as EventListener);
    return () => {
      window.removeEventListener("duya:open-skill-preview", handleOpenSkillPreview as EventListener);
    };
  }, []);


  // Plan 566: background-command rows (indicator popover, task drawer)
  // open the task's output in the side panel's terminal page. The dedup
  // key folds on taskId, so re-clicking a task activates its tab.
  useEffect(() => {
    const handleOpenBashTaskOutput = (event: Event) => {
      const detail = (event as CustomEvent<{
        taskId?: string;
        sessionId?: string;
        outputFile?: string;
        command?: string;
        startTime?: number;
      }>).detail;
      const taskId = typeof detail?.taskId === "string" ? detail.taskId : "";
      const outputFile = typeof detail?.outputFile === "string" ? detail.outputFile : "";
      if (!taskId.trim() || !outputFile.trim()) return;
      const command = typeof detail?.command === "string" ? detail.command : "";
      const params: Record<string, unknown> = {
        taskId: taskId.trim(),
        outputFile: outputFile.trim(),
        command,
        title: bashTaskOutputTabTitle(command),
      };
      if (typeof detail?.sessionId === "string") params.sessionId = detail.sessionId;
      if (typeof detail?.startTime === "number") params.startTime = detail.startTime;
      openOrActivatePage("terminal", params);
    };

    window.addEventListener("duya:open-bash-output-panel", handleOpenBashTaskOutput as EventListener);
    return () => {
      window.removeEventListener("duya:open-bash-output-panel", handleOpenBashTaskOutput as EventListener);
    };
  }, [openOrActivatePage]);

  // Subagent / workflow-node session viewer (ZCode-parity side pane).
  // Emitters (workflow evidence rows, subagent tool rows, TaskDrawer rows)
  // only broadcast { sessionId, title?, parentSessionId?, taskId? }; the page
  // dedups on sessionId so a repeated click focuses the existing tab instead
  // of stacking copies. `parentSessionId` / `taskId` are optional context the
  // panel needs for the sub-agent stop control — a reused tab keeps its
  // original params, which is correct because the view is keyed on the
  // immutable session id.
  useEffect(() => {
    const handleOpenSessionPanel = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        title?: string;
        parentSessionId?: string;
        taskId?: string;
      }>).detail;
      const sessionId = typeof detail?.sessionId === "string" ? detail.sessionId.trim() : "";
      if (!sessionId) return;
      const params: Record<string, unknown> = {
        sessionId,
        // Always seed a tab title: reused tabs keep their params, and the
        // generic default-title lookup (`panel.${pageId}`) has no entry for
        // this page. The panel component refines it from the thread row.
        title: typeof detail?.title === "string" && detail.title.trim()
          ? detail.title.trim()
          : sessionId.slice(0, 8),
      };
      if (typeof detail?.parentSessionId === "string" && detail.parentSessionId.trim()) {
        params.parentSessionId = detail.parentSessionId.trim();
      }
      if (typeof detail?.taskId === "string" && detail.taskId.trim()) {
        params.taskId = detail.taskId.trim();
      }
      openOrActivatePage("session-messages", params);
    };

    window.addEventListener("duya:open-session-panel", handleOpenSessionPanel as EventListener);
    return () => {
      window.removeEventListener("duya:open-session-panel", handleOpenSessionPanel as EventListener);
    };
  }, [openOrActivatePage]);

  const closePanel = useCallback<PanelContextValue["closePanel"]>((tabId) => {
    setTabs((prev) => {
      const closing = prev.find((tab) => tab.id === tabId);
      if (!closing) return prev;
      // Only a real PTY owns a killable shell process; task-output viewer
      // tabs reuse the terminal page but hold no process.
      if (
        closing.pageId === "terminal" &&
        typeof closing.params?.taskId !== "string" &&
        typeof window !== "undefined"
      ) {
        void window.electronAPI?.terminal?.kill?.(tabId).catch(() => {});
      }
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        setPanelView("picker");
        setPanelOpen(false);
        setWorkspaceExpandedState(false);
      }
      return next;
    });

    // The card leaves the wall; the remaining cards close the gap.
    setLayout((prev) => removePane(prev, tabId));
  }, []);

  const activateTab = useCallback<PanelContextValue["activateTab"]>((tabId) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    setLayout((prev) => setActivePane(prev, tabId));
    if (tab) {
      applyPageLayout(tab.pageId);
    } else {
      setPanelOpen(true);
      setPanelView("content");
    }
  }, [applyPageLayout]);

  const updateTabTitle = useCallback<PanelContextValue["updateTabTitle"]>((tabId, title) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setTabs((prev) => {
      const target = prev.find((tab) => tab.id === tabId);
      if (!target || target.title === nextTitle) return prev;
      return prev.map((tab) => (
        tab.id === tabId ? { ...tab, title: nextTitle } : tab
      ));
    });
  }, []);

  const updateTabFavicon = useCallback<PanelContextValue["updateTabFavicon"]>((tabId, favicon) => {
    setTabs((prev) => prev.map((tab) => (
      tab.id === tabId && tab.favicon !== favicon
        ? { ...tab, favicon }
        : tab
    )));
  }, []);

  const reorderTabs = useCallback<PanelContextValue["reorderTabs"]>(
    (fromId, toId, position) => {
      setTabs((prev) => {
        const fromIdx = prev.findIndex((t) => t.id === fromId);
        const toIdxRaw = prev.findIndex((t) => t.id === toId);
        if (fromIdx === -1 || toIdxRaw === -1 || fromIdx === toIdxRaw) return prev;
        const insertAt =
          position === "after" && toIdxRaw > fromIdx
            ? toIdxRaw
            : position === "after" && toIdxRaw < fromIdx
              ? toIdxRaw + 1
              : position === "before" && toIdxRaw > fromIdx
                ? toIdxRaw - 1
                : toIdxRaw;
        if (insertAt === fromIdx) return prev;
        const next = prev.slice();
        const [moved] = next.splice(fromIdx, 1);
        next.splice(insertAt, 0, moved);
        return next;
      });
    },
    []
  );

  /** Set the pixel width of every column; the wall keeps its own width. */
  const setColumnWidths = useCallback((widths: number[]) => {
    applyColumnWidths(widths);
  }, [applyColumnWidths]);

  /** Set the pixel height of every row; the wall keeps its own height. */
  const setRowHeights = useCallback((heights: number[]) => {
    const total = heights.reduce((sum, height) => sum + height, 0);
    if (total <= 0) return;
    setLayout((prev) => setRowRatios(prev, heights.map((height) => height / total)));
  }, []);

  /** Expand a card so it fills the wall, or collapse it back into its cell. */
  const togglePaneExpanded = useCallback((paneId: string) => {
    setLayout((prev) => toggleExpandedPane(prev, paneId));
  }, []);

  const value = useMemo<PanelContextValue>(
    () => ({
      panelOpen,
      setPanelOpen,
      togglePanel,
      setPanelWidth: handleSetWidth,
      rememberUserWidth,
      resetPanelWidth,
      workspaceExpanded,
      setWorkspaceExpanded,
      panelView,
      setPanelView,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      updateTabTitle,
      updateTabFavicon,
      openOrActivatePage,
      reorderTabs,
      setColumnWidths,
      setRowHeights,
      togglePaneExpanded,
    }),
    [
      panelOpen,
      togglePanel,
      handleSetWidth,
      rememberUserWidth,
      resetPanelWidth,
      workspaceExpanded,
      setWorkspaceExpanded,
      panelView,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      updateTabTitle,
      updateTabFavicon,
      openOrActivatePage,
      reorderTabs,
      setColumnWidths,
      setRowHeights,
      togglePaneExpanded,
    ],
  );

  // The geometry has its own context: it changes on every frame of a drag,
  // and only the panel zone reads it. Keeping it out of the shared context
  // is what stops a drag from re-rendering the whole app shell.
  const geometry = useMemo<PanelGeometryValue>(
    () => ({ panelWidth, layout }),
    [panelWidth, layout],
  );

  return React.createElement(
    PanelGeometryContext.Provider,
    { value: geometry },
    React.createElement(PanelContext.Provider, { value }, children),
  );
}

export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within a PanelProvider");
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link usePanel}. Returns `null` when no
 * `PanelProvider` is mounted above the consumer, instead of throwing.
 * Useful for components that are rendered both inside and outside the
 * panel subtree (e.g. integrated file tree used standalone).
 */
export function useOptionalPanel(): PanelContextValue | null {
  return useContext(PanelContext);
}

/**
 * The geometry of the panel region: its width and the wall's column tree.
 *
 * Read it only where the geometry is actually drawn. A component that reads
 * it re-renders on every frame of a drag.
 */
export function usePanelGeometry(): PanelGeometryValue {
  const ctx = useContext(PanelGeometryContext);
  if (!ctx) {
    throw new Error("usePanelGeometry must be used within a PanelProvider");
  }
  return ctx;
}

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

function defaultPanelTitle(t: TFunc, pageId: PageId): string {
  return t(`panel.${pageId}` as TranslationKey);
}
