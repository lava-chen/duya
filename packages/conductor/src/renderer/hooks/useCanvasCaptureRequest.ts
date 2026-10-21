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
          // Wait for the canvas viewport to actually be mounted and to have
          // finished its first paint. Without this gate, capture called
          // during boot (StartupLanding overlay still up) or right after
          // ConductorView exits its `isLoading` placeholder produces a PNG
          // containing the splash screen or empty stage instead of the
          // rendered canvas — silently invalidating visual verification.
          await waitForCanvasViewport(req.requestId);

          const viewportEl = document.querySelector<HTMLElement>(".canvas-area");
          if (!viewportEl) {
            send({
              requestId: req.requestId,
              error: "Canvas viewport not found. Is a canvas open?",
            });
            return;
          }
          const canvasInnerEl = document.querySelector<HTMLElement>(".canvas-inner");

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

/**
 * Resolves once `.canvas-area` exists in the DOM and `.canvas-inner`
 * has finished its first paint — i.e. the agent will not receive a
 * splash-screen PNG when calling `canvas_capture`.
 *
 * Returns a sentinel error when the viewport never becomes ready
 * within the timeout so the caller can surface a clear message
 * instead of saving a useless file.
 *
 * The "ready" condition is: `.canvas-area` is present AND
 * `.canvas-inner` exists. An empty `.canvas-inner` is OK — that is
 * the legitimate "canvas has no elements" state, not a loading state.
 * The earlier failure modes we are protecting against are:
 *   1. `.canvas-area` not yet mounted (ConductorView still in
 *      `isLoading` shimmer-text placeholder);
 *   2. `.canvas-area` mounted but `.canvas-inner` not yet rendered
 *      (React commit in flight);
 *   3. StartupLanding overlay still painting on top.
 *
 * Two `requestAnimationFrame`s after both `.canvas-area` and
 * `.canvas-inner` are present give the browser a chance to flush
 * layout and paint before html2canvas walks the DOM.
 */
const VIEWPORT_READY_TIMEOUT_MS = 4000;
const VIEWPORT_POLL_INTERVAL_MS = 50;
const POST_READY_FRAMES = 2;

export async function waitForCanvasViewport(
  requestId?: string,
): Promise<void> {
  const deadline = Date.now() + VIEWPORT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const viewportEl = document.querySelector<HTMLElement>(".canvas-area");
    const innerEl = document.querySelector<HTMLElement>(".canvas-inner");
    if (viewportEl && innerEl) {
      // Yield to the browser so layout and paint actually finish before
      // html2canvas reads the DOM. Two rAFs is the empirical minimum
      // for React commit + first paint of a freshly-mounted subtree.
      for (let i = 0; i < POST_READY_FRAMES; i++) {
        await nextAnimationFrame();
      }
      return;
    }
    await sleep(VIEWPORT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Canvas viewport never became ready within ${VIEWPORT_READY_TIMEOUT_MS}ms ` +
      (requestId ? `(requestId=${requestId}). ` : "") +
      `The conductor view is likely still in the StartupLanding loading ` +
      `overlay or the canvas store has not yet hydrated. ` +
      `Retry canvas_capture after the canvas is visible.`,
  );
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      // Node test environment without rAF — fall back to a microtask.
      setTimeout(resolve, 16);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
