"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertCircle,
  IconChevronDown,
  IconColumns2,
  IconCopy,
  IconFileCode,
  IconFileDiff,
  IconFileMinus,
  IconFilePlus,
  IconFileX,
  IconFold,
  IconGitBranch,
  IconGitCompare,
  IconHistory,
  IconLayoutSidebarRight,
  IconMessagePlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTextWrap,
} from "@/components/icons";
import { dispatchAddAttachment } from "@/lib/add-attachment-event";
import {
  getGitReview,
  getGitReviewFullDiff,
  getGitLatestTurnReview,
  type GitReviewFile,
  type GitReviewResult,
  type GitTurnReview,
} from "@/lib/git-ipc";
import { useOptionalPanel } from "@/hooks/usePanel";
import type { PageTab } from "./registry";
import {
  collapseContextLines,
  parseReviewPatch,
  toSplitRows,
  type ReviewDiffHunk,
  type ReviewDiffLine,
  type ReviewDisplayLine,
  type ReviewFilePatch,
} from "./code-review-diff";

type DiffLayout = "unified" | "split";
type ReviewScope = "latest-turn" | "workspace";

const EMPTY_REVIEW: GitReviewResult = { isGitRepo: false, files: [] };

function joinWorkspacePath(workingDirectory: string, relativePath: string): string {
  return `${workingDirectory.replace(/[\\/]$/, "")}/${relativePath}`;
}

function statusColor(status: GitReviewFile["status"]): string {
  switch (status) {
    case "added":
    case "untracked": return "var(--review-add)";
    case "deleted": return "var(--review-remove)";
    case "renamed": return "#b68cff";
    default: return "#f39a49";
  }
}

function StatusIcon({ status }: { status: GitReviewFile["status"] }) {
  const color = statusColor(status);
  const props = { size: 18, stroke: 2, color, "aria-label": status, title: status };
  switch (status) {
    case "added":
    case "untracked":
      return <IconFilePlus {...props} />;
    case "deleted":
      return <IconFileMinus {...props} />;
    case "renamed":
      return <IconFileX {...props} />;
    default:
      return <IconFileDiff {...props} />;
  }
}

function DiffLineView({ line, wrapped }: { line: ReviewDiffLine; wrapped: boolean }) {
  const lineNumber = line.type === "remove" ? line.oldLineNumber : line.newLineNumber;
  return (
    <div className={`code-review-line code-review-line-${line.type}${wrapped ? " is-wrapped" : ""}`}>
      <span className="code-review-line-number">{lineNumber ?? ""}</span>
      <span className="code-review-line-prefix" aria-hidden="true">
        {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
      </span>
      <code className="code-review-line-code">{line.content || " "}</code>
    </div>
  );
}

function CollapsedLinesButton({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button type="button" className="code-review-collapsed-lines" onClick={onExpand}>
      <IconChevronDown size={14} aria-hidden="true" />
      显示 {count} 行未修改内容
    </button>
  );
}

function UnifiedHunk({ hunk, wrapped, foldUnchanged }: {
  hunk: ReviewDiffHunk;
  wrapped: boolean;
  foldUnchanged: boolean;
}) {
  const [expandedContext, setExpandedContext] = useState(false);
  const lines = useMemo(
    () => collapseContextLines(hunk.lines, foldUnchanged && !expandedContext),
    [expandedContext, foldUnchanged, hunk.lines],
  );

  return (
    <section className="code-review-hunk">
      <div className="code-review-hunk-header">{hunk.header}</div>
      {lines.map((line, index) => line.type === "collapsed" ? (
        <CollapsedLinesButton
          key={`collapsed-${index}`}
          count={line.count}
          onExpand={() => setExpandedContext(true)}
        />
      ) : (
        <DiffLineView key={`${line.type}-${line.oldLineNumber ?? line.newLineNumber ?? index}`} line={line} wrapped={wrapped} />
      ))}
    </section>
  );
}

function SplitHunk({ hunk, wrapped, foldUnchanged }: {
  hunk: ReviewDiffHunk;
  wrapped: boolean;
  foldUnchanged: boolean;
}) {
  const [expandedContext, setExpandedContext] = useState(false);
  const lines = useMemo<ReviewDisplayLine[]>(
    () => collapseContextLines(hunk.lines, foldUnchanged && !expandedContext),
    [expandedContext, foldUnchanged, hunk.lines],
  );
  const rows = useMemo(() => toSplitRows(lines), [lines]);

  return (
    <section className="code-review-hunk code-review-hunk-split">
      <div className="code-review-hunk-header">{hunk.header}</div>
      {rows.map((row, index) => row.type === "collapsed" ? (
        <CollapsedLinesButton
          key={`collapsed-${index}`}
          count={row.count}
          onExpand={() => setExpandedContext(true)}
        />
      ) : (
        <div className="code-review-split-row" key={`split-${index}`}>
          {row.oldLine ? <DiffLineView line={row.oldLine} wrapped={wrapped} /> : <div className="code-review-line code-review-line-empty" />}
          {row.newLine ? <DiffLineView line={row.newLine} wrapped={wrapped} /> : <div className="code-review-line code-review-line-empty" />}
        </div>
      ))}
    </section>
  );
}

function DiffContents({ hunks, layout, wrapped, foldUnchanged }: {
  hunks: ReviewDiffHunk[];
  layout: DiffLayout;
  wrapped: boolean;
  foldUnchanged: boolean;
}) {
  if (hunks.length === 0) {
    return <div className="code-review-empty">此文件没有可显示的文本差异。</div>;
  }
  return (
    <div className={`code-review-diff code-review-diff-${layout}`}>
      {hunks.map((hunk, index) => layout === "split" ? (
        <SplitHunk key={`${hunk.header}-${index}`} hunk={hunk} wrapped={wrapped} foldUnchanged={foldUnchanged} />
      ) : (
        <UnifiedHunk key={`${hunk.header}-${index}`} hunk={hunk} wrapped={wrapped} foldUnchanged={foldUnchanged} />
      ))}
    </div>
  );
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  path: string;
}

function ReviewContextMenu({
  state,
  onClose,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onAddToInput,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onCopyAbsolutePath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onAddToInput: (path: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (state.visible) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [state.visible, onClose]);

  useEffect(() => {
    if (!state.visible || !menuRef.current) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let newX = state.x;
    let newY = state.y;
    if (newX + rect.width > vw) newX = vw - rect.width - 8;
    if (newY + rect.height > vh) newY = vh - rect.height - 8;
    if (newX < 8) newX = 8;
    if (newY < 8) newY = 8;
    setPosition({ x: newX, y: newY });
  }, [state.visible, state.x, state.y]);

  if (!state.visible) return null;

  const items = [
    {
      label: "Add to input",
      icon: <IconMessagePlus size={14} />,
      action: () => { onAddToInput(state.path); onClose(); },
    },
    {
      label: "Copy absolute path",
      icon: <IconCopy size={14} />,
      action: () => { onCopyAbsolutePath(state.path); onClose(); },
    },
    {
      label: "Copy relative path",
      icon: <IconRoute size={14} />,
      action: () => { onCopyRelativePath(state.path); onClose(); },
    },
  ];

  return (
    <div
      ref={menuRef}
      className="file-tree-context-menu"
      style={{ position: "fixed", left: position.x, top: position.y, zIndex: 9999 }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className="file-tree-context-menu-item"
          onClick={item.action}
        >
          <span className="file-tree-context-menu-icon">{item.icon}</span>
          <span className="file-tree-context-menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function CodeReviewPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const workingDirectory = typeof tab.params?.workingDirectory === "string" ? tab.params.workingDirectory : "";
  const sessionId = typeof tab.params?.sessionId === "string" ? tab.params.sessionId : "";
  const panel = useOptionalPanel();
  const workspaceExpanded = panel?.workspaceExpanded ?? false;
  const [review, setReview] = useState<GitReviewResult>(EMPTY_REVIEW);
  const [scope, setScope] = useState<ReviewScope>("latest-turn");
  const [turnReview, setTurnReview] = useState<GitTurnReview | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const [filter, setFilter] = useState("");
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [wrapped, setWrapped] = useState(false);
  const [foldUnchanged, setFoldUnchanged] = useState(true);
  const [showFiles, setShowFiles] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, path: "",
  });
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!workingDirectory) {
      setReview(EMPTY_REVIEW);
      setError("当前会话没有项目目录。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (scope === "latest-turn") {
        if (!sessionId) {
          setScope("workspace");
          return;
        }
        const next = await getGitLatestTurnReview(sessionId, workingDirectory);
        if (next.error) setError(next.error);
        const stored = next.review ?? null;
        setTurnReview(stored);
        setReview({
          isGitRepo: next.isGitRepo,
          branch: stored ? "上一轮对话" : undefined,
          baseRef: stored ? "开始 → 结束" : undefined,
          files: stored?.files ?? [],
          totals: stored?.totals,
        });
        return;
      }
      setTurnReview(null);
      const next = await getGitReview(workingDirectory);
      setReview(next);
      if (!next.isGitRepo) setError("此项目不是 Git 仓库，或 Git 当前不可用。");
    } catch {
      setReview(EMPTY_REVIEW);
      setError("无法读取工作区变更。");
    } finally {
      setLoading(false);
    }
  }, [scope, sessionId, workingDirectory]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const files = review.files ?? [];
  useEffect(() => {
    setSelectedPath((current) => files.some((file) => file.path === current) ? current : files[0]?.path ?? null);
  }, [files]);

  useEffect(() => {
    if (!workspaceExpanded && layout === "split") setLayout("unified");
  }, [layout, workspaceExpanded]);

  useEffect(() => {
    if (scope === "latest-turn") {
      setPatch(turnReview?.patch ?? "");
      if (turnReview?.binary) setDiffError("部分文件包含二进制差异，无法以内联文本显示。");
      else if (turnReview?.truncated) setDiffError("差异内容过大，仅显示前 1 MB。");
      else setDiffError("");
      setDiffLoading(false);
      return;
    }
    if (!workingDirectory || files.length === 0) {
      setPatch("");
      setDiffError("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    void getGitReviewFullDiff(workingDirectory)
      .then((result) => {
        if (cancelled) return;
        setPatch(result.patch ?? "");
        if (result.error) setDiffError(result.error);
        else if (result.binary) setDiffError("部分文件包含二进制差异，无法以内联文本显示。");
        else if (result.truncated) setDiffError("差异内容过大，仅显示前 1 MB。");
      })
      .catch(() => {
        if (!cancelled) {
          setPatch("");
          setDiffError("无法加载差异。");
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => { cancelled = true; };
  }, [scope, turnReview, workingDirectory, files.length]);

  const filePatches = useMemo(() => parseReviewPatch(patch), [patch]);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  const filteredFiles = useMemo(
    () => files.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase())),
    [files, filter],
  );
  const totals = review.totals;

  const scrollToFile = useCallback((filePath: string) => {
    const element = fileRefs.current[filePath];
    const container = scrollContainerRef.current;
    if (!element || !container) return;
    container.scrollTo({ top: element.offsetTop - container.offsetTop, behavior: "smooth" });
  }, []);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedPath(filePath);
    scrollToFile(filePath);
  }, [scrollToFile]);

  const handleContextMenu = useCallback((path: string, event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ visible: true, x: event.clientX, y: event.clientY, path });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleCopyAbsolutePath = useCallback((path: string) => {
    if (!workingDirectory) return;
    navigator.clipboard.writeText(joinWorkspacePath(workingDirectory, path)).catch(() => {});
  }, [workingDirectory]);

  const handleCopyRelativePath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {});
  }, []);

  const handleAddToInput = useCallback((path: string) => {
    if (!workingDirectory) return;
    dispatchAddAttachment({ kind: "file-tree-ref", path: joinWorkspacePath(workingDirectory, path) });
  }, [workingDirectory]);

  return (
    <div className={`code-review-panel${showFiles ? " has-file-tree" : ""}`}>
      <header className="code-review-toolbar">
        <div className="code-review-scope">
          {scope === "latest-turn" ? <IconHistory size={18} aria-hidden="true" /> : <IconGitBranch size={18} aria-hidden="true" />}
          <div className="code-review-scope-copy">
            <span className="code-review-scope-label">{scope === "latest-turn" ? "上一轮审阅" : "工作区审阅"}</span>
            <span className="code-review-scope-range">{scope === "latest-turn" ? "回合开始 → 结束" : "HEAD → 工作区"}</span>
          </div>
          <div className="code-review-scope-switch" role="group" aria-label="审阅范围">
            <button type="button" className={scope === "latest-turn" ? "is-active" : ""} onClick={() => setScope("latest-turn")}>上一轮</button>
            <button type="button" className={scope === "workspace" ? "is-active" : ""} onClick={() => setScope("workspace")}>工作区</button>
          </div>
        </div>
        <div className="code-review-totals" aria-label={`${files.length} 个变更文件`}>
          <span className="is-add">+{totals?.additions ?? 0}</span>
          <span className="is-remove">−{totals?.removals ?? 0}</span>
          <span className="code-review-file-count">{files.length} 个文件</span>
        </div>
        <div className="code-review-toolbar-actions">
          <button type="button" className="code-review-icon-button" onClick={() => void refresh()} title="刷新变更" aria-label="刷新变更" disabled={loading}>
            <IconRefresh size={17} className={loading ? "animate-spin" : ""} />
          </button>
          <button type="button" className={`code-review-icon-button${wrapped ? " is-active" : ""}`} onClick={() => setWrapped((value) => !value)} title="自动换行" aria-label="自动换行" aria-pressed={wrapped}>
            <IconTextWrap size={17} />
          </button>
          <button type="button" className={`code-review-icon-button${foldUnchanged ? " is-active" : ""}`} onClick={() => setFoldUnchanged((value) => !value)} title="折叠未修改内容" aria-label="折叠未修改内容" aria-pressed={foldUnchanged}>
            <IconFold size={17} />
          </button>
          <button type="button" className={`code-review-icon-button${layout === "split" ? " is-active" : ""}`} onClick={() => setLayout((value) => value === "unified" ? "split" : "unified")} title={workspaceExpanded ? "切换统一/分栏差异" : "展开审阅页后可使用分栏差异"} aria-label="切换统一或分栏差异" aria-pressed={layout === "split"} disabled={!workspaceExpanded}>
            <IconColumns2 size={17} />
          </button>
          <button type="button" className={`code-review-icon-button${showFiles ? " is-active" : ""}`} onClick={() => setShowFiles((value) => !value)} title={showFiles ? "隐藏文件" : "显示文件"} aria-label={showFiles ? "隐藏文件" : "显示文件"} aria-pressed={showFiles}>
            <IconLayoutSidebarRight size={17} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="code-review-state code-review-state-error"><IconAlertCircle size={18} />{error}</div>
      ) : !review.isGitRepo ? (
        <div className="code-review-state"><IconGitCompare size={22} />正在检查工作区…</div>
      ) : files.length === 0 ? (
        <div className="code-review-state"><IconGitCompare size={22} />{scope === "latest-turn" ? "上一轮对话没有文件变更。" : "工作区没有相对 HEAD 的未提交改动。"}</div>
      ) : (
        <div className="code-review-workspace">
          <main className="code-review-main">
            <div className="code-review-diff-scroll" ref={scrollContainerRef}>
              {diffLoading ? (
                <div className="code-review-state">正在加载差异…</div>
              ) : diffError && !patch ? (
                <div className="code-review-state code-review-state-error"><IconAlertCircle size={18} />{diffError}</div>
              ) : (
                <>
                  {diffError && <div className="code-review-diff-notice">{diffError}</div>}
                  {filePatches.length === 0 ? (
                    <div className="code-review-empty">没有可显示的文本差异。</div>
                  ) : (
                    filePatches.map((filePatch) => (
                      <div
                        key={filePatch.path}
                        id={`review-file-${filePatch.path}`}
                        ref={(element) => { fileRefs.current[filePatch.path] = element; }}
                        className={`code-review-file-section${selectedPath === filePatch.path ? " is-selected" : ""}`}
                      >
                        <div className="code-review-file-header">
                          <div className="code-review-file-identity">
                            <IconFileCode size={18} aria-hidden="true" />
                            <span title={filePatch.path}>{filePatch.path}</span>
                            {filePatch.status === "binary" && <span className="code-review-file-binary">binary</span>}
                          </div>
                        </div>
                        {filePatch.status === "binary" ? (
                          <div className="code-review-empty">二进制文件，无法以内联文本显示。</div>
                        ) : (
                          <DiffContents hunks={filePatch.hunks} layout={layout} wrapped={wrapped} foldUnchanged={foldUnchanged} />
                        )}
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          </main>

          {showFiles && (
            <aside className="code-review-file-tree" aria-label="变更文件">
              <div className="file-tree-search-row">
                <div className="file-tree-search">
                  <IconSearch size={12} className="file-tree-search-icon" />
                  <input
                    type="text"
                    placeholder="筛选文件…"
                    aria-label="筛选文件"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="file-tree-search-input"
                  />
                </div>
              </div>
              <div className="code-review-file-list">
                {filteredFiles.length === 0 ? (
                  <div className="file-tree-empty">没有匹配的文件。</div>
                ) : (
                  filteredFiles.map((file) => {
                    const isSelected = selectedPath === file.path;
                    return (
                      <button
                        key={file.path}
                        type="button"
                        className={`code-review-file-list-item${isSelected ? " is-selected" : ""}`}
                        onClick={() => handleSelectFile(file.path)}
                        onContextMenu={(e) => handleContextMenu(file.path, e)}
                        aria-selected={isSelected}
                        role="listitem"
                        title={file.path}
                      >
                        <span className="code-review-file-list-icon">
                          <StatusIcon status={file.status} />
                        </span>
                        <span className="code-review-file-list-path">{file.path}</span>
                        <span className="code-review-file-list-stats" aria-label={`+${file.additions} −${file.removals}`}>
                          <span className="is-add">+{file.additions}</span>
                          <span className="is-remove">−{file.removals}</span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      <ReviewContextMenu
        state={contextMenu}
        onClose={handleCloseContextMenu}
        onCopyAbsolutePath={handleCopyAbsolutePath}
        onCopyRelativePath={handleCopyRelativePath}
        onAddToInput={handleAddToInput}
      />
    </div>
  );
}
