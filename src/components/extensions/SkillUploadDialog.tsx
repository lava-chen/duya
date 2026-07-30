"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { FileIcon, XIcon } from "@/components/icons";

interface SkillUploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onUploaded?: () => void;
}

const ACCEPTED_EXTENSIONS = [".md", ".zip", ".skill"];

export function SkillUploadDialog({
  isOpen,
  onClose,
  onUploaded,
}: SkillUploadDialogProps) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setError(null);
      setIsUploading(false);
      setDragActive(false);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isUploading) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, isUploading, onClose]);

  const handleFiles = useCallback((files: FileList | null) => {
    const selected = files?.[0];
    if (!selected) return;

    const extIndex = selected.name.lastIndexOf(".");
    const ext = extIndex >= 0 ? selected.name.slice(extIndex).toLowerCase() : "";
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError(t("extensions.skills.uploadError", { error: `${ext || selected.name}` }));
      return;
    }

    setFile(selected);
    setError(null);
  }, [t]);

  const getFilePath = (selected: File): string | undefined => {
    const webUtils = (
      window as unknown as {
        electronWebUtils?: { getPathForFile: (f: File) => string };
      }
    ).electronWebUtils;
    if (webUtils?.getPathForFile) {
      try {
        return webUtils.getPathForFile(selected);
      } catch {
        // fall through to File.path fallback
      }
    }
    return (selected as File & { path?: string }).path;
  };

  const handleUpload = useCallback(async () => {
    if (!file) return;

    const filePath = getFilePath(file);
    if (!filePath) {
      setError(t("extensions.skills.uploadDialog.noPath"));
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const res = await window.electronAPI.skills.uploadSkill(filePath);
      if (res.success) {
        onUploaded?.();
        onClose();
      } else {
        setError(
          t("extensions.skills.uploadError", {
            error: res.error || t("extensions.error"),
          })
        );
      }
    } catch (err) {
      setError(
        t("extensions.skills.uploadError", {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      setIsUploading(false);
    }
  }, [file, onClose, onUploaded, t]);

  if (!isOpen) return null;

  const canClose = !isUploading;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
      onClick={() => {
        if (canClose) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl p-6 shadow-xl"
        style={{
          backgroundColor: "var(--sidebar-bg)",
          border: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            className="text-lg font-medium"
            style={{ color: "var(--text)" }}
          >
            {t("extensions.skills.uploadDialog.title")}
          </h3>
          <button
            type="button"
            onClick={() => {
              if (canClose) onClose();
            }}
            disabled={!canClose}
            className="rounded-md p-1 transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-40"
            aria-label={t("extensions.skills.uploadDialog.cancel")}
          >
            <XIcon size={18} style={{ color: "var(--muted)" }} />
          </button>
        </div>

        <div
          className={cn(
            "mb-4 rounded-lg border border-dashed border-border p-6 text-center transition-colors cursor-pointer",
            dragActive && "border-accent bg-accent/5"
          )}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            handleFiles(e.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".md,.zip,.skill"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <FileIcon
            size={32}
            className="mx-auto mb-2"
            style={{ color: "var(--muted)" }}
          />
          <p
            className="text-sm"
            style={{ color: "var(--foreground)" }}
          >
            {t("extensions.skills.uploadDialog.dragHint")}
          </p>
          <p
            className="text-xs mt-1"
            style={{ color: "var(--muted)" }}
          >
            {t("extensions.skills.uploadDialog.fileRequirements")}
          </p>
        </div>

        {file && (
          <div
            className="mb-4 text-sm truncate"
            style={{ color: "var(--foreground)" }}
          >
            {t("extensions.skills.uploadDialog.selectedFile", {
              name: file.name,
            })}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              if (canClose) onClose();
            }}
            disabled={!canClose}
          >
            {t("extensions.skills.uploadDialog.cancel")}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleUpload}
            disabled={!file || isUploading}
          >
            {isUploading
              ? t("extensions.skills.uploading")
              : t("extensions.skills.uploadDialog.upload")}
          </Button>
        </div>
      </div>
    </div>
  );
}
