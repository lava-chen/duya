"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  ArrowsClockwise,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  Copy,
  Path,
  Plus,
} from "@phosphor-icons/react";
import { usePanel } from "@/hooks/usePanel";
import { useTranslation } from "@/hooks/useTranslation";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import {
  FileTree,
  RenderTreeNodes,
  type FileTreeNode,
} from "@/components/file-tree";
import { useConversationStore } from "@/stores/conversation-store";
import { TaskListPanel } from "@/components/layout/sidebar/TaskListPanel";

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
  const filtered = searchQuery ? filterTree(nodes, searchQuery) : nodes;
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

export function FileTreePanel() {
  const { fileTreeWidth, setFileTreeWidth } = usePanel();
  const { t } = useTranslation();
  const { activeThreadId, threads } = useConversationStore();

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    path: "",
    name: "",
    type: "file",
  });

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const workingDirectory = activeThread?.workingDirectory;

  const fetchTree = useCallback(async () => {
    console.log("[FileTreePanel] fetchTree called, workingDirectory:", workingDirectory);
    
    if (!workingDirectory) {
      console.log("[FileTreePanel] No working directory");
      setTree([]);
      setError(null);
      setLoading(false);
      return;
    }

    // Check if files API is available
    if (!window.electronAPI?.files?.browse) {
      console.log("[FileTreePanel] Files API not available");
      setTree([]);
      setError("File browser not available - please rebuild Electron");
      setLoading(false);
      return;
    }

    console.log("[FileTreePanel] Calling files.browse...");
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.files.browse(workingDirectory, 4);
      console.log("[FileTreePanel] files.browse result:", result);
      if (result.success) {
        setTree(result.tree);
      } else {
        setTree([]);
        setError(result.error || "Failed to load file tree");
      }
    } catch (e) {
      console.error("[FileTreePanel] files.browse error:", e);
      setTree([]);
      setError(String(e) || "Failed to load file tree");
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  const handleResize = useCallback(
    (delta: number) => {
      setFileTreeWidth(fileTreeWidth - delta);
    },
    [fileTreeWidth, setFileTreeWidth]
  );

  const handleOpenFile = useCallback(async (path: string) => {
    try {
      if (window.electronAPI?.shell?.openPath) {
        await window.electronAPI.shell.openPath(path);
      } else {
        // Fallback for non-Electron environments
        window.open(`file://${path}`, '_blank');
      }
    } catch (e) {
      console.error("[FileTreePanel] Failed to open file:", e);
    }
  }, []);

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

  const handleRenameSubmit = useCallback(async (path: string, newName: string) => {
    try {
      const result = await window.electronAPI.files.rename(path, newName);
      if (result.success) {
        await fetchTree();
      } else {
        console.error("[FileTreePanel] Rename failed:", result.error);
      }
    } catch (e) {
      console.error("[FileTreePanel] Rename error:", e);
    } finally {
      setRenamingPath(undefined);
      setRenamingName(undefined);
    }
  }, [fetchTree]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(undefined);
    setRenamingName(undefined);
  }, []);

  const handleDelete = useCallback(async (path: string) => {
    const name = path.split(/[/\\]/).pop() || "";
    if (!window.confirm(`Delete "${name}"?`)) return;
    try {
      const result = await window.electronAPI.files.delete(path);
      if (result.success) {
        await fetchTree();
      } else {
        console.error("[FileTreePanel] Delete failed:", result.error);
      }
    } catch (e) {
      console.error("[FileTreePanel] Delete error:", e);
    }
  }, [fetchTree]);

  const handleCopyAbsolutePath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(console.error);
  }, []);

  const handleCopyRelativePath = useCallback(
    (path: string) => {
      if (workingDirectory) {
        const relativePath = path.replace(workingDirectory, "").replace(/^[\\/]/, "");
        navigator.clipboard.writeText(relativePath).catch(console.error);
      }
    },
    [workingDirectory]
  );

  const handleAddToInput = useCallback((path: string) => {
    // Dispatch custom event that MessageInput will listen to
    const event = new CustomEvent("file-tree-add-to-input", {
      detail: { path },
    });
    window.dispatchEvent(event);
  }, []);

  const defaultExpanded = new Set<string>();

  // Show loading state
  if (loading) {
    return (
      <div className="file-tree-panel">
        <ResizeHandle side="left" onResize={handleResize} />
        <div
          className="file-tree-panel-inner"
          style={{ width: fileTreeWidth }}
        >
          <TaskListPanel />
          <div className="file-tree-panel-header">
            <span className="file-tree-panel-title">{t("panel.files")}</span>
          </div>
          <div className="file-tree-panel-toolbar">
            <div className="file-tree-search">
              <MagnifyingGlass size={12} className="file-tree-search-icon" />
              <input
                type="text"
                placeholder={t("fileTree.filterFiles")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="file-tree-search-input"
                disabled
              />
            </div>
            <button
              type="button"
              className="file-tree-refresh-btn"
              disabled
              aria-label={t("fileTree.refresh")}
            >
              <ArrowsClockwise size={12} className="animate-spin" />
            </button>
          </div>
          <div className="file-tree-panel-body">
            <div className="file-tree-loading">
              <ArrowsClockwise
                size={16}
                className="animate-spin text-muted-foreground"
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show error or empty state
  if (tree.length === 0) {
    return (
      <div className="file-tree-panel">
        <ResizeHandle side="left" onResize={handleResize} />
        <div
          className="file-tree-panel-inner"
          style={{ width: fileTreeWidth }}
        >
          <TaskListPanel />
          <div className="file-tree-panel-header">
            <span className="file-tree-panel-title">{t("panel.files")}</span>
          </div>
          <div className="file-tree-panel-toolbar">
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
            >
              <ArrowsClockwise size={12} />
            </button>
          </div>
          <div className="file-tree-panel-body">
            <p className="file-tree-empty">
              {error
                ? error
                : workingDirectory
                ? t("fileTree.noFiles")
                : t("fileTree.selectFolder")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Show tree
  return (
    <div className="file-tree-panel">
      <ResizeHandle side="left" onResize={handleResize} />
      <div
        className="file-tree-panel-inner"
        style={{ width: fileTreeWidth }}
      >
        <TaskListPanel />
        <div className="file-tree-panel-header">
          <span className="file-tree-panel-title">{t("panel.files")}</span>
        </div>
        <div className="file-tree-panel-toolbar">
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
          >
            <ArrowsClockwise size={12} />
          </button>
        </div>
        <div className="file-tree-panel-body">
          <FileTree
            defaultExpanded={defaultExpanded}
            onOpenFile={handleOpenFile}
            onContextMenu={handleContextMenu}
            workingDirectory={workingDirectory || undefined}
            renamingPath={renamingPath}
            renamingName={renamingName}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={handleRenameCancel}
          >
            <FileTreeContent nodes={tree} searchQuery={searchQuery} />
          </FileTree>
        </div>
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
