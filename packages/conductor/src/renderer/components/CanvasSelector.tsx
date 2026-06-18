"use client";

import { useState, useRef, useEffect } from "react";
import { useConductorStore } from "..//stores/conductor-store";
import { createCanvas, updateCanvas, deleteCanvas, getSnapshot } from "..//ipc/conductor-ipc";
import { InputDialog } from "@/components/ui/InputDialog";
import {
  ChevronDownIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  CheckIcon,
} from "@/components/icons";

export function CanvasSelector() {
  const {
    canvases,
    activeCanvasId,
    setCanvases,
    addCanvas,
    setActiveCanvas,
    setSnapshot,
    connectBridge,
    disconnectBridge,
  } = useConductorStore();

  const [isOpen, setIsOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renamingCanvas, setRenamingCanvas] = useState<{ id: string; name: string } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeCanvas = canvases.find((c) => c.id === activeCanvasId);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectCanvas = async (canvasId: string) => {
    if (canvasId === activeCanvasId) {
      setIsOpen(false);
      return;
    }

    disconnectBridge();
    setActiveCanvas(canvasId);
    const snap = await getSnapshot(canvasId);
    if (snap) setSnapshot(snap);
    connectBridge(canvasId);
    setIsOpen(false);
  };

  const handleCreateCanvas = async (name: string) => {
    if (!name.trim()) return;
    try {
      const canvas = await createCanvas(name.trim());
      addCanvas(canvas);
      disconnectBridge();
      setActiveCanvas(canvas.id);
      connectBridge(canvas.id);
      setCreateDialogOpen(false);
      setIsOpen(false);
    } catch {
      // Error handled by IPC
    }
  };

  const handleRenameCanvas = async (name: string) => {
    if (!name.trim() || !renamingCanvas) return;
    try {
      const updated = await updateCanvas(renamingCanvas.id, { name: name.trim() });
      if (updated) {
        setCanvases(canvases.map((c) => (c.id === updated.id ? updated : c)));
      }
      setRenameDialogOpen(false);
      setRenamingCanvas(null);
    } catch {
      // Error handled by IPC
    }
  };

  const handleDeleteCanvas = async (canvasId: string) => {
    try {
      const success = await deleteCanvas(canvasId);
      if (success) {
        const remaining = canvases.filter((c) => c.id !== canvasId);
        setCanvases(remaining);

        if (activeCanvasId === canvasId) {
          disconnectBridge();
          if (remaining.length > 0) {
            setActiveCanvas(remaining[0].id);
            const snap = await getSnapshot(remaining[0].id);
            if (snap) setSnapshot(snap);
            connectBridge(remaining[0].id);
          } else {
            const canvas = await createCanvas("Workbench");
            addCanvas(canvas);
            setActiveCanvas(canvas.id);
            connectBridge(canvas.id);
            const snap = await getSnapshot(canvas.id);
            if (snap) setSnapshot(snap);
          }
        }
      }
      setDeleteConfirmId(null);
    } catch {
      // Error handled by IPC
    }
  };

  const openRenameDialog = (canvas: { id: string; name: string }, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingCanvas(canvas);
    setRenameDialogOpen(true);
  };

  const confirmDelete = (canvasId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConfirmId(canvasId);
  };

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: "var(--text)" }}
        >
          <span className="max-w-[200px] truncate">
            {activeCanvas?.name || "Select Canvas"}
          </span>
          <ChevronDownIcon
            size={16}
            className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
            style={{ color: "var(--muted)" }}
          />
        </button>

        {isOpen && (
          <div
            className="absolute top-full left-0 mt-1 w-64 rounded-lg shadow-xl border z-50 py-1"
            style={{
              backgroundColor: "var(--sidebar-bg)",
              borderColor: "var(--border)",
            }}
          >
            <div className="px-2 py-1.5">
              <button
                onClick={() => setCreateDialogOpen(true)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors"
                style={{ color: "var(--accent)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor = "var(--surface-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = "transparent")
                }
              >
                <PlusIcon size={16} />
                <span>New Canvas</span>
              </button>
            </div>

            <div
              className="mx-2 h-px"
              style={{ backgroundColor: "var(--border)" }}
            />

            <div className="max-h-64 overflow-y-auto py-1">
              {canvases.length === 0 ? (
                <div
                  className="px-4 py-3 text-sm text-center"
                  style={{ color: "var(--muted)" }}
                >
                  No canvases yet
                </div>
              ) : (
                canvases.map((canvas) => (
                  <div
                    key={canvas.id}
                    className="group flex items-center justify-between px-2 py-1 mx-1 rounded-md cursor-pointer transition-colors"
                    style={{
                      backgroundColor:
                        canvas.id === activeCanvasId
                          ? "var(--surface-hover)"
                          : "transparent",
                    }}
                    onClick={() => handleSelectCanvas(canvas.id)}
                    onMouseEnter={(e) => {
                      if (canvas.id !== activeCanvasId) {
                        e.currentTarget.style.backgroundColor = "var(--surface-hover)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (canvas.id !== activeCanvasId) {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {canvas.id === activeCanvasId && (
                        <CheckIcon size={14} style={{ color: "var(--accent)" }} />
                      )}
                      <span
                        className="text-sm truncate"
                        style={{ color: "var(--text)" }}
                      >
                        {canvas.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => openRenameDialog(canvas, e)}
                        className="p-1 rounded transition-colors"
                        style={{ color: "var(--muted)" }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.backgroundColor = "var(--chip)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.backgroundColor = "transparent")
                        }
                        title="Rename"
                      >
                        <PencilIcon size={14} />
                      </button>
                      {canvases.length > 1 && (
                        <button
                          onClick={(e) => confirmDelete(canvas.id, e)}
                          className="p-1 rounded transition-colors"
                          style={{ color: "var(--error)" }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.backgroundColor = "var(--error-soft)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.backgroundColor = "transparent")
                          }
                          title="Delete"
                        >
                          <TrashIcon size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <InputDialog
        isOpen={createDialogOpen}
        title="Create New Canvas"
        placeholder="Enter canvas name..."
        onConfirm={handleCreateCanvas}
        onCancel={() => setCreateDialogOpen(false)}
      />

      <InputDialog
        isOpen={renameDialogOpen}
        title="Rename Canvas"
        placeholder="Enter new name..."
        defaultValue={renamingCanvas?.name || ""}
        onConfirm={handleRenameCanvas}
        onCancel={() => {
          setRenameDialogOpen(false);
          setRenamingCanvas(null);
        }}
      />

      {deleteConfirmId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
          onClick={() => setDeleteConfirmId(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl p-5 shadow-xl"
            style={{
              backgroundColor: "var(--sidebar-bg)",
              border: "1px solid var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className="text-base font-medium mb-2"
              style={{ color: "var(--text)" }}
            >
              Delete Canvas?
            </h3>
            <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
              This action cannot be undone. All widgets and data on this canvas will be permanently deleted.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2 rounded-lg text-sm transition-colors"
                style={{ color: "var(--muted)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor = "var(--surface-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = "transparent")
                }
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteCanvas(deleteConfirmId)}
                className="px-4 py-2 rounded-lg text-sm text-white transition-colors"
                style={{ backgroundColor: "var(--error)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.opacity = "0.9")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.opacity = "1")
                }
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
