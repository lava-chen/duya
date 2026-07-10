"use client";

import {
  ArrowSquareOut,
  Camera,
  CaretDown,
  Copy,
  FileText,
  Files,
  FolderOpen,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { PanelFileTreeSplit } from "./PanelFileTreeSplit";
import { useOptionalPanel } from "@/hooks/usePanel";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "@/hooks/useTranslation";
import { dispatchAddAttachment } from "@/lib/add-attachment-event";
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

/** 1-indexed line range to focus (scroll to + highlight) inside the
 *  preview. `end` is optional; when omitted only `start` is highlighted. */
interface FocusLines {
  start: number;
  end?: number;
}

/** Extract the directory part of a Windows or Unix path without pulling
 *  in the `path` Node module (renderer should stay lightweight). */
function getDirectoryPath(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

interface BreadcrumbSegment {
  name: string;
  fullPath: string;
}

/** Build a breadcrumb from the project root to the current file.
 *  Returns null when the file is not inside the root (e.g. an absolute
 *  path outside the workspace). */
function buildBreadcrumb(filePath: string, rootPath: string): BreadcrumbSegment[] | null {
  if (!filePath || !rootPath) return null;
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedFile.startsWith(normalizedRoot + "/")) return null;
  const relative = normalizedFile.slice(normalizedRoot.length + 1);
  if (!relative) return null;
  const parts = relative.split("/").filter(Boolean);
  return parts.map((name, index) => ({
    name,
    fullPath: normalizedRoot + "/" + parts.slice(0, index + 1).join("/"),
  }));
}

/** Map a file extension to a react-syntax-highlighter language.
 *  Keep the list conservative: only languages the highlighter bundles
 *  by default; everything else falls back to "text" so rendering stays
 *  fast and accurate. */
function languageFromExtension(extension?: string): string {
  if (!extension) return "text";
  const ext = extension.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    cs: "csharp",
    cpp: "cpp",
    cxx: "cpp",
    cc: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    css: "css",
    scss: "scss",
    sass: "scss",
    less: "less",
    html: "html",
    htm: "html",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    svg: "xml",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "bash",
    dockerfile: "docker",
    toml: "toml",
    ini: "ini",
    conf: "ini",
    cfg: "ini",
    env: "bash",
    vue: "html",
    svelte: "html",
    astro: "html",
    graphql: "graphql",
    gql: "graphql",
    proto: "protobuf",
    php: "php",
    lua: "lua",
    r: "r",
  };
  return map[ext] ?? "text";
}

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

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
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openMenuStyle, setOpenMenuStyle] = useState<{ top: number; left: number } | null>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const { t } = useTranslation();
  const panel = useOptionalPanel();
  const workspaceTreeOpen = panel?.workspaceTreeOpen ?? false;

  // Read the initial focus range from tab.params (set by ReadToolRow via
  // openLocalArtifactTarget → duya:open-file-preview-panel). Subsequent
  // re-focus on an already-open tab arrives via the duya:preview-focus-lines
  // event below, so we only read params once on mount.
  const [focusLines, setFocusLines] = useState<FocusLines | null>(() => {
    const ls = tab.params?.lineStart;
    const le = tab.params?.lineEnd;
    if (typeof ls === "number" && Number.isFinite(ls) && ls > 0) {
      return { start: ls, end: typeof le === "number" && Number.isFinite(le) ? le : undefined };
    }
    return null;
  });

  // Close the "Open" dropdown when clicking outside.
  useEffect(() => {
    if (!openMenuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !openMenuRef.current?.contains(target) &&
        !openButtonRef.current?.contains(target)
      ) {
        setOpenMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenuOpen]);

  // Listen for re-focus events (fired by openLocalArtifactTarget when the
  // caller supplied a line range). This is what lets a second click on a
  // different ReadToolRow for the SAME file scroll the already-open tab to
  // the new range — dedupKey would otherwise only activate the existing
  // tab without re-running its params.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        filePath?: string;
        lineStart?: number;
        lineEnd?: number;
      }>).detail;
      if (!detail) return;
      // Only accept events aimed at this panel's file. Resolve against the
      // same filePath we're currently displaying (including overrides).
      if (typeof detail.filePath === "string" && detail.filePath !== filePath) return;
      const ls = detail.lineStart;
      if (typeof ls !== "number" || !Number.isFinite(ls) || ls <= 0) {
        setFocusLines(null);
        return;
      }
      const le = detail.lineEnd;
      setFocusLines({
        start: ls,
        end: typeof le === "number" && Number.isFinite(le) && le >= ls ? le : undefined,
      });
    };
    window.addEventListener("duya:preview-focus-lines", handler as EventListener);
    return () => window.removeEventListener("duya:preview-focus-lines", handler as EventListener);
  }, [filePath]);

  // After the syntax-highlighted code renders, scroll the first focused
  // line into the vertical center of the canvas.
  useEffect(() => {
    if (!focusLines || !canvasRef.current || loading) return;
    const canvas = canvasRef.current;
    // Allow the highlighter one paint cycle to mount the line elements.
    const raf = requestAnimationFrame(() => {
      const lineEl = canvas.querySelector(`[data-preview-line="${focusLines.start}"]`) as HTMLElement | null;
      if (lineEl) {
        const canvasRect = canvas.getBoundingClientRect();
        const lineRect = lineEl.getBoundingClientRect();
        const targetScroll =
          canvas.scrollTop +
          (lineRect.top - canvasRect.top) -
          canvas.clientHeight / 2 +
          lineRect.height / 2;
        canvas.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [focusLines, loading, preview?.content]);

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
    // each endpoint against the raw preview content.
    let lineStart: number | undefined;
    let lineEnd: number | undefined;
    if (preview?.content) {
      const codeEl = anchor.closest('code');
      if (!codeEl) {
        setSelection(null);
        return;
      }
      const offsetOfNode = (node: Node, offset: number): number => {
        const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
        let total = 0;
        let current: Node | null = walker.nextNode();
        while (current) {
          if (current === node) return total + offset;
          total += current.textContent?.length ?? 0;
          current = walker.nextNode();
        }
        return -1;
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

  // Screenshot capture: images reuse the already-decoded data URL; text
  // (code/markdown) is captured via html2canvas. PDF iframes are
  // cross-origin and cannot be captured — the button stays disabled.
  const canScreenshot = !!preview?.success && !preview.tooLarge && (preview.kind === "image" || preview.kind === "text");

  const handleScreenshot = useCallback(async () => {
    const canvasEl = canvasRef.current;
    if (!canvasEl || !preview?.success || !filePath || !canScreenshot) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const attachmentId = crypto.randomUUID();
    const fileLabel = preview.name || tab.title || "file";
    let screenshotUrl = "";

    try {
      if (preview.kind === "image" && dataUrl) {
        screenshotUrl = dataUrl;
      } else if (preview.kind === "text") {
        const html2canvas = (await import("html2canvas")).default;
        const rect = canvasEl.getBoundingClientRect();
        const renderCanvas = await html2canvas(canvasEl, {
          backgroundColor: null,
          scale: window.devicePixelRatio || 1,
          useCORS: true,
          logging: false,
          width: rect.width,
          height: rect.height,
          windowWidth: canvasEl.scrollWidth,
          windowHeight: canvasEl.scrollHeight,
        });
        screenshotUrl = renderCanvas.toDataURL("image/png");
      }
    } catch {
      return;
    }

    if (!screenshotUrl) return;
    const base64 = screenshotUrl.split(",", 2)[1] ?? "";
    dispatchAddAttachment({
      kind: "browser-ref",
      reference: {
        kind: "screenshot",
        label: "Screenshot",
        title: fileLabel,
        url: filePath,
        content: [
          "File preview screenshot reference:",
          `- File: ${fileLabel}`,
          `- Path: ${filePath}`,
          "Use the attached screenshot as visual context.",
        ].join("\n"),
      },
      attachment: {
        id: attachmentId,
        name: `preview-screenshot-${stamp}.png`,
        type: "image/png",
        url: screenshotUrl,
        size: Math.round((base64.length * 3) / 4),
      },
    });
  }, [canScreenshot, dataUrl, filePath, preview, tab.title]);

  const language = useMemo(
    () => languageFromExtension(preview?.extension),
    [preview?.extension],
  );

  const lineProps = useCallback(
    (lineNumber: number) => {
      return {
        "data-preview-line": lineNumber,
        style: {
          display: "block" as const,
          width: "100%",
        },
      };
    },
    [],
  );

  const breadcrumb = useMemo(
    () => buildBreadcrumb(filePath, workingDirectory),
    [filePath, workingDirectory],
  );

  const rootName = useMemo(() => {
    if (!workingDirectory) return "";
    const normalized = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
    const idx = normalized.lastIndexOf("/");
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
  }, [workingDirectory]);

  const handleOpenWithDefault = useCallback(() => {
    setOpenMenuOpen(false);
    void window.electronAPI?.shell?.openPath(filePath);
  }, [filePath]);

  const handleRevealInFolder = useCallback(() => {
    setOpenMenuOpen(false);
    if (window.electronAPI?.shell?.showItemInFolder) {
      void window.electronAPI.shell.showItemInFolder(filePath);
      return;
    }
    void window.electronAPI?.shell?.openPath(getDirectoryPath(filePath));
  }, [filePath]);

  const handleCopyPath = useCallback(async () => {
    setOpenMenuOpen(false);
    try {
      await navigator.clipboard.writeText(filePath);
    } catch {
      // Ignore clipboard errors in restricted contexts.
    }
  }, [filePath]);

  if (!filePath) {
    return (
      <PanelFileTreeSplit workingDirectory={workingDirectory}>
      <div className="file-preview-empty">
        <FolderOpen size={32} weight="duotone" />
        <strong>{t('filePreview.openFile')}</strong>
        <span>{t('filePreview.selectFileHint')}</span>
      </div>
      </PanelFileTreeSplit>
    );
  }

  return (
    <PanelFileTreeSplit workingDirectory={workingDirectory}>
    <div className="file-preview-panel">
      <div className="file-preview-toolbar">
        <div className="file-preview-title">
          <div className="file-preview-name-stack">
            <div className="file-preview-breadcrumb">
              {rootName && (
                <span className="file-preview-breadcrumb-root">{rootName}</span>
              )}
              {breadcrumb?.map((segment, index) => {
                const isLast = index === breadcrumb.length - 1;
                return (
                  <span key={segment.fullPath} className="file-preview-breadcrumb-segment">
                    <span className="file-preview-breadcrumb-separator">›</span>
                    <span className={isLast ? "file-preview-breadcrumb-current" : "file-preview-breadcrumb-part"}>
                      {segment.name}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        <div className="file-preview-actions">
          {panel && workingDirectory && (
            <button
            type="button"
            className={workspaceTreeOpen ? "active" : undefined}
            onClick={() => panel.setWorkspaceTreeOpen(!workspaceTreeOpen)}
            title={workspaceTreeOpen ? t('panel.collapseFileTree') : t('panel.expandFileTree')}
            aria-label={workspaceTreeOpen ? t('panel.collapseFileTree') : t('panel.expandFileTree')}
            aria-pressed={workspaceTreeOpen}
            data-testid="file-tree-toggle"
          >
              <Files size={16} />
            </button>
          )}
          <button
            type="button"
            className="file-preview-screenshot-btn"
            onClick={() => void handleScreenshot()}
            disabled={!canScreenshot || loading}
            title={t('filePreview.screenshot')}
            aria-label={t('filePreview.screenshot')}
          >
            <Camera size={16} />
          </button>
          <div className="file-preview-open-dropdown">
            <button
              ref={openButtonRef}
              type="button"
              className="file-preview-open-button"
              onClick={() => {
                const rect = openButtonRef.current?.getBoundingClientRect();
                if (rect) {
                  setOpenMenuStyle({ top: rect.bottom + 6, left: rect.left });
                }
                setOpenMenuOpen((prev) => !prev);
              }}
              aria-haspopup="menu"
              aria-expanded={openMenuOpen}
            >
              <ArrowSquareOut size={14} />
              <span>{t('filePreview.open')}</span>
              <CaretDown size={12} className={openMenuOpen ? "rotate-180" : ""} />
            </button>
            {openMenuOpen && openMenuStyle && (
              <div
                ref={openMenuRef}
                className="file-preview-open-menu"
                role="menu"
                style={{
                  position: "fixed",
                  top: openMenuStyle.top,
                  left: openMenuStyle.left,
                }}
              >
                <button type="button" role="menuitem" onClick={handleOpenWithDefault}>
                  <ArrowSquareOut size={14} />
                  {t('filePreview.openWithDefault')}
                </button>
                <button type="button" role="menuitem" onClick={handleRevealInFolder}>
                  <FolderOpen size={14} />
                  {t('filePreview.revealInFolder')}
                </button>
                <button type="button" role="menuitem" onClick={handleCopyPath}>
                  <Copy size={14} />
                  {t('filePreview.copyPath')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`file-preview-canvas${preview?.kind === "pdf" ? " file-preview-canvas-pdf" : ""}`} ref={canvasRef} onMouseUp={captureSelection}>
        {loading && (
          <div className="file-preview-state"><span className="animate-pulse">{t('filePreview.loading')}</span></div>
        )}
        {!loading && preview && !preview.success && (
          <div className="file-preview-state file-preview-error"><WarningCircle size={20} /> {preview.error || t('filePreview.error')}</div>
        )}
        {!loading && preview?.success && (preview.kind === "unsupported" || preview.tooLarge) && (
          <div className="file-preview-state">
            <FileText size={36} weight="duotone" />
            <strong>{preview.tooLarge ? t('filePreview.fileTooLarge') : t('filePreview.unsupportedFileType')}</strong>
            <span>{t('filePreview.unsupportedHint')}</span>
          </div>
        )}
        {!loading && preview?.success && !preview.tooLarge && preview.kind === "image" && dataUrl && (
          <div className="file-preview-image-stage"><img src={dataUrl} alt={preview.name || tab.title} /></div>
        )}
        {!loading && preview?.success && !preview.tooLarge && preview.kind === "pdf" && dataUrl && (
          <iframe className="file-preview-pdf" src={`${dataUrl}#toolbar=0`} title={preview.name || tab.title} />
        )}
        {!loading && preview?.success && preview.kind === "text" && (
          <div className={`file-preview-text${MARKDOWN_EXTENSIONS.has(preview.extension ?? "") ? " markdown" : " code"}`}>
            {preview.truncated && <div className="file-preview-truncated">{t('filePreview.truncatedHint')}</div>}
            {MARKDOWN_EXTENSIONS.has(preview.extension ?? "") ? (
              <MarkdownRenderer className="prose dark:prose-invert max-w-none file-preview-markdown">
                {preview.content || ""}
              </MarkdownRenderer>
            ) : (
              <SyntaxHighlighter
                language={language}
                style={isDark ? vscDarkPlus : vs}
                wrapLines
                showLineNumbers
                startingLineNumber={1}
                lineProps={lineProps}
                customStyle={{
                  margin: 0,
                  padding: 0,
                  background: "transparent",
                  fontSize: "13px",
                  lineHeight: "1.65",
                  minHeight: "100%",
                }}
                codeTagProps={{
                  style: {
                    fontFamily: "var(--font-mono, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace)",
                  },
                }}
                lineNumberStyle={{
                  minWidth: "36px",
                  paddingRight: "12px",
                  paddingLeft: "8px",
                  textAlign: "right",
                  color: isDark ? "#6e7681" : "#6e7681",
                  background: "transparent",
                  userSelect: "none",
                }}
              >
                {preview.content || ""}
              </SyntaxHighlighter>
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
            <Sparkle size={14} weight="fill" /> {t('filePreview.askDuya')}
          </button>
        )}
      </div>
    </div>
    </PanelFileTreeSplit>
  );
}
