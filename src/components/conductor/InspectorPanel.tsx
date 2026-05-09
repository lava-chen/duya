"use client";

import { useMemo } from "react";
import { useConductorStore } from "@/stores/conductor-store";

function formatDate(ts: number) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "-";
  }
}

export function InspectorPanel() {
  const { activeCanvasId, canvases, widgets } = useConductorStore();

  const activeCanvas = useMemo(
    () => canvases.find((canvas) => canvas.id === activeCanvasId) || null,
    [canvases, activeCanvasId]
  );

  // V1 lightweight selection fallback: use first widget when present.
  const activeWidget = widgets.length > 0 ? widgets[0] : null;

  return (
    <aside className="w-[280px] border-l border-[var(--border)] bg-[var(--sidebar-bg)] flex-shrink-0 overflow-y-auto">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--text)] uppercase">Inspector</h3>
      </div>

      {!activeWidget ? (
        <div className="p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-[var(--text)]">Canvas</p>
            <p className="text-xs text-[var(--muted)] mt-1">
              {activeCanvas?.name || "No canvas selected"}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--main-bg)] p-3">
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Click the add button in the left toolbar to insert your first widget. Drag on the canvas to arrange your workspace.
            </p>
          </div>
          {activeCanvas?.description ? (
            <div>
              <p className="text-xs text-[var(--muted)] uppercase tracking-wide">Description</p>
              <p className="text-sm text-[var(--text)] mt-1">{activeCanvas.description}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="p-4 space-y-3">
          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wide">Widget Type</p>
            <p className="text-sm text-[var(--text)] mt-1">{activeWidget.type}</p>
          </div>

          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wide">Widget ID</p>
            <p className="text-xs text-[var(--text)] mt-1 break-all">{activeWidget.id}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <InfoCell label="X" value={String(activeWidget.position.x)} />
            <InfoCell label="Y" value={String(activeWidget.position.y)} />
            <InfoCell label="W" value={String(activeWidget.position.w)} />
            <InfoCell label="H" value={String(activeWidget.position.h)} />
          </div>

          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wide">State</p>
            <p className="text-sm text-[var(--text)] mt-1">{activeWidget.state}</p>
          </div>

          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wide">Updated</p>
            <p className="text-xs text-[var(--text)] mt-1">{formatDate(activeWidget.updatedAt)}</p>
          </div>
        </div>
      )}
    </aside>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--main-bg)] px-2 py-1.5">
      <p className="text-[10px] text-[var(--muted)] uppercase">{label}</p>
      <p className="text-xs text-[var(--text)] mt-0.5">{value}</p>
    </div>
  );
}
