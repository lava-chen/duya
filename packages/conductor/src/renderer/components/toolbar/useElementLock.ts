"use client";

import { useCallback } from "react";
import type { CanvasElement } from "../../types/conductor";
import { executeAction } from "../../ipc/conductor-ipc";
import { useConductorStore } from "../../stores/conductor-store";

export function useElementLock(element: CanvasElement) {
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const setUiError = useConductorStore((state) => state.setUiError);
  const locked = element.metadata.locked === true;

  const setLocked = useCallback((nextLocked: boolean) => {
    const previousMetadata = element.metadata;
    const metadata = { ...previousMetadata, locked: nextLocked };
    updateElement(element.id, { metadata, updatedAt: Date.now() });
    if (!activeCanvasId) return;

    void executeAction({
      action: "element.update",
      canvasId: activeCanvasId,
      elementId: element.id,
      metadata,
    }).catch((error) => {
      updateElement(element.id, { metadata: previousMetadata, updatedAt: Date.now() });
      setUiError(`Update element lock failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeCanvasId, element.id, element.metadata, setUiError, updateElement]);

  const toggleLocked = useCallback(() => setLocked(!locked), [locked, setLocked]);

  return { locked, setLocked, toggleLocked };
}
