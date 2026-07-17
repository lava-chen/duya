"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilePlus, FileText, FolderOpen, MagnifyingGlass, X } from "@phosphor-icons/react";
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
      ? `请在当前画布创建一个 Markdown 文档。目标：${agentPrompt.trim()}`
      : "请在当前画布创建一个 Markdown 文档，并先询问我希望这份草稿包含什么内容。";
    try {
      if (activeThreadId && canvasId) {
        await window.electronAPI.session.setConductorMode(activeThreadId, true, canvasId);
      }
      window.dispatchEvent(new CustomEvent("conductor:forward-message", {
        detail: { text: detail, canvasId, sessionId: activeThreadId, source: "document-create-dialog" },
      }));
      onClose();
    } catch (error) {
      onError?.(`启动文档聊天失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [activeThreadId, agentPrompt, canvasId, onClose, onError]);

  const chooseFromFolder = useCallback(async () => {
    if (!projectPath) return;
    const result = await window.electronAPI.references.pickFiles({
      title: "从当前项目添加 Markdown",
      defaultPath: projectPath,
    });
    const importPath = result.filePaths[0];
    if (!result.canceled && importPath) onConfirm({ importPath });
  }, [onConfirm, projectPath]);

  if (!open) return null;

  const dialog = (
    <div
      className="canvas-link-picker-overlay"
      style={canvasBounds ? { inset: "auto", left: canvasBounds.left, top: canvasBounds.top, width: canvasBounds.width, height: canvasBounds.height } : undefined}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="canvas-document-picker" role="dialog" aria-modal="true" aria-label="创建或添加 Markdown 文档" onMouseDown={(event) => event.stopPropagation()}>
        <header className="canvas-document-picker__header">
          <strong>添加 Markdown 文档</strong>
          <button type="button" onClick={onClose} aria-label="关闭文档选择器"><X size={18} /></button>
        </header>

        <section className="canvas-document-picker__agent">
          <strong>通过聊天创建</strong>
          <textarea ref={promptRef} value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void requestAgentDraft(); } }} placeholder="描述你想起草的内容，例如：把这份行程整理成逐日计划" rows={3} />
          <div className="canvas-document-picker__agent-footer">
            <span>将在当前 Agent 会话中继续</span>
            <button type="button" onClick={() => { void requestAgentDraft(); }}>开始创建</button>
          </div>
        </section>

        <section className="canvas-document-picker__section">
          <h2>手动添加</h2>
          <button type="button" className="canvas-document-picker__action" onClick={() => onConfirm()}>
            <span className="canvas-document-picker__glyph"><FilePlus size={18} weight="bold" /></span>
            <span><strong>创建空白文档</strong><small>新建一个保存在项目中的 Markdown 草稿</small></span>
          </button>
          <button type="button" className="canvas-document-picker__action" disabled={!projectPath} onClick={() => { void chooseFromFolder(); }}>
            <span className="canvas-document-picker__glyph"><FolderOpen size={18} weight="bold" /></span>
            <span><strong>从文件夹选择</strong><small>选择当前项目中的现有 .md 文件</small></span>
          </button>
        </section>

        <section className="canvas-document-picker__workspace">
          <div className="canvas-document-picker__workspace-heading"><h2>工作区中的 Markdown</h2><span>{loading ? "正在加载…" : `${files.length} 个文件`}</span></div>
          <label className="canvas-document-picker__search"><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选 Markdown 文件…" /></label>
          <div className="canvas-document-picker__file-list">
            {!projectPath ? <p>请先为画布选择项目文件夹，才能浏览 Markdown 文件。</p> : loading ? <p>正在扫描工作区…</p> : visibleFiles.length === 0 ? <p>{files.length ? "没有匹配的 Markdown 文件。" : "在四层目录内未找到 Markdown 文件。"}</p> : visibleFiles.map((file) => (
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
