"use client";

import { useState, useCallback, useDeferredValue, useEffect, useRef, useMemo } from "react";
import {
  ArrowsClockwise,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  Copy,
  Path,
  Plus,
} from "@phosphor-icons/react";
import {
  FileTree,
  RenderTreeNodes,
  type FileTreeNode,
} from "@/components/file-tree";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import type { PageId, PageTab } from "./registry";
import { useOptionalPanel } from "@/hooks/usePanel";

function resolveTreePath(workingDirectory: string | null | undefined, treePath: string): string {
  if (!workingDirectory || /^(?:[A-Za-z]:[\\/]|[/\\]{2}|\/)/.test(treePath)) return treePath;
  const separator = workingDirectory.includes("\\") ? "\\" : "/";
  const normalized = treePath.replace(/[\\/]/g, separator);
  return `${workingDirectory.replace(/[\\/]$/, "")}${separator}${normalized}`;
}

function containsMatch(node: FileTreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.children) {
    return node.children.some((child) => containsMatch(child, query));
  }
  return false;
}

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  return nodes
    .filter((node) => containsMatch(node, query))
    .map((node) => ({
      ...node,
      children: node.children ? filterTree(node.children, query) : undefined,
    }));
}

function FileTreeContent({
  nodes,
  searchQuery,
}: {
  nodes: FileTreeNode[];
  searchQuery: string;
}) {
  const filtered = useMemo(
    () => searchQuery ? filterTree(nodes, searchQuery) : nodes,
    [nodes, searchQuery],
  );
  return <RenderTreeNodes nodes={filtered} />;
}

// Context menu component
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  path: string;
  name: string;
  type: "file" | "directory";
}

function ContextMenu({
  state,
  onClose,
  onRename,
  onDelete,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onAddToInput,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
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
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let newX = state.x;
    let newY = state.y;

    if (newX + rect.width > viewportWidth) {
      newX = viewportWidth - rect.width - 8;
    }
    if (newY + rect.height > viewportHeight) {
      newY = viewportHeight - rect.height - 8;
    }
    if (newX < 8) {
      newX = 8;
    }
    if (newY < 8) {
      newY = 8;
    }

    setPosition({ x: newX, y: newY });
  }, [state.visible, state.x, state.y]);

  if (!state.visible) return null;

  const menuItems = [
    {
      label: "Add to input",
      icon: <Plus size={14} />,
      action: () => {
        onAddToInput(state.path);
        onClose();
      },
    },
    {
      label: "Copy absolute path",
      icon: <Copy size={14} />,
      action: () => {
        onCopyAbsolutePath(state.path);
        onClose();
      },
    },
    {
      label: "Copy relative path",
      icon: <Path size={14} />,
      action: () => {
        onCopyRelativePath(state.path);
        onClose();
      },
    },
    {
      type: "divider" as const,
    },
    {
      label: "Rename",
      icon: <PencilSimple size={14} />,
      action: () => {
        onRename(state.path);
        onClose();
      },
    },
    {
      type: "divider" as const,
    },
    {
      label: "Delete",
      icon: <Trash size={14} />,
      action: () => {
        onDelete(state.path);
        onClose();
      },
      danger: true,
    },
  ];

  return (
    <div
      ref={menuRef}
      className="file-tree-context-menu"
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 9999,
      }}
    >
      {menuItems.map((item, index) =>
        item.type === "divider" ? (
          <div key={index} className="file-tree-context-menu-divider" />
        ) : (
          <button
            key={index}
            className={`file-tree-context-menu-item${item.danger ? " danger" : ""}`}
            onClick={item.action}
          >
            <span className="file-tree-context-menu-icon">{item.icon}</span>
            <span className="file-tree-context-menu-label">{item.label}</span>
          </button>
        )
      )}
    </div>
  );
}

export function FileTreePanel({ tab, embedded }: { tab?: PageTab; embedded?: boolean }) {
  const { activeThreadId, threads } = useConversationStore();
  const { t } = useTranslation();
  // Plan 220: when this component is embedded inside FilePreviewPanel
  // it is rendered outside the PanelProvider tree, so usePanel() would
  // throw. useOptionalPanel returns null in that case, and the file
  // preview open falls through to the global `duya:open-page` event
  // dispatcher (the App-level event handler picks it up).
  const panel = useOptionalPanel();
  const openOrActivatePage = useCallback(
    (pageId: PageId, params?: Record<string, unknown>) => {
      if (panel) {
        panel.openOrActivatePage(pageId, params);
        return;
      }
      window.dispatchEvent(new CustomEvent("duya:open-page", {
        detail: { pageId, params },
      }));
    },
    [panel],
  );

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    path: "",
    name: "",
    type: "file",
  });

  // When mounted as a registry page, tab is provided and the path is
  // frozen at open time. When mounted standalone (legacy / tests), fall
  // back to the active thread's working directory.
  const fallbackThread = threads.find((t) => t.id === activeThreadId);
  const workingDirectory =
    (tab?.params?.workingDirectory as string | undefined) ??
    fallbackThread?.workingDirectory;

  const fetchTree = useCallback(async () => {
    if (!workingDirectory) {
      setTree([]);
      setError(null);
      setLoading(false);
      return;
    }

    if (!window.electronAPI?.files?.browse) {
      setTree([]);
      setError("File browser not available - please rebuild Electron");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.files.browse(workingDirectory, 4);
      if (result.success) {
        setTree(result.tree);
      } else {
        setTree([]);
        setError(result.error || "Failed to load file tree");
      }
    } catch (e) {
      setTree([]);
      setError(String(e) || "Failed to load file tree");
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  const handleOpenFile = useCallback((treePath: string) => {
    const filePath = resolveTreePath(workingDirectory, treePath);
    setSelectedPath(treePath);
    if (/\.(docx|pptx|xlsx)$/i.test(filePath)) {
      window.dispatchEvent(new CustomEvent("duya:open-office-panel", {
        detail: { filePath, workingDirectory },
      }));
      return;
    }
    // Plan 220: in embedded mode (rendered inside FilePreviewPanel
    // without a PanelProvider), fall through to a `duya:open-file`
    // event so the parent preview panel can switch its current file
    // instead of trying to open a new tab.
    if (embedded) {
      window.dispatchEvent(new CustomEvent("duya:open-file", {
        detail: { filePath, workingDirectory },
      }));
      return;
    }
    openOrActivatePage("preview", {
      filePath,
      workingDirectory,
      title: filePath.split(/[/\\]/).pop() || t('panel.preview'),
    });
  }, [openOrActivatePage, workingDirectory, embedded, t]);

  const handleContextMenu = useCallback(
    (path: string, type: "file" | "directory", event: React.MouseEvent) => {
      event.preventDefault();
      const name = path.split(/[/\\]/).pop() || "";
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        path,
        name,
        type,
      });
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const [renamingPath, setRenamingPath] = useState<string | undefined>(undefined);
  const [renamingName, setRenamingName] = useState<string | undefined>(undefined);

  const handleRename = useCallback((path: string) => {
    const name = path.split(/[/\\]/).pop() || "";
    setRenamingPath(path);
    setRenamingName(name);
  }, []);

  const handleRenameSubmit = useCallback(
    async (path: string, newName: string) => {
      try {
        const result = await window.electronAPI.files.rename(resolveTreePath(workingDirectory, path), newName);
        if (result.success) {
          await fetchTree();
        }
      } catch (e) {
        // Rename failed - ignore
      } finally {
        setRenamingPath(undefined);
        setRenamingName(undefined);
      }
    },
    [fetchTree, workingDirectory]
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(undefined);
    setRenamingName(undefined);
  }, []);

  const handleDelete = useCallback(
    async (path: string) => {
      const name = path.split(/[/\\]/).pop() || "";
      if (!window.confirm(`Delete "${name}"?`)) return;
      try {
        const result = await window.electronAPI.files.delete(resolveTreePath(workingDirectory, path));
        if (result.success) {
          await fetchTree();
        }
      } catch (e) {
        // Delete failed - ignore
      }
    },
    [fetchTree, workingDirectory]
  );

  const handleCopyAbsolutePath = useCallback((path: string) => {
    navigator.clipboard.writeText(resolveTreePath(workingDirectory, path)).catch(() => {});
  }, [workingDirectory]);

  const handleCopyRelativePath = useCallback(
    (path: string) => {
      if (workingDirectory) {
        navigator.clipboard.writeText(path.replace(workingDirectory, "").replace(/^[\\/]/, "")).catch(() => {});
      }
    },
    [workingDirectory]
  );

  const handleAddToInput = useCallback((path: string) => {
    const event = new CustomEvent("file-tree-add-to-input", {
      detail: { path: resolveTreePath(workingDirectory, path) },
    });
    window.dispatchEvent(event);
  }, [workingDirectory]);

  const defaultExpanded = useMemo(() => new Set<string>(), []);

  return (
    <div className="file-tree-panel-embedded">
      {!embedded && (
        <div className="file-tree-search-row">
          <div className="file-tree-search">
            <MagnifyingGlass size={12} className="file-tree-search-icon" />
            <input
              type="text"
              placeholder={t("fileTree.filterFiles")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="file-tree-search-input"
            />
          </div>
          <button
            type="button"
            className="file-tree-refresh-btn"
            onClick={fetchTree}
            aria-label={t("fileTree.refresh")}
            disabled={loading}
          >
            <ArrowsClockwise size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      )}
      <div className="file-tree-panel-body">
        {loading && tree.length === 0 ? (
          <div className="file-tree-loading">
            <ArrowsClockwise
              size={16}
              className="animate-spin text-muted-foreground"
            />
          </div>
        ) : tree.length === 0 ? (
          <p className="file-tree-empty">
            {error
              ? error
              : workingDirectory
                ? t("fileTree.noFiles")
                : t("fileTree.selectFolder")}
          </p>
        ) : (
          <FileTree
            defaultExpanded={defaultExpanded}
            selectedPath={selectedPath}
            onOpenFile={handleOpenFile}
            onContextMenu={handleContextMenu}
            workingDirectory={workingDirectory || undefined}
            renamingPath={renamingPath}
            renamingName={renamingName}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={handleRenameCancel}
          >
            <FileTreeContent nodes={tree} searchQuery={deferredSearchQuery} />
          </FileTree>
        )}
      </div>
      <ContextMenu
        state={contextMenu}
        onClose={handleCloseContextMenu}
        onRename={handleRename}
        onDelete={handleDelete}
        onCopyAbsolutePath={handleCopyAbsolutePath}
        onCopyRelativePath={handleCopyRelativePath}
        onAddToInput={handleAddToInput}
      />
    </div>
  );
}
