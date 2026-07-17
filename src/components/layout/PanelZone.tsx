"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { MAX_PANEL_RATIO, MAX_PANEL_WIDTH, MIN_CHAT_WIDTH, MIN_PANEL_WIDTH, usePanel } from "@/hooks/usePanel";
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

// `office` is a passive surface — opened by events
// (`duya:open-office-panel`), so it is intentionally absent from both
// this launcher and the add-page menu.
const EMPTY_LAUNCHER_ORDER: PageId[] = ["terminal", "browser", "files", "conductor"];

function shortcutFor(id: PageId): string | null {
  switch (id) {
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
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const currentView = useConversationStore((s) => s.currentView);
  const threads = useConversationStore((s) => s.threads);
  const [resizing, setResizing] = useState(false);
  const resizeStartWidthRef = useRef(panelWidth);
  const taskDrawerOpen = useTaskDrawerOpen();
  const isSessionView = currentView === "chat" && !!activeThreadId;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const browserTabs = tabs.filter((tab) => tab.pageId === "browser");
  const activeDescriptor = activeTab ? getPageDescriptor(activeTab.pageId) : null;
  const activePanelMinWidth = activeDescriptor?.minWidth ?? 340;
  const activePanelMaxWidth = activeDescriptor?.maxWidth === null
    ? Number.POSITIVE_INFINITY
    : activeDescriptor?.maxWidth ?? MAX_PANEL_WIDTH;
  const activePanelMaxRatio = activeDescriptor?.maxWidthRatio ?? MAX_PANEL_RATIO;
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
      const workspace = document.querySelector(".app-workspace-row");
      const workspaceWidth = workspace?.getBoundingClientRect().width ?? window.innerWidth;
      const maxByRatio = workspaceWidth * activePanelMaxRatio;
      const maxWithChat = workspaceWidth - MIN_CHAT_WIDTH;
      const upperBound = Math.min(activePanelMaxWidth, maxByRatio, maxWithChat);
      const lowerBound = Math.max(MIN_PANEL_WIDTH, activePanelMinWidth);
      setPanelWidth(Math.max(lowerBound, Math.min(nextWidth, upperBound)));
    },
    [activePanelMaxRatio, activePanelMaxWidth, activePanelMinWidth, setPanelWidth]
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
            title={panelOpen ? t('panel.closePanel') : t('panel.openPanel')}
            aria-label={panelOpen ? t('panel.closePanel') : t('panel.openPanel')}
            aria-expanded={panelOpen}
          >
            <SidebarRightIcon size={16} stroke={1.75} />
          </button>

          {panelOpen && activeTab && (
            <button
              type="button"
              className="panel-edge-toggle panel-expand-toggle"
              onClick={() => setWorkspaceExpanded(!workspaceExpanded)}
              title={workspaceExpanded ? t('panel.collapsePanel') : t('panel.expandPanel')}
              aria-label={workspaceExpanded ? t('panel.collapsePanel') : t('panel.expandPanel')}
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
          {browserTabs.map((browserTab) => {
            const BrowserComponent = getPageDescriptor(browserTab.pageId).component;
            const isActive = browserTab.id === activeTabId;
            return (
              <div
                key={browserTab.id}
                className={`sidebar-panel-browser-tab${isActive ? " active" : ""}`}
                aria-hidden={!isActive}
              >
                <BrowserComponent tab={browserTab} embedded />
              </div>
            );
          })}
          {activeTab && activeTab.pageId !== "browser" ? (
            (() => {
              const desc = getPageDescriptor(activeTab.pageId);
              const Component = desc.component;
              return <Component tab={activeTab} embedded />;
            })()
          ) : !activeTab ? (
            <EmptyPanelLauncher onSelect={openPage} />
          ) : null}
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
  const { t } = useTranslation();
  const Icon = entry.icon;
  const label = t(entry.labelKey);

  return (
    <button
      type="button"
      className={`panel-empty-launcher-row${entry.available ? "" : " disabled"}`}
      disabled={!entry.available}
      onClick={() => {
        if (!entry.available) return;
        onSelect();
      }}
      title={entry.available ? label : `${label} (${t('panel.unavailable')})`}
    >
      <span className="panel-empty-launcher-main">
        <span className="panel-empty-launcher-icon">
          <Icon size={16} weight="regular" />
        </span>
        <span className="panel-empty-launcher-name">{label}</span>
      </span>
      <span className="panel-empty-launcher-meta">
        {shortcut && <span className="panel-empty-launcher-shortcut">{shortcut}</span>}
        {!entry.available && <span className="panel-empty-launcher-hint">{t('panel.unavailable')}</span>}
      </span>
    </button>
  );
}
