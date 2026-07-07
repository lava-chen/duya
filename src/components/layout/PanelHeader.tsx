// src/components/layout/PanelHeader.tsx
"use client";

import { forwardRef, useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { usePanel } from "@/hooks/usePanel";
import { getPageDescriptor, PAGE_REGISTRY, type PageDescriptor, type PageId } from "./panels/registry";
import { useConversationStore } from "@/stores/conversation-store";

interface DragState {
  fromId: string;
  overId: string | null;
  position: "before" | "after";
}

/**
 * Header bar inside the side panel. Renders one of three shapes:
 *
 * - `empty` (no tabs): a "侧栏" label + `+` control.
 * - `content` view: the full tab strip with drag-to-reorder, plus
 *   the `+` add button. The sidebar toggle
 *   lives in `PanelZone` so it can stay visually stable during animation.
 */
export function PanelHeader() {
  const {
    tabs,
    activeTabId,
    activateTab,
    closePanel,
    openOrActivatePage,
    reorderTabs,
  } = usePanel();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const threads = useConversationStore((s) => s.threads);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const cwd = activeThread?.workingDirectory ?? undefined;

  const paramsFor = useCallback(
    (pageId: PageId): Record<string, unknown> | undefined => {
      if (!cwd) return undefined;
      if (pageId === "terminal") return { cwd };
      if (pageId === "files") return { workingDirectory: cwd };
      if (pageId === "office") return { workingDirectory: cwd };
      return undefined;
    },
    [cwd]
  );

  const openPage = useCallback(
    (pageId: PageId) => {
      openOrActivatePage(pageId, paramsFor(pageId));
      setAddMenuOpen(false);
    },
    [openOrActivatePage, paramsFor]
  );

  useEffect(() => {
    if (!addMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (addButtonRef.current?.contains(target) || addMenuRef.current?.contains(target)) {
        return;
      }
      setAddMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen]);

  const onTabDragStart = useCallback(
    (e: ReactDragEvent<HTMLButtonElement>, tabId: string) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tabId);
      setDrag({ fromId: tabId, overId: null, position: "before" });
    },
    []
  );

  const onTabDragOver = useCallback(
    (e: ReactDragEvent<HTMLButtonElement>, tabId: string) => {
      if (!drag || drag.fromId === tabId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const position: "before" | "after" = x < rect.width / 2 ? "before" : "after";
      if (drag.overId !== tabId || drag.position !== position) {
        setDrag({ fromId: drag.fromId, overId: tabId, position });
      }
    },
    [drag]
  );

  const finishDrag = useCallback(() => {
    if (drag && drag.overId && drag.fromId !== drag.overId) {
      reorderTabs(drag.fromId, drag.overId, drag.position);
    }
    setDrag(null);
  }, [drag, reorderTabs]);

  if (tabs.length === 0) {
    return (
      <div className="panel-header panel-header-empty">
        <span className="panel-header-empty-text">侧栏</span>
        <div className="panel-header-actions">
          <div className="panel-header-add-wrap">
            <AddPageButton
              ref={addButtonRef}
              open={addMenuOpen}
              onClick={() => setAddMenuOpen((value) => !value)}
            />
            {addMenuOpen && <AddPageMenu ref={addMenuRef} onSelect={openPage} />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="panel-header"
      onDragOver={(e) => {
        if (drag) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        finishDrag();
      }}
    >
      <div className="panel-header-tabs">
        {tabs.map((tab) => {
          const desc = getPageDescriptor(tab.pageId);
          const Icon = desc.icon;
          const active = tab.id === activeTabId;
          const dropClass =
            drag && drag.overId === tab.id
              ? drag.position === "before"
                ? " drop-before"
                : " drop-after"
              : "";
          const isDragging = drag?.fromId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              draggable
              className={`panel-header-tab${active ? " active" : ""}${dropClass}${isDragging ? " dragging" : ""}`}
              onClick={() => activateTab(tab.id)}
              onDragStart={(e) => onTabDragStart(e, tab.id)}
              onDragOver={(e) => onTabDragOver(e, tab.id)}
              onDragEnd={finishDrag}
              title={tab.title}
              aria-pressed={active}
            >
              {tab.favicon ? (
                <img
                  src={tab.favicon}
                  alt=""
                  className="panel-header-tab-favicon"
                  onError={(event) => { event.currentTarget.style.display = "none"; }}
                />
              ) : (
                <Icon size={12} weight={active ? "fill" : "regular"} />
              )}
              <span className="panel-header-tab-title">{tab.title}</span>
              <span
                role="button"
                aria-label="关闭标签"
                className="panel-header-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closePanel(tab.id);
                }}
              >
                <XIcon size={10} weight="bold" />
              </span>
            </button>
          );
        })}
      </div>
      <div className="panel-header-add-wrap">
        <AddPageButton
          ref={addButtonRef}
          open={addMenuOpen}
          onClick={() => setAddMenuOpen((value) => !value)}
        />
        {addMenuOpen && <AddPageMenu ref={addMenuRef} onSelect={openPage} />}
      </div>
    </div>
  );
}

function shortcutFor(id: PageId): string | null {
  switch (id) {
    case "research": return "Ctrl+Shift+G";
    case "terminal": return "Ctrl+`";
    case "browser": return "Ctrl+T";
    case "files": return "Ctrl+P";
    case "conductor": return "Ctrl+Alt+S";
    default: return null;
  }
}

const AddPageButton = forwardRef<
  HTMLButtonElement,
  { open: boolean; onClick: () => void }
>(function AddPageButton({ open, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`panel-header-icon-btn panel-header-add-page${open ? " active" : ""}`}
      onClick={onClick}
      title="新增页面"
      aria-label="新增页面"
      aria-expanded={open}
      aria-haspopup="menu"
    >
      <PlusIcon size={16} weight="bold" />
    </button>
  );
});

const AddPageMenu = forwardRef<
  HTMLDivElement,
  { onSelect: (pageId: PageId) => void }
>(function AddPageMenu({ onSelect }, ref) {
  // `office` and `research` are passive surfaces — opened by the
  // agent / external events, not chosen from the menu. Hide them here
  // so the picker only surfaces pages the user can launch themselves.
  const entries = Object.values(PAGE_REGISTRY).filter(
    (entry) => entry.id !== "office" && entry.id !== "preview" && entry.id !== "research"
  );

  return (
    <div ref={ref} className="panel-add-menu" role="menu">
      {entries.map((entry) => (
        <AddPageMenuRow
          key={entry.id}
          entry={entry}
          shortcut={shortcutFor(entry.id)}
          onSelect={() => onSelect(entry.id)}
        />
      ))}
    </div>
  );
});

function AddPageMenuRow({
  entry,
  shortcut,
  onSelect,
}: {
  entry: PageDescriptor;
  shortcut: string | null;
  onSelect: () => void;
}) {
  const Icon = entry.icon;

  return (
    <button
      type="button"
      role="menuitem"
      className={`panel-add-menu-row${entry.available ? "" : " disabled"}`}
      disabled={!entry.available}
      onClick={() => {
        if (!entry.available) return;
        onSelect();
      }}
      title={entry.available ? entry.label : `${entry.label}（未实现）`}
    >
      <span className="panel-add-menu-main">
        <span className="panel-add-menu-icon">
          <Icon size={16} weight="regular" />
        </span>
        <span className="panel-add-menu-name">{entry.label}</span>
      </span>
      <span className="panel-add-menu-meta">
        {shortcut && <span className="panel-add-menu-shortcut">{shortcut}</span>}
        {!entry.available && <span className="panel-add-menu-hint">未实现</span>}
      </span>
    </button>
  );
}
