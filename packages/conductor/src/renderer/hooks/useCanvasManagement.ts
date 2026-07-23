"use client";

import { useEffect } from "react";
import { useConductorStore } from "../stores/conductor-store";

/**
 * Subscribe to `conductor:canvas:changed` events broadcast by the main
 * process when the agent creates / switches / renames a canvas.
 *
 * Without this subscription, the renderer's `useConductorStore().canvases`
 * is stale: `canvas_manage create` reports success and persists to SQLite,
 * but the renderer never learns about the new canvas — so
 * `canvas_manage list` from the agent sees the old list, and follow-up
 * element tool calls target a canvas the renderer cannot see. That is
 * what the agent reports as "false success".
 *
 * Mount this hook from any view that owns the conductor canvas surface
 * (ConductorView, SidebarConductorView). Safe to mount from multiple
 * views — Zustand store updates are idempotent.
 */
export function useCanvasManagement(): void {
  const setCanvases = useConductorStore((s) => s.setCanvases);
  const addCanvas = useConductorStore((s) => s.addCanvas);
  const updateCanvas = useConductorStore((s) => s.updateCanvas);
  const setActiveCanvas = useConductorStore((s) => s.setActiveCanvas);

  // Snapshot the action references in a ref-free style — Zustand
  // returns stable function references so this is only for clarity.
  useEffect(() => {
    const port = window.electronAPI?.getConductorPort?.();
    if (!port || typeof port.onCanvasChanged !== "function") {
      console.warn(
        "[useCanvasManagement] conductorPort.onCanvasChanged is unavailable; " +
          "canvas_manage create/switch/rename results will not reach the renderer. " +
          "Rebuild the electron preload (npm run build:electron).",
      );
      return;
    }

    const unsubscribe = port.onCanvasChanged((event) => {
      const canvas = event.canvas as CanvasSummaryFromMain;
      if (!canvas || typeof canvas.id !== "string") return;

      switch (event.operation) {
        case "create":
          // De-duplicate in case the broadcast races the renderer's own
          // initial list load; addCanvas otherwise appends, which can
          // produce duplicate entries after a re-mount.
          addCanvas(canvas);
          if (event.currentCanvasId === canvas.id) {
            setActiveCanvas(canvas.id);
          }
          break;
        case "switch":
          setActiveCanvas(canvas.id);
          break;
        case "rename":
          updateCanvas(canvas);
          break;
        default:
          // Unknown operation — ignore rather than crash.
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [addCanvas, updateCanvas, setActiveCanvas, setCanvases]);
}

/**
 * Subset of `ConductorCanvas` as broadcast by the main process. Only the
 * fields the renderer actually consumes are typed; the IPC carries more
 * but the renderer can ignore the rest.
 */
interface CanvasSummaryFromMain {
  id: string;
  name: string;
  description?: string | null;
  layoutConfig?: Record<string, unknown>;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
  projectPath?: string | null;
}