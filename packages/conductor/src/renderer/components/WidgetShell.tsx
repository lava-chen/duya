"use client";

import { useEffect, useRef } from "react";
import type { ConductorWidget } from "..//types/conductor";
import { useConductorStore } from "..//stores/conductor-store";
import { executeAction } from "..//ipc/conductor-ipc";
import { widgetRegistry, type DynamicWidgetDefinition } from "..//widgets/registry";
import { useRefineCaptureTarget } from "..//refine/useRefineCaptureTarget";
import { RefineToolbarButton } from "..//refine/RefineToolbarButton";
import { X, Warning, SpinnerGap, Robot } from "@phosphor-icons/react";
import { GRID_PX } from "../domain/canvas/units";

interface WidgetShellProps {
  widget: ConductorWidget;
  dynamicDef?: DynamicWidgetDefinition;
}

const CHROME_PADDING_PX = 12 + 12; // body padding on each side

export function WidgetShell({ widget, dynamicDef }: WidgetShellProps) {
  const { editMode, activeCanvasId, removeWidget, agentStatus, updateElement } = useConductorStore();
  const captureRef = useRefineCaptureTarget(widget.id);
  const resizedRef = useRef(false);

  const WidgetContent = widgetRegistry.get(widget.type)?.component;
  const isAgentEditing = agentStatus === "streaming" || agentStatus === "tool_use" || agentStatus === "thinking";

  // Listen to the iframe reporting its natural content height and grow the
  // widget container to fit so no scrollbars appear.
  useEffect(() => {
    if (!dynamicDef?.sanitizedHtml) return;
    const widgetId = widget.id;
    const canvasId = widget.canvasId;
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type !== "widget:resize" || typeof e.data.height !== "number") return;
      if (resizedRef.current) return;
      const contentHeight = e.data.height + CHROME_PADDING_PX;
      const currentHeightPx = widget.position.h * GRID_PX;
      if (contentHeight > currentHeightPx + 4) {
        const newH = Math.ceil(contentHeight / GRID_PX);
        // Read the full element position from the store so we preserve
        // zIndex/rotation when emitting the move action.
        const fullPosition = useConductorStore
          .getState()
          .elements.find((el) => el.id === widgetId)?.position;
        const nextPosition = fullPosition
          ? { ...fullPosition, h: newH }
          : { ...widget.position, h: newH, zIndex: 0, rotation: 0 };
        updateElement(widgetId, {
          position: nextPosition,
        });
        if (canvasId) {
          executeAction({
            action: "element.move",
            canvasId,
            elementId: widgetId,
            position: nextPosition,
          }).catch(() => {});
        }
        resizedRef.current = true;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [dynamicDef?.sanitizedHtml, widget.canvasId, widget.id, widget.position, updateElement]);

  const handleDelete = async () => {
    if (!activeCanvasId) return;
    try {
      await executeAction({
        action: "widget.delete",
        widgetId: widget.id,
        canvasId: activeCanvasId,
      });
      removeWidget(widget.id);
    } catch {
      // Silently fail
    }
  };

  const handleDataChange = (data: Record<string, unknown>) => {
    if (!activeCanvasId) return;

    executeAction({
      action: "widget.update_data",
      widgetId: widget.id,
      canvasId: activeCanvasId,
      data,
      clientTs: Date.now(),
    }).catch(() => {});
  };

  // Dynamic widgets are agent-generated HTML/SVG. They already provide
  // their own visual container (background, borders, title), so we render
  // them without the builtin widget shell/header.
  if (dynamicDef?.renderMode === "iframe" && dynamicDef.sanitizedHtml) {
    return (
      <div
        ref={captureRef}
        data-testid={`widget-shell-${widget.id}`}
        className="w-full h-full overflow-hidden"
      >
        <iframe
          srcDoc={dynamicDef.sanitizedHtml}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "100%", border: "none", pointerEvents: "auto" }}
          title="widget-dynamic"
        />
      </div>
    );
  }

  return (
    <div
      ref={captureRef}
      data-testid={`widget-shell-${widget.id}`}
      className="flex flex-col h-full rounded-xl border border-[var(--border)] bg-[var(--main-bg)] overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md group"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isAgentEditing && widget.state === "agent-editing" ? (
            <span className="flex items-center gap-1 text-[10px] text-[var(--accent)] animate-pulse">
              <Robot size={11} />
              <span className="hidden sm:inline">Agent</span>
            </span>
          ) : null}
          <span className="text-xs font-medium text-[var(--text)] truncate">
            {widget.config?.title as string || widget.type}
          </span>
          {widget.state === "loading" && (
            <SpinnerGap size={12} className="animate-spin text-[var(--muted)]" />
          )}
          {widget.state === "error" && (
            <Warning size={12} className="text-[var(--error)]" />
          )}
        </div>
        {editMode && (
          <div className="flex items-center gap-1">
            <RefineToolbarButton widgetId={widget.id} />
            <button
              type="button"
              onClick={handleDelete}
              className="flex items-center justify-center w-5 h-5 rounded-md text-[var(--muted)] hover:bg-[var(--error-soft)] hover:text-[var(--error)] transition-colors"
              style={{ opacity: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {widget.state === "error" ? (
          <div className="flex items-center justify-center h-full text-xs text-[var(--error)]">
            Widget failed to load
          </div>
        ) : WidgetContent ? (
          <WidgetContent
            data={widget.data}
            config={widget.config}
            onChange={handleDataChange}
            readOnly={isAgentEditing}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-[var(--muted)]">
            Unknown widget: {widget.type}
          </div>
        )}
      </div>
    </div>
  );
}
