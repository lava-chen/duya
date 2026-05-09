"use client";

import { useState, useRef, useEffect } from "react";
import { useConductorStore } from "@/stores/conductor-store";
import { widgetRegistry } from "@/conductor/widgets/registry";
import { addWidget, createCanvas, getSnapshot } from "@/lib/conductor-ipc";
import {
  PencilSimple,
  Eye,
  Plus,
  ArrowsClockwise,
  ArrowArcLeft,
  ArrowArcRight,
  ClockCounterClockwise,
  SquaresFour,
  Note,
  Timer,
  CheckSquare,
  Newspaper,
} from "@phosphor-icons/react";

const WIDGET_ICONS: Record<string, typeof SquaresFour> = {
  "task-list": CheckSquare,
  "note-pad": Note,
  pomodoro: Timer,
  "news-board": Newspaper,
};

function widgetPickerPosition() {
  return {
    left: "100%" as const,
    top: "0" as const,
    marginLeft: "8px" as const,
  };
}

type ToolbarButtonProps = {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function ToolbarButton({ title, active = false, disabled = false, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center w-8 h-8 rounded-full border transition-all ${
        active
          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] shadow-[0_0_0_2px_rgba(139,92,246,0.18)]"
          : "border-transparent text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

export function CanvasToolbar() {
  const {
    editMode,
    toggleEditMode,
    undo,
    redo,
    canUndo,
    canRedo,
    activeCanvasId,
    addCanvas,
    setActiveCanvas,
    setSnapshot,
    connectBridge,
    setUiError,
    toggleHistory,
    autoLayout,
  } = useConductorStore();

  const [showWidgetPicker, setShowWidgetPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        pickerRef.current &&
        !pickerRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setShowWidgetPicker(false);
      }
    }

    if (showWidgetPicker) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showWidgetPicker]);

  const handleAddWidget = async (type: string) => {
    setShowWidgetPicker(false);
    let canvasId = activeCanvasId;

    if (!canvasId) {
      try {
        const canvas = await createCanvas("Canvas 1");
        addCanvas(canvas);
        setActiveCanvas(canvas.id);
        connectBridge(canvas.id);
        const snap = await getSnapshot(canvas.id);
        if (snap) setSnapshot(snap);
        canvasId = canvas.id;
        setUiError(null);
      } catch (error) {
        setUiError(`Create canvas failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return;
      }
    }

    const def = widgetRegistry.get(type);
    if (!def) return;

    const position = {
      x: 0,
      y: 0,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
    };

    try {
      await addWidget(canvasId, def.kind, def.type, def.defaultData, def.defaultConfig, position);
      setUiError(null);
    } catch (error) {
      setUiError(`Add widget failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  return (
    <aside className="absolute left-4 top-16 z-30 rounded-2xl border border-[var(--border)]/80 bg-[var(--sidebar-bg)]/92 backdrop-blur-md shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
      <div className="flex flex-col items-center p-1.5 gap-1.5">
        <ToolbarButton title={editMode ? "Switch to view mode" : "Switch to editing mode"} active={editMode} onClick={toggleEditMode}>
          {editMode ? <PencilSimple size={16} /> : <Eye size={16} />}
        </ToolbarButton>

        <div className="relative">
          <button
            ref={buttonRef}
            type="button"
            title="Add widget"
            aria-label="Add widget"
            onClick={() => setShowWidgetPicker((prev) => !prev)}
            className="flex items-center justify-center w-8 h-8 rounded-full border border-transparent text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors"
          >
            <Plus size={16} />
          </button>

          {showWidgetPicker && (
            <div
              ref={pickerRef}
              className="absolute z-50 w-[180px] bg-[var(--sidebar-bg)]/95 border border-[var(--border)] rounded-xl shadow-xl overflow-hidden backdrop-blur-md"
              style={widgetPickerPosition()}
            >
              {Array.from(widgetRegistry.values()).map((def) => {
                const Icon = WIDGET_ICONS[def.type] || SquaresFour;
                return (
                  <button
                    key={def.type}
                    type="button"
                    onClick={() => handleAddWidget(def.type)}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors"
                  >
                    <Icon size={14} className="text-[var(--muted)] flex-shrink-0" />
                    <span>{def.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <ToolbarButton title="Auto layout" onClick={autoLayout}>
          <ArrowsClockwise size={16} />
        </ToolbarButton>

        <div className="w-5 h-px bg-[var(--border)]/80 my-0.5" />

        <ToolbarButton title="Undo" onClick={undo} disabled={!canUndo}>
          <ArrowArcLeft size={16} />
        </ToolbarButton>

        <ToolbarButton title="Redo" onClick={redo} disabled={!canRedo}>
          <ArrowArcRight size={16} />
        </ToolbarButton>

        <ToolbarButton title="History" onClick={toggleHistory}>
          <ClockCounterClockwise size={16} />
        </ToolbarButton>
      </div>
    </aside>
  );
}
