"use client";

import { useCallback, useMemo, useState } from "react";
import { MagicWand, PaperPlaneTilt, SpinnerGap, X } from "@phosphor-icons/react";
import { useConductorStreamControl } from "@/hooks/useConductorStream";
import { buildObjectAgentPrompt } from "../agent/object-agent-prompt";
import { useConductorStore } from "../stores/conductor-store";
import type { CanvasElement } from "../types/conductor";

const GRID_PX = 80;
const PANEL_WIDTH = 360;

function getElementLabel(element: CanvasElement): string {
  if (element.metadata?.label) return element.metadata.label;
  if (element.native_kind) return element.native_kind;
  return element.elementKind.replace(/^widget\//, "").replace(/^native\//, "");
}

function getElementTypeHint(element: CanvasElement): string {
  if (element.elementKind.startsWith("widget/")) return "widget";
  if (element.native_kind === "sticky") return "sticky";
  if (element.native_kind === "mindmap") return "mind map";
  if (element.native_kind) return element.native_kind;
  return element.elementKind;
}

export function ObjectAgentPrompt() {
  const [value, setValue] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
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
    setIsExpanded(true);
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
      <div className="rounded-lg border border-[var(--border)] bg-[var(--sidebar-bg)] shadow-[0_16px_40px_rgba(0,0,0,0.32)] overflow-hidden">
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[var(--border)]/70">
          <MagicWand size={14} className="text-[var(--accent)] flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-[var(--text)] truncate">
              {selectedElements.length > 1 ? `${selectedElements.length} selected objects` : getElementLabel(primary)}
            </div>
            <div className="text-[10px] text-[var(--muted)] truncate">
              Ask agent to edit this {getElementTypeHint(primary)}
            </div>
          </div>
          {isBusy && <SpinnerGap size={13} className="animate-spin text-[var(--muted)] flex-shrink-0" />}
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]"
            onClick={() => {
              setValue("");
              setIsExpanded(false);
            }}
            aria-label="Clear object agent prompt"
          >
            <X size={12} />
          </button>
        </div>
        <div className="flex items-end gap-2 px-2.5 py-2">
          <textarea
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (!isExpanded) setIsExpanded(true);
            }}
            onFocus={() => setIsExpanded(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
              }
              if (event.key === "Escape") {
                event.currentTarget.blur();
                setIsExpanded(false);
              }
            }}
            rows={isExpanded ? 3 : 1}
            disabled={isBusy}
            placeholder="Change, rewrite, generate, or arrange..."
            className="min-h-0 flex-1 resize-none bg-transparent py-1 text-[12px] leading-5 text-[var(--text)] outline-none placeholder:text-[var(--muted)] disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim() || isBusy}
            className="mb-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--send-btn)] text-white transition-colors hover:bg-[var(--send-btn-hover)] disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Send object agent prompt"
          >
            <PaperPlaneTilt size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

