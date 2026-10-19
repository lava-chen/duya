"use client";

import { useState, useEffect, useCallback } from "react";
import { CanvasToolbar } from "@duya/conductor/renderer/components/CanvasToolbar";
import { CanvasArea } from "@duya/conductor/renderer/components/CanvasArea";
import { FiniteCanvasArea } from "@duya/conductor/renderer/components/FiniteCanvasArea";
import {
  CanvasPresentationModeToggle,
  type CanvasPresentationMode,
} from "@duya/conductor/renderer/components/CanvasPresentationModeToggle";
import { CanvasErrorBoundary } from "@duya/conductor/renderer/components/CanvasErrorBoundary";
import { CanvasSelector } from "@duya/conductor/renderer/components/CanvasSelector";
import { CanvasLibraryView } from "@duya/conductor/renderer/components/CanvasLibraryView";
import { useConductorStore } from "@duya/conductor/renderer/stores/conductor-store";
import { listCanvases, listCanvasGroups, getSnapshot, executeAction } from "@duya/conductor/renderer/ipc/conductor-ipc";
import { registerAllElements } from "@duya/conductor/renderer/elements";
import { useCanvasCaptureRequest } from "@duya/conductor/renderer/hooks/useCanvasCaptureRequest";
import "@duya/conductor/renderer/widgets";
import type { CanvasPosition } from "@duya/conductor/renderer/types/conductor";
import type { PageTab } from "./registry";
import { useOptionalPanel } from "@/hooks/usePanel";
import { useConversationStore } from "@/stores/conversation-store";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { ArrowLeftIcon } from "@/components/icons";

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
    setCanvasGroups,
    setActiveCanvas,
    setSnapshot,
    connectBridge,
    disconnectBridge,
    uiError,
    setUiError,
    elements,
    updateElement,
    removeElement,
    pendingChatFocusElementId,
    clearPendingChatFocus,
    centerOnElement,
    setSelectedElementId,
  } = useConductorStore();

  // When mounted as a registry page, tab is provided and the canvas is
  // frozen at open time. When mounted standalone (legacy / tests), fall
  // back to the active canvas id from the conductor store.
  const tabCanvasId = tab?.params?.canvasId as string | undefined;

  const panel = useOptionalPanel();
  const updateTabTitle = panel?.updateTabTitle;
  const currentView = useConversationStore((s) => s.currentView);
  const targetCanvasName = useConductorStore((s) => {
    const targetId = tabCanvasId ?? s.activeCanvasId;
    if (!targetId) return undefined;
    return s.canvases.find((c) => c.id === targetId)?.name;
  });

  useEffect(() => {
    if (!tab?.id || !updateTabTitle || !targetCanvasName) return;
    updateTabTitle(tab.id, targetCanvasName);
  }, [tab?.id, targetCanvasName, updateTabTitle]);

  const [isLoading, setIsLoading] = useState(true);
  // Default to the infinite canvas view. The "finite" / document view
  // is still in development — keep it reachable via the toggle in dev,
  // but ship production users on the canvas view.
  const [presentationMode, setPresentationMode] = useState<CanvasPresentationMode>("infinite");

  // Asset library home vs canvas editor. The sidebar opens on the
  // Notion-style multi-canvas library; clicking a card opens its editor.
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
        const [list, groups] = await Promise.all([listCanvases(), listCanvasGroups()]);
        if (cancelled) return;

        setCanvases(list);
        setCanvasGroups(groups);

        // A frozen tab (opened from a chat canvas link) jumps straight
        // into that canvas's editor. Otherwise the sidebar stays on the
        // multi-canvas library home and the user picks a canvas to open.
        if (tabCanvasId && list.some((c) => c.id === tabCanvasId)) {
          await openCanvas(tabCanvasId);
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

  // Fulfill chat-initiated element focus requests. When a user clicks a
  // canvas tool-use row in the chat, the row stores the target element id
  // in pendingChatFocusElementId and opens the conductor panel. This
  // effect waits until the element is present in the canvas (snapshot may
  // still be loading) and then selects + centers it.
  useEffect(() => {
    if (!pendingChatFocusElementId) return;
    const el = elements.find((e) => e.id === pendingChatFocusElementId);
    if (!el) return;
    // A chat tool-use row asked us to focus an element: make sure the
    // editor is visible (leave the asset library) before centering.
    if (libraryOpen) setLibraryOpen(false);
    setSelectedElementId(pendingChatFocusElementId);
    centerOnElement(pendingChatFocusElementId);
    clearPendingChatFocus();
  }, [pendingChatFocusElementId, elements, libraryOpen, centerOnElement, setSelectedElementId, clearPendingChatFocus]);

  if (isLoading) {
    return (
      <div className="sidebar-conductor-loading">
        Loading Conductor...
      </div>
    );
  }

  return (
    <div className="sidebar-conductor">
      {uiError && (
        <div
          className="mx-2 mt-2 rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-xs text-[var(--error)] flex items-center justify-between gap-2"
        >
          <span className="truncate">{uiError}</span>
          <IconButton
            type="button"
            variant="ghost"
            shape="square"
            size="sm"
            onClick={() => setUiError(null)}
            className="text-[var(--error)]/80 hover:text-[var(--error)]"
            aria-label="Dismiss error"
          >
            ×
          </IconButton>
        </div>
      )}

      {libraryOpen ? (
        <CanvasLibraryView onOpenCanvas={openCanvas} />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 shrink-0 px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLibraryOpen(true)}
                aria-label="返回画布库"
              >
                <ArrowLeftIcon size={15} />
                画布库
              </Button>
              <CanvasSelector />
            </div>
            {import.meta.env.DEV && (
              <CanvasPresentationModeToggle value={presentationMode} onChange={setPresentationMode} />
            )}
          </div>

          <div className="relative flex-1 min-h-0">
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
                <p>Select or create a canvas to begin</p>
              </div>
            )}

            {presentationMode === "infinite" && <CanvasToolbar />}
          </div>
        </>
      )}
    </div>
  );
}
