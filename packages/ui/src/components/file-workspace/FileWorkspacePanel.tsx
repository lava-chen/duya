"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  EyeIcon,
  FileTextIcon,
  FolderOpenIcon,
  FoldersIcon,
  MagnifyingGlassIcon,
  CodeIcon,
  XIcon,
} from "@/components/icons";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { useTranslation } from "@/hooks/useTranslation";
import type { PageTab } from "@/components/layout/panels/page-tab";
import { CodeSurface, CODE_ROW_HEIGHT, type CodeSelection } from "./CodeSurface";
import { TreeSidebar, type FsNode } from "./TreeSidebar";
import { computeFolds, indentDepth } from "./fw-tokenize";

interface Doc {
  path: string;
  name: string;
  ext: string;
  kind: "text" | "image" | "pdf" | "unsupported";
  content: string;
  dataUrl?: string;
  lines: string[];
  guides: number[];
  folds: Map<number, number>;
  collapsed: Set<number>;
  comments: Map<number, string>;
  mode: "render" | "source";
  scrollTop: number;
}

interface MenuEntry {
  label?: string;
  kbd?: string;
  disabled?: boolean;
  separator?: boolean;
  children?: MenuEntry[];
  action?: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

const MARKDOWN_EXT = new Set(["md", "mdx", "markdown"]);
const HTML_EXT = new Set(["html", "htm"]);
const COMPOSER_HEIGHT = 58;

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : path;
}

function buildDoc(payload: {
  path: string;
  name: string;
  extension?: string;
  kind?: string;
  content?: string;
  data?: string;
  mediaType?: string;
}): Doc {
  const content = payload.content ?? "";
  const lines = content.split("\n");
  const ext = (payload.extension ?? "").toLowerCase();
  const isMd = MARKDOWN_EXT.has(ext);
  const isHtml = HTML_EXT.has(ext);
  const kind = (payload.kind ?? "text") as Doc["kind"];
  return {
    path: payload.path,
    name: payload.name,
    ext,
    kind,
    content,
    dataUrl: payload.data && payload.mediaType
      ? `data:${payload.mediaType};base64,${payload.data}`
      : undefined,
    lines,
    guides: lines.map(indentDepth),
    folds: kind === "text" ? computeFolds(lines) : new Map(),
    collapsed: new Set(),
    comments: new Map(),
    mode: isMd || isHtml ? "render" : "source",
    scrollTop: 0,
  };
}

export function FileWorkspacePanel({ tab }: { tab: PageTab; embedded?: boolean }) {
  const { t } = useTranslation();
  const workingDirectory = typeof tab.params?.workingDirectory === "string"
    ? tab.params.workingDirectory
    : "";

  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [treeOpen, setTreeOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ line: number; text: string } | null>(null);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ line: number; token: number } | null>(null);

  const panelRef = useRef<HTMLElement>(null);
  const toastTimer = useRef<number | null>(null);
  const docsRef = useRef<Doc[]>([]);

  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);

  const activeDoc = activeIndex >= 0 ? docs[activeIndex] : undefined;

  const flash = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  /* ---- open / close ---- */
  const loadDoc = useCallback(
    async (path: string, name: string) => {
      const existing = docsRef.current.findIndex((doc) => doc.path === path);
      if (existing >= 0) {
        setActiveIndex(existing);
        return;
      }
      const api = window.electronAPI?.files;
      if (!api?.preview) {
        flash("文件预览不可用，请重新构建 Electron");
        return;
      }
      setNotice(null);
      // Files outside the workspace (chat links to a home-directory file) need
      // the standalone gate, otherwise the main process rejects the path.
      const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
      const normalizedRoot = workingDirectory.replace(/\\/g, "/").toLowerCase();
      const insideRoot = normalizedRoot.length > 0 && normalizedPath.startsWith(normalizedRoot);
      const result = await api.preview(
        path,
        workingDirectory,
        insideRoot ? undefined : { standalone: true },
      );
      if (!result?.success) {
        setNotice(result?.error ?? "无法打开这个文件");
        return;
      }
      const doc = buildDoc({
        path,
        name: result.name ?? name,
        extension: result.extension,
        kind: result.kind,
        content: result.content,
        data: result.data,
        mediaType: result.mediaType,
      });
      const base = docsRef.current.length;
      setDocs((prev) => {
        const next = [...prev, doc];
        return next.length > 8 ? next.slice(1) : next;
      });
      setActiveIndex(Math.min(base, 7));
    },
    [flash, workingDirectory],
  );

  const openFile = useCallback(
    (node: FsNode) => {
      void loadDoc(node.path, node.name);
    },
    [loadDoc],
  );

  const closeDoc = useCallback((index: number) => {
    const remaining = docsRef.current.length - 1;
    setDocs((prev) => prev.filter((_, i) => i !== index));
    setActiveIndex((current) => {
      if (remaining <= 0) return -1;
      const shifted = current > index ? current - 1 : current;
      return Math.max(0, Math.min(shifted, remaining - 1));
    });
    setComposer(null);
    setSelection(null);
  }, []);

  /* the page opens with a file when launched from chat */
  const initialPath = typeof tab.params?.filePath === "string" ? tab.params.filePath : "";
  useEffect(() => {
    if (!initialPath) return;
    void loadDoc(initialPath, basename(initialPath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  /* later opens reuse the same page tab, so they arrive as events */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string; lineStart?: number }>).detail;
      if (!detail?.filePath) return;
      void loadDoc(detail.filePath, basename(detail.filePath));
      if (typeof detail.lineStart === "number" && detail.lineStart > 0) {
        setScrollTo({ line: detail.lineStart, token: Date.now() });
      }
    };
    window.addEventListener("duya:workspace-open-file", handler as EventListener);
    return () => window.removeEventListener("duya:workspace-open-file", handler as EventListener);
  }, [loadDoc]);

  /* ---- view state ---- */
  const patchDoc = useCallback((index: number, patch: Partial<Doc>) => {
    setDocs((prev) => prev.map((doc, i) => (i === index ? { ...doc, ...patch } : doc)));
  }, []);

  const toggleFold = useCallback(
    (line: number) => {
      if (!activeDoc) return;
      const next = new Set(activeDoc.collapsed);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      patchDoc(activeIndex, { collapsed: next });
    },
    [activeDoc, activeIndex, patchDoc],
  );

  const view = useMemo(() => {
    if (!activeDoc) return [];
    const out: number[] = [];
    for (let i = 0; i < activeDoc.lines.length; i++) {
      out.push(i);
      if (activeDoc.collapsed.has(i + 1)) {
        const end = activeDoc.folds.get(i + 1);
        if (end && end > i + 1) i = end - 1;
      }
    }
    return out;
  }, [activeDoc]);

  /* ---- comments ---- */
  const commitComment = useCallback(() => {
    if (!activeDoc || !composer) return;
    const text = composer.text.trim();
    const next = new Map(activeDoc.comments);
    if (text) next.set(composer.line, text);
    else next.delete(composer.line);
    patchDoc(activeIndex, { comments: next });
    setComposer(null);
    if (text) flash(`评论已添加 · 第 ${composer.line} 行`);
  }, [activeDoc, activeIndex, composer, flash, patchDoc]);

  const composerNode: ReactNode = composer ? (
    <div className="fw-cmt">
      <div className="fw-cmt-hd">第 {composer.line} 行</div>
      <textarea
        className="fw-cmt-input"
        autoFocus
        value={composer.text}
        placeholder="添加评论"
        onChange={(event) => setComposer({ line: composer.line, text: event.target.value })}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            commitComment();
          }
          if (event.key === "Escape") setComposer(null);
        }}
      />
      <div className="fw-cmt-actions">
        <button type="button" className="fw-cmt-send" title="提交 (Ctrl+Enter)" onClick={commitComment}>
          <CaretRightIcon size={12} />
        </button>
      </div>
    </div>
  ) : null;

  /* ---- selection bar ---- */
  const attachSelection = useCallback(() => {
    if (!activeDoc || !selection) return;
    window.dispatchEvent(new CustomEvent("file-tree-add-to-input", {
      detail: {
        path: activeDoc.path,
        lineStart: selection.start,
        lineEnd: selection.end,
        selectedText: selection.text,
      },
    }));
    flash(`已将 L${selection.start}–L${selection.end} 附加为上下文`);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [activeDoc, flash, selection]);

  /* ---- context menu ---- */
  const openEditorMenu = useCallback(
    (x: number, y: number, line: number) => {
      if (!activeDoc) return;
      const hasSelection = Boolean(selection?.text);
      setMenu({
        x,
        y,
        items: [
          {
            label: "将选择附加为上下文",
            kbd: "Ctrl+Shift+L",
            disabled: !hasSelection,
            action: attachSelection,
          },
          {
            label: "添加评论",
            disabled: !hasSelection,
            action: () => {
              setComposer({ line: selection?.end ?? line, text: "" });
            },
          },
          { separator: true },
          { label: "撤销", kbd: "Ctrl+Z", disabled: true },
          { label: "重做", kbd: "Ctrl+Y", disabled: true },
          { separator: true },
          { label: "剪切", kbd: "Ctrl+X", disabled: true },
          {
            label: "复制",
            kbd: "Ctrl+C",
            disabled: !hasSelection,
            action: () => {
              if (!selection) return;
              void navigator.clipboard.writeText(selection.text);
              flash("已复制选中内容");
            },
          },
          { label: "粘贴", kbd: "Ctrl+V", disabled: true },
          { separator: true },
          {
            label: "全选",
            kbd: "Ctrl+A",
            action: () => {
              const container = panelRef.current?.querySelector(".fw-code-scroll");
              if (!container) return;
              const range = document.createRange();
              range.selectNodeContents(container);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            },
          },
          {
            label: "跳转到行",
            kbd: "Ctrl+G",
            action: () => {
              const input = window.prompt("跳转到行", "1");
              const parsed = Number(input);
              if (Number.isFinite(parsed) && parsed > 0) {
                setScrollTo({ line: Math.floor(parsed), token: Date.now() });
              }
            },
          },
        ],
      });
    },
    [activeDoc, attachSelection, flash, selection],
  );

  const openTreeMenu = useCallback(
    (x: number, y: number, node: FsNode) => {
      const absolute = node.path;
      const relative = workingDirectory
        ? node.path.replace(workingDirectory, "").replace(/^[\\/]/, "")
        : node.path;
      const copy = (value: string, label: string) => () => {
        void navigator.clipboard.writeText(value);
        flash(`已复制${label}`);
      };
      setMenu({
        x,
        y,
        items: [
          {
            label: "作为上下文附加",
            action: () => {
              window.dispatchEvent(new CustomEvent("file-tree-add-to-input", { detail: { path: node.path } }));
              flash(`已附加 ${node.name}`);
            },
          },
          {
            label: "复制",
            children: [
              { label: "绝对路径", action: copy(absolute, "绝对路径") },
              { label: "相对路径", action: copy(relative, "相对路径") },
              { label: "文件名", action: copy(node.name, "文件名") },
            ],
          },
          { separator: true },
          {
            label: "打开于",
            children: [
              {
                label: "系统默认程序",
                action: () => {
                  void window.electronAPI?.shell?.openPath?.(node.path);
                },
              },
            ],
          },
          {
            label: "在资源管理器中显示",
            action: () => {
              void window.electronAPI?.shell?.showItemInFolder?.(node.path);
            },
          },
        ],
      });
    },
    [flash, workingDirectory],
  );

  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const renderMenuItems = (items: MenuEntry[]): ReactNode =>
    items.map((item, index) => {
      if (item.separator) return <div key={index} className="fw-menu-sep" />;
      if (items[index] === item && item.children) {
        return (
          <div key={index} className="fw-menu-item has-sub">
            <span className="fw-menu-label">{item.label}</span>
            <span className="fw-menu-arrow">›</span>
            <div className="fw-menu fw-submenu">{renderMenuItems(item.children)}</div>
          </div>
        );
      }
      return (
        <div
          key={index}
          className={`fw-menu-item${item.disabled ? " is-disabled" : ""}`}
          onMouseDown={(event) => {
            event.stopPropagation();
            if (item.disabled) return;
            item.action?.();
            setMenu(null);
          }}
        >
          <span className="fw-menu-label">{item.label}</span>
          {item.kbd ? <span className="fw-menu-kbd">{item.kbd}</span> : null}
        </div>
      );
    });

  /* ---- render ---- */
  const canToggleMode = Boolean(activeDoc && (MARKDOWN_EXT.has(activeDoc.ext) || HTML_EXT.has(activeDoc.ext)));

  return (
    <section className="fw-panel" ref={panelRef}>
      <header className="fw-head">
        <div className="fw-head-left">
          <button
            type="button"
            className={`fw-icon-btn${treeOpen ? " is-on" : ""}`}
            title={treeOpen ? "收起侧栏 (Ctrl+B)" : "展开侧栏 (Ctrl+B)"}
            aria-pressed={treeOpen}
            onClick={() => setTreeOpen((prev) => !prev)}
          >
            <FoldersIcon size={15} />
          </button>
          <span className="fw-head-title">{t("panel.files")}</span>
        </div>

        <div className="fw-tabs">
          {docs.map((doc, index) => (
            <div
              key={doc.path}
              className={`fw-tab${index === activeIndex ? " is-active" : ""}`}
              title={doc.path}
              onClick={() => setActiveIndex(index)}
            >
              <span className="fw-tab-name">{doc.name}</span>
              <button
                type="button"
                className="fw-tab-close"
                aria-label="关闭"
                onClick={(event) => {
                  event.stopPropagation();
                  closeDoc(index);
                }}
              >
                <XIcon size={11} />
              </button>
            </div>
          ))}
        </div>

        <div className="fw-head-actions">
          <button type="button" className="fw-icon-btn" title="刷新" onClick={() => setReloadToken((n) => n + 1)}>
            <ArrowsClockwiseIcon size={14} />
          </button>
        </div>
      </header>

      <div className="fw-body">
        {treeOpen ? (
          <aside className="fw-sidebar">
            <div className="fw-search">
              <MagnifyingGlassIcon size={12} />
              <input
                value={query}
                spellCheck={false}
                placeholder="筛选，或输入 ? 在文件中搜索"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {workingDirectory ? (
              <TreeSidebar
                root={workingDirectory}
                query={query}
                selectedPath={activeDoc?.path}
                reloadToken={reloadToken}
                onOpenFile={openFile}
                onContextMenu={openTreeMenu}
              />
            ) : (
              <p className="fw-tree-empty">还没有选择项目目录</p>
            )}
          </aside>
        ) : null}

        <div className="fw-main">
          {activeDoc ? (
            <>
              <div className="fw-crumbs">
                <span className="fw-crumb-seg">{dirname(activeDoc.path)}</span>
                <span className="fw-crumb-sep">›</span>
                <span className="fw-crumb-seg is-last">{activeDoc.name}</span>
                {canToggleMode ? (
                  <div className="fw-mode">
                    <button
                      type="button"
                      className={activeDoc.mode === "render" ? "is-on" : ""}
                      title="渲染视图"
                      onClick={() => patchDoc(activeIndex, { mode: "render" })}
                    >
                      <EyeIcon size={12} />
                    </button>
                    <button
                      type="button"
                      className={activeDoc.mode === "source" ? "is-on" : ""}
                      title="源码视图"
                      onClick={() => patchDoc(activeIndex, { mode: "source" })}
                    >
                      <CodeIcon size={12} />
                    </button>
                  </div>
                ) : null}
              </div>

              {activeDoc.mode === "render" && MARKDOWN_EXT.has(activeDoc.ext) ? (
                <div className="fw-render">
                  <MarkdownRenderer className="fw-markdown" baseDirectory={dirname(activeDoc.path)}>
                    {activeDoc.content}
                  </MarkdownRenderer>
                </div>
              ) : activeDoc.mode === "render" && HTML_EXT.has(activeDoc.ext) ? (
                <iframe className="fw-html" title={activeDoc.name} srcDoc={activeDoc.content} />
              ) : activeDoc.kind === "image" && activeDoc.dataUrl ? (
                <div className="fw-media">
                  <img src={activeDoc.dataUrl} alt={activeDoc.name} />
                </div>
              ) : activeDoc.kind === "pdf" && activeDoc.dataUrl ? (
                <iframe className="fw-html" title={activeDoc.name} src={`${activeDoc.dataUrl}#toolbar=0`} />
              ) : activeDoc.kind === "unsupported" ? (
                <div className="fw-empty">
                  <FileTextIcon size={30} />
                  <strong>这个文件类型暂不支持预览</strong>
                  <span>可以用右键菜单在系统里打开它。</span>
                </div>
              ) : (
                <CodeSurface
                  lines={activeDoc.lines}
                  view={view}
                  guides={activeDoc.guides}
                  folds={activeDoc.folds}
                  collapsed={activeDoc.collapsed}
                  onToggleFold={toggleFold}
                  commentLines={new Set(activeDoc.comments.keys())}
                  onComment={(line) => setComposer({ line, text: activeDoc.comments.get(line) ?? "" })}
                  editingLine={composer ? composer.line - 1 : null}
                  onSelection={setSelection}
                  onContextMenu={openEditorMenu}
                  scrollTo={scrollTo}
                  reserve={composer ? { line: composer.line, height: COMPOSER_HEIGHT, node: composerNode } : null}
                />
              )}
            </>
          ) : (
            <div className="fw-empty">
              <FolderOpenIcon size={32} />
              <strong>{notice ?? "打开的文件会显示在这里"}</strong>
              <span>在文件树中选择一个文件，或点击对话中的文件路径。</span>
            </div>
          )}
        </div>
      </div>

      {selection ? (
        <div
          className="fw-selbar"
          style={{
            left: Math.max(8, Math.min(selection.rect.left + selection.rect.width / 2 - 88, window.innerWidth - 190)),
            top: selection.rect.bottom + 8,
          }}
        >
          <button type="button" onClick={attachSelection}>作为上下文附加</button>
          <button
            type="button"
            onClick={() => {
              setComposer({ line: selection.end, text: "" });
              setSelection(null);
            }}
          >
            添加评论
          </button>
        </div>
      ) : null}

      {menu ? (
        <div
          className="fw-menu"
          style={{
            left: Math.max(6, Math.min(menu.x, window.innerWidth - 300)),
            top: Math.max(6, Math.min(menu.y, window.innerHeight - 260)),
          }}
        >
          {renderMenuItems(menu.items)}
        </div>
      ) : null}

      {toast ? <div className="fw-toast">{toast}</div> : null}
    </section>
  );
}
