"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useConductorStore } from "../stores/conductor-store";
import { createCanvas, getSnapshot } from "../ipc/conductor-ipc";
import { CanvasThumbnail } from "./CanvasThumbnail";
import { InputDialog } from "@/components/ui/InputDialog";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { PageTabs } from "@/components/ui/page";
import { cn } from "@/lib/utils";
import {
  StarIcon,
  PlusIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GridFourIcon,
  TableIcon,
  CheckIcon,
} from "@/components/icons";

type CanvasView = "gallery" | "table";
type SortField = "name" | "createdAt" | "updatedAt" | "manual";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString();
}

function StarButton({
  filled,
  onClick,
}: {
  filled: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <IconButton
      size="sm"
      variant={filled ? "default" : "ghost"}
      aria-label={filled ? "取消收藏" : "收藏"}
      onClick={onClick}
      className={cn(filled && "text-[var(--warning,#e0a800)]")}
    >
      <StarIcon size={15} className={cn(filled && "fill-current")} />
    </IconButton>
  );
}

function SelectCheckbox({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "w-4 h-4 rounded flex items-center justify-center transition-colors",
        checked
          ? "bg-accent border border-accent text-white"
          : "border border-border/70 bg-[var(--surface)]/70 backdrop-blur-sm hover:border-accent/60",
      )}
    >
      {checked && <CheckIcon size={11} />}
    </button>
  );
}

export function CanvasLibraryView({
  onOpenCanvas,
}: {
  onOpenCanvas: (canvasId: string) => void;
}) {
  const {
    canvases,
    canvasGroups,
    canvasView,
    setCanvasView,
    canvasSort,
    setCanvasSort,
    canvasFilter,
    setCanvasFilter,
    toggleFavorite,
    setCanvasGroup,
    createGroup,
    renameGroup,
    deleteGroup,
    addCanvas,
    activeCanvasId,
    snapshot: activeSnapshot,
  } = useConductorStore();

  const [newCanvasOpen, setNewCanvasOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  // Multi-select across cards/rows. Powers the bulk action bar and the
  // checkbox overlay on each card. Persists across filters and view
  // switches so a user can build up a selection, then act.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelected = () => setSelected(new Set());
  // Snapshot cache keyed by canvasId. The active canvas's snapshot is
  // seeded synchronously so its thumbnail paints immediately; other
  // visible canvases are fetched on demand below.
  const [thumbs, setThumbs] = useState<Record<string, unknown>>({});

  const sortMenuRef = useRef<HTMLDivElement>(null);

  // Seed the active canvas's snapshot into the thumbnail cache.
  useEffect(() => {
    if (activeSnapshot && activeCanvasId) {
      setThumbs((prev) =>
        prev[activeCanvasId] ? prev : { ...prev, [activeCanvasId]: activeSnapshot },
      );
    }
  }, [activeCanvasId, activeSnapshot]);

  // Close transient menus on outside click.
  useEffect(() => {
    const close = () => {
      setSortMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of canvases) for (const t of c.tags ?? []) set.add(t);
    return Array.from(set);
  }, [canvases]);

  const visible = useMemo(() => {
    const q = canvasFilter.search.trim().toLowerCase();
    let list = canvases.filter((c) => {
      if (canvasFilter.favoritesOnly && !c.isFavorite) return false;
      if (canvasFilter.groupId && c.groupId !== canvasFilter.groupId) return false;
      if (canvasFilter.tag && !(c.tags ?? []).includes(canvasFilter.tag)) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = canvasSort.dir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      switch (canvasSort.field) {
        case "name":
          return dir * a.name.localeCompare(b.name);
        case "createdAt":
          return dir * (a.createdAt - b.createdAt);
        case "manual":
          return dir * (a.sortOrder - b.sortOrder);
        case "updatedAt":
        default:
          return dir * (a.updatedAt - b.updatedAt);
      }
    });
    return list;
  }, [canvases, canvasFilter, canvasSort]);

  // Lazy-load snapshots for the canvases currently visible in the
  // library. Concurrency is bounded to keep the IPC channel responsive
  // when the user has dozens of canvases; previously cached entries are
  // preserved so toggling filters does not refetch.
  const visibleIdsKey = visible.map((c) => c.id).join("|");
  useEffect(() => {
    const ids = visible.map((c) => c.id);
    const missing = ids.filter((id) => !(id in thumbs));
    if (missing.length === 0) return;
    let cancelled = false;
    const CONCURRENCY = 6;
    const queue = [...missing];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        try {
          const snap = await getSnapshot(id);
          if (!cancelled && snap) {
            setThumbs((prev) => ({ ...prev, [id]: snap }));
          }
        } catch {
          /* ignore — leave the thumbnail empty */
        }
      }
    });
    return () => {
      cancelled = true;
      void workers;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey]);

  const handleCreateCanvas = async (name: string) => {
    if (!name.trim()) return;
    try {
      const canvas = await createCanvas(name.trim(), undefined, null);
      addCanvas(canvas);
      setNewCanvasOpen(false);
      onOpenCanvas(canvas.id);
    } catch {
      /* IPC error */
    }
  };

  const handleCreateGroup = async (name: string) => {
    if (!name.trim()) return;
    const g = await createGroup(name.trim());
    setNewGroupOpen(false);
    if (g) setCanvasFilter({ groupId: g.id });
  };

  const handleRenameGroup = async (name: string) => {
    if (renameGroupId && name.trim()) await renameGroup(renameGroupId, name.trim());
    setRenameGroupId(null);
  };

  const handleDeleteGroup = async (groupId: string) => {
    await deleteGroup(groupId);
  };

  // Bulk-action derivations. "allFav" drives whether the bulk button
  // says 收藏 or 取消收藏: it only switches to "取消收藏" when every
  // selected canvas is already favorited.
  const selectedCanvases = useMemo(
    () => canvases.filter((c) => selected.has(c.id)),
    [canvases, selected],
  );
  const allFav = selectedCanvases.length > 0 && selectedCanvases.every((c) => c.isFavorite);
  const handleBulkFavorite = () => {
    for (const c of selectedCanvases) {
      if (allFav && c.isFavorite) toggleFavorite(c.id);
      else if (!allFav && !c.isFavorite) toggleFavorite(c.id);
    }
  };

  // Current active filter ID: "all" | "favorites" | groupId
  const activeFilterId =
    canvasFilter.favoritesOnly
      ? "favorites"
      : canvasFilter.groupId ?? "all";

  const handleFilterChange = (id: string) => {
    if (id === "all") setCanvasFilter({ groupId: null, favoritesOnly: false });
    else if (id === "favorites") setCanvasFilter({ favoritesOnly: true, groupId: null });
    else setCanvasFilter({ groupId: id, favoritesOnly: false });
  };

  const SORT_OPTIONS: Array<{ field: SortField; label: string }> = [
    { field: "updatedAt", label: "最近更新" },
    { field: "createdAt", label: "创建时间" },
    { field: "name", label: "名称" },
    { field: "manual", label: "手动" },
  ];

  // Tabs: 全部画布 | ★ 收藏 | [each group] | +新建分组
  const tabs = [
    { id: "all", label: "全部画布", count: canvases.length },
    { id: "favorites", label: "★ 收藏", count: canvases.filter((c) => c.isFavorite).length },
    ...canvasGroups.map((g) => ({
      id: g.id,
      label: g.name,
      count: canvases.filter((c) => c.groupId === g.id).length,
    })),
  ];

  return (
    <div className="flex flex-1 min-h-0" style={{ color: "var(--text)" }}>
      {/* Main: tab bar + toolbar + content */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Tab bar — horizontal PageTabs, same as Automation/Extensions */}
        <div className="flex items-center border-b border-border px-3">
          <PageTabs
            tabs={tabs}
            active={activeFilterId}
            onChange={handleFilterChange}
          />
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="新建分组"
            onClick={() => setNewGroupOpen(true)}
            className="ml-auto shrink-0"
          >
            <PlusIcon size={14} />
          </IconButton>
        </div>

        {/* Toolbar row */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <div className="flex-1 min-w-0">
            <Input
              type="search"
              size="sm"
              value={canvasFilter.search}
              onChange={(e) => setCanvasFilter({ search: e.target.value })}
              placeholder="搜索画布…"
              aria-label="搜索画布"
            />
          </div>

          {/* Sort */}
          <div
            className="relative shrink-0"
            ref={sortMenuRef}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSortMenuOpen(!sortMenuOpen)}
              aria-label="排序方式"
              className="h-7 px-2"
            >
              {SORT_OPTIONS.find((o) => o.field === canvasSort.field)?.label}
              <ChevronDownIcon size={13} className="text-muted-foreground" />
            </Button>
            {sortMenuOpen && (
              <div
                className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-border bg-[var(--surface)] shadow-lg py-1 w-32"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.field}
                    type="button"
                    onClick={() => {
                      setCanvasSort({ field: o.field, dir: canvasSort.dir });
                      setSortMenuOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-md",
                      canvasSort.field === o.field
                        ? "text-accent bg-[var(--surface-hover)]"
                        : "text-foreground hover:bg-[var(--surface-hover)]",
                    )}
                  >
                    {o.label}
                    {canvasSort.field === o.field && (
                      <ChevronDownIcon size={12} className="rotate-180" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <IconButton
            size="sm"
            variant="default"
            aria-label={canvasSort.dir === "asc" ? "当前升序，点击切换降序" : "当前降序，点击切换升序"}
            onClick={() => setCanvasSort({ field: canvasSort.field, dir: canvasSort.dir === "asc" ? "desc" : "asc" })}
            className="h-7 w-7 shrink-0 border border-border"
          >
            {canvasSort.dir === "asc" ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
          </IconButton>

          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-border overflow-hidden shrink-0">
            <IconButton
              size="sm"
              variant={canvasView === "gallery" ? "default" : "ghost"}
              aria-label="画廊视图"
              title="画廊视图"
              onClick={() => setCanvasView("gallery")}
              className={cn("rounded-none h-7 w-7", canvasView === "gallery" && "text-accent")}
            >
              <GridFourIcon size={15} />
            </IconButton>
            <IconButton
              size="sm"
              variant={canvasView === "table" ? "default" : "ghost"}
              aria-label="表格视图"
              title="表格视图"
              onClick={() => setCanvasView("table")}
              className={cn("rounded-none h-7 w-7 border-l border-border", canvasView === "table" && "text-accent")}
            >
              <TableIcon size={15} />
            </IconButton>
          </div>

          <Button size="sm" onClick={() => setNewCanvasOpen(true)} className="h-7 shrink-0">
            <PlusIcon size={14} /> 新建
          </Button>
        </div>

        {/* Bulk action bar — visible whenever 1+ cards/rows are selected */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-[var(--surface)] text-sm">
            <span className="text-foreground">已选 {selected.size} 项</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleBulkFavorite}
              disabled={selectedCanvases.length === 0}
            >
              <StarIcon
                size={14}
                className={cn(allFav && "fill-current text-[var(--warning,#e0a800)]")}
              />
              {allFav ? "取消收藏" : "收藏"}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelected}>
              清空选择
            </Button>
          </div>
        )}

        {/* Tag filter chips */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-border">
            <span className="text-xs text-muted-foreground mr-0.5">标签</span>
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCanvasFilter({ tag: canvasFilter.tag === t ? null : t })}
                className={cn(
                  "px-2 py-0.5 rounded-full text-xs transition-colors",
                  canvasFilter.tag === t
                    ? "bg-accent text-white"
                    : "bg-chip text-muted-foreground hover:bg-[var(--surface-hover)]",
                )}
              >
                #{t}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {visible.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <p>{canvases.length === 0 ? "还没有画布" : "没有符合条件的画布"}</p>
              <Button size="sm" variant="secondary" onClick={() => setNewCanvasOpen(true)}>
                <PlusIcon size={14} /> 新建画布
              </Button>
            </div>
          ) : canvasView === "gallery" ? (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
              {visible.map((c) => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  className="relative rounded-lg border border-border bg-[var(--surface)] overflow-hidden cursor-pointer transition-colors hover:border-accent/50"
                  onClick={() => onOpenCanvas(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpenCanvas(c.id);
                  }}
                >
                  <div className="absolute top-1.5 right-1.5 z-10">
                    <SelectCheckbox
                      checked={selected.has(c.id)}
                      onChange={() => toggleSelected(c.id)}
                      ariaLabel={`选择 ${c.name}`}
                    />
                  </div>
                  <CanvasThumbnail snapshot={thumbs[c.id]} />
                  <div className="p-2.5">
                    <span className="text-sm font-medium text-foreground truncate block" title={c.name}>
                      {c.name}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-muted-foreground">
                  <th className="font-normal py-1.5 px-2 w-8"></th>
                  <th className="font-normal py-1.5 px-2">名称</th>
                  <th className="font-normal py-1.5 px-2">分组</th>
                  <th className="font-normal py-1.5 px-2">标签</th>
                  <th className="font-normal py-1.5 px-2">更新</th>
                  <th className="font-normal py-1.5 px-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer border-t border-border hover:bg-[var(--surface-hover)]"
                    onClick={() => onOpenCanvas(c.id)}
                  >
                    <td className="py-1.5 px-2" onClick={(e) => e.stopPropagation()}>
                      <SelectCheckbox
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                        ariaLabel={`选择 ${c.name}`}
                      />
                    </td>
                    <td className="py-1.5 px-2 truncate max-w-[140px] text-foreground">{c.name}</td>
                    <td className="py-1.5 px-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={c.groupId ?? ""}
                        onChange={(e) => setCanvasGroup(c.id, e.target.value === "" ? null : e.target.value)}
                        className="text-xs bg-transparent outline-none rounded-md px-1 py-0.5 text-muted-foreground border border-border/60"
                        aria-label={`${c.name} 分组`}
                      >
                        <option value="">未分组</option>
                        {canvasGroups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 px-2 truncate max-w-[140px] text-muted-foreground">
                      {(c.tags ?? []).slice(0, 2).map((t) => `#${t}`).join(" ")}
                    </td>
                    <td className="py-1.5 px-2 text-muted-foreground whitespace-nowrap">{timeAgo(c.updatedAt)}</td>
                    <td className="py-1.5 px-2 text-right">
                      <StarButton
                        filled={c.isFavorite}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(c.id);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <InputDialog
        isOpen={newCanvasOpen}
        title="新建画布"
        placeholder="输入画布名称"
        onConfirm={handleCreateCanvas}
        onCancel={() => setNewCanvasOpen(false)}
      />
      <InputDialog
        isOpen={newGroupOpen}
        title="新建分组"
        placeholder="输入分组名称"
        onConfirm={handleCreateGroup}
        onCancel={() => setNewGroupOpen(false)}
      />
      <InputDialog
        isOpen={renameGroupId !== null}
        title="重命名分组"
        placeholder="输入新名称"
        defaultValue={canvasGroups.find((g) => g.id === renameGroupId)?.name ?? ""}
        onConfirm={handleRenameGroup}
        onCancel={() => setRenameGroupId(null)}
      />
    </div>
  );
}
