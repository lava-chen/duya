"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "@/components/conductor/CanvasToolbar";
import { CanvasArea } from "@/components/conductor/CanvasArea";
import { CanvasSelector } from "@/components/conductor/CanvasSelector";
import { useConductorStore } from "@/stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "@/lib/conductor-ipc";
import { registerAllElements } from "@/conductor/elements";
import "@/conductor/widgets";
import type { CanvasPosition } from "@/types/conductor";

export function SidebarConductorView() {
  const {
    activeCanvasId,
    setCanvases,
    setActiveCanvas,
    setSnapshot,
    connectBridge,
    disconnectBridge,
    uiError,
    setUiError,
    elements,
    updateElement,
    removeElement,
  } = useConductorStore();

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    registerAllElements();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const list = await listCanvases();
        if (cancelled) return;

        setCanvases(list);

        if (list.length > 0 && !activeCanvasId) {
          setActiveCanvas(list[0].id);
          const snap = await getSnapshot(list[0].id);
          if (snap && !cancelled) setSnapshot(snap);
          connectBridge(list[0].id);
        } else if (list.length === 0) {
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
      <div className="sidebar-conductor-loading">
        Loading Conductor...
      </div>
    );
  }

  return (
    <div className="sidebar-conductor">
      <div className="sidebar-conductor-header">
        <CanvasSelector />
      </div>

      {uiError && (
        <div
          className="mx-2 mt-2 rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-xs text-[var(--error)] flex items-center justify-between gap-2"
        >
          <span className="truncate">{uiError}</span>
          <button
            type="button"
            onClick={() => setUiError(null)}
            className="text-[var(--error)]/80 hover:text-[var(--error)]"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="sidebar-conductor-canvas">
        {activeCanvasId ? (
          <CanvasArea
            elements={elements}
            readOnly={false}
            onPositionChange={handlePositionChange}
            onDeleteElement={handleDeleteElement}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--muted)] text-sm gap-4">
            <p>Select or create a canvas to begin</p>
          </div>
        )}

        <CanvasToolbar />
      </div>
    </div>
  );
}