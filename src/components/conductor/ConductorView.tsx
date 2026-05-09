"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasArea } from "./CanvasArea";
import { ConductorComposer } from "./ConductorComposer";
import { HistoryPanel } from "./HistoryPanel";
import { CanvasStatusBar } from "./CanvasStatusBar";
import { useConductorStore } from "@/stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "@/lib/conductor-ipc";
import { CaretDown, Plus } from "@phosphor-icons/react";
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
  const [showCanvasMenu, setShowCanvasMenu] = useState(false);

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
          const canvas = await createCanvas("工作台");
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

  const handleSelectCanvas = useCallback(
    async (canvasId: string) => {
      setActiveCanvas(canvasId);
      connectBridge(canvasId);
      const snap = await getSnapshot(canvasId);
      if (snap) setSnapshot(snap);
    },
    [setActiveCanvas, setSnapshot, connectBridge]
  );

  const handleCreateCanvas = useCallback(async () => {
    try {
      const canvas = await createCanvas(`工作台 ${canvases.length + 1}`);
      addCanvas(canvas);
      setActiveCanvas(canvas.id);
      connectBridge(canvas.id);
      const snap = await getSnapshot(canvas.id);
      if (snap) setSnapshot(snap);
      setUiError(null);
    } catch (error) {
      setUiError(`Create canvas failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }, [canvases.length, addCanvas, setActiveCanvas, connectBridge, setSnapshot, setUiError]);

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
      <div className="flex items-center justify-center h-full">
        <div className="shimmer-text text-sm">Loading Conductor...</div>
      </div>
    );
  }

  const activeName = canvases.find((c) => c.id === activeCanvasId)?.name || "Select Canvas";

  return (
    <div className="h-full w-full overflow-hidden relative bg-[var(--main-bg)]">
      <CanvasToolbar />

      <div className="absolute left-4 top-4 z-30">
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowCanvasMenu((v) => !v)}
            className="flex items-center gap-1.5 rounded-full border border-[var(--border)]/80 bg-[var(--sidebar-bg)]/92 backdrop-blur-md px-3 py-1.5 text-[13px] text-[var(--text)] shadow-[0_8px_22px_rgba(0,0,0,0.32)]"
          >
            <span className="max-w-[180px] truncate font-medium">{activeName}</span>
            <CaretDown size={14} className="text-[var(--muted)]" />
          </button>

          {showCanvasMenu && (
            <div className="absolute left-0 mt-2 w-[240px] rounded-xl border border-[var(--border)] bg-[var(--sidebar-bg)]/95 backdrop-blur-md shadow-xl overflow-hidden">
              <div className="max-h-[260px] overflow-y-auto">
                {canvases.map((canvas) => (
                  <button
                    key={canvas.id}
                    type="button"
                    onClick={() => {
                      handleSelectCanvas(canvas.id);
                      setShowCanvasMenu(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                      canvas.id === activeCanvasId
                        ? "bg-[var(--surface)] text-[var(--text)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    }`}
                  >
                    {canvas.name}
                  </button>
                ))}
              </div>
              <div className="border-t border-[var(--border)] p-2">
                <button
                  type="button"
                  onClick={async () => {
                    await handleCreateCanvas();
                    setShowCanvasMenu(false);
                  }}
                  className="w-full flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent-soft)] text-[var(--accent)] px-2 py-1.5 text-sm hover:opacity-90"
                >
                  <Plus size={14} />
                  New Canvas
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {uiError && (
        <div className="absolute left-1/2 top-4 -translate-x-1/2 z-40 w-[min(720px,80vw)] rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-xs text-[var(--error)] flex items-center justify-between gap-2 shadow-lg">
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
          <button
            type="button"
            onClick={handleCreateCanvas}
            className="px-4 py-2 rounded-md bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 transition-opacity text-sm"
          >
            Create Canvas
          </button>
        </div>
      )}

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
  );
}
