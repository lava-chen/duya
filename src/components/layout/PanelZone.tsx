"use client";

import { useCallback, useState } from "react";
import { usePanel } from "@/hooks/usePanel";
import { PanelHeader } from "./PanelHeader";
import { PAGE_REGISTRY, getPageDescriptor, type PageDescriptor, type PageId } from "./panels/registry";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarRightIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import { useTaskCount } from "@/hooks/useTaskCount";
import {
  setTaskDrawerOpen,
  useTaskDrawerOpen,
} from "./task-drawer-store";
import { CheckSquareIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";

const MIN_CHAT_WIDTH = 520;

const EMPTY_LAUNCHER_ORDER: PageId[] = ["research", "terminal", "browser", "files", "conductor"];

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

export function PanelZone() {
  const {
    panelOpen,
    panelWidth,
    setPanelWidth,
    togglePanel,
    openOrActivatePage,
    tabs,
    activeTabId,
  } = usePanel();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const threads = useConversationStore((s) => s.threads);
  const [resizing, setResizing] = useState(false);
  const taskDrawerOpen = useTaskDrawerOpen();
  const { pending, active } = useTaskCount();
  const taskBadgeCount = pending + active;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const cwd = activeThread?.workingDirectory ?? undefined;
  const zoneStyle = {
    "--panel-zone-width": `${panelWidth}px`,
    "--panel-content-width": `${panelWidth}px`,
  } as CSSProperties;

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

  const handleResize = useCallback(
    (delta: number) => {
      const nextWidth = panelWidth - delta;
      const main = document.querySelector(".app-main-wrapper");
      const mainWidth = main?.getBoundingClientRect().width ?? MIN_CHAT_WIDTH;
      const availableWidth = mainWidth + panelWidth;
      const maxWidthForChat = Math.max(220, availableWidth - MIN_CHAT_WIDTH);
      setPanelWidth(Math.min(nextWidth, maxWidthForChat));
    },
    [panelWidth, setPanelWidth]
  );

  return (
    <div
      className={`panel-zone ${panelOpen ? "panel-zone-open" : "panel-zone-closed"}${resizing ? " panel-zone-resizing" : ""}`}
      style={zoneStyle}
    >
      <button
        type="button"
        className={`panel-edge-toggle${panelOpen ? " active" : ""}`}
        onClick={togglePanel}
        title={panelOpen ? "收起侧栏" : "打开侧栏"}
        aria-label={panelOpen ? "收起侧栏" : "打开侧栏"}
        aria-expanded={panelOpen}
      >
        <SidebarRightIcon size={16} stroke={1.75} />
      </button>

      <button
        type="button"
        className={`panel-edge-toggle panel-task-toggle${taskDrawerOpen ? " active" : ""}`}
        onClick={() => setTaskDrawerOpen(!taskDrawerOpen)}
        title="任务列表"
        aria-label="任务列表"
        aria-pressed={taskDrawerOpen}
      >
        <CheckSquareIcon size={16} weight="regular" />
        {taskBadgeCount > 0 && (
          <span className="panel-task-toggle-badge">
            {taskBadgeCount > 99 ? "99+" : taskBadgeCount}
          </span>
        )}
      </button>

      {panelOpen && (
        <ResizeHandle
          side="left"
          onResizeStart={() => setResizing(true)}
          onResize={handleResize}
          onResizeEnd={() => setResizing(false)}
        />
      )}

      <div
        className="sidebar-panel-inner"
        style={{ width: panelWidth }}
        aria-hidden={!panelOpen}
      >
        {tabs.length > 0 && <PanelHeader />}
        <div className="sidebar-panel-content">
          {activeTab ? (
            (() => {
              const desc = getPageDescriptor(activeTab.pageId);
              const Component = desc.component;
              return <Component tab={activeTab} embedded />;
            })()
          ) : (
            <EmptyPanelLauncher onSelect={openPage} />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyPanelLauncher({ onSelect }: { onSelect: (pageId: PageId) => void }) {
  const entries = EMPTY_LAUNCHER_ORDER.map((id) => PAGE_REGISTRY[id]);

  return (
    <div className="panel-empty-launcher">
      <div className="panel-empty-launcher-list">
        {entries.map((entry) => (
          <EmptyPanelLauncherRow
            key={entry.id}
            entry={entry}
            shortcut={shortcutFor(entry.id)}
            onSelect={() => onSelect(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyPanelLauncherRow({
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
      className={`panel-empty-launcher-row${entry.available ? "" : " disabled"}`}
      disabled={!entry.available}
      onClick={() => {
        if (!entry.available) return;
        onSelect();
      }}
      title={entry.available ? entry.label : `${entry.label}（未实现）`}
    >
      <span className="panel-empty-launcher-main">
        <span className="panel-empty-launcher-icon">
          <Icon size={16} weight="regular" />
        </span>
        <span className="panel-empty-launcher-name">{entry.label}</span>
      </span>
      <span className="panel-empty-launcher-meta">
        {shortcut && <span className="panel-empty-launcher-shortcut">{shortcut}</span>}
        {!entry.available && <span className="panel-empty-launcher-hint">未实现</span>}
      </span>
    </button>
  );
}
