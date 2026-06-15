"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PageId, PageTab } from "@/components/layout/panels/registry";

export type { PageId, PageTab } from "@/components/layout/panels/registry";

export interface PanelContextValue {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  panelWidth: number;
  setPanelWidth: (width: number) => void;

  tabs: PageTab[];
  activeTabId: string | null;

  openPanel: (pageId: PageId, params?: Record<string, unknown>) => string;
  closePanel: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  openOrActivatePage: (pageId: PageId, params?: Record<string, unknown>) => string;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 960;
const DEFAULT_PANEL_WIDTH = 340;

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a dedup key for a pageId + params. Pages that don't
 * multi-instance (multiInstance=false) collapse to pageId alone.
 */
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [tabs, setTabs] = useState<PageTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Mirror tabs into a ref so callbacks can read the latest value
  // synchronously. The setter-updater pattern does not guarantee the
  // updater runs before subsequent reads in the same call frame, so
  // we can't read `tabs` from inside `setTabs((prev) => …)`.
  const tabsRef = useRef<PageTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => !prev);
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
      const next = prev.filter((t) => t.id !== tabId);
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        if (next.length === 0) return null;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback.id;
      });
      if (next.length === 0) {
        setPanelOpen(false);
      }
      return next;
    });
  }, []);

  const activateTab = useCallback<PanelContextValue["activateTab"]>((tabId) => {
    setActiveTabId(tabId);
    setPanelOpen(true);
  }, []);

  const value = useMemo<PanelContextValue>(
    () => ({
      panelOpen,
      setPanelOpen,
      togglePanel,
      panelWidth,
      setPanelWidth: handleSetWidth,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      openOrActivatePage,
    }),
    [
      panelOpen,
      togglePanel,
      panelWidth,
      handleSetWidth,
      tabs,
      activeTabId,
      openPanel,
      closePanel,
      activateTab,
      openOrActivatePage,
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
    case "files": return "文件树";
    case "conductor": return "Conductor";
    case "research": return "Research";
    case "terminal": return "终端";
    case "browser": return "浏览器";
    default: return pageId;
  }
}
