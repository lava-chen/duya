"use client";

import { useEffect } from "react";
import { captureCanvasView } from "../refine/screenshot";

/**
 * Listen for agent-initiated canvas capture requests and respond with
 * a screenshot taken via html2canvas.
 *
 * The agent calls `canvas_capture` -> main process sends a capture
 * request to the renderer via the conductor channel -> this hook
 * takes a screenshot -> sends the result back to main.
 *
 * This hook MUST be mounted by every component that hosts the canvas
 * viewport (`.canvas-area` / `.canvas-inner`). Otherwise capture
 * requests from the agent will time out (15s) with no response.
 * Currently mounted by:
 *   - ConductorView (full-screen conductor view)
 *   - SidebarConductorView (sidebar canvas panel in chat + conductor mode)
 *
 * Feature-detects `onCaptureRequest`: when running against a stale
 * preload (e.g. user ran vite dev without rebuilding electron), the
 * conductor port will exist but won't expose the capture APIs. In
 * that case, skip registering the listener and let the agent fall
 * back to no-vision mode for this session.
 *
 * @param activeCanvasId The currently active canvas ID. Re-subscribes
 *   when this changes (the port may have been swapped between canvases).
 */
export function useCanvasCaptureRequest(activeCanvasId?: string | null): void {
  useEffect(() => {
    if (!window.electronAPI?.getConductorPort) return;

    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    const subscribe = (port: {
      onCaptureRequest: (
        cb: (req: CaptureRequest) => void,
      ) => () => void;
      sendCaptureResponse: (data: CaptureResponse) => void;
    }) => {
      if (cancelled) return;
      if (typeof port.onCaptureRequest !== "function") {
        console.warn(
          "[useCanvasCaptureRequest] conductorPort.onCaptureRequest is unavailable; " +
            "rebuild the electron preload (npm run build:electron) to enable " +
            "agent-initiated canvas capture.",
        );
        return;
      }

      unsubscribe = port.onCaptureRequest(async (req: CaptureRequest) => {
        const send = (data: CaptureResponse) => {
          if (typeof port.sendCaptureResponse === "function") {
            port.sendCaptureResponse(data);
          } else {
            console.warn(
              "[useCanvasCaptureRequest] sendCaptureResponse missing; capture result dropped",
              req.requestId,
            );
          }
        };

        console.log(
          "[useCanvasCaptureRequest] capture request received",
          req.requestId,
          req.scope,
          req.canvasId,
        );

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

          console.log(
            "[useCanvasCaptureRequest] capture succeeded",
            req.requestId,
            result.width,
            result.height,
          );
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
          console.error("[useCanvasCaptureRequest] capture failed", req.requestId, err);
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
        if (p) subscribe(p as Parameters<typeof subscribe>[0]);
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
}

interface CaptureRequest {
  requestId: string;
  canvasId: string;
  scope: string;
  elementId?: string;
  region?: { x: number; y: number; w: number; h: number };
}

interface CaptureResponse {
  requestId: string;
  result?: unknown;
  error?: string;
}
