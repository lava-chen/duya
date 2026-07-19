"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasArea } from "./CanvasArea";
import { CanvasErrorBoundary } from "./CanvasErrorBoundary";
import { CanvasSelector } from "./CanvasSelector";
import { useConductorStore } from "..//stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "..//ipc/conductor-ipc";
import { registerAllElements } from "../elements";
import "../widgets";
import { RefinePanel } from "..//refine/RefinePanel";
import { useCanvasCaptureRequest } from "../hooks/useCanvasCaptureRequest";
import { useTranslation } from "@/hooks/useTranslation";
import type { CanvasPosition } from "..//types/conductor";

export function ConductorView() {
  const { t } = useTranslation();
  const {
    canvases,
    activeCanvasId,
    setCanvases,
    addCanvas,
    setActiveCanvas,
    setSnapshot,
    connectBridge,
    disconnectBridge,
    uiError,
    setUiError,
    elements,
    updateElement,
    removeElement,
    loadConductorSettings,
  } = useConductorStore();

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    registerAllElements();
  }, []);

  // Load persisted conductor settings (model, vision model, permission
  // mode) once on mount. Non-blocking — settings just appear when ready.
  useEffect(() => {
    loadConductorSettings().catch(() => {});
  }, [loadConductorSettings]);

  // Register the agent-initiated canvas capture listener. Extracted to
  // a shared hook so both this view and SidebarConductorView respond
  // to canvas_capture tool calls regardless of which one is mounted.
  useCanvasCaptureRequest(activeCanvasId);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const list = await listCanvases();
        if (cancelled) return;

        setCanvases(list);

        // Always pick a canvas and reload its snapshot. Resuming from
        // store state without reloading leaves elements empty until
        // manual refresh.
        const desiredId =
          (activeCanvasId && list.find((c) => c.id === activeCanvasId)?.id) ||
          list[0]?.id;

        if (desiredId) {
          setActiveCanvas(desiredId);
          const snap = await getSnapshot(desiredId);
          if (snap && !cancelled) setSnapshot(snap);
          connectBridge(desiredId);
        } else {
          const canvas = await createCanvas("Workbench");
          if (!cancelled) {
            setCanvases([canvas]);
            setActiveCanvas(canvas.id);
            connectBridge(canvas.id);
            const snap = await getSnapshot(canvas.id);
            if (snap) setSnapshot(snap);
          }
        }
      } catch (error) {
        setUiError(`Load canvases failed: ${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      disconnectBridge();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePositionChange = useCallback(
    (id: string, position: CanvasPosition) => {
      updateElement(id, { position, updatedAt: Date.now() });
      if (activeCanvasId) {
        executeAction({
          action: "element.move",
          elementId: id,
          canvasId: activeCanvasId,
          position,
        }).catch(() => {});
      }
    },
    [activeCanvasId, updateElement]
  );

  const handleDeleteElement = useCallback(
    (id: string) => {
      removeElement(id);
      if (activeCanvasId) {
        executeAction({
          action: "element.delete",
          elementId: id,
          canvasId: activeCanvasId,
        }).catch(() => {});
      }
    },
    [activeCanvasId, removeElement]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--main-bg)]">
        <div className="shimmer-text text-sm">{t("conductor.loading")}</div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden bg-[var(--main-bg)]">
      <div className="relative h-full">
        {/* Header with Canvas Selector */}
        <div className="absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-4 py-2">
          <CanvasSelector />
        </div>

        {uiError && (
          <div className="absolute left-1/2 top-12 -translate-x-1/2 z-40 w-[min(720px,80vw)] rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-xs text-[var(--error)] flex items-center justify-between gap-2 shadow-lg">
            <span className="truncate">{uiError}</span>
            <button
              type="button"
              onClick={() => setUiError(null)}
              className="text-[var(--error)]/80 hover:text-[var(--error)]"
              aria-label={t("conductor.dismissError")}
            >
              ×
            </button>
          </div>
        )}

        {activeCanvasId ? (
          <CanvasErrorBoundary>
            <CanvasArea
              elements={elements}
              readOnly={false}
              onPositionChange={handlePositionChange}
              onDeleteElement={handleDeleteElement}
            />
          </CanvasErrorBoundary>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--muted)] text-sm gap-4">
            <p>{t("conductor.selectOrCreateCanvas")}</p>
          </div>
        )}

        <CanvasToolbar />

        <RefinePanel />
      </div>
    </div>
  );
}
