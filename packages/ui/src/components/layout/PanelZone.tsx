// apps/desktop/src/renderer/components/layout/PanelZone.tsx
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { MAX_PANEL_RATIO, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, clampWidthToBounds, usePanel } from "@/hooks/usePanel";
import { PAGE_REGISTRY, getPageDescriptor, type PageDescriptor, type PageId } from "./panels/registry";
import { PanelCard, PanelCardDetachedPlaceholder } from "./panels/PanelCard";
import { WALL_PAGE_IDS } from "./panels/wall-pages";
import { panelParamsFor, shortcutFor } from "./panels/launch";
import {
  columnPixelWidths,
  formatWallSeparatorLabel,
  rowPixelHeights,
  wallShape,
} from "./panels/layout-model";
import { ResizeHandle } from "./ResizeHandle";
import { PlusIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import {
  setTaskDrawerOpen,
  useTaskDrawerOpen,
} from "./task-drawer-store";
import type { CSSProperties } from "react";
import { getPluginUiSurfaceIcon } from "@/components/plugin-apps/plugin-ui-surface-icons";

/** The gap between two cards of the wall, in pixels. */
const WALL_GAP = 4;
/** The wall's own padding, in pixels; keeps every card inset like a small
 * window inside the app. Must match the CSS `.panel-wall` padding. */
const WALL_PADDING = 8;

export function PanelZone() {
  const {
    panelOpen,
    panelWidth,
    setPanelOpen,
    setPanelWidth,
    openOrActivatePage,
    activateTab,
    closePanel,
    rememberUserWidth,
    resetPanelWidth,
    tabs,
    activeTabId,
    layout,
    workspaceExpanded,
    setWorkspaceExpanded,
    setColumnWidths,
    setRowHeights,
    togglePaneExpanded,
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
  // Widths of the columns / heights of the rows when the in-flight drag
  // started. The drag reports the offset from that point, not a step.
  const columnResizeStartRef = useRef<number[]>([]);
  const rowResizeStartRef = useRef<number[]>([]);
  // The wall's own size: the separators sit in the gaps between the cards,
  // so their positions need the pixel geometry of the wall.
  const wallRef = useRef<HTMLDivElement | null>(null);
  const [wallSize, setWallSize] = useState({ width: 0, height: 0 });
  const taskDrawerOpen = useTaskDrawerOpen();
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  // Panes currently living in their own OS window. The bridge only exists in
  // the Electron build; on the web the set stays empty and no popout action
  // is offered. The wall keeps each detached pane's grid slot (rendered as a
  // placeholder) so the layout does not shift underneath the user.
  const [detachedPaneIds, setDetachedPaneIds] = useState<ReadonlySet<string>>(new Set());
  const detachedBridge = useRef(
    typeof window !== "undefined" ? window.electronAPI?.panelWindow : undefined,
  );
  const activePluginSurface = activeTab?.pageId === "plugin-app";
  const activeSurfaceAvailable = activePluginSurface && (
    activeTab.params?.availability === "always" || !!activeThreadId
  );
  const isSessionView = (currentView === "chat" && !!activeThreadId) || activeSurfaceAvailable;
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
  const { columns, rows } = wallShape(layout);
  // The wall fills the region, so the region's width is the best guess
  // before the wall has been measured.
  const wallWidth = wallSize.width > 0 ? wallSize.width : panelWidth;
  const wallHeight = wallSize.height;
  const columnWidths = useMemo(
    () => columnPixelWidths(layout, wallWidth, WALL_GAP),
    [layout, wallWidth],
  );
  const rowHeights = useMemo(
    () => rowPixelHeights(layout, wallHeight, WALL_GAP),
    [layout, wallHeight],
  );
  const expandedPaneId = layout.expandedPaneId;

  // The panel is normally anchored to a chat session, so non-session views
  // force-close it (it would otherwise be open with no toggle in reach).
  useEffect(() => {
    if (isSessionView) return;
    if (taskDrawerOpen) setTaskDrawerOpen(false);
    if (panelOpen) setPanelOpen(false);
  }, [isSessionView, currentView, panelOpen, setPanelOpen, taskDrawerOpen]);

  useEffect(() => {
    if (activeThreadId) return;
    for (const tab of tabs) {
      if (tab.pageId === "plugin-app" && tab.params?.availability === "session") {
        closePanel(tab.id);
      }
    }
  }, [tabs, activeThreadId, closePanel]);

  const openPage = useCallback(
    (pageId: PageId) => {
      openOrActivatePage(
        pageId,
        panelParamsFor(pageId, { workingDirectory: cwd, sessionId: activeThreadId }),
      );
    },
    [openOrActivatePage, cwd, activeThreadId]
  );

  // Sync the detached set with the main process: panes that were detached in
  // a previous session of this renderer (or by another surface) are spotted
  // through getState, and every later transition arrives as an event.
  useEffect(() => {
    const bridge = detachedBridge.current;
    if (!bridge) return;
    let cancelled = false;
    const sync = async () => {
      for (const tab of tabs) {
        const state = await bridge.getState(tab.id).catch(() => null);
        if (cancelled) return;
        if (state?.ok && state.detached) {
          setDetachedPaneIds((prev) => {
            if (prev.has(tab.id)) return prev;
            const next = new Set(prev);
            next.add(tab.id);
            return next;
          });
        }
      }
    };
    void sync();
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === "opened") {
        setDetachedPaneIds((prev) => new Set(prev).add(event.paneId));
      } else if (event.type === "returned") {
        setDetachedPaneIds((prev) => {
          if (!prev.has(event.paneId)) return prev;
          const next = new Set(prev);
          next.delete(event.paneId);
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tabs]);

  /** Detach a pane into its own OS window (Electron only). */
  const handlePopout = useCallback(
    (paneId: string) => {
      const bridge = detachedBridge.current;
      const tab = tabsById.get(paneId);
      if (!bridge || !tab) return;
      void bridge
        .open(tab.id, tab.pageId, tab.title, tab.params)
        .then((result) => {
          if (result.ok) {
            setDetachedPaneIds((prev) => new Set(prev).add(tab.id));
            if (layout.expandedPaneId === paneId) togglePaneExpanded(paneId);
          }
        })
        .catch(() => {});
    },
    [tabsById, layout.expandedPaneId, togglePaneExpanded],
  );

  /** Hand a detached pane back to the wall; the event closes the loop. */
  const handleReturn = useCallback(
    (paneId: string) => {
      const bridge = detachedBridge.current;
      if (!bridge) return;
      void bridge.close(paneId).catch(() => {});
    },
    [],
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

  // Measure the wall so the separators can sit in the gaps between the
  // cards. The grid itself is laid out in `fr` units, so it does not depend
  // on this measurement.
  useEffect(() => {
    const element = wallRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setWallSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** The card titles of the grid cells left / right of a column boundary. */
  const columnSeparatorLabel = useCallback(
    (columnIndex: number) => {
      const left: string[] = [];
      const right: string[] = [];
      layout.panes.forEach((paneId, index) => {
        const title = tabsById.get(paneId)?.title ?? "";
        ((index % columns) < columnIndex ? left : right).push(title);
      });
      return formatWallSeparatorLabel(left, right);
    },
    [columns, layout.panes, tabsById]
  );

  /** The card titles above / below a row boundary. */
  const rowSeparatorLabel = useCallback(
    (rowIndex: number) => {
      const above: string[] = [];
      const below: string[] = [];
      layout.panes.forEach((paneId, index) => {
        const title = tabsById.get(paneId)?.title ?? "";
        (Math.floor(index / columns) < rowIndex ? above : below).push(title);
      });
      return formatWallSeparatorLabel(above, below);
    },
    [columns, layout.panes, tabsById]
  );

  /** Move the boundary between two columns; the wall keeps its width. */
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

  /** Move the boundary between two rows; the wall keeps its height. */
  const handleRowResize = useCallback(
    (rowIndex: number, delta: number) => {
      const start = rowResizeStartRef.current;
      if (start.length !== rowHeights.length) return;
      const next = [...start];
      next[rowIndex - 1] -= delta;
      next[rowIndex] += delta;
      setRowHeights(next);
    },
    [rowHeights.length, setRowHeights]
  );

  /** Absolute height request for the row above the separator. */
  const handleRowHeightRequest = useCallback(
    (rowIndex: number, height: number) => {
      const start = rowResizeStartRef.current.length === rowHeights.length
        ? rowResizeStartRef.current
        : rowHeights;
      const next = [...start];
      const delta = next[rowIndex - 1] - height;
      next[rowIndex - 1] = height;
      next[rowIndex] += delta;
      setRowHeights(next);
    },
    [rowHeights, setRowHeights]
  );

  const wallStyle = {
    gridTemplateColumns: layout.columnRatios.map((ratio) => `minmax(0, ${ratio}fr)`).join(" "),
    gridTemplateRows: layout.rowRatios.map((ratio) => `minmax(0, ${ratio}fr)`).join(" "),
  } as CSSProperties;

  const cardStyle = useCallback(
    (index: number): CSSProperties => {
      if (expandedPaneId) {
        // The expanded card fills the wall; the other cards stay mounted but
        // out of sight (a browser webview must keep its state).
        return { gridArea: "1 / 1 / -1 / -1" };
      }
      return {
        gridColumn: (index % columns) + 1,
        gridRow: Math.floor(index / columns) + 1,
      };
    },
    [columns, expandedPaneId]
  );

  const renderCard = useCallback(
    (paneId: string) => {
      const tab = tabsById.get(paneId);
      if (!tab) return null;
      const descriptor = getPageDescriptor(tab.pageId);
      const Icon = tab.pageId === "plugin-app"
        ? getPluginUiSurfaceIcon(tab.params?.icon)
        : descriptor.icon;
      const isExpanded = expandedPaneId === paneId;
      const hidden = Boolean(expandedPaneId) && !isExpanded;
      // A lone card already fills the wall, so its header action expands the
      // whole panel region instead. With two or more cards the same action
      // expands the card and the region together, so a maximized panel always
      // covers the entire content column.
      const controlsWorkspace = layout.panes.length <= 1;
      const isDetached = detachedPaneIds.has(paneId);
      if (isDetached) {
        return (
          <div
            key={paneId}
            className="panel-wall-cell"
            data-pane-id={paneId}
            style={{
              ...cardStyle(layout.panes.indexOf(paneId)),
              display: hidden ? "none" : undefined,
            }}
          >
            <PanelCardDetachedPlaceholder
              tab={tab}
              icon={Icon}
              onReturn={() => handleReturn(paneId)}
            />
          </div>
        );
      }
      const Component = descriptor.component;
      return (
        <div
          key={paneId}
          className="panel-wall-cell"
          data-pane-id={paneId}
          style={{
            ...cardStyle(layout.panes.indexOf(paneId)),
            display: hidden ? "none" : undefined,
          }}
        >
          <PanelCard
            tab={tab}
            icon={Icon}
            expanded={controlsWorkspace ? workspaceExpanded : isExpanded}
            expandable={controlsWorkspace ? isSessionView : true}
            onActivate={() => activateTab(paneId)}
            onToggleExpand={() => {
              if (controlsWorkspace) {
                setWorkspaceExpanded(!workspaceExpanded);
                return;
              }
              if (isExpanded) {
                togglePaneExpanded(paneId);
                setWorkspaceExpanded(false);
                return;
              }
              activateTab(paneId);
              togglePaneExpanded(paneId);
              setWorkspaceExpanded(true);
            }}
            onClose={() => {
              if (isExpanded) setWorkspaceExpanded(false);
              closePanel(paneId);
            }}
            onPopout={detachedBridge.current
              ? () => handlePopout(paneId)
              : undefined}
            expandTestId={controlsWorkspace ? "workspace-expand" : undefined}
          >
            <Suspense fallback={<div className="sidebar-panel-lazy-fallback" />}>
              {(tab.pageId !== "plugin-app" || (panelOpen && !hidden))
                ? <Component tab={tab} embedded />
                : null}
            </Suspense>
          </PanelCard>
        </div>
      );
    },
    [
      cardStyle,
      closePanel,
      detachedPaneIds,
      expandedPaneId,
      handlePopout,
      handleReturn,
      layout.panes,
      tabsById,
      togglePaneExpanded,
      activateTab,
      isSessionView,
      setWorkspaceExpanded,
      workspaceExpanded,
    ]
  );

  /**
   * The position of the separator between column `index - 1` and column
   * `index`. The grid shares are the widths between the gaps, so the
   * boundary sits one gap past the shared width.
   */
  const columnBoundaryLeft = useCallback(
    (index: number) => {
      const shared = layout.columnRatios
        .slice(0, index)
        .reduce((sum, ratio) => sum + ratio, 0);
      const gapOffset = WALL_PADDING + index * WALL_GAP - WALL_GAP / 2;
      if (wallSize.width > 0) {
        const usable = Math.max(
          0,
          wallSize.width - WALL_PADDING * 2 - WALL_GAP * (columns - 1),
        );
        return `${WALL_PADDING + shared * usable + index * WALL_GAP - WALL_GAP / 2}px`;
      }
      return `calc(${shared * 100}% + ${gapOffset}px)`;
    },
    [columns, layout.columnRatios, wallSize.width]
  );

  /** The position of the separator between two rows. */
  const rowBoundaryTop = useCallback(
    (index: number) => {
      const shared = layout.rowRatios
        .slice(0, index)
        .reduce((sum, ratio) => sum + ratio, 0);
      const gapOffset = WALL_PADDING + index * WALL_GAP - WALL_GAP / 2;
      if (wallSize.height > 0) {
        const usable = Math.max(
          0,
          wallSize.height - WALL_PADDING * 2 - WALL_GAP * (rows - 1),
        );
        return `${WALL_PADDING + shared * usable + index * WALL_GAP - WALL_GAP / 2}px`;
      }
      return `calc(${shared * 100}% + ${gapOffset}px)`;
    },
    [layout.rowRatios, rows, wallSize.height]
  );

  const emptyCells = Math.max(0, columns * rows - layout.panes.length);

  return (
    <div
      className={`panel-zone ${panelOpen ? "panel-zone-open" : "panel-zone-closed"}${workspaceExpanded ? " panel-zone-expanded" : ""}${resizing ? " panel-zone-resizing" : ""}`}
      data-page-id={activeTab?.pageId ?? "none"}
      data-wall-columns={columns}
      data-wall-rows={rows}
      style={zoneStyle}
    >
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
        {layout.panes.length === 0 ? (
          <Suspense fallback={<div className="sidebar-panel-lazy-fallback" />}>
            <EmptyPanelLauncher onSelect={openPage} />
          </Suspense>
        ) : (
        <div className="panel-wall" ref={wallRef} style={wallStyle}>
          {layout.panes.map((paneId) => renderCard(paneId))}
          {emptyCells > 0 && !expandedPaneId && (
            <div
              className="panel-wall-cell panel-wall-cell-empty"
              style={{
                gridColumn: (layout.panes.length % columns) + 1,
                gridRow: Math.floor(layout.panes.length / columns) + 1,
              }}
            >
              <button
                type="button"
                className="panel-wall-add-tile"
                title={t('panel.addPage')}
                aria-label={t('panel.addPage')}
                onClick={() => openPage(WALL_PAGE_IDS[0])}
              >
                <PlusIcon size={16} stroke={1.5} />
              </button>
            </div>
          )}
          {!expandedPaneId && Array.from({ length: Math.max(0, columns - 1) }, (_, index) => (
            <div
              key={`column-separator-${index}`}
              className="panel-wall-separator panel-wall-separator-column"
              style={{ left: columnBoundaryLeft(index + 1) }}
            >
              <ResizeHandle
                side="right"
                onResizeStart={() => {
                  columnResizeStartRef.current = columnWidths;
                }}
                onResize={(delta) => handleColumnResize(index + 1, delta)}
                width={columnWidths[index]}
                minWidth={MIN_PANEL_WIDTH}
                onWidthRequest={(width) => handleColumnWidthRequest(index + 1, width)}
                label={columnSeparatorLabel(index + 1)}
              />
            </div>
          ))}
          {!expandedPaneId && Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (
            <div
              key={`row-separator-${index}`}
              className="panel-wall-separator panel-wall-separator-row"
              style={{ top: rowBoundaryTop(index + 1) }}
            >
              <ResizeHandle
                side="top"
                onResizeStart={() => {
                  rowResizeStartRef.current = rowHeights;
                }}
                onResize={(delta) => handleRowResize(index + 1, delta)}
                width={rowHeights[index]}
                minWidth={0}
                onWidthRequest={(height) => handleRowHeightRequest(index + 1, height)}
                label={rowSeparatorLabel(index + 1)}
              />
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}

function EmptyPanelLauncher({ onSelect }: { onSelect: (pageId: PageId) => void }) {
  const entries = WALL_PAGE_IDS.map((id) => PAGE_REGISTRY[id]);

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
