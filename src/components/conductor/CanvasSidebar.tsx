"use client";

import { useState, useCallback } from "react";
import type { ConductorCanvas } from "@/types/conductor";
import { createCanvas, deleteCanvas, updateCanvas } from "@/lib/conductor-ipc";
import { useConductorStore } from "@/stores/conductor-store";
import { Plus, Trash, PencilSimple, SquaresFour } from "@phosphor-icons/react";

interface CanvasSidebarProps {
  canvases: ConductorCanvas[];
  activeCanvasId: string | null;
  onSelect: (canvasId: string) => void;
}

export function CanvasSidebar({ canvases, activeCanvasId, onSelect }: CanvasSidebarProps) {
  const { addCanvas, removeCanvas, updateCanvas: updateCanvasInStore, setUiError } = useConductorStore();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    try {
      const canvas = await createCanvas(`Canvas ${canvases.length + 1}`);
      addCanvas(canvas);
      onSelect(canvas.id);
      setUiError(null);
    } catch (error) {
      setUiError(`Create canvas failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setIsCreating(false);
    }
  }, [canvases.length, addCanvas, onSelect, setUiError]);

  const handleDelete = useCallback(async (canvasId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteCanvas(canvasId);
      removeCanvas(canvasId);
      if (activeCanvasId === canvasId && canvases.length > 1) {
        const next = canvases.find((c) => c.id !== canvasId);
        if (next) onSelect(next.id);
      }
      setUiError(null);
    } catch (error) {
      setUiError(`Delete canvas failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }, [activeCanvasId, canvases, removeCanvas, onSelect, setUiError]);

  const startEditing = useCallback((canvas: ConductorCanvas, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(canvas.id);
    setEditName(canvas.name);
  }, []);

  const finishEditing = useCallback(async () => {
    if (!editingId || !editName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      const updated = await updateCanvas(editingId, { name: editName.trim() });
      if (updated) {
        updateCanvasInStore(updated);
      }
      setUiError(null);
    } catch (error) {
      setUiError(`Rename canvas failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    setEditingId(null);
  }, [editingId, editName, updateCanvasInStore, setUiError]);

  return (
    <aside className="flex flex-col w-[220px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--sidebar-bg)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--border)]">
        <span className="text-xs font-semibold tracking-wider uppercase text-[var(--muted)]">
          Canvases
        </span>
        <button
          type="button"
          onClick={handleCreate}
          disabled={isCreating}
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors disabled:opacity-40"
        >
          <Plus size={14} weight="bold" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {canvases.map((canvas) => (
          <div
            key={canvas.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(canvas.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(canvas.id);
              }
            }}
            className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors group ${
              canvas.id === activeCanvasId
                ? "bg-[var(--surface)] text-[var(--text)] font-medium"
                : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            }`}
          >
            <SquaresFour size={14} className="flex-shrink-0 opacity-60" />
            {editingId === canvas.id ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={finishEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishEditing();
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="flex-1 min-w-0 bg-[var(--main-bg)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-xs text-[var(--text)] outline-none"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="flex-1 min-w-0 truncate">{canvas.name}</span>
            )}
            <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={(e) => startEditing(canvas, e)}
                className="p-0.5 rounded hover:bg-[var(--surface-hover)] text-[var(--muted)] hover:text-[var(--text)]"
              >
                <PencilSimple size={12} />
              </button>
              <button
                type="button"
                onClick={(e) => handleDelete(canvas.id, e)}
                className="p-0.5 rounded hover:bg-[var(--error-soft)] text-[var(--muted)] hover:text-[var(--error)]"
              >
                <Trash size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
