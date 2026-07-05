"use client";

import { useCallback, useMemo, useState } from "react";
import { PaperPlaneTilt, SpinnerGap } from "@phosphor-icons/react";
import { buildObjectAgentPrompt } from "../agent/object-agent-prompt";
import { useConductorStore } from "../stores/conductor-store";
import { useConversationStore } from "@/stores/conversation-store";
import type { CanvasElement } from "../types/conductor";
import {
  isStylePanelKind,
  STYLE_PANEL_HEIGHT,
  STYLE_PANEL_STACK_GAP,
} from "./StylePanel";
import { GRID_PX } from "../domain/canvas/units";
const PANEL_WIDTH = 320;

export function ObjectAgentPrompt() {
  const [value, setValue] = useState("");
  const {
    activeCanvasId,
    agentStatus,
    canvasScrollX,
    canvasScrollY,
    canvasViewportW,
    canvasZoom,
    conductorModel,
    elements,
    selectedElementId,
    selectedElementIds,
    setAgentStatus,
    setUiError,
    snapshot,
  } = useConductorStore();
  // Plan 221 Phase 7: in-canvas entry points now forward to the main chat
  // session. We only need the active main thread id (the conductor sign is
  // applied via session.setConductorMode below).
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  const selectedElements = useMemo(() => {
    const ids = selectedElementIds.length > 0
      ? selectedElementIds
      : selectedElementId
        ? [selectedElementId]
        : [];
    const idSet = new Set(ids);
    return elements.filter((element) => idSet.has(element.id));
  }, [elements, selectedElementId, selectedElementIds]);

  const primary = selectedElements[0] ?? null;
  const isBusy = agentStatus === "thinking" || agentStatus === "streaming" || agentStatus === "tool_use";
  // When the StylePanel is visible (single sticky/connector/group selection),
  // stack below it to avoid overlap.
  const stylePanelVisible = !!primary && isStylePanelKind(primary.elementKind);

  const position = useMemo(() => {
    if (!primary) return null;
    const zoom = canvasZoom > 0 ? canvasZoom : 1;
    const widthPx = primary.position.w * GRID_PX * zoom;
    const left = canvasScrollX + primary.position.x * GRID_PX * zoom + widthPx / 2;
    const stackOffset = stylePanelVisible ? STYLE_PANEL_HEIGHT + STYLE_PANEL_STACK_GAP : 0;
    const top = canvasScrollY + (primary.position.y * GRID_PX + primary.position.h * GRID_PX) * zoom + 14 + stackOffset;
    const clampedLeft = Math.max(16, Math.min(left - PANEL_WIDTH / 2, Math.max(16, canvasViewportW - PANEL_WIDTH - 16)));
    return { left: clampedLeft, top: Math.max(56, top) };
  }, [canvasScrollX, canvasScrollY, canvasViewportW, canvasZoom, primary, stylePanelVisible]);

  const handleSubmit = useCallback(() => {
    if (!activeCanvasId || !primary || !value.trim() || isBusy) return;

    const content = buildObjectAgentPrompt({
      userRequest: value,
      selectedElements,
      allElements: elements,
      snapshot,
    });

    setValue("");
    setAgentStatus("thinking");
    setUiError(null);

    // Plan 221 Phase 7: forward to the main chat session instead of spawning
    // a separate conductor agent. The main agent (with conductor mode
    // enabled) receives the prompt and uses the canvas tools directly.
    void (async () => {
      const sessionId = activeThreadId;
      try {
        if (sessionId) {
          await window.electronAPI?.session?.setConductorMode(
            sessionId,
            true,
            activeCanvasId,
          );
        }
        window.dispatchEvent(
          new CustomEvent("conductor:forward-message", {
            detail: {
              text: content,
              canvasId: activeCanvasId,
              sessionId,
              elementContext: selectedElements.map((el) => ({
                id: el.id,
                elementKind: el.elementKind,
              })),
              // Pass through model preference for the main chat input to pick up.
              model: conductorModel || undefined,
              source: "object-agent-prompt",
            },
          }),
        );
      } catch (error) {
        setAgentStatus("error");
        setUiError(
          `Object agent forward failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }, [
    activeCanvasId,
    activeThreadId,
    conductorModel,
    elements,
    isBusy,
    primary,
    selectedElements,
    setAgentStatus,
    setUiError,
    snapshot,
    value,
  ]);

  if (!activeCanvasId || !primary || !position) return null;

  return (
    <div
      className="absolute z-[45] pointer-events-auto"
      style={{ left: position.left, top: position.top, width: PANEL_WIDTH }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--sidebar-bg)] px-2 py-1 shadow-[0_16px_40px_rgba(0,0,0,0.32)]">
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
            if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
          disabled={isBusy}
          placeholder="Ask agent..."
          className="min-w-0 flex-1 bg-transparent py-1 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--muted)] disabled:opacity-60"
        />
        {isBusy ? (
          <SpinnerGap size={13} className="flex-shrink-0 animate-spin text-[var(--muted)]" />
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim() || isBusy}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--send-btn)] text-white transition-colors hover:bg-[var(--send-btn-hover)] disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Send object agent prompt"
          >
            <PaperPlaneTilt size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
