"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { XIcon, UploadSimpleIcon, SpinnerGapIcon } from "@/components/icons";

interface AddReferencesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (filePaths: string[]) => Promise<void>;
  busy: boolean;
}

export function AddReferencesModal({ isOpen, onClose, onUpload, busy }: AddReferencesModalProps) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (busy) return;
      const files: string[] = [];
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          if (file.path) {
            files.push(file.path);
          }
        }
      }
      if (files.length > 0) {
        await onUpload(files);
      }
    },
    [busy, onUpload]
  );

  const handleInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (busy) return;
      const files = Array.from(e.target.files || []);
      const paths = files.map((f) => "path" in f ? (f as { path: string }).path : undefined).filter(Boolean) as string[];
      if (paths.length > 0) {
        await onUpload(paths);
      }
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
    [busy, onUpload]
  );

  const handleBrowse = useCallback(() => {
    if (busy) return;
    inputRef.current?.click();
  }, [busy]);

  if (!isOpen) return null;

  return (
    <div className="references-modal-overlay" onClick={onClose}>
      <div className="references-modal" onClick={(e) => e.stopPropagation()}>
        <div className="references-modal-header">
          <h3>{t("references.modal.title")}</h3>
          <button className="references-modal-close" onClick={onClose} disabled={busy} aria-label={t("references.modal.close")}>
            <XIcon size={18} />
          </button>
        </div>

        <div
          className={`references-dropzone ${isDragging ? "dragging" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowse}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            className="references-file-input"
            onChange={handleInputChange}
          />
          {busy ? (
            <>
              <SpinnerGapIcon size={28} className="spin" />
              <span>{t("references.modal.uploading")}</span>
            </>
          ) : (
            <>
              <UploadSimpleIcon size={28} />
              <span>{t("references.modal.dropHint")}</span>
            </>
          )}
        </div>

        <div className="references-modal-actions">
          <button className="references-modal-browse" onClick={handleBrowse} disabled={busy}>
            <UploadSimpleIcon size={16} />
            <span>{t("references.modal.browse")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
