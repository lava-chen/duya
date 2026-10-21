"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/page";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/icons";

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

  const canClose = !isUploading;

  return (
    <Modal
      open={isOpen}
      onClose={canClose ? onClose : () => undefined}
      title={t("extensions.skills.uploadDialog.title")}
      size="sm"
      closeOnOverlayClick={canClose}
      footer={
        <>
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
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
        </>
      }
    >
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
        <FileIcon size={32} className="mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-foreground">
          {t("extensions.skills.uploadDialog.dragHint")}
        </p>
        <p className="text-xs mt-1 text-muted-foreground">
          {t("extensions.skills.uploadDialog.fileRequirements")}
        </p>
      </div>

      {file && (
        <div className="mb-4 text-sm truncate text-foreground">
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
    </Modal>
  );
}