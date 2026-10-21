"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ConductorWidget } from "..//types/conductor";
import { useConductorStore } from "..//stores/conductor-store";
import { executeAction, widgetAction } from "..//ipc/conductor-ipc";
import { widgetRegistry, type DynamicWidgetDefinition } from "..//widgets/registry";
import { useRefineCaptureTarget } from "..//refine/useRefineCaptureTarget";
import { RefineToolbarButton } from "..//refine/RefineToolbarButton";
import { XIcon, WarningIcon, SpinnerGapIcon, RobotIcon } from "@/components/icons";
import { GRID_PX } from "../domain/canvas/units";
import {
  buildWorkbenchSrcdoc,
  WORKBENCH_ACTION_MESSAGE,
  WORKBENCH_DATA_MESSAGE,
  type WorkbenchActionPayload,
} from "../elements/workbench-runtime";

interface WidgetShellProps {
  widget: ConductorWidget;
  dynamicDef?: DynamicWidgetDefinition;
}

const CHROME_PADDING_PX = 12 + 12; // body padding on each side

export function WidgetShell({ widget, dynamicDef }: WidgetShellProps) {
  const { editMode, activeCanvasId, removeWidget, agentStatus, updateElement } = useConductorStore();
  const captureRef = useRefineCaptureTarget(widget.id);
  const resizedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Plan 570: live workbench snapshots for this widget's canvas.
  const workbenchSnapshots = useConductorStore((state) =>
    widget.canvasId ? state.workbenchData[widget.canvasId]?.snapshots : undefined,
  );

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

  // ------------------------------------------------------------
  // Plan 570: workbench runtime — data push + action routing.
  // ------------------------------------------------------------

  // Dynamic widget srcdoc with the workbench runtime injected (recomputed
  // only when the agent rewrites the source, so iframe reloads stay rare).
  const workbenchSrcdoc = useMemo(
    () => (widget.sourceCode ? buildWorkbenchSrcdoc(widget.sourceCode) : null),
    [widget.sourceCode],
  );

  // Route action intents from the iframe (strategy buttons) into the
  // main-process runtime. `event.source` ties the message to THIS iframe —
  // sandboxed iframes have an opaque origin, so source identity is the only
  // meaningful check.
  useEffect(() => {
    if (!workbenchSrcdoc || !widget.canvasId) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; action?: WorkbenchActionPayload } | null;
      if (!data || data.type !== WORKBENCH_ACTION_MESSAGE || !data.action) return;
      const action = data.action;
      if (action.kind !== "refresh" || !action.sourceId) return;
      void widgetAction({
        canvasId: widget.canvasId,
        elementId: widget.id,
        action: { kind: "refresh", sourceId: action.sourceId },
      }).catch(() => {});
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [workbenchSrcdoc, widget.canvasId, widget.id]);

  // Push the latest canvas snapshots into the iframe — on every data change
  // and again when the iframe (re)loads, so late iframes never miss state.
  const pushWorkbenchData = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        { type: WORKBENCH_DATA_MESSAGE, snapshots: workbenchSnapshots ?? {} },
        "*",
      );
    } catch {
      // iframe not ready — the next push or reload effect will catch up.
    }
  };

  useEffect(() => {
    pushWorkbenchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchSnapshots, workbenchSrcdoc]);

  // Dynamic widgets are agent-generated HTML/SVG. They already provide
  // their own visual container (background, borders, title), so we render
  // them without the builtin widget shell/header. The srcdoc carries the
  // workbench runtime (live data + action bridge) when sourceCode exists.
  if (dynamicDef?.renderMode === "iframe" && dynamicDef.sanitizedHtml) {
    const srcdoc = workbenchSrcdoc ?? dynamicDef.sanitizedHtml;
    return (
      <div
        ref={captureRef}
        data-testid={`widget-shell-${widget.id}`}
        className="w-full h-full overflow-hidden"
      >
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "100%", border: "none", pointerEvents: "auto" }}
          title="widget-dynamic"
          onLoad={pushWorkbenchData}
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
              <RobotIcon size={11} />
              <span className="hidden sm:inline">Agent</span>
            </span>
          ) : null}
          <span className="text-xs font-medium text-[var(--text)] truncate">
            {widget.config?.title as string || widget.type}
          </span>
          {widget.state === "loading" && (
            <SpinnerGapIcon size={12} className="animate-spin text-[var(--muted)]" />
          )}
          {widget.state === "error" && (
            <WarningIcon size={12} className="text-[var(--error)]" />
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
              <XIcon size={12} />
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
