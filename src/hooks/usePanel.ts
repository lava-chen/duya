"use client";

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

export type PanelTab = 'canvas' | 'files' | 'research';

export interface PanelContextValue {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  panelWidth: number;
  setPanelWidth: (width: number) => void;
  activeTab: PanelTab;
  setActiveTab: (tab: PanelTab) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 960;
const DEFAULT_PANEL_WIDTH = 340;
const CANVAS_RATIO = 0.58;

function getSidebarWidth(): number {
  const sidebar = document.querySelector('.app-sidebar') as HTMLElement | null;
  return sidebar?.offsetWidth ?? 260;
}

function calculateCanvasPanelWidth(): number {
  const sidebarWidth = getSidebarWidth();
  const availableWidth = window.innerWidth - sidebarWidth;
  const targetWidth = Math.round(availableWidth * CANVAS_RATIO);
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, targetWidth));
}

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [activeTab, setActiveTab] = useState<PanelTab>('files');

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => !prev);
  }, []);

  const handleSetWidth = useCallback((width: number) => {
    setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width)));
  }, []);

  const setActiveTabWithPanel = useCallback((tab: PanelTab) => {
    const isCanvasTab = tab === 'canvas';

    setPanelOpen(true);

    if (isCanvasTab) {
      setPanelWidth(calculateCanvasPanelWidth());
    }

    setActiveTab(tab);
  }, []);

  const value = useMemo(
    () => ({
      panelOpen,
      setPanelOpen,
      togglePanel,
      panelWidth,
      setPanelWidth: handleSetWidth,
      activeTab,
      setActiveTab: setActiveTabWithPanel,
    }),
    [panelOpen, togglePanel, panelWidth, handleSetWidth, activeTab, setActiveTabWithPanel]
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
