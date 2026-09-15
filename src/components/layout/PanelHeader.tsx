// src/components/layout/PanelHeader.tsx
"use client";

import { useCallback, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { PlusIcon, XIcon } from "@/components/icons";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useTranslation } from "@/hooks/useTranslation";
import { usePanel } from "@/hooks/usePanel";
import { getPageDescriptor, PAGE_REGISTRY, type PageId, type PageTab } from "./panels/registry";
import { fileExtensionFromName, getFileTypeIcon } from "@/components/file-tree/file-type-icon";
import { useConversationStore } from "@/stores/conversation-store";

interface DragState {
  fromId: string;
  overId: string | null;
  position: "before" | "after";
}

/**
 * Header bar inside the side panel. Renders one of three shapes:
 *
 * - `empty` (no tabs): a sidebar label + `+` control.
 * - `content` view: the full tab strip with drag-to-reorder, plus
 *   the `+` add button. The sidebar toggle
 *   lives in `PanelZone` so it can stay visually stable during animation.
 */
export function PanelHeader() {
  const { t } = useTranslation();
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

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const cwd = activeThread?.workingDirectory ?? undefined;

  const paramsFor = useCallback(
    (pageId: PageId): Record<string, unknown> | undefined => {
      if (!cwd) return undefined;
      if (pageId === "terminal") return { cwd };
      if (pageId === "files") return { workingDirectory: cwd };
      return undefined;
    },
    [cwd]
  );

  const openPage = useCallback(
    (pageId: PageId) => {
      openOrActivatePage(pageId, paramsFor(pageId));
    },
    [openOrActivatePage, paramsFor]
  );

  const entries = Object.values(PAGE_REGISTRY).filter((entry) => entry.id !== "preview");

  const menuItems: MenuAction[] = entries.map((entry) => ({
    kind: "action",
    id: entry.id,
    label: t(entry.labelKey),
    shortcut: shortcutFor(entry.id) ?? undefined,
    disabled: !entry.available,
    description: !entry.available ? t("panel.unavailable") : undefined,
    iconLeft: <entry.icon size={15} stroke={1.5} />,
    onSelect: () => openPage(entry.id),
  }));

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
        <span className="panel-header-empty-text">{t('panel.sidebar')}</span>
        <div className="panel-header-actions">
          <DropdownMenu
            trigger={
              <AddPageButton />
            }
            items={menuItems}
            className="panel-add-menu"
          />
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
                <TabFileTypeIcon tab={tab} fallback={<Icon size={14} stroke={1.5} />} />
              )}
              <span className="panel-header-tab-title">{tab.title}</span>
              <CloseTabButton tabId={tab.id} onClose={() => closePanel(tab.id)} />
            </button>
          );
        })}
      </div>
      <DropdownMenu
          trigger={
            <AddPageButton />
          }
          items={menuItems}
          className="panel-add-menu"
        />
      </div>
    );
  }

function shortcutFor(id: PageId): string | null {
  switch (id) {
    case "terminal": return "Ctrl+`";
    case "browser": return "Ctrl+T";
    case "files": return "Ctrl+P";
    case "conductor": return "Ctrl+Alt+S";
    default: return null;
  }
}

function AddPageButton() {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="panel-header-icon-btn panel-header-add-page"
      title={t('panel.addPage')}
      aria-label={t('panel.addPage')}
    >
      <PlusIcon size={14} stroke={1.5} />
    </button>
  );
}

function CloseTabButton({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <span
      role="button"
      aria-label={t('panel.closeTab')}
      className="panel-header-tab-close"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <XIcon size={11} stroke={2} />
    </span>
  );
}

/**
 * Per-extension icon for file-backed tabs (preview / office), resolved
 * through the same mapping the project file tree uses — a markdown tab
 * shows the md mark, a TS tab the ts mark. Falls back to the page
 * descriptor's static icon when the tab has no file path or the
 * extension is unknown.
 */
function TabFileTypeIcon({ tab, fallback }: { tab: PageTab; fallback: ReactNode }) {
  const filePath = typeof tab.params?.filePath === "string" ? tab.params.filePath : "";
  if (filePath) {
    const fileName = filePath.split(/[/\\]/).pop() ?? "";
    const Icon = getFileTypeIcon(fileExtensionFromName(fileName));
    if (Icon) return <Icon size={14} stroke={1.5} />;
  }
  return <>{fallback}</>;
}
