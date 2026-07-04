"use client";

import {
  ArrowSquareOut,
  ArrowsClockwise,
  FileText,
  FolderOpen,
  Plus,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { PanelFileTreeSplit } from "./PanelFileTreeSplit";
import type { PageTab } from "./registry";

interface PreviewPayload {
  success: boolean;
  error?: string;
  kind?: "text" | "image" | "pdf" | "unsupported";
  name?: string;
  path?: string;
  size?: number;
  modifiedAt?: number;
  extension?: string;
  content?: string;
  data?: string;
  mediaType?: string;
  truncated?: boolean;
  tooLarge?: boolean;
}

interface SelectionContext {
  text: string;
  x: number;
  y: number;
  /** Plan 220: 1-indexed line range within the preview text. */
  lineStart?: number;
  lineEnd?: number;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

function formatSize(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreviewPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const propFilePath = typeof tab.params?.filePath === "string" ? tab.params.filePath : "";
  const propWorkingDirectory = typeof tab.params?.workingDirectory === "string"
    ? tab.params.workingDirectory
    : "";
  // Plan 220: when an embedded FileTreePanel dispatches `duya:open-file`,
  // we override the prop with a local override so the preview can
  // switch files without re-routing through the PanelProvider.
  const [filePathOverride, setFilePathOverride] = useState<string | null>(null);
  const [workingDirOverride, setWorkingDirOverride] = useState<string | null>(null);
  const filePath = filePathOverride ?? propFilePath;
  const workingDirectory = workingDirOverride ?? propWorkingDirectory;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<SelectionContext | null>(null);

  const loadPreview = useCallback(async () => {
    if (!filePath || !workingDirectory) return;
    setLoading(true);
    setSelection(null);
    try {
      const result = await window.electronAPI?.files?.preview?.(filePath, workingDirectory);
      setPreview(result ?? { success: false, error: "File preview is unavailable. Rebuild Electron and try again." });
    } catch (cause) {
      setPreview({ success: false, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, [filePath, workingDirectory]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  // Plan 220: listen for `duya:open-file` from an embedded
  // FileTreePanel (which is rendered outside the PanelProvider
  // tree) so that double-clicking a different file in the tree
  // switches the preview's current file instead of trying to open
  // a new tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath: string; workingDirectory?: string }>).detail;
      if (detail?.filePath && detail.filePath !== filePath) {
        setFilePathOverride(detail.filePath);
        if (detail.workingDirectory) {
          setWorkingDirOverride(detail.workingDirectory);
        }
      }
    };
    window.addEventListener('duya:open-file', handler as EventListener);
    return () => window.removeEventListener('duya:open-file', handler as EventListener);
  }, [filePath]);

  const addFileToInput = useCallback(
    (selectionContext?: Pick<SelectionContext, "lineStart" | "lineEnd" | "text">) => {
      if (!filePath) return;
      // Plan 220: when the user has a selection in the preview, attach
      // the file with the selection's line range so the file-tree-ref
      // card shows e.g. "main.py:L2-L10". Without a selection this
      // falls back to a plain file reference.
      const detail: {
        path: string;
        lineStart?: number;
        lineEnd?: number;
        selectedText?: string;
      } = { path: filePath };
      if (selectionContext?.lineStart != null) detail.lineStart = selectionContext.lineStart;
      if (selectionContext?.lineEnd != null) detail.lineEnd = selectionContext.lineEnd;
      if (selectionContext?.text) detail.selectedText = selectionContext.text;
      window.dispatchEvent(new CustomEvent("file-tree-add-to-input", { detail }));
    },
    [filePath],
  );

  const captureSelection = useCallback(() => {
    const nativeSelection = window.getSelection();
    const text = nativeSelection?.toString().trim() ?? "";
    const anchor = nativeSelection?.anchorNode instanceof Element
      ? nativeSelection.anchorNode
      : nativeSelection?.anchorNode?.parentElement;
    const range = nativeSelection?.rangeCount ? nativeSelection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const canvas = canvasRef.current;
    if (!text || !anchor || !rect || !canvas?.contains(anchor)) {
      setSelection(null);
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();

    // Plan 220: compute 1-indexed line range from the selection.
    // We do this by walking up from the anchor/focus to the
    // <pre><code> container and computing the character offset of
    // each endpoint against the raw preview content. The preview
    // is rendered as a single text node, so the offset relative to
    // that text node is the offset into `preview.content`.
    let lineStart: number | undefined;
    let lineEnd: number | undefined;
    if (preview?.content) {
      const offsetOfNode = (node: Node, offset: number): number => {
        // Find the <code> ancestor that holds the raw text.
        const codeEl =
          node.nodeType === Node.ELEMENT_NODE
            ? (node as Element).closest('code, pre')
            : node.parentElement?.closest('code, pre');
        if (!codeEl) return -1;
        // Compute character offset from start of codeEl.
        const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
        let total = 0;
        let current: Node | null = walker.nextNode();
        while (current) {
          if (current === node) return total + offset;
          total += current.textContent?.length ?? 0;
          current = walker.nextNode();
        }
        return total;
      };
      const startOff = offsetOfNode(
        nativeSelection?.anchorNode as Node,
        nativeSelection?.anchorOffset ?? 0,
      );
      const endOff = offsetOfNode(
        nativeSelection?.focusNode as Node,
        nativeSelection?.focusOffset ?? 0,
      );
      if (startOff >= 0 && endOff >= 0) {
        const [a, b] = startOff <= endOff ? [startOff, endOff] : [endOff, startOff];
        const before = preview.content.slice(0, a);
        const inside = preview.content.slice(a, b);
        lineStart = before.split('\n').length;
        lineEnd = before.split('\n').length + Math.max(0, inside.split('\n').length - 1);
        if (lineEnd < lineStart) lineEnd = lineStart;
      }
    }

    setSelection({
      text: text.slice(0, 8_000),
      x: canvas.scrollLeft + Math.min(canvasRect.width - 138, Math.max(12, rect.left - canvasRect.left + rect.width / 2 - 62)),
      y: canvas.scrollTop + Math.max(12, rect.bottom - canvasRect.top + 10),
      lineStart,
      lineEnd,
    });
  }, [preview?.content]);

  const askDuya = useCallback(() => {
    if (!selection || !filePath) return;
    // Plan 220: askDuya from a file preview attaches the FILE
    // (file-tree-ref card visible to the user, displaying
    // `name:L{lineStart}-L{lineEnd}`) and injects a hidden context
    // prompt that the LLM will see but the user does NOT see in the
    // input box. The user keeps a clean inputValue to type their
    // actual question. The hidden prompt is cleared on the next send.
    addFileToInput(selection);
    window.dispatchEvent(new CustomEvent("duya:set-hidden-prompt", {
      detail: {
        value: [
          `请基于文件中的这段选中内容回答或修改：`,
          `文件：${filePath}`,
          "选中内容：",
          selection.text,
        ].join("\n"),
      },
    }));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [addFileToInput, filePath, selection]);

  const dataUrl = useMemo(() => {
    if (!preview?.data || !preview.mediaType) return "";
    return `data:${preview.mediaType};base64,${preview.data}`;
  }, [preview?.data, preview?.mediaType]);

  if (!filePath) {
    return (
      <PanelFileTreeSplit workingDirectory={workingDirectory}>
      <div className="file-preview-empty">
        <FolderOpen size={32} weight="duotone" />
        <strong>打开文件</strong>
        <span>从右侧项目树中选择一个文件进行只读预览</span>
      </div>
      </PanelFileTreeSplit>
    );
  }

  return (
    <PanelFileTreeSplit workingDirectory={workingDirectory}>
    <div className="file-preview-panel">
      <div className="file-preview-toolbar">
        <div className="file-preview-title">
          <FileText size={16} weight="duotone" />
          <span>{preview?.name ?? tab.title}</span>
          {preview?.extension && <small>{preview.extension.toUpperCase()}</small>}
          {preview?.size !== undefined && <small>{formatSize(preview.size)}</small>}
        </div>
        <div className="file-preview-actions">
          <button type="button" onClick={() => addFileToInput()} title="添加到输入框" aria-label="添加到输入框">
            <Plus size={15} />
          </button>
          <button type="button" onClick={() => void loadPreview()} title="重新加载" aria-label="重新加载">
            <ArrowsClockwise size={15} className={loading ? "animate-spin" : ""} />
          </button>
          <button type="button" onClick={() => void window.electronAPI?.shell?.openPath(filePath)} title="用默认应用打开" aria-label="用默认应用打开">
            <ArrowSquareOut size={15} />
          </button>
        </div>
      </div>

      <div className="file-preview-canvas" ref={canvasRef} onMouseUp={captureSelection}>
        {loading && (
          <div className="file-preview-state"><ArrowsClockwise size={18} className="animate-spin" /> 正在载入预览…</div>
        )}
        {!loading && preview && !preview.success && (
          <div className="file-preview-state file-preview-error"><WarningCircle size={20} /> {preview.error || "无法预览文件"}</div>
        )}
        {!loading && preview?.success && (preview.kind === "unsupported" || preview.tooLarge) && (
          <div className="file-preview-state">
            <FileText size={36} weight="duotone" />
            <strong>{preview.tooLarge ? "文件太大，无法安全预览" : "此文件类型暂不支持预览"}</strong>
            <span>仍然可以把文件加入输入框，或用系统默认应用打开。</span>
          </div>
        )}
        {!loading && preview?.success && !preview.tooLarge && preview.kind === "image" && dataUrl && (
          <div className="file-preview-image-stage"><img src={dataUrl} alt={preview.name || tab.title} /></div>
        )}
        {!loading && preview?.success && !preview.tooLarge && preview.kind === "pdf" && dataUrl && (
          <iframe className="file-preview-pdf" src={dataUrl} title={preview.name || tab.title} />
        )}
        {!loading && preview?.success && preview.kind === "text" && (
          <div className={`file-preview-text${MARKDOWN_EXTENSIONS.has(preview.extension ?? "") ? " markdown" : " code"}`}>
            {preview.truncated && <div className="file-preview-truncated">仅显示前 1 MB 内容</div>}
            {MARKDOWN_EXTENSIONS.has(preview.extension ?? "") ? (
              <MarkdownRenderer className="prose dark:prose-invert max-w-none file-preview-markdown">
                {preview.content || ""}
              </MarkdownRenderer>
            ) : (
              <pre className="file-preview-code"><code>{preview.content || ""}</code></pre>
            )}
          </div>
        )}
        {selection && (
          <button
            type="button"
            className="file-preview-ask-duya"
            style={{ left: selection.x, top: selection.y }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={askDuya}
          >
            <Sparkle size={14} weight="fill" /> 询问 DUYA
          </button>
        )}
      </div>
    </div>
    </PanelFileTreeSplit>
  );
}
