"use client";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { MAX_PANEL_RATIO, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, clampWidthToBounds, usePanel } from "@/hooks/usePanel";
import { PanelHeader } from "./PanelHeader";
import { PAGE_REGISTRY, getPageDescriptor, type PageDescriptor, type PageId } from "./panels/registry";
import {
  columnPixelWidths,
  familyResolver,
  formatPaneTreeLabel,
  isPaneVisible,
  type ColumnId,
  type PaneId,
} from "./panels/layout-model";
import { ResizeHandle } from "./ResizeHandle";
import { SidebarLeftCollapseIcon, SidebarLeftExpandIcon, CornersInIcon, CornersOutIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import {
  setTaskDrawerOpen,
  useTaskDrawerOpen,
} from "./task-drawer-store";
import type { CSSProperties } from "react";

// `office` is a passive surface — opened by events
// (`duya:open-office-panel`), so it is intentionally absent from both
// this launcher and the add-page menu.
const EMPTY_LAUNCHER_ORDER: PageId[] = ["review", "terminal", "browser", "files", "conductor"];

function shortcutFor(id: PageId): string | null {
  switch (id) {
    case "terminal": return "Ctrl+`";
    case "browser": return "Ctrl+T";
    case "review": return "Ctrl+Shift+G";
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
    rememberUserWidth,
    resetPanelWidth,
    tabs,
    activeTabId,
    layout,
    workspaceExpanded,
    setWorkspaceExpanded,
    setColumnWidths,
    setPaneRatio,
  } = usePanel();
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const currentView = useConversationStore((s) => s.currentView);
  const threads = useConversationStore((s) => s.threads);
  const [resizing, setResizing] = useState(false);
  const resizeStartWidthRef = useRef(panelWidth);
  // Last width produced by the in-flight drag; committed to the per-page
  // width memory on drag end.
  const lastDragWidthRef = useRef(panelWidth);
  // Widths of the columns when the in-flight column drag started.
  const columnResizeStartRef = useRef<number[]>([]);
  // Height of the panel content area: the columns fill it, so it converts a
  // pane's vertical share into pixels.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const taskDrawerOpen = useTaskDrawerOpen();
  const isSessionView = currentView === "chat" && !!activeThreadId;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
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

  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const familyOf = useMemo(
    () => familyResolver(tabs.map((tab) => ({ id: tab.id, pageId: tab.pageId }))),
    [tabs],
  );
  const columnWidths = useMemo(
    () => columnPixelWidths(layout, panelWidth),
    [layout, panelWidth],
  );

  // The panel is normally anchored to a chat session, so non-session views
  // force-close it (it would otherwise be open with no toggle in reach).
  // Exception: `workflow` — its management page renders run cards whose whole
  // affordance is landing a run detail in the side panel; force-closing here
  // made the panel flash and vanish on every card click. The panel stays
  // closable on that view via the edge toggle rendered while it is open.
  useEffect(() => {
    if (isSessionView) return;
    if (currentView === "workflow") return;
    if (taskDrawerOpen) setTaskDrawerOpen(false);
    if (panelOpen) setPanelOpen(false);
  }, [isSessionView, currentView, panelOpen, setPanelOpen, taskDrawerOpen]);

  const paramsFor = useCallback(
    (pageId: PageId): Record<string, unknown> | undefined => {
      if (!cwd) return undefined;
      if (pageId === "terminal") return { cwd };
      if (pageId === "files") return { workingDirectory: cwd };
      if (pageId === "review") return { workingDirectory: cwd, sessionId: activeThreadId };
      if (pageId === "workflow") return { workingDirectory: cwd };
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

  const clampActiveWidth = useCallback(
    (width: number) => {
      const workspace = document.querySelector(".app-workspace-row");
      const workspaceWidth = workspace?.getBoundingClientRect().width ?? window.innerWidth;
      return clampWidthToBounds(width, {
        minWidth: activePanelMinWidth,
        maxWidth: activeDescriptor?.maxWidth,
        maxWidthRatio: activePanelMaxRatio,
      }, workspaceWidth);
    },
    [activePanelMaxRatio, activePanelMinWidth, activeDescriptor]
  );

  const handleResize = useCallback(
    (delta: number) => {
      // When lowerBound > upperBound (narrow workspace), the shared clamp
      // picks upperBound so the drag never pushes the panel past the chat
      // column's protected minimum width.
      const nextWidth = clampActiveWidth(resizeStartWidthRef.current - delta);
      lastDragWidthRef.current = nextWidth;
      setPanelWidth(nextWidth);
    },
    [clampActiveWidth, setPanelWidth]
  );

  /** Absolute width request from keyboard interaction; persists as user width. */
  const handleWidthRequest = useCallback(
    (nextWidth: number) => {
      const clamped = clampActiveWidth(nextWidth);
      lastDragWidthRef.current = clamped;
      setPanelWidth(clamped);
      if (activeTab && !workspaceExpanded) {
        rememberUserWidth(activeTab.pageId, clamped);
      }
    },
    [activeTab, clampActiveWidth, rememberUserWidth, setPanelWidth, workspaceExpanded]
  );

  useEffect(() => {
    if (panelOpen && panelWidth < activePanelMinWidth) {
      setPanelWidth(activePanelMinWidth);
    }
  }, [activePanelMinWidth, panelOpen, panelWidth, setPanelWidth]);

  // The content area's height is what turns a pane's vertical share into
  // pixels.
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setContentHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const titleOf = useCallback(
    (paneId: PaneId) => tabsById.get(paneId)?.title ?? "",
    [tabsById]
  );

  /**
   * The accessible name of the separator between two columns: it spells out
   * the panes on each side, so the whole pane tree can be read out.
   */
  const columnSeparatorLabel = useCallback(
    (columnIndex: number) => {
      const left: string[] = [];
      const right: string[] = [];
      layout.columns.forEach((column, index) => {
        for (const paneId of column.panes) {
          (index < columnIndex ? left : right).push(titleOf(paneId));
        }
      });
      return formatPaneTreeLabel(left, right);
    },
    [layout.columns, titleOf]
  );

  /** The accessible name of the separator between two stacked panes. */
  const paneSeparatorLabel = useCallback(
    (columnId: ColumnId, paneIndex: number) => {
      const column = layout.columns.find((candidate) => candidate.id === columnId);
      if (!column) return formatPaneTreeLabel([], []);
      // The separator sits between the pane above it and the pane below it.
      return formatPaneTreeLabel(
        column.panes.slice(0, paneIndex).map(titleOf),
        column.panes.slice(paneIndex).map(titleOf),
      );
    },
    [layout.columns, titleOf]
  );

  /** Move the boundary between two columns; the region keeps its width. */
  const handleColumnResize = useCallback(
    (columnIndex: number, delta: number) => {
      const start = columnResizeStartRef.current;
      if (start.length !== columnWidths.length) return;
      const next = [...start];
      next[columnIndex - 1] += delta;
      next[columnIndex] -= delta;
      setColumnWidths(next);
    },
    [columnWidths.length, setColumnWidths]
  );

  /** Absolute width request for the column left of the separator. */
  const handleColumnWidthRequest = useCallback(
    (columnIndex: number, width: number) => {
      const start = columnResizeStartRef.current.length === columnWidths.length
        ? columnResizeStartRef.current
        : columnWidths;
      const next = [...start];
      const delta = width - next[columnIndex - 1];
      next[columnIndex - 1] = width;
      next[columnIndex] -= delta;
      setColumnWidths(next);
    },
    [columnWidths, setColumnWidths]
  );

  /** Move the boundary between two stacked panes of a column. */
  const handlePaneResize = useCallback(
    (columnId: ColumnId, paneId: PaneId, delta: number) => {
      if (contentHeight <= 0) return;
      const column = layout.columns.find((candidate) => candidate.id === columnId);
      const ratio = column?.ratios[column.panes.indexOf(paneId)] ?? 0.5;
      setPaneRatio(columnId, paneId, ratio - delta / contentHeight);
    },
    [layout.columns, setPaneRatio, contentHeight]
  );

  const renderPane = useCallback(
    (paneId: PaneId) => {
      const tab = tabsById.get(paneId);
      if (!tab) return null;
      const Component = getPageDescriptor(tab.pageId).component;
      return <Component tab={tab} embedded />;
    },
    [tabsById]
  );

  return (
    <div
      className={`panel-zone ${panelOpen ? "panel-zone-open" : "panel-zone-closed"}${workspaceExpanded ? " panel-zone-expanded" : ""}${resizing ? " panel-zone-resizing" : ""}`}
      data-page-id={activeTab?.pageId ?? "none"}
      data-column-count={layout.columns.length}
      style={zoneStyle}
    >
      {(isSessionView || panelOpen) && (
        <>
          <button
            type="button"
            className={`panel-edge-toggle${panelOpen ? " active" : ""}`}
            onClick={togglePanel}
            title={panelOpen ? t('panel.closePanel') : t('panel.openPanel')}
            aria-label={panelOpen ? t('panel.closePanel') : t('panel.openPanel')}
            aria-expanded={panelOpen}
          >
            {panelOpen
              ? <SidebarLeftCollapseIcon size={16} stroke={1.5} />
              : <SidebarLeftExpandIcon size={16} stroke={1.5} />}
          </button>

          {isSessionView && panelOpen && activeTab && (
            <button
              type="button"
              className="panel-edge-toggle panel-expand-toggle"
              onClick={() => setWorkspaceExpanded(!workspaceExpanded)}
              title={workspaceExpanded ? t('panel.collapsePanel') : t('panel.expandPanel')}
              aria-label={workspaceExpanded ? t('panel.collapsePanel') : t('panel.expandPanel')}
              data-testid="workspace-expand"
            >
              {workspaceExpanded
                ? <CornersInIcon size={16} stroke={1.5} />
                : <CornersOutIcon size={16} stroke={1.5} />}
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
          onResizeEnd={() => {
            setResizing(false);
            if (activeTab) {
              rememberUserWidth(activeTab.pageId, lastDragWidthRef.current);
            }
          }}
          width={panelWidth}
          minWidth={Math.max(MIN_PANEL_WIDTH, activePanelMinWidth)}
          maxWidth={activePanelMaxWidth === Number.POSITIVE_INFINITY ? undefined : activePanelMaxWidth}
          onWidthRequest={handleWidthRequest}
          onReset={activeTab ? () => resetPanelWidth(activeTab.pageId) : undefined}
          label={t('panel.resizeHandle')}
        />
      )}

      <div
        className="sidebar-panel-inner"
        style={{ width: workspaceExpanded ? "100%" : panelWidth }}
        aria-hidden={!panelOpen}
      >
        {tabs.length > 0 && <PanelHeader />}
        <div className="sidebar-panel-content" ref={contentRef}>
          {layout.columns.length === 0 ? (
            <Suspense fallback={<div className="sidebar-panel-lazy-fallback" />}>
              <EmptyPanelLauncher onSelect={openPage} />
            </Suspense>
          ) : (
            <div className="panel-columns">
              {layout.columns.map((column, columnIndex) => (
                <Fragment key={column.id}>
                  {columnIndex > 0 && (
                    <div className="panel-column-separator">
                      <ResizeHandle
                        side="right"
                        onResizeStart={() => {
                          columnResizeStartRef.current = columnWidths;
                        }}
                        onResize={(delta) => handleColumnResize(columnIndex, delta)}
                        width={columnWidths[columnIndex - 1]}
                        minWidth={MIN_PANEL_WIDTH}
                        onWidthRequest={(width) => handleColumnWidthRequest(columnIndex, width)}
                        label={columnSeparatorLabel(columnIndex)}
                      />
                    </div>
                  )}
                  <div
                    className="panel-column"
                    style={{ flex: `0 0 ${columnWidths[columnIndex] ?? 0}px` }}
                  >
                    {column.panes.map((paneId, paneIndex) => {
                      const visible = isPaneVisible(layout, column.id, paneId, familyOf);
                      const ratio = column.ratios[paneIndex] ?? 1;
                      return (
                        <Fragment key={paneId}>
                          {paneIndex > 0 && (
                            <div className="panel-pane-separator">
                              <ResizeHandle
                                side="top"
                                onResize={(delta) => handlePaneResize(column.id, paneId, delta)}
                                onWidthRequest={(target) => {
                                  if (contentHeight <= 0) return;
                                  setPaneRatio(column.id, paneId, target / contentHeight);
                                }}
                                width={ratio * contentHeight}
                                minWidth={0}
                                label={paneSeparatorLabel(column.id, paneIndex)}
                              />
                            </div>
                          )}
                          <div
                            className={`panel-column-pane${visible ? "" : " panel-column-pane-hidden"}`}
                            style={{ flexGrow: ratio }}
                            aria-hidden={!visible}
                            data-pane-id={paneId}
                          >
                            <Suspense fallback={<div className="sidebar-panel-lazy-fallback" />}>
                              {renderPane(paneId)}
                            </Suspense>
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </div>
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
          <Icon size={15} stroke={1.5} />
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
