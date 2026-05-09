"use client";

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

export interface PanelContextValue {
  fileTreeOpen: boolean;
  setFileTreeOpen: (open: boolean) => void;
  toggleFileTree: () => void;
  fileTreeWidth: number;
  setFileTreeWidth: (width: number) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

const MIN_FILE_TREE_WIDTH = 220;
const MAX_FILE_TREE_WIDTH = 500;
const DEFAULT_FILE_TREE_WIDTH = 280;

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const [fileTreeWidth, setFileTreeWidth] = useState(DEFAULT_FILE_TREE_WIDTH);

  const toggleFileTree = useCallback(() => {
    setFileTreeOpen((prev) => !prev);
  }, []);

  const handleSetWidth = useCallback((width: number) => {
    setFileTreeWidth(Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, width)));
  }, []);

  const value = useMemo(
    () => ({
      fileTreeOpen,
      setFileTreeOpen,
      toggleFileTree,
      fileTreeWidth,
      setFileTreeWidth: handleSetWidth,
    }),
    [fileTreeOpen, toggleFileTree, fileTreeWidth, handleSetWidth]
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
