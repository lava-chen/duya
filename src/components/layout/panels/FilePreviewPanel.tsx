"use client";

import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CopyIcon,
  FileTextIcon,
  FolderOpenIcon,
  FoldersIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@/components/icons";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SyntaxHighlighter } from "@/lib/prism-languages";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { PanelFileTreeSplit } from "./PanelFileTreeSplit";
import { IdeBrandIcon } from "@/components/ide/ide-brand-icons";
import {
  OptionPanel,
  type OptionPanelItem,
  useOptionPanelPlacement,
} from "@/components/ui/OptionPanel";
import { useOptionalPanel } from "@/hooks/usePanel";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "@/hooks/useTranslation";
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

/** Code line height in px. MUST stay in sync with the CSS
 *  (`.file-preview-text.code` font-size 13px × line-height 1.6). */
const CODE_LINE_HEIGHT = 20.8;

/** Top padding of the code area in px. MUST stay in sync with the CSS
 *  (`.file-preview-text.code pre` padding-top) so the focus bar and the
 *  gutter line up with the first code row. */
const CODE_TOP_PADDING = 10;

function lineCountOf(content: string): number {
  return Math.max(1, content.split("\n").length);
}

/** Memoized markdown preview body. Isolated from selection, menu, and
 *  focus-line state changes in the parent so they don't trigger a
 *  re-render of the markdown parser. */
const PreviewMarkdownContent = memo(function PreviewMarkdownContent({
  content,
  truncatedHint,
  baseDirectory,
}: {
  content: string;
  truncatedHint: string;
  baseDirectory?: string;
}) {
  return (
    <div className="file-preview-text markdown">
      {truncatedHint && <div className="file-preview-truncated">{truncatedHint}</div>}
      <MarkdownRenderer
        className="prose dark:prose-invert max-w-none file-preview-markdown"
        baseDirectory={baseDirectory}
      >
        {content}
      </MarkdownRenderer>
    </div>
  );
});

/** Memoized syntax-highlighted code body. This is the expensive part;
 *  its props stay referentially stable while the user clicks lines, so
 *  the tokenizer never re-runs on interaction. */
const PreviewCodeContent = memo(function PreviewCodeContent({
  content,
  language,
  isDark,
  lineProps,
}: {
  content: string;
  language: string;
  isDark: boolean;
  lineProps: (lineNumber: number) => object;
}) {
  return (
    <SyntaxHighlighter
      language={language}
      style={isDark ? vscDarkPlus : vs}
      wrapLines
      showLineNumbers={false}
      lineProps={lineProps}
      customStyle={{
        margin: 0,
        // No padding here: the host CSS owns `.file-preview-text.code pre`
        // padding (10px top), which the gutter and focus bar align with.
        // An inline padding would override that CSS and desync the rows.
        background: "transparent",
        fontSize: "13px",
        lineHeight: "1.6",
        minHeight: "100%",
      }}
      codeTagProps={{
        style: {
          fontFamily: "var(--font-mono, 'Cascadia Code', 'SFMono-Regular', Consolas, monospace)",
        },
      }}
    >
      {content}
    </SyntaxHighlighter>
  );
});

/** Fixed line-number gutter rendered next to the code. Stays put while
 *  the code scrolls horizontally (position: sticky in CSS). Line
 *  heights must match `CODE_LINE_HEIGHT`. */
const PreviewCodeGutter = memo(function PreviewCodeGutter({
  content,
  currentLine,
  onLineClick,
}: {
  content: string;
  currentLine: number | null;
  onLineClick: (lineNumber: number) => void;
}) {
  const lineCount = useMemo(() => lineCountOf(content), [content]);
  const rows = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1), [lineCount]);
  return (
    <div className="file-preview-gutter" aria-hidden="true">
      {rows.map((lineNumber) => (
        <div
          key={lineNumber}
          className={`file-preview-line-no${lineNumber === currentLine ? " current" : ""}`}
          data-preview-line={lineNumber}
          onClick={() => onLineClick(lineNumber)}
          title={`Ln ${lineNumber}`}
        >
          {lineNumber}
        </div>
      ))}
    </div>
  );
});

/** Overlay strip highlighting the focused line range. Rendered above
 *  the gutter but behind the code text; positioned from
 *  `CODE_LINE_HEIGHT` so it stays perfectly aligned with the rows. */
function PreviewHighlightBar({ focusLines }: { focusLines: FocusLines | null }) {
  if (!focusLines) return null;
  const top = (focusLines.start - 1) * CODE_LINE_HEIGHT + CODE_TOP_PADDING;
  const height = ((focusLines.end ?? focusLines.start) - focusLines.start + 1) * CODE_LINE_HEIGHT;
  return (
    <div
      className="file-preview-focus-bar"
      style={{ top, height }}
      aria-hidden="true"
    />
  );
}

/** Single-row "you are here" overlay that spans the code body. Pairs
 *  with the gutter's `.file-preview-line-no.current` rule (same color)
 *  so the highlight reads as one continuous band. Lower intensity than
 *  `PreviewHighlightBar` (no borders, same percentage), reflecting
 *  that it's pure cursor tracking rather than an external focus. */
function PreviewCurrentLine({ currentLine }: { currentLine: number | null }) {
  if (currentLine == null) return null;
  const top = (currentLine - 1) * CODE_LINE_HEIGHT + CODE_TOP_PADDING;
  return (
    <div
      className="file-preview-current-line"
      style={{ top, height: CODE_LINE_HEIGHT }}
      aria-hidden="true"
    />
  );
}

export function FilePreviewPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const propFilePath = typeof tab.params?.filePath === "string" ? tab.params.filePath : "";
  const propWorkingDirectory = typeof tab.params?.workingDirectory === "string"
    ? tab.params.workingDirectory
    : "";
  const propStandalone = tab.params?.standalone === true;
  // Plan 220: when an embedded FileTreePanel dispatches `duya:open-file`,
  // we override the prop with a local override so the preview can
  // switch files without re-routing through the PanelProvider.
  const [filePathOverride, setFilePathOverride] = useState<string | null>(null);
  const [workingDirOverride, setWorkingDirOverride] = useState<string | null>(null);
  const filePath = filePathOverride ?? propFilePath;
  const workingDirectory = workingDirOverride ?? propWorkingDirectory;
  // Effective directory for the integrated file tree. Standalone previews
  // (in-chat clicks) ship with an empty workingDirectory on purpose — fall
  // back to the file's own directory so the file-tree toggle stays visible
  // and usable in every preview mode instead of silently disappearing.
  const treeWorkingDirectory = useMemo(
    () => workingDirectory || (filePath ? getDirectoryPath(filePath) : ""),
    [workingDirectory, filePath],
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const openContainerRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const { placement, maxListHeight } = useOptionPanelPlacement(openMenuOpen, openContainerRef);
  // Detected external IDEs (from `ide:list`) and the effective default used
  // by the "Open" action (`ide:get-default`, honors config `ide.default`).
  const [ides, setIdes] = useState<Array<{ id: string; name: string; executable: string; icon?: string }>>([]);
  const [defaultIde, setDefaultIde] = useState<{ id: string; name: string; executable: string; icon?: string } | null>(null);

  useEffect(() => {
    let active = true;
    window.electronAPI?.ide?.getDefault?.()
      .then((ide) => { if (active) setDefaultIde(ide); })
      .catch(() => {});
    window.electronAPI?.ide?.list?.()
      .then((list) => { if (active) setIdes(Array.isArray(list) ? list : []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const { t } = useTranslation();
  const panel = useOptionalPanel();
  const workspaceTreeOpen = panel?.workspaceTreeOpen ?? false;

  // Line the user last clicked (shown in the status bar and highlighted
  // in the gutter). Distinct from focusLines which comes from external
  // requests (ReadToolRow / gutter clicks).
  const [currentLine, setCurrentLine] = useState<number | null>(null);

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

  // Close the "Open" dropdown when clicking outside the trigger/panel.
  useEffect(() => {
    if (!openMenuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (openContainerRef.current && !openContainerRef.current.contains(target)) {
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
    // Standalone mode (in-chat click to a file outside the workspace)
    // is allowed to ship without a workingDirectory — the IPC anchors
    // the read to the user home directory instead of the project root.
    // Project-scoped opens keep the existing invariant that both fields
    // are required.
    if (!filePath) return;
    if (!propStandalone && !workingDirectory) return;
    setLoading(true);
    setSelection(null);
    try {
      const result = await window.electronAPI?.files?.preview?.(
        filePath,
        workingDirectory,
        propStandalone ? { standalone: true } : undefined,
      );
      setPreview(result ?? { success: false, error: "File preview is unavailable. Rebuild Electron and try again." });
    } catch (cause) {
      setPreview({ success: false, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, [filePath, workingDirectory, propStandalone]);

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

  // Track the line under the cursor so the status bar and gutter can
  // show "Ln n". The gutter and code rows both carry data-preview-line,
  // so this handles clicks on either.
  const handleCanvasClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const lineEl = target.closest("[data-preview-line]");
    if (lineEl instanceof HTMLElement) {
      const lineNumber = Number(lineEl.dataset.previewLine);
      if (Number.isFinite(lineNumber) && lineNumber > 0) setCurrentLine(lineNumber);
    }
  }, []);

  // Clicking a line number focuses that line: it scrolls to center,
  // highlights it, and becomes the "current" line.
  const handleLineClick = useCallback((lineNumber: number) => {
    setCurrentLine(lineNumber);
    setFocusLines({ start: lineNumber });
  }, []);

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

  const language = useMemo(
    () => languageFromExtension(preview?.extension),
    [preview?.extension],
  );

  // Referentially stable so the memoized highlighter never re-tokenizes
  // when the user clicks around. Focus highlighting is done with the
  // absolutely-positioned PreviewHighlightBar instead.
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

  // File name shown prominently in the header (from the preview payload or
  // the full path fallback), plus the extension-specific type icon.
  const fileName = useMemo(
    () => preview?.name || filePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || tab.title || "",
    [preview?.name, filePath, tab.title],
  );
  const isMarkdown = useMemo(() => MARKDOWN_EXTENSIONS.has(preview?.extension ?? ""), [preview?.extension]);

  const handleOpenWithDefault = useCallback(() => {
    setOpenMenuOpen(false);
    void window.electronAPI?.shell?.openPath(filePath);
  }, [filePath]);

  const handleOpenInIde = useCallback((id: string) => {
    setOpenMenuOpen(false);
    void window.electronAPI?.ide?.open?.(id, filePath);
  }, [filePath]);

  // Primary action of the "Open" trigger: launch the default IDE when one is
  // detected, otherwise fall back to the OS default application.
  const handleOpenDefaultIde = useCallback(() => {
    if (defaultIde) {
      handleOpenInIde(defaultIde.id);
    } else {
      handleOpenWithDefault();
    }
  }, [defaultIde, handleOpenInIde, handleOpenWithDefault]);

  // Menu items for the "Open" dropdown (reuses OptionPanel like the model
  // picker): detected IDEs first, then the utility actions. When no IDE is
  // detected we just skip the IDE section — the placeholder row used to
  // squat at the top of the menu and confused the layout.
  const openItems = useMemo<OptionPanelItem[]>(() => {
    const ideItems: OptionPanelItem[] = ides.map((ide) => ({
      id: `ide:${ide.id}`,
      label: t('filePreview.openInIde', { name: ide.name }),
      // OS shell icon extracted from the IDE executable (same source as the
      // OS "Open with" menus); the vector brand mark is the fallback.
      icon: ide.icon
        ? <img src={ide.icon} alt="" width={16} height={16} className="file-preview-ide-icon" />
        : <IdeBrandIcon id={ide.id} size={14} />,
      searchText: ide.name,
    }));
    return [
      ...ideItems,
      { id: 'default', label: t('filePreview.openWithDefault'), icon: <ArrowSquareOutIcon size={14} stroke={1.5} /> },
      { id: 'reveal', label: t('filePreview.revealInFolder'), icon: <FolderOpenIcon size={14} stroke={1.5} /> },
      ...(preview?.kind === "text"
        ? [{ id: 'copy-content', label: t('filePreview.copyContent'), icon: <CopyIcon size={14} stroke={1.5} /> }]
        : []),
      { id: 'copy', label: t('filePreview.copyPath'), icon: <CopyIcon size={14} stroke={1.5} /> },
    ];
  }, [ides, preview?.kind, t]);

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

  const handleCopyContent = useCallback(async () => {
    if (!preview?.content) return;
    try {
      await navigator.clipboard.writeText(preview.content);
    } catch {
      // Ignore clipboard errors in restricted contexts.
    }
  }, [preview?.content]);

  const handleOpenItem = useCallback((item: OptionPanelItem) => {
    setOpenMenuOpen(false);
    if (item.id.startsWith('ide:')) {
      handleOpenInIde(item.id.slice(4));
    } else if (item.id === 'default') {
      handleOpenWithDefault();
    } else if (item.id === 'reveal') {
      handleRevealInFolder();
    } else if (item.id === 'copy-content') {
      void handleCopyContent();
    } else if (item.id === 'copy') {
      handleCopyPath();
    }
  }, [handleOpenInIde, handleOpenWithDefault, handleRevealInFolder, handleCopyPath, handleCopyContent]);

  if (!filePath) {
    return (
      <div className="file-preview-panel">
        <PanelFileTreeSplit workingDirectory={treeWorkingDirectory}>
          <div className="file-preview-empty">
            <FolderOpenIcon size={32} stroke={1.25} />
            <strong>{t('filePreview.openFile')}</strong>
            <span>{t('filePreview.selectFileHint')}</span>
          </div>
        </PanelFileTreeSplit>
      </div>
    );
  }

  const truncatedHint = preview?.truncated ? t('filePreview.truncatedHint') : "";

  return (
    <div className="file-preview-panel">
      <div className="file-preview-toolbar">
        <div className="file-preview-title">
          {breadcrumb ? (
            <span className="file-preview-path" title={filePath}>
              {rootName && <span className="file-preview-path-root">{rootName}</span>}
              {breadcrumb.map((segment, index) => (
                <span
                  key={segment.fullPath}
                  className={`file-preview-path-segment${index === breadcrumb.length - 1 ? " file-preview-path-file" : ""}`}
                >
                  <span className="file-preview-path-separator">›</span>
                  {segment.name}
                </span>
              ))}
            </span>
          ) : (
            <span className="file-preview-filename" title={fileName}>{fileName}</span>
          )}
        </div>
        <div className="file-preview-actions">
          {panel && treeWorkingDirectory && (
            <IconButton
              type="button"
              variant="default"
              shape="square"
              size="md"
              className={workspaceTreeOpen ? "active" : undefined}
              onClick={() => panel.setWorkspaceTreeOpen(!workspaceTreeOpen)}
              title={workspaceTreeOpen ? t('panel.collapseFileTree') : t('panel.expandFileTree')}
              aria-label={workspaceTreeOpen ? t('panel.collapseFileTree') : t('panel.expandFileTree')}
              aria-pressed={workspaceTreeOpen}
              data-testid="file-tree-toggle"
            >
              <FoldersIcon size={18} stroke={1.5} />
            </IconButton>
          )}
          <div ref={openContainerRef} className="file-preview-open-dropdown">
            <div className="file-preview-open-group">
              <button
                ref={openButtonRef}
                type="button"
                className="file-preview-open-ide"
                onClick={handleOpenDefaultIde}
                aria-label={defaultIde ? t('filePreview.openInIde', { name: defaultIde.name }) : t('filePreview.openWithDefault')}
                title={defaultIde ? t('filePreview.openInIde', { name: defaultIde.name }) : t('filePreview.openWithDefault')}
              >
                {defaultIde?.icon ? (
                  <img
                    src={defaultIde.icon}
                    alt=""
                    width={16}
                    height={16}
                    className="file-preview-ide-icon"
                  />
                ) : defaultIde ? (
                  <IdeBrandIcon id={defaultIde.id} size={16} />
                ) : (
                  <ArrowSquareOutIcon size={16} stroke={1.5} />
                )}
                <span className="file-preview-open-label">{t('filePreview.open')}</span>
              </button>
              <button
                type="button"
                className="file-preview-open-caret"
                onClick={() => setOpenMenuOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={openMenuOpen}
                aria-label={t('filePreview.open')}
                title={t('filePreview.open')}
              >
                <CaretDownIcon size={12} stroke={1.75} className={openMenuOpen ? "rotate-180" : ""} />
              </button>
            </div>
            {openMenuOpen && (
              <OptionPanel
                className={`file-preview-open-menu absolute right-0 z-50 w-64 ${placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'}`}
                title={t('filePreview.open')}
                items={openItems}
                selectedId={defaultIde ? `ide:${defaultIde.id}` : undefined}
                onSelect={handleOpenItem}
                onClose={() => setOpenMenuOpen(false)}
                maxListHeight={maxListHeight}
                showSearch={false}
                searchPlaceholder={t('filePreview.open')}
                emptyMessage={t('filePreview.noIdeDetected')}
              />
            )}
          </div>
        </div>
      </div>

      <PanelFileTreeSplit workingDirectory={treeWorkingDirectory}>
      <div className={`file-preview-canvas${preview?.kind === "pdf" ? " file-preview-canvas-pdf" : ""}`} ref={canvasRef} onMouseUp={captureSelection} onClick={handleCanvasClick}>
        {loading && (
          <div className="file-preview-state"><span className="animate-pulse">{t('filePreview.loading')}</span></div>
        )}
        {!loading && preview && !preview.success && (
          <div className="file-preview-state file-preview-error"><WarningCircleIcon size={20} /> {preview.error || t('filePreview.error')}</div>
        )}
        {!loading && preview?.success && (preview.kind === "unsupported" || preview.tooLarge) && (
          <div className="file-preview-state">
            <FileTextIcon size={36} />
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
        {!loading && preview?.success && preview.kind === "text" && !isMarkdown && (
          <div className="file-preview-text code">
            {truncatedHint && <div className="file-preview-truncated">{truncatedHint}</div>}
            <div className="file-preview-code-scroll">
              <PreviewCodeGutter
                content={preview.content || ""}
                currentLine={currentLine}
                onLineClick={handleLineClick}
              />
              <div className="file-preview-code-body">
                <PreviewHighlightBar focusLines={focusLines} />
                <PreviewCurrentLine currentLine={currentLine} />
                <PreviewCodeContent
                  content={preview.content || ""}
                  language={language}
                  isDark={isDark}
                  lineProps={lineProps}
                />
              </div>
            </div>
          </div>
        )}
        {!loading && preview?.success && preview.kind === "text" && isMarkdown && (
          <PreviewMarkdownContent
            content={preview.content || ""}
            truncatedHint={truncatedHint}
            baseDirectory={getDirectoryPath(filePath)}
          />
        )}
        {selection && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="file-preview-ask-duya"
            style={{ left: selection.x, top: selection.y }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={askDuya}
          >
            <SparkleIcon size={14} fill="currentColor" /> {t('filePreview.askDuya')}
          </Button>
        )}
      </div>
      </PanelFileTreeSplit>
    </div>
  );
}
