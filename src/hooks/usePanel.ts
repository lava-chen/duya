"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isPageId, type PageId, type PageTab } from "@/components/layout/panels/registry";
import { useConversationStore } from "@/stores/conversation-store";

export type { PageId, PageTab } from "@/components/layout/panels/registry";

export type PanelView = "content" | "picker";

export interface PanelContextValue {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  panelWidth: number;
  setPanelWidth: (width: number) => void;

  panelView: PanelView;
  setPanelView: (view: PanelView) => void;

  tabs: PageTab[];
  activeTabId: string | null;

  openPanel: (pageId: PageId, params?: Record<string, unknown>) => string;
  closePanel: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  openOrActivatePage: (pageId: PageId, params?: Record<string, unknown>) => string;
  reorderTabs: (fromId: string, toId: string, position: "before" | "after") => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 960;
const DEFAULT_PANEL_WIDTH = 340;

const PANEL_STORAGE_PREFIX = "duya:panel:v2:";
const HOME_PANEL_KEY = "__home__";

interface PersistedPanelState {
  tabs: PageTab[];
  activeTabId: string | null;
  panelOpen: boolean;
  panelView: PanelView;
}

function emptyPanelState(): PersistedPanelState {
  return {
    tabs: [],
    activeTabId: null,
    panelOpen: false,
    panelView: "picker",
  };
}

function panelStorageKey(sessionKey: string): string {
  return `${PANEL_STORAGE_PREFIX}${sessionKey}`;
}

/**
 * Read previously-persisted panel state. Validates `pageId` values
 * against the live registry and silently drops unknown entries so a
 * stale `localStorage` payload (e.g. after removing a page) cannot
 * crash the provider.
 */
function loadPersistedState(sessionKey: string): PersistedPanelState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(panelStorageKey(sessionKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedPanelState> | null;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs: PageTab[] = [];
    for (const t of parsed.tabs) {
      if (!t || typeof t.id !== "string" || !isPageId(t.pageId)) continue;
      tabs.push({
        id: t.id,
        pageId: t.pageId,
        title: typeof t.title === "string" ? t.title : defaultTitle(t.pageId),
        params:
          t.params && typeof t.params === "object" && !Array.isArray(t.params)
            ? (t.params as Record<string, unknown>)
            : undefined,
      });
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
    };
  } catch {
    return null;
  }
}

function savePersistedState(sessionKey: string, state: PersistedPanelState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(panelStorageKey(sessionKey), JSON.stringify(state));
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
    case "conductor":
      return `conductor::${(params?.canvasId as string | undefined) ?? "__active__"}`;
    default:
      return `${pageId}::${JSON.stringify(params ?? {})}`;
  }
}

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const sessionKey = activeThreadId ?? HOME_PANEL_KEY;

  // Load persisted state exactly once. `useRef(undefined)` lets us
  // distinguish "haven't tried yet" from "loaded null" so subsequent
  // renders (e.g. React strict mode double-invoke) don't re-read
  // localStorage.
  const initialRef = useRef<PersistedPanelState | null | undefined>(undefined);
  if (initialRef.current === undefined) {
    initialRef.current = loadPersistedState(sessionKey);
  }
  const initial = initialRef.current ?? emptyPanelState();

  const [panelOpen, setPanelOpen] = useState<boolean>(initial.panelOpen);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [panelView, setPanelView] = useState<PanelView>(initial.panelView);
  const [tabs, setTabs] = useState<PageTab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initial.activeTabId);

  const currentSessionKeyRef = useRef(sessionKey);
  const panelStateRef = useRef<PersistedPanelState>(initial);
  panelStateRef.current = { tabs, activeTabId, panelOpen, panelView };

  const tabsRef = useRef<PageTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Persist the slice of state that needs to survive a reload.
  // `panelWidth` is intentionally excluded — it's a transient UI
  // affordance, not part of the panel "contents".
  useEffect(() => {
    savePersistedState(currentSessionKeyRef.current, { tabs, activeTabId, panelOpen, panelView });
  }, [tabs, activeTabId, panelOpen, panelView]);

  useEffect(() => {
    const previousSessionKey = currentSessionKeyRef.current;
    if (previousSessionKey === sessionKey) return;

    savePersistedState(previousSessionKey, panelStateRef.current);

    const next = loadPersistedState(sessionKey) ?? emptyPanelState();
    currentSessionKeyRef.current = sessionKey;
    setTabs(next.tabs);
    setActiveTabId(next.activeTabId);
    setPanelOpen(next.panelOpen);
    setPanelView(next.panelView);
  }, [sessionKey]);

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev;
      if (next) {
        setPanelView("content");
      }
      return next;
    });
  }, []);

  const handleSetWidth = useCallback((width: number) => {
    setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width)));
  }, []);

  const openPanel = useCallback<PanelContextValue["openPanel"]>((pageId, params) => {
    const id = genId();
    const newTab: PageTab = {
      id,
      pageId,
      title: defaultTitle(pageId),
      params,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    setPanelOpen(true);
    setPanelView("content");
    return id;
  }, []);

  const openOrActivatePage = useCallback<PanelContextValue["openOrActivatePage"]>(
    (pageId, params) => {
      const key = dedupKey(pageId, params);
      const existing = tabsRef.current.find(
        (t) => t.pageId === pageId && dedupKey(t.pageId, t.params) === key
      );
      if (existing) {
        setActiveTabId(existing.id);
        setPanelOpen(true);
        setPanelView("content");
        return existing.id;
      }
      return openPanel(pageId, params);
    },
    [openPanel]
  );

  const closePanel = useCallback<PanelContextValue["closePanel"]>((tabId) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      const closing = prev[idx];
      if (closing.pageId === "terminal" && typeof window !== "undefined") {
        void window.electronAPI?.terminal?.kill?.(tabId).catch(() => {});
      }
      const next = prev.filter((t) => t.id !== tabId);
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        if (next.length === 0) return null;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback.id;
      });
      if (next.length === 0) {
        setPanelView("picker");
        setPanelOpen(false);
      }
      return next;
    });
  }, []);

  const activateTab = useCallback<PanelContextValue["activateTab"]>((tabId) => {
    setActiveTabId(tabId);
    setPanelOpen(true);
    setPanelView("content");
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

  const value = useMemo<PanelContextValue>(
    () => ({
      panelOpen,
      setPanelOpen,
      togglePanel,
      panelWidth,
      setPanelWidth: handleSetWidth,
      panelView,
      setPanelView,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      openOrActivatePage,
      reorderTabs,
    }),
    [
      panelOpen,
      togglePanel,
      panelWidth,
      handleSetWidth,
      panelView,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      openOrActivatePage,
      reorderTabs,
    ]
  );

  return React.createElement(PanelContext.Provider, { value }, children);
}

export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within a PanelProvider");
  }
  return ctx;
}

function defaultTitle(pageId: PageId): string {
  switch (pageId) {
    case "files": return "文件";
    case "conductor": return "指挥台";
    case "research": return "审查";
    case "terminal": return "终端";
    case "browser": return "浏览器";
    default: return pageId;
  }
}
