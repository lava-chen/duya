"use client";

import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffect,
} from "react";
import {
  Folder,
  FolderOpen,
  File,
  CaretRight,
  FileCode,
  Code,
  FileTsIcon,
  FileJsIcon,
  FileJsxIcon,
  FilePyIcon,
  FileCIcon,
  FileCppIcon,
  FileCssIcon,
  FileHtmlIcon,
  FileImageIcon,
  FilePngIcon,
  FileJpgIcon,
  FilePdfIcon,
  FileDocIcon,
  FileArchiveIcon,
  FileTextIcon,
  FileMdIcon,
  FileSqlIcon,
  FileSvgIcon,
  FileVueIcon,
  FileRsIcon,
  FileIniIcon,
} from "@phosphor-icons/react";

// =============================================================================
// Types
// =============================================================================

export interface FileTreeNode {
  name: string;
  path: string;
  type: "directory" | "file";
  extension?: string;
  children?: FileTreeNode[];
}

export interface FileTreeContextMenuItem {
  label: string;
  action: string;
  icon?: ReactNode;
  danger?: boolean;
}

interface FileTreeContextType {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onContextMenu?: (path: string, type: "file" | "directory", event: React.MouseEvent) => void;
  onAddToInput?: (path: string) => void;
  workingDirectory?: string;
  renamingPath?: string;
  renamingName?: string;
  onRenameSubmit?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
}

// =============================================================================
// Context
// =============================================================================

const FileTreeContext = createContext<FileTreeContextType>({
  expandedPaths: new Set(),
  togglePath: () => {},
});

// =============================================================================
// Root FileTree Component
// =============================================================================

interface FileTreeProps {
  children: ReactNode;
  defaultExpanded?: Set<string>;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onContextMenu?: (path: string, type: "file" | "directory", event: React.MouseEvent) => void;
  onAddToInput?: (path: string) => void;
  workingDirectory?: string;
  renamingPath?: string;
  renamingName?: string;
  onRenameSubmit?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
}

export function FileTree({
  children,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onOpenFile,
  onContextMenu,
  onAddToInput,
  workingDirectory,
  renamingPath,
  renamingName,
  onRenameSubmit,
  onRenameCancel,
}: FileTreeProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

  const togglePath = useCallback((path: string) => {
    setInternalExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const contextValue = useMemo(
    () => ({ expandedPaths: internalExpanded, togglePath, selectedPath, onSelect, onOpenFile, onContextMenu, onAddToInput, workingDirectory, renamingPath, renamingName, onRenameSubmit, onRenameCancel }),
    [internalExpanded, togglePath, selectedPath, onSelect, onOpenFile, onContextMenu, onAddToInput, workingDirectory, renamingPath, renamingName, onRenameSubmit, onRenameCancel]
  );

  return (
    <FileTreeContext.Provider value={contextValue}>
      <div className="file-tree" role="tree">
        {children}
      </div>
    </FileTreeContext.Provider>
  );
}

// =============================================================================
// Folder Component
// =============================================================================

interface FileTreeFolderProps {
  path: string;
  name: string;
  children?: ReactNode;
}

export function FileTreeFolder({ path, name, children }: FileTreeFolderProps) {
  const { expandedPaths, togglePath, onContextMenu, renamingPath, renamingName, onRenameSubmit, onRenameCancel } = useContext(FileTreeContext);
  const isExpanded = expandedPaths.has(path);
  const isRenaming = renamingPath === path;
  const [editName, setEditName] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setEditName(renamingName || name);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isRenaming, renamingName, name]);

  const handleToggle = useCallback(() => {
    togglePath(path);
  }, [togglePath, path]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(path, "directory", e);
  }, [onContextMenu, path]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (editName.trim() && editName.trim() !== name) {
        onRenameSubmit?.(path, editName.trim());
      } else {
        onRenameCancel?.();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onRenameCancel?.();
    }
  }, [editName, name, path, onRenameSubmit, onRenameCancel]);

  const handleRenameBlur = useCallback(() => {
    if (editName.trim() && editName.trim() !== name) {
      onRenameSubmit?.(path, editName.trim());
    } else {
      onRenameCancel?.();
    }
  }, [editName, name, path, onRenameSubmit, onRenameCancel]);

  if (isRenaming) {
    return (
      <div className="file-tree-folder" role="treeitem">
        <div className="file-tree-folder-header file-tree-folder-renaming">
          <span className="file-tree-caret">
            <CaretRight
              size={14}
              className={isExpanded ? "file-tree-caret-expanded" : ""}
            />
          </span>
          <span className="file-tree-folder-icon">
            {isExpanded ? (
              <FolderOpen size={16} />
            ) : (
              <Folder size={16} />
            )}
          </span>
          <input
            ref={inputRef}
            className="file-tree-rename-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        {isExpanded && children && (
          <div className="file-tree-folder-children">{children}</div>
        )}
      </div>
    );
  }

  return (
    <div className="file-tree-folder" role="treeitem">
      <div
        className="file-tree-folder-header"
        onClick={handleToggle}
        onContextMenu={handleContextMenu}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="file-tree-caret">
          <CaretRight
            size={14}
            className={isExpanded ? "file-tree-caret-expanded" : ""}
          />
        </span>
        <span className="file-tree-folder-icon">
          {isExpanded ? (
            <FolderOpen size={16} />
          ) : (
            <Folder size={16} />
          )}
        </span>
        <span className="file-tree-name">{name}</span>
      </div>
      {isExpanded && children && (
        <div className="file-tree-folder-children">{children}</div>
      )}
    </div>
  );
}

// =============================================================================
// File Component
// =============================================================================

interface FileTreeFileProps {
  path: string;
  name: string;
  icon?: ReactNode;
}

export function FileTreeFile({ path, name, icon }: FileTreeFileProps) {
  const { selectedPath, onSelect, onOpenFile, onContextMenu, renamingPath, renamingName, onRenameSubmit, onRenameCancel } = useContext(FileTreeContext);
  const isSelected = selectedPath === path;
  const isRenaming = renamingPath === path;
  const [editName, setEditName] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setEditName(renamingName || name);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isRenaming, renamingName, name]);

  const handleClick = useCallback(() => {
    onSelect?.(path);
    onOpenFile?.(path);
  }, [onSelect, onOpenFile, path]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(path, "file", e);
  }, [onContextMenu, path]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (editName.trim() && editName.trim() !== name) {
        onRenameSubmit?.(path, editName.trim());
      } else {
        onRenameCancel?.();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onRenameCancel?.();
    }
  }, [editName, name, path, onRenameSubmit, onRenameCancel]);

  const handleRenameBlur = useCallback(() => {
    if (editName.trim() && editName.trim() !== name) {
      onRenameSubmit?.(path, editName.trim());
    } else {
      onRenameCancel?.();
    }
  }, [editName, name, path, onRenameSubmit, onRenameCancel]);

  if (isRenaming) {
    return (
      <div className="file-tree-file file-tree-file-renaming" role="treeitem">
        <span className="file-tree-file-icon">
          {icon ?? <File size={16} />}
        </span>
        <input
          ref={inputRef}
          className="file-tree-rename-input"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div
      className={`file-tree-file${isSelected ? " file-tree-file-selected" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onSelect?.(path);
          onOpenFile?.(path);
        }
      }}
      role="treeitem"
      tabIndex={0}
    >
      <span className="file-tree-file-icon">
        {icon ?? <File size={16} />}
      </span>
      <span className="file-tree-name">{name}</span>
    </div>
  );
}

// =============================================================================
// Get file icon by extension
// =============================================================================

function getFileIcon(extension?: string) {
  const iconClass = "text-muted-foreground";
  switch (extension?.toLowerCase()) {
    // TypeScript
    case "ts":
    case "tsx":
      return <FileTsIcon size={16} className={iconClass} />;
    // JavaScript
    case "js":
      return <FileJsIcon size={16} className={iconClass} />;
    case "jsx":
      return <FileJsxIcon size={16} className={iconClass} />;
    // Python
    case "py":
    case "pyc":
    case "pyo":
    case "pyd":
      return <FilePyIcon size={16} className={iconClass} />;
    // Rust
    case "rs":
      return <FileRsIcon size={16} className={iconClass} />;
    // C/C++
    case "c":
      return <FileCIcon size={16} className={iconClass} />;
    case "cpp":
    case "cc":
    case "cxx":
    case "h":
    case "hpp":
      return <FileCppIcon size={16} className={iconClass} />;
    // CSS
    case "css":
    case "scss":
    case "sass":
    case "less":
      return <FileCssIcon size={16} className={iconClass} />;
    // HTML
    case "html":
    case "htm":
      return <FileHtmlIcon size={16} className={iconClass} />;
    // Vue
    case "vue":
      return <FileVueIcon size={16} className={iconClass} />;
    // Images
    case "png":
      return <FilePngIcon size={16} className={iconClass} />;
    case "jpg":
    case "jpeg":
      return <FileJpgIcon size={16} className={iconClass} />;
    case "gif":
    case "bmp":
    case "webp":
    case "ico":
      return <FileImageIcon size={16} className={iconClass} />;
    case "svg":
      return <FileSvgIcon size={16} className={iconClass} />;
    // Documents
    case "pdf":
      return <FilePdfIcon size={16} className={iconClass} />;
    case "doc":
    case "docx":
      return <FileDocIcon size={16} className={iconClass} />;
    // Markdown
    case "md":
    case "mdx":
      return <FileMdIcon size={16} className={iconClass} />;
    // SQL
    case "sql":
      return <FileSqlIcon size={16} className={iconClass} />;
    // Config files
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return <Code size={16} className={iconClass} />;
    case "ini":
    case "cfg":
    case "conf":
      return <FileIniIcon size={16} className={iconClass} />;
    // Archives
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
    case "bz2":
      return <FileArchiveIcon size={16} className={iconClass} />;
    // Text files
    case "txt":
    case "log":
      return <FileTextIcon size={16} className={iconClass} />;
    // Other code files (fallback)
    case "rb":
    case "go":
    case "java":
    case "swift":
    case "kt":
    case "dart":
    case "lua":
    case "php":
    case "zig":
    case "r":
    case "pl":
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return <FileCode size={16} className={iconClass} />;
    default:
      return null;
  }
}

// =============================================================================
// RenderTreeNodes - Recursive renderer
// =============================================================================

interface RenderTreeNodesProps {
  nodes: FileTreeNode[];
}

export function RenderTreeNodes({ nodes }: RenderTreeNodesProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "directory") {
          return (
            <FileTreeFolder key={node.path} path={node.path} name={node.name}>
              {node.children && <RenderTreeNodes nodes={node.children} />}
            </FileTreeFolder>
          );
        }
        return (
          <FileTreeFile
            key={node.path}
            path={node.path}
            name={node.name}
            icon={getFileIcon(node.extension)}
          />
        );
      })}
    </>
  );
}
