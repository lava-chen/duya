"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "@duya/conductor/renderer/components/CanvasToolbar";
import { CanvasArea } from "@duya/conductor/renderer/components/CanvasArea";
import { CanvasSelector } from "@duya/conductor/renderer/components/CanvasSelector";
import { useConductorStore } from "@duya/conductor/renderer/stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "@duya/conductor/renderer/ipc/conductor-ipc";
import { registerAllElements } from "@duya/conductor/renderer/elements";
import { useCanvasCaptureRequest } from "@duya/conductor/renderer/hooks/useCanvasCaptureRequest";
import "@duya/conductor/renderer/widgets";
import type { CanvasPosition } from "@duya/conductor/renderer/types/conductor";
import type { PageTab } from "./registry";

export function SidebarConductorView({
  tab,
  embedded: _embedded = false,
}: {
  tab?: PageTab;
  embedded?: boolean;
}) {
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

  // When mounted as a registry page, tab is provided and the canvas is
  // frozen at open time. When mounted standalone (legacy / tests), fall
  // back to the active canvas id from the conductor store.
  const tabCanvasId = tab?.params?.canvasId as string | undefined;

  const [isLoading, setIsLoading] = useState(true);

  // Register the agent-initiated canvas capture listener so the
  // sidebar canvas can respond to canvas_capture tool calls. Without
  // this, capture requests time out (15s) when the user is in chat
  // view + sidebar conductor mode (the full ConductorView is not
  // mounted in that layout).
  useCanvasCaptureRequest(activeCanvasId);

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

        // Decide which canvas to show. Priority:
        //   1. tab.params.canvasId (frozen tab)
        //   2. store.activeCanvasId (resume last viewed)
        //   3. list[0] (first canvas)
        //   4. create new "Workbench"
        const desiredId =
          (tabCanvasId && list.find((c) => c.id === tabCanvasId)?.id) ||
          (activeCanvasId && list.find((c) => c.id === activeCanvasId)?.id) ||
          list[0]?.id;

        if (desiredId) {
          // Always reload the snapshot. The store may have stale
          // elements from a previous canvas (or none at all) — without
          // this refresh, reopening the panel shows an empty canvas
          // until the user manually refreshes.
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
  }, [tabCanvasId]);

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