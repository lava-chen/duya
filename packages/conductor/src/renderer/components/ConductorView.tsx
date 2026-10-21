"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasArea } from "./CanvasArea";
import { FiniteCanvasArea } from "./FiniteCanvasArea";
import {
  CanvasPresentationModeToggle,
  type CanvasPresentationMode,
} from "./CanvasPresentationModeToggle";
import { CanvasErrorBoundary } from "./CanvasErrorBoundary";
import { CanvasSelector } from "./CanvasSelector";
import { CanvasLibraryView } from "./CanvasLibraryView";
import { useConductorStore } from "..//stores/conductor-store";
import { listCanvases, listCanvasGroups, createCanvas, getSnapshot, executeAction } from "..//ipc/conductor-ipc";
import { registerAllElements } from "../elements";
import "../widgets";
import { RefinePanel } from "..//refine/RefinePanel";
import { useCanvasCaptureRequest } from "../hooks/useCanvasCaptureRequest";
import { useCanvasManagement } from "../hooks/useCanvasManagement";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { PageFrame, PageHeader } from "@/components/ui/page";
import { ArrowLeftIcon } from "@/components/icons";
import type { CanvasPosition } from "..//types/conductor";

export function ConductorView() {
  const { t } = useTranslation();
  const {
    canvases,
    activeCanvasId,
    setCanvases,
    setCanvasGroups,
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
  const [presentationMode, setPresentationMode] = useState<CanvasPresentationMode>("infinite");

  // Asset library home vs canvas editor. The Conductor main view opens on
  // the Notion-style multi-canvas library; clicking a card opens its editor.
  const [libraryOpen, setLibraryOpen] = useState(true);

  const openCanvas = useCallback(
    async (canvasId: string) => {
      disconnectBridge();
      setActiveCanvas(canvasId);
      const snap = await getSnapshot(canvasId);
      if (snap) setSnapshot(snap);
      connectBridge(canvasId);
      setLibraryOpen(false);
    },
    [disconnectBridge, setActiveCanvas, setSnapshot, connectBridge]
  );

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

  // Subscribe to canvas lifecycle broadcasts (create / switch / rename)
  // so the renderer's canvas list stays in sync with what the agent
  // sees. Without this, canvas_manage create looks successful but the
  // renderer's `canvases` is stale and follow-up tools target a canvas
  // the renderer cannot see.
  useCanvasManagement();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [list, groups] = await Promise.all([listCanvases(), listCanvasGroups()]);
        if (cancelled) return;

        setCanvases(list);
        setCanvasGroups(groups);

        // The main view opens on the multi-canvas library home. The user
        // picks a canvas from there; we do NOT auto-open an editor here.
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

  if (libraryOpen) {
    return (
      <PageFrame maxWidth={1280} testId="conductor-main-view">
        <PageHeader
          title={t("conductor.title")}
          subtitle={t("conductor.subtitle")}
        />
        <CanvasLibraryView onOpenCanvas={openCanvas} />
      </PageFrame>
    );
  }

  return (
    <div data-testid="conductor-main-view" className="h-full w-full flex flex-col overflow-hidden bg-[var(--main-bg)]">
      {/* Unified editor header — solid bar consistent with other main pages */}
      <div className="flex items-center justify-between gap-3 shrink-0 px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLibraryOpen(true)}
            aria-label={t("conductor.backToLibrary")}
          >
            <ArrowLeftIcon size={15} />
            {t("conductor.backToLibrary")}
          </Button>
          <CanvasSelector />
        </div>
        {import.meta.env.DEV && (
          <CanvasPresentationModeToggle value={presentationMode} onChange={setPresentationMode} />
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        {uiError && (
          <div className="absolute left-1/2 top-2 -translate-x-1/2 z-40 w-[min(720px,80vw)] rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-xs text-[var(--error)] flex items-center justify-between gap-2 shadow-lg">
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
            {presentationMode === "finite" ? (
              <FiniteCanvasArea
                elements={elements}
                readOnly={false}
                onPositionChange={handlePositionChange}
                onDeleteElement={handleDeleteElement}
              />
            ) : (
              <CanvasArea
                elements={elements}
                readOnly={false}
                onPositionChange={handlePositionChange}
                onDeleteElement={handleDeleteElement}
              />
            )}
          </CanvasErrorBoundary>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--muted)] text-sm gap-4">
            <p>{t("conductor.selectOrCreateCanvas")}</p>
          </div>
        )}

        {presentationMode === "infinite" && <CanvasToolbar />}

        <RefinePanel />
      </div>
    </div>
  );
}
