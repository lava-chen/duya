/**
 * TreeSidebar.tsx — lazily loaded, windowed file tree.
 *
 * The old panel called `files.browse(root, root, 4)` once and rendered every
 * node. Here each directory is fetched with depth=1 the first time it is
 * expanded, and only the rows inside the viewport exist in the DOM, so a
 * 30k-node repository stays at ~50 row elements regardless of expansion.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretRightIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
} from "@/components/icons";
import { useVirtualRows } from "./fw-hooks";

export interface FsNode {
  name: string;
  path: string;
  type: "directory" | "file";
  extension?: string;
  children?: FsNode[];
  loaded?: boolean;
  loading?: boolean;
  open?: boolean;
}

const ROW_HEIGHT = 22;

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "yml", "yaml",
  "toml", "css", "scss", "less", "py", "rs", "go", "java", "c", "cpp", "h",
  "sh", "bash", "sql", "xml", "lock", "ini", "conf", "env",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);

export function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${sep}${name}`;
}

function normalize(list: FsNode[], parent: string): FsNode[] {
  return list.map((item) => ({
    name: item.name,
    path: joinPath(parent, item.name),
    type: item.type,
    extension: item.extension,
    children: item.children ? normalize(item.children, joinPath(parent, item.name)) : undefined,
    loaded: false,
    loading: false,
    open: false,
  }));
}

function mapNode(list: FsNode[], path: string, fn: (node: FsNode) => FsNode): FsNode[] {
  return list.map((node) => {
    if (node.path === path) return fn(node);
    if (node.children) return { ...node, children: mapNode(node.children, path, fn) };
    return node;
  });
}

function FileTypeIcon({ node }: { node: FsNode }) {
  const ext = node.extension ?? "";
  if (ext === "html" || ext === "htm") return <GlobeIcon size={14} />;
  if (IMAGE_EXTENSIONS.has(ext)) return <FileImageIcon size={14} />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCodeIcon size={14} />;
  if (ext === "md" || ext === "mdx" || ext === "txt") return <FileTextIcon size={14} />;
  return <FileIcon size={14} />;
}

interface FlatRow {
  node: FsNode;
  depth: number;
}

function flatten(list: FsNode[], depth: number, out: FlatRow[]): void {
  for (const node of list) {
    out.push({ node, depth });
    if (node.type === "directory" && node.open && node.children) {
      flatten(node.children, depth + 1, out);
    }
  }
}

function flattenFiltered(list: FsNode[], depth: number, query: string, out: FlatRow[]): void {
  for (const node of list) {
    const selfHit = node.name.toLowerCase().includes(query);
    if (node.type === "directory" && node.children) {
      const nested: FlatRow[] = [];
      flattenFiltered(node.children, depth + 1, query, nested);
      if (selfHit || nested.length > 0) {
        out.push({ node, depth });
        out.push(...nested);
      }
    } else if (selfHit) {
      out.push({ node, depth });
    }
  }
}

export interface TreeSidebarProps {
  root: string;
  query: string;
  selectedPath?: string;
  reloadToken?: number;
  onOpenFile: (node: FsNode) => void;
  onContextMenu: (x: number, y: number, node: FsNode) => void;
}

export function TreeSidebar({
  root,
  query,
  selectedPath,
  reloadToken = 0,
  onOpenFile,
  onContextMenu,
}: TreeSidebarProps) {
  const [tree, setTree] = useState<FsNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    (async () => {
      const api = window.electronAPI?.files;
      if (!api?.browse) {
        if (alive) setError("File browser unavailable");
        return;
      }
      try {
        const result = await api.browse(root, root, 1);
        if (!alive) return;
        if (result.success) {
          setTree(normalize(result.tree as FsNode[], root));
        } else {
          setTree([]);
          setError(result.error ?? "Failed to load files");
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [root, reloadToken]);

  const toggle = useCallback(
    async (node: FsNode) => {
      if (node.type !== "directory") return;
      if (node.open) {
        setTree((prev) => mapNode(prev, node.path, (n) => ({ ...n, open: false })));
        return;
      }
      if (node.loaded) {
        setTree((prev) => mapNode(prev, node.path, (n) => ({ ...n, open: true })));
        return;
      }
      setTree((prev) => mapNode(prev, node.path, (n) => ({ ...n, open: true, loading: true })));
      try {
        const result = await window.electronAPI?.files?.browse(node.path, root, 1);
        const children = result?.success ? normalize(result.tree as FsNode[], node.path) : [];
        setTree((prev) =>
          mapNode(prev, node.path, (n) => ({
            ...n,
            loading: false,
            loaded: true,
            children,
          })),
        );
      } catch {
        setTree((prev) =>
          mapNode(prev, node.path, (n) => ({ ...n, loading: false, loaded: true, children: [] })),
        );
      }
    },
    [root],
  );

  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    const q = query.trim().toLowerCase();
    if (q) flattenFiltered(tree, 0, q, out);
    else flatten(tree, 0, out);
    return out;
  }, [tree, query]);

  const range = useVirtualRows(scrollRef, rows.length, ROW_HEIGHT);

  const visible = [];
  for (let k = range.start; k < range.end; k++) {
    const row = rows[k];
    if (!row) continue;
    const { node, depth } = row;
    const isDir = node.type === "directory";
    visible.push(
      <div
        key={node.path}
        className={`fw-tree-row${selectedPath === node.path ? " is-selected" : ""}`}
        style={{ transform: `translateY(${k * ROW_HEIGHT}px)`, paddingLeft: 6 + depth * 13 }}
        onClick={() => (isDir ? void toggle(node) : onOpenFile(node))}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY, node);
        }}
      >
        <span className={`fw-tree-ic${isDir ? " is-dir" : ""}${node.open ? " is-open" : ""}`}>
          {node.loading ? (
            <span className="fw-spin" />
          ) : isDir ? (
            <CaretRightIcon size={13} />
          ) : (
            <FileTypeIcon node={node} />
          )}
        </span>
        <span className="fw-tree-name">{node.name}</span>
      </div>,
    );
  }

  return (
    <div className="fw-tree-scroll" ref={scrollRef}>
      <div className="fw-tree-phantom" style={{ height: rows.length * ROW_HEIGHT }}>
        {visible}
      </div>
      {rows.length === 0 ? (
        <p className="fw-tree-empty">{error ?? (query ? "没有匹配的文件" : "这个文件夹是空的")}</p>
      ) : null}
    </div>
  );
}
