"use client";

import { ArrowArcLeft, ArrowArcRight, GearSix } from "@phosphor-icons/react";
import { useConductorStore } from "../stores/conductor-store";
import { ConductorSettings } from "./ConductorSettings";

const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  thinking: "Agent thinking",
  streaming: "Agent responding",
  tool_use: "Tool running",
  completed: "Completed",
  error: "Error",
};

export function CanvasStatusBar() {
  const { undo, redo, canUndo, canRedo, agentStatus, canvasZoom, setConductorSettingsOpen } =
    useConductorStore();

  const safeZoom = Number.isFinite(canvasZoom) && canvasZoom > 0 ? canvasZoom : 1;
  const zoomPercent = Math.round(safeZoom * 100);

  return (
    <div className="relative h-10 px-3 flex items-center gap-2 flex-shrink-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          title="Undo"
          className="flex items-center justify-center w-7 h-7 rounded-full text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowArcLeft size={14} weight="regular" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          title="Redo"
          className="flex items-center justify-center w-7 h-7 rounded-full text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowArcRight size={14} weight="regular" />
        </button>
      </div>

      <div className="text-[11px] text-[var(--muted)] px-1">{zoomPercent}%</div>
      <div className="text-[11px] text-[var(--muted)] px-1">
        {STATUS_LABEL[agentStatus] || "Syncing"}
      </div>

      <div className="w-px h-4 bg-[var(--border)] mx-1" />

      <button
        type="button"
        onClick={() => setConductorSettingsOpen(true)}
        title="Conductor settings"
        className="flex items-center justify-center w-7 h-7 rounded-full text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors"
      >
        <GearSix size={14} weight="regular" />
      </button>

      <ConductorSettings />
    </div>
  );
}
