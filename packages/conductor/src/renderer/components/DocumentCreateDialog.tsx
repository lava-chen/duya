"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilePlus, FileText, FolderOpen, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useTranslation } from "@/hooks/useTranslation";
import { useConversationStore } from "@/stores/conversation-store";

interface FileTreeNode {
  name: string;
  path: string;
  type: "directory" | "file";
  extension?: string;
  children?: FileTreeNode[];
}

interface MarkdownFile {
  name: string;
  path: string;
  relativePath: string;
}

interface DocumentCreateDialogProps {
  open: boolean;
  projectPath?: string;
  canvasId?: string | null;
  onClose: () => void;
  onConfirm: (content?: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

function workspaceRelative(filePath: string, projectPath: string): string {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoot = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;
}

function collectMarkdownFiles(nodes: FileTreeNode[], projectPath: string): MarkdownFile[] {
  const result: MarkdownFile[] = [];
  const visit = (entries: FileTreeNode[]) => {
    for (const entry of entries) {
      if (entry.type === "directory") {
        if ([".git", "node_modules", ".duya"].includes(entry.name)) continue;
        visit(entry.children ?? []);
      } else if (entry.extension?.toLowerCase() === "md" || entry.name.toLowerCase().endsWith(".md")) {
        result.push({ name: entry.name, path: entry.path, relativePath: workspaceRelative(entry.path, projectPath) });
      }
    }
  };
  visit(nodes);
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
}

export const DocumentCreateDialog: React.FC<DocumentCreateDialogProps> = ({ open, projectPath, canvasId, onClose, onConfirm, onError }) => {
  const { t } = useTranslation();
  const [agentPrompt, setAgentPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<MarkdownFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [canvasBounds, setCanvasBounds] = useState<DOMRect | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  useEffect(() => {
    if (!open) return;
    setAgentPrompt("");
    setQuery("");
    setFiles([]);
    window.setTimeout(() => promptRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updateBounds = () => setCanvasBounds(document.querySelector(".canvas-area")?.getBoundingClientRect() ?? null);
    updateBounds();
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [open]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let active = true;
    setLoading(true);
    window.electronAPI.files.browse(projectPath, 4)
      .then((result) => {
        if (active) setFiles(result.success ? collectMarkdownFiles(result.tree as FileTreeNode[], projectPath) : []);
      })
      .catch(() => { if (active) setFiles([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectPath]);

  const visibleFiles = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? files.filter((file) => file.relativePath.toLowerCase().includes(term)) : files;
  }, [files, query]);

  const requestAgentDraft = useCallback(async () => {
    const detail = agentPrompt.trim()
      ? t("conductor.document.agentPrompt", { prompt: agentPrompt.trim() })
      : t("conductor.document.agentPromptEmpty");
    try {
      if (activeThreadId && canvasId) {
        await window.electronAPI.session.setConductorMode(activeThreadId, true, canvasId);
      }
      window.dispatchEvent(new CustomEvent("conductor:forward-message", {
        detail: { text: detail, canvasId, sessionId: activeThreadId, source: "document-create-dialog" },
      }));
      onClose();
    } catch (error) {
      onError?.(t("conductor.document.startChatError", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [activeThreadId, agentPrompt, canvasId, onClose, onError, t]);

  const chooseFromFolder = useCallback(async () => {
    if (!projectPath) return;
    const result = await window.electronAPI.references.pickFiles({
      title: t("conductor.document.pickFilesTitle"),
      defaultPath: projectPath,
    });
    const importPath = result.filePaths[0];
    if (!result.canceled && importPath) onConfirm({ importPath });
  }, [onConfirm, projectPath, t]);

  if (!open) return null;

  const dialog = (
    <div
      className="canvas-link-picker-overlay"
      style={canvasBounds ? { inset: "auto", left: canvasBounds.left, top: canvasBounds.top, width: canvasBounds.width, height: canvasBounds.height } : undefined}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="canvas-document-picker" role="dialog" aria-modal="true" aria-label={t("conductor.document.title")} onMouseDown={(event) => event.stopPropagation()}>
        <header className="canvas-document-picker__header">
          <strong>{t("conductor.document.addTitle")}</strong>
          <button type="button" onClick={onClose} aria-label={t("conductor.document.close")}><X size={18} /></button>
        </header>

        <section className="canvas-document-picker__agent">
          <strong>{t("conductor.document.viaChat")}</strong>
          <textarea ref={promptRef} value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void requestAgentDraft(); } }} placeholder={t("conductor.document.promptPlaceholder")} rows={3} />
          <div className="canvas-document-picker__agent-footer">
            <span>{t("conductor.document.continueInSession")}</span>
            <button type="button" onClick={() => { void requestAgentDraft(); }}>{t("conductor.document.startCreate")}</button>
          </div>
        </section>

        <section className="canvas-document-picker__section">
          <h2>{t("conductor.document.manual")}</h2>
          <button type="button" className="canvas-document-picker__action" onClick={() => onConfirm()}>
            <span className="canvas-document-picker__glyph"><FilePlus size={18} weight="bold" /></span>
            <span><strong>{t("conductor.document.createBlank")}</strong><small>{t("conductor.document.createBlankDesc")}</small></span>
          </button>
          <button type="button" className="canvas-document-picker__action" disabled={!projectPath} onClick={() => { void chooseFromFolder(); }}>
            <span className="canvas-document-picker__glyph"><FolderOpen size={18} weight="bold" /></span>
            <span><strong>{t("conductor.document.chooseFromFolder")}</strong><small>{t("conductor.document.chooseFromFolderDesc")}</small></span>
          </button>
        </section>

        <section className="canvas-document-picker__workspace">
          <div className="canvas-document-picker__workspace-heading"><h2>{t("conductor.document.workspaceMarkdown")}</h2><span>{loading ? t("conductor.document.loading") : t("conductor.document.fileCount", { count: files.length })}</span></div>
          <label className="canvas-document-picker__search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("conductor.document.filterPlaceholder")} /></label>
          <div className="canvas-document-picker__file-list">
            {!projectPath ? <p>{t("conductor.document.selectProjectFirst")}</p> : loading ? <p>{t("conductor.document.scanning")}</p> : visibleFiles.length === 0 ? <p>{files.length ? t("conductor.document.noMatches") : t("conductor.document.noMarkdownFound")}</p> : visibleFiles.map((file) => (
              <button key={file.path} type="button" className="canvas-document-picker__file" onClick={() => onConfirm({ importPath: file.path })}>
                <FileText size={17} weight="regular" /><span><strong>{file.name}</strong><small>{file.relativePath}</small></span>
              </button>
            ))}
          </div>
        </section>
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
};
