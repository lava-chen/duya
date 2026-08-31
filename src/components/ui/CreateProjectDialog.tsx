"use client";

import React, { useState, useEffect, useRef } from "react";
import { XIcon, FolderOpenIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";

/**
 * CreateProjectDialog — Plan 471 v7.
 *
 * The "项目" section's + button opens this dialog instead of an
 * intermediate "type a name" or "pick a folder" flow. The dialog mirrors
 * Codex's "创建项目" UX:
 *
 *   ┌─────────────────────────────────────────┐
 *   │ 创建项目                            ✕  │
 *   │ ┌──────────────────────────────────┐   │
 *   │ │ 🗀  项目名称                       │   │
 *   │ └──────────────────────────────────┘   │
 *   │ 源文件夹                              │
 *   │ ┌──────────────────────────────────┐   │
 *   │ │     📁  添加文件夹（可选）          │   │
 *   │ └──────────────────────────────────┘   │
 *   │                       取消  创建项目   │
 *   └─────────────────────────────────────────┘
 *
 * Either field is valid alone:
 *  - Name + folder path → create a thread tied to that path.
 *  - Name only          → spawn a fresh empty folder with the given name
 *                          (delegate to `app.createProjectFolder`).
 *  - Path only          → accept the folder's basename as the project name.
 */
export interface CreateProjectDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  /** Called when the user confirms; the parent picks how to materialize the project. */
  onConfirm: (input: { name: string; workingDirectory: string | null }) => void;
}

export function CreateProjectDialog({ isOpen, onCancel, onConfirm }: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state every time the dialog opens, then focus the name field.
  useEffect(() => {
    if (isOpen) {
      setName("");
      setWorkingDirectory(null);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      } else if (e.key === "Enter" && !pickingFolder) {
        // Don't fire when the user is mid-folder-pick (Enter on a child
        // element of the picker would prematurely submit).
        handleConfirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, name, workingDirectory, pickingFolder]);

  const handlePickFolder = async () => {
    if (pickingFolder) return;
    setPickingFolder(true);
    try {
      const api = window.electronAPI?.dialog;
      if (!api?.openFolder) {
        console.warn("[CreateProjectDialog] electronAPI.dialog.openFolder is unavailable");
        return;
      }
      const result = await api.openFolder({
        title: t('project.selectNewProjectFolder'),
      });
      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0];
        setWorkingDirectory(path);
        // If the user hasn't typed a name yet, prefill from the picked
        // folder's basename — saves a step in the common case.
        if (!name.trim()) {
          const segments = path.split(/[\\/]/).filter(Boolean);
          setName(segments[segments.length - 1] ?? "");
        }
      }
    } catch (err) {
      console.error("[CreateProjectDialog] openFolder failed", err);
    } finally {
      setPickingFolder(false);
    }
  };

  const handleConfirm = () => {
    const trimmedName = name.trim();
    const finalName = trimmedName || (workingDirectory
      ? workingDirectory.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? ""
      : "");
    if (!finalName) return;
    onConfirm({ name: finalName, workingDirectory });
  };

  const canSubmit = name.trim().length > 0 || workingDirectory !== null;

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl p-6 shadow-xl"
        style={{
          backgroundColor: "var(--sidebar-bg)",
          border: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-medium" style={{ color: "var(--text)" }}>
            {t('project.createProject')}
          </h3>
          <IconButton onClick={onCancel} aria-label="Close" variant="default" size="md">
            <XIcon size={18} />
          </IconButton>
        </div>

        {/* Project name — file-icon prefix like Codex so the row reads as
            a single labeled field. */}
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2 mb-4"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          <FolderOpenIcon
            size={16}
            style={{ color: "var(--muted)", flexShrink: 0 }}
          />
          <Input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('project.nameProjectPlaceholder')}
            className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 flex-1"
            style={{ height: 'auto', padding: 0 }}
          />
        </div>

        <div className="text-sm font-medium mb-2" style={{ color: "var(--text)" }}>
          {t('project.sourceFolder')}
        </div>
        {workingDirectory ? (
          <button
            type="button"
            onClick={handlePickFolder}
            className="w-full text-left rounded-lg px-3 py-3 mb-5 transition-colors"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              fontSize: "0.85rem",
              wordBreak: "break-all",
            }}
          >
            {workingDirectory}
          </button>
        ) : (
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={pickingFolder}
            className="w-full flex flex-col items-center justify-center gap-2 rounded-lg py-6 mb-5 transition-colors disabled:opacity-60"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px dashed var(--border)",
              color: "var(--muted)",
              minHeight: 96,
            }}
          >
            <PlusIcon size={18} />
            <span className="text-sm">{t('project.addLocalFolder')}</span>
          </button>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} variant="ghost" size="md">
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            variant="primary"
            size="md"
            disabled={!canSubmit}
          >
            {t('project.createProject')}
          </Button>
        </div>
      </div>
    </div>
  );
}
