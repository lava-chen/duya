"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePanel } from "@/hooks/usePanel";
import { PanelHeader } from "./PanelHeader";
import { PAGE_REGISTRY, getPageDescriptor, type PageDescriptor, type PageId } from "./panels/registry";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarRightIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import {
  setTaskDrawerOpen,
  useTaskDrawerOpen,
} from "./task-drawer-store";
import { ArrowsInSimple, ArrowsOutSimple } from "@phosphor-icons/react";
import type { CSSProperties } from "react";

const MIN_CHAT_WIDTH = 520;

// `office` and `research` are passive surfaces — they are opened by
// events (`duya:open-office-panel`) or by `ResearchModePanel` once a
// research session is running, so they are intentionally absent from
// both this launcher and the add-page menu.
const EMPTY_LAUNCHER_ORDER: PageId[] = ["terminal", "browser", "files", "conductor"];

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
    setPanelOpen,
    setPanelWidth,
    togglePanel,
    openOrActivatePage,
    tabs,
    activeTabId,
    workspaceExpanded,
    setWorkspaceExpanded,
  } = usePanel();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const currentView = useConversationStore((s) => s.currentView);
  const threads = useConversationStore((s) => s.threads);
  const [resizing, setResizing] = useState(false);
  const resizeStartWidthRef = useRef(panelWidth);
  const taskDrawerOpen = useTaskDrawerOpen();
  const isSessionView = currentView === "chat" && !!activeThreadId;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeDescriptor = activeTab ? getPageDescriptor(activeTab.pageId) : null;
  const activePanelMinWidth = activeDescriptor?.minWidth ?? 340;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const cwd = activeThread?.workingDirectory ?? undefined;
  const zoneStyle = {
    "--panel-zone-width": `${panelWidth}px`,
    "--panel-content-width": `${panelWidth}px`,
  } as CSSProperties;

  useEffect(() => {
    if (isSessionView) return;
    if (taskDrawerOpen) setTaskDrawerOpen(false);
    if (panelOpen) setPanelOpen(false);
  }, [isSessionView, panelOpen, setPanelOpen, taskDrawerOpen]);

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
    },
    [openOrActivatePage, paramsFor]
  );

  const handleResize = useCallback(
    (delta: number) => {
      const nextWidth = resizeStartWidthRef.current - delta;
      const main = document.querySelector(".app-main-wrapper");
      const mainWidth = main?.getBoundingClientRect().width ?? MIN_CHAT_WIDTH;
      const availableWidth = mainWidth + resizeStartWidthRef.current;
      const maxWidthForChat = Math.max(activePanelMinWidth, availableWidth - MIN_CHAT_WIDTH);
      setPanelWidth(Math.max(activePanelMinWidth, Math.min(nextWidth, maxWidthForChat)));
    },
    [activePanelMinWidth, setPanelWidth]
  );

  useEffect(() => {
    if (panelOpen && panelWidth < activePanelMinWidth) {
      setPanelWidth(activePanelMinWidth);
    }
  }, [activePanelMinWidth, panelOpen, panelWidth, setPanelWidth]);

  return (
    <div
      className={`panel-zone ${panelOpen ? "panel-zone-open" : "panel-zone-closed"}${workspaceExpanded ? " panel-zone-expanded" : ""}${resizing ? " panel-zone-resizing" : ""}`}
      data-page-id={activeTab?.pageId ?? "none"}
      style={zoneStyle}
    >
      {isSessionView && (
        <>
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

          {panelOpen && activeTab && (
            <button
              type="button"
              className="panel-edge-toggle panel-expand-toggle"
              onClick={() => setWorkspaceExpanded(!workspaceExpanded)}
              title={workspaceExpanded ? "收起面板" : "展开面板"}
              aria-label={workspaceExpanded ? "收起面板" : "展开面板"}
              data-testid="workspace-expand"
            >
              {workspaceExpanded
                ? <ArrowsInSimple size={16} weight="regular" />
                : <ArrowsOutSimple size={16} weight="regular" />}
            </button>
          )}
        </>
      )}

      {panelOpen && !workspaceExpanded && (
        <ResizeHandle
          side="left"
          onResizeStart={() => {
            resizeStartWidthRef.current = panelWidth;
            setResizing(true);
          }}
          onResize={handleResize}
          onResizeEnd={() => setResizing(false)}
        />
      )}

      <div
        className="sidebar-panel-inner"
        style={{ width: workspaceExpanded ? "100%" : panelWidth }}
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
