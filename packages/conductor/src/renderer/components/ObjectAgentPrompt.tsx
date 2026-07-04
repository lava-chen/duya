"use client";

import { useCallback, useMemo, useState } from "react";
import { PaperPlaneTilt, SpinnerGap } from "@phosphor-icons/react";
import { useConductorStreamControl } from "../hooks/useConductorStream";
import { buildObjectAgentPrompt } from "../agent/object-agent-prompt";
import { useConductorStore } from "../stores/conductor-store";
import type { CanvasElement } from "../types/conductor";

const GRID_PX = 80;
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
  const { startStream } = useConductorStreamControl(activeCanvasId);

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

  const position = useMemo(() => {
    if (!primary) return null;
    const zoom = canvasZoom > 0 ? canvasZoom : 1;
    const widthPx = primary.position.w * GRID_PX * zoom;
    const left = canvasScrollX + primary.position.x * zoom + widthPx / 2;
    const top = canvasScrollY + (primary.position.y + primary.position.h * GRID_PX) * zoom + 14;
    const clampedLeft = Math.max(16, Math.min(left - PANEL_WIDTH / 2, Math.max(16, canvasViewportW - PANEL_WIDTH - 16)));
    return { left: clampedLeft, top: Math.max(56, top) };
  }, [canvasScrollX, canvasScrollY, canvasViewportW, canvasZoom, primary]);

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

    try {
      startStream({
        content,
        snapshot: snapshot ?? {
          canvasId: activeCanvasId,
          canvasName: "Canvas",
          elements,
          widgets: [],
          actionCursor: 0,
        },
        model: conductorModel || undefined,
      });
    } catch (error) {
      setAgentStatus("error");
      setUiError(`Object agent failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [
    activeCanvasId,
    conductorModel,
    elements,
    isBusy,
    primary,
    selectedElements,
    setAgentStatus,
    setUiError,
    snapshot,
    startStream,
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
