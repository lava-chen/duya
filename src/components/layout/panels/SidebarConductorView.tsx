"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "@duya/conductor/renderer/components/CanvasToolbar";
import { CanvasArea } from "@duya/conductor/renderer/components/CanvasArea";
import { CanvasSelector } from "@duya/conductor/renderer/components/CanvasSelector";
import { useConductorStore } from "@duya/conductor/renderer/stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "@duya/conductor/renderer/ipc/conductor-ipc";
import { registerAllElements } from "@duya/conductor/renderer/elements";
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

        if (tabCanvasId) {
          // Canvas id was provided via tab params — look it up in the
          // list and activate it. Only switch if the canvas exists; the
          // first-canvas / create-new fallbacks below are the legacy
          // "active canvas" behavior used when no canvasId is given.
          const target = list.find((c) => c.id === tabCanvasId);
          if (target) {
            setActiveCanvas(target.id);
            const snap = await getSnapshot(target.id);
            if (snap && !cancelled) setSnapshot(snap);
            connectBridge(target.id);
          } else if (list.length > 0) {
            setActiveCanvas(list[0].id);
            const snap = await getSnapshot(list[0].id);
            if (snap && !cancelled) setSnapshot(snap);
            connectBridge(list[0].id);
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
        } else if (list.length > 0 && !activeCanvasId) {
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
  }, [tabCanvasId, activeCanvasId, setCanvases, setActiveCanvas, setSnapshot, connectBridge, disconnectBridge, setUiError]);

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