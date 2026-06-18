"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasArea } from "./CanvasArea";
import { ConductorComposer } from "./ConductorComposer";
import { HistoryPanel } from "./HistoryPanel";
import { CanvasStatusBar } from "./CanvasStatusBar";
import { CanvasSelector } from "./CanvasSelector";
import { useConductorStore } from "..//stores/conductor-store";
import { listCanvases, createCanvas, getSnapshot, executeAction } from "..//ipc/conductor-ipc";
import { registerAllElements } from "../elements";
import "../widgets";
import { RefinePanel } from "..//refine/RefinePanel";
import { captureCanvasView } from "../refine/screenshot";
import type { CanvasPosition } from "..//types/conductor";

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

  // ── Agent-initiated canvas capture ───────────────────────────────
  // The agent calls canvas_capture → main process sends a capture
  // request to the renderer via the conductor channel → we take a
  // screenshot using html2canvas → send the result back to main.
  //
  // Feature-detect onCaptureRequest: when running against a stale
  // preload (e.g. user ran vite dev without rebuilding electron),
  // the conductor port will exist but won't expose the new capture
  // APIs. In that case, just skip registering the listener and let
  // the agent fall back to no-vision mode for this session.
  //
  // Wait for `conductor-port-ready` before grabbing the port. The
  // main process posts the MessagePort to the renderer in
  // `did-finish-load`, which can fire before the React effect runs
  // but the postMessage lands in the next event-loop tick. Calling
  // getConductorPort() too early returns null and floods the
  // preload console with "conductorPort is null" warnings.
  useEffect(() => {
    if (!window.electronAPI?.getConductorPort) return;

    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    const subscribe = (port: any) => {
      if (cancelled) return;
      if (typeof port.onCaptureRequest !== "function") {
        console.warn(
          "[ConductorView] conductorPort.onCaptureRequest is unavailable; " +
          "rebuild the electron preload (npm run build:electron) to enable " +
          "agent-initiated canvas capture.",
        );
        return;
      }

      unsubscribe = port.onCaptureRequest(async (req: {
        requestId: string;
        canvasId: string;
        scope: string;
        elementId?: string;
        region?: { x: number; y: number; w: number; h: number };
      }) => {
        const send = (data: { requestId: string; result?: unknown; error?: string }) => {
          if (typeof port.sendCaptureResponse === "function") {
            port.sendCaptureResponse(data);
          } else {
            console.warn("[ConductorView] sendCaptureResponse missing; capture result dropped", req.requestId);
          }
        };

        try {
          const viewportEl = document.querySelector<HTMLElement>(".canvas-area");
          const canvasInnerEl = document.querySelector<HTMLElement>(".canvas-inner");

          if (!viewportEl) {
            send({
              requestId: req.requestId,
              error: "Canvas viewport not found. Is a canvas open?",
            });
            return;
          }

          const result = await captureCanvasView(viewportEl, canvasInnerEl, {
            scope: req.scope as "viewport" | "element" | "region",
            elementId: req.elementId,
            region: req.region,
          });

          send({
            requestId: req.requestId,
            result: {
              pngBase64: result.pngBase64,
              width: result.width,
              height: result.height,
              dataUrl: result.dataUrl,
              scope: result.scope,
              capturedAt: result.capturedAt,
            },
          });
        } catch (err) {
          send({
            requestId: req.requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    };

    const port = window.electronAPI.getConductorPort();
    if (port) {
      // Port already ready (re-mount, or main process beat us to it)
      subscribe(port);
    } else {
      // Wait for the ready event the preload fires once the
      // MessagePort has been assigned.
      const handleReady = () => {
        const p = window.electronAPI?.getConductorPort?.();
        if (p) subscribe(p);
      };
      window.addEventListener("conductor-port-ready", handleReady, { once: true });
      // Cleanup listener if we unmount before ready fires
      return () => {
        cancelled = true;
        window.removeEventListener("conductor-port-ready", handleReady);
        if (unsubscribe) unsubscribe();
      };
    }

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [activeCanvasId]);

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

        <RefinePanel />
      </div>
    </div>
  );
}
