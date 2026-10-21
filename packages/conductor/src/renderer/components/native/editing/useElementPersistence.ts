import { useCallback } from "react";
import { executeAction, updateElementContent } from "../../../ipc/conductor-ipc";
import { useConductorStore } from "../../../stores/conductor-store";
import type { CanvasElement, CanvasPosition } from "../../../types/conductor";

interface ElementPersistencePatch {
  config?: Record<string, unknown>;
  position?: CanvasPosition;
}

/** Optimistic element persistence with a consistent stale-safe rollback. */
export function useElementPersistence(element: CanvasElement) {
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const setUiError = useConductorStore((state) => state.setUiError);

  return useCallback((patch: ElementPersistencePatch, failureLabel: string) => {
    const current = useConductorStore.getState().elements.find((candidate) => candidate.id === element.id) ?? element;
    const previousConfig = current.config;
    const previousPosition = current.position;
    const nextConfig = patch.config ? { ...previousConfig, ...patch.config } : previousConfig;
    const nextPosition = patch.position ?? previousPosition;

    updateElement(element.id, {
      ...(patch.config ? { config: nextConfig } : {}),
      ...(patch.position ? { position: nextPosition } : {}),
    });
    const optimistic = useConductorStore.getState().elements.find((candidate) => candidate.id === element.id);
    const optimisticConfig = optimistic?.config;
    const optimisticPosition = optimistic?.position;

    if (!activeCanvasId) return;

    const request = patch.position
      ? executeAction({
          action: "element.update",
          elementId: element.id,
          canvasId: activeCanvasId,
          ...(patch.config ? { config: nextConfig } : {}),
          position: nextPosition,
        })
      : updateElementContent(element.id, activeCanvasId, patch.config ?? {});

    void request.catch((error) => {
      const latest = useConductorStore.getState().elements.find((candidate) => candidate.id === element.id);
      const rollbackConfig = patch.config && latest?.config === optimisticConfig;
      const rollbackPosition = patch.position && latest?.position === optimisticPosition;
      if (rollbackConfig || rollbackPosition) {
        updateElement(element.id, {
          ...(rollbackConfig ? { config: previousConfig } : {}),
          ...(rollbackPosition ? { position: previousPosition } : {}),
        });
      }
      setUiError(`${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeCanvasId, element, setUiError, updateElement]);
}
