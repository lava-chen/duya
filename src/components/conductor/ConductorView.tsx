"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasArea } from "./CanvasArea";
import { ConductorComposer } from "./ConductorComposer";
import { HistoryPanel } from "./HistoryPanel";
import { CanvasStatusBar } from "./CanvasStatusBar";
import { CanvasSelector } from "./CanvasSelector";
import { useConductorStore } from "@/stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "@/lib/conductor-ipc";
import { registerAllElements } from "@/conductor/elements";
import "@/conductor/widgets";
import type { CanvasPosition } from "@/types/conductor";

export function ConductorView() {
  const {
    canvases,
    activeCanvasId,
    setCanvases,
    addCanvas,
    setActiveCanvas,
    setSnapshot,
    connectBridge,
    disconnectBridge,
    historyOpen,
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
  }, [activeCanvasId, connectBridge, disconnectBridge, setActiveCanvas, setCanvases, setSnapshot, setUiError]);

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
        <div className="shimmer-text text-sm">Loading Conductor...</div>
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
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

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

        <div className="absolute left-1/2 bottom-5 -translate-x-1/2 z-30 w-[min(860px,84vw)] flex items-end gap-2">
          <div className="flex-1 rounded-2xl border border-[var(--border)] bg-[var(--sidebar-bg)] shadow-[0_14px_36px_rgba(0,0,0,0.42)] overflow-hidden">
            <ConductorComposer />
          </div>
          <div className="rounded-full border border-[var(--border)] bg-[var(--sidebar-bg)] shadow-[0_8px_24px_rgba(0,0,0,0.35)] overflow-hidden flex-shrink-0">
            <CanvasStatusBar />
          </div>
        </div>

        {historyOpen && <HistoryPanel />}
      </div>
    </div>
  );
}