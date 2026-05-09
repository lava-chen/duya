"use client";

import type { ConductorWidget } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
import { executeAction } from "@/lib/conductor-ipc";
import { widgetRegistry } from "@/conductor/widgets/registry";
import { X, Warning, SpinnerGap, Robot } from "@phosphor-icons/react";

interface WidgetShellProps {
  widget: ConductorWidget;
}

export function WidgetShell({ widget }: WidgetShellProps) {
  const { editMode, activeCanvasId, removeWidget, agentStatus } = useConductorStore();

  const WidgetContent = widgetRegistry.get(widget.type)?.component;
  const isAgentEditing = agentStatus === "streaming" || agentStatus === "tool_use" || agentStatus === "thinking";

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

  return (
    <div className="flex flex-col h-full rounded-xl border border-[var(--border)] bg-[var(--main-bg)] overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md group">
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
