"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import {
  FileIcon,
  FileTextIcon,
  TrashIcon,
  PlusIcon,
  SpinnerGapIcon,
  FolderIcon,
  FilePdfIcon,
  FileXlsIcon,
  FilePptIcon,
  ImageIcon,
  CodeIcon,
} from "@/components/icons";
import { AddReferencesModal } from "./AddReferencesModal";

interface ReferencesPanelProps {
  workingDirectory: string;
  projectName?: string;
}

interface ReferenceEntry {
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  isDirectory: boolean;
  mtime: number;
  extension?: string;
}

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

function formatSize(bytes: number, t: TFunc): string {
  if (bytes < 1024) return t("references.size.bytes", { n: bytes });
  if (bytes < 1024 * 1024) return t("references.size.kb", { n: (bytes / 1024).toFixed(1) });
  return t("references.size.mb", { n: (bytes / (1024 * 1024)).toFixed(1) });
}

function formatDate(ms: number, locale: string): string {
  const d = new Date(ms);
  const localeStr = locale === "zh" ? "zh-CN" : "en-US";
  return d.toLocaleDateString(localeStr, { year: "numeric", month: "long", day: "numeric" });
}

function getFileKindLabel(extension: string | undefined, t: TFunc): string {
  const ext = (extension || "").toLowerCase();
  switch (ext) {
    case "pdf":
      return t("references.kind.pdf");
    case "xls":
    case "xlsx":
    case "csv":
      return t("references.kind.spreadsheet");
    case "ppt":
    case "pptx":
      return t("references.kind.presentation");
    case "doc":
    case "docx":
      return t("references.kind.document");
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
      return t("references.kind.image");
    case "md":
    case "txt":
      return t("references.kind.text");
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
      return t("references.kind.code");
    default:
      return t("references.kind.file");
  }
}

function entryIcon(entry: ReferenceEntry, colored = true) {
  if (entry.isDirectory) {
    return <FolderIcon size={22} />;
  }
  const ext = (entry.extension || "").toLowerCase();
  switch (ext) {
    case "pdf":
      return <FilePdfIcon size={22} color={colored ? "#ef4444" : undefined} />;
    case "xls":
    case "xlsx":
    case "csv":
      return <FileXlsIcon size={22} color={colored ? "#22c55e" : undefined} />;
    case "ppt":
    case "pptx":
      return <FilePptIcon size={22} color={colored ? "#f97316" : undefined} />;
    case "doc":
    case "docx":
      return <FileTextIcon size={22} color={colored ? "#3b82f6" : undefined} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
      return <ImageIcon size={22} color={colored ? "#a855f7" : undefined} />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
      return <CodeIcon size={22} color={colored ? "#14b8a6" : undefined} />;
    default:
      return <FileIcon size={22} />;
  }
}

export function ReferencesPanel({ workingDirectory, projectName }: ReferencesPanelProps) {
  const { t, locale } = useTranslation();
  const [entries, setEntries] = useState<ReferenceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.references.list(workingDirectory);
      if (!result.success) {
        setError(result.error || t("references.list.error"));
        setEntries([]);
      } else {
        setEntries(result.data || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUpload = async (filePaths: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const addResult = await window.electronAPI.references.add(workingDirectory, filePaths);
      if (!addResult.success) {
        setError(addResult.error || t("references.add.error", { error: "" }));
        return;
      }
      const addedCount = addResult.data?.length || 0;
      const failedCount = filePaths.length - addedCount;
      if (addedCount === 0) {
        setError(t("references.add.none"));
      } else if (failedCount > 0) {
        setError(t("references.add.partialFailure", { success: addedCount, failed: failedCount }));
      }
      await refresh();
      if (addedCount > 0 && failedCount === 0) {
        setIsModalOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (entry: ReferenceEntry) => {
    let count = 1;
    if (entry.isDirectory) {
      const prefix = entry.relativePath + "/";
      count = entries.filter((e) => !e.isDirectory && e.relativePath.startsWith(prefix)).length;
      if (!window.confirm(t("references.deleteDir.confirm", { name: entry.name, count }))) {
        return;
      }
    } else {
      if (!window.confirm(t("references.delete.confirm", { name: entry.name }))) {
        return;
      }
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.references.delete(workingDirectory, entry.relativePath);
      if (!result.success) {
        setError(result.error || t("references.delete.error", { error: "" }));
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (entry: ReferenceEntry) => {
    if (entry.isDirectory) return;
    const result = await window.electronAPI.references.open(workingDirectory, entry.relativePath);
    if (!result.success) {
      setError(result.error || t("references.open.error"));
    }
  };

  const topLevel = entries.filter((e) => !e.relativePath.includes("/"));

  return (
    <div className="references-panel">
      {error && (
        <div className="references-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="references-loading">
          <SpinnerGapIcon size={22} className="spin" />
          <span>{t("references.loading")}</span>
        </div>
      ) : (
        <>
          <button className="references-add-source-row" onClick={() => setIsModalOpen(true)} disabled={busy}>
            <span className="references-add-source-icon">
              <PlusIcon size={20} />
            </span>
            <span className="references-add-source-label">{t("references.addFiles")}</span>
          </button>

          {topLevel.length === 0 ? (
            <div className="references-empty">
              <div className="references-empty-title">{t("references.empty.title")}</div>
              <div className="references-empty-hint">{t("references.empty.hint")}</div>
            </div>
          ) : (
            <div className="references-list">
              {topLevel.map((entry) => (
                <div key={entry.relativePath} className={`references-item ${entry.isDirectory ? "is-dir" : ""}`}>
                  <button
                    className="references-item-main"
                    onClick={() => (entry.isDirectory ? undefined : handleOpen(entry))}
                    title={entry.relativePath}
                    disabled={entry.isDirectory}
                  >
                    <span className="references-item-icon">{entryIcon(entry)}</span>
                    <span className="references-item-info">
                      <span className="references-item-name">{entry.name}</span>
                      <span className="references-item-meta">
                        {entry.isDirectory
                          ? t("references.kind.folder")
                          : `${getFileKindLabel(entry.extension, t)} · ${formatDate(entry.mtime, locale)}${entry.size > 0 ? ` · ${formatSize(entry.size, t)}` : ""}`}
                      </span>
                    </span>
                  </button>
                  <button
                    className="references-item-delete"
                    onClick={() => handleDelete(entry)}
                    disabled={busy}
                    title={t("references.delete")}
                  >
                    <TrashIcon size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <AddReferencesModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onUpload={handleUpload}
        busy={busy}
      />
    </div>
  );
}
