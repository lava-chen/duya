// apps/desktop/src/renderer/components/layout/PanelZone.tsx
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { MIN_CHAT_PEEK_WIDTH, MIN_CHAT_WIDTH, MIN_PANEL_WIDTH, clampWidthToBounds, usePanel, usePanelGeometry } from "@/hooks/usePanel";
import { PAGE_REGISTRY, getPageDescriptor, type PageDescriptor, type PageId } from "./panels/registry";
import { PanelCard, PanelCardDetachedPlaceholder } from "./panels/PanelCard";
import { WALL_PAGE_IDS } from "./panels/wall-pages";
import { panelParamsFor, shortcutFor } from "./panels/launch";
import {
  columnPixelWidths,
  formatWallSeparatorLabel,
  paneIdsInColumn,
  rowPixelHeights,
  wallShape,
} from "./panels/layout-model";
import { ResizeHandle } from "./ResizeHandle";
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
    setPanelOpen,
    setPanelWidth,
    openOrActivatePage,
    activateTab,
    closePanel,
    rememberUserWidth,
    resetPanelWidth,
    tabs,
    activeTabId,
    workspaceExpanded,
    setWorkspaceExpanded,
    setColumnWidths,
    setRowHeights,
    togglePaneExpanded,
  } = usePanel();
  // Keep layout geometry out of shared panel state so only this surface
  // reacts when a resize gesture commits its final dimensions.
  const { panelWidth, layout } = usePanelGeometry();
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
  const rowResizeStartRef = useRef<number[][]>([]);
  const columnResizeCurrentRef = useRef<number[] | null>(null);
  const rowResizeCurrentRef = useRef<number[][]>([]);
  const regionResizeActiveRef = useRef(false);
  // The wall's own size: the separators sit in the gaps between the cards,
  // so their positions need the pixel geometry of the wall.
  const wallRef = useRef<HTMLDivElement | null>(null);
  const panelZoneRef = useRef<HTMLDivElement | null>(null);
  const panelInnerRef = useRef<HTMLDivElement | null>(null);
  const [wallSize, setWallSize] = useState({ width: 0, height: 0 });
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
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
  const activePanelMaxWidth = activeDescriptor?.maxWidth;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const cwd = activeThread?.workingDirectory ?? undefined;
  const zoneStyle = {
    "--panel-zone-width": `${panelWidth}px`,
    "--panel-content-width": `${panelWidth}px`,
  } as CSSProperties;

  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const { columns, rows } = wallShape(layout);
  const columnPanes = useMemo(
    () => Array.from({ length: columns }, (_, index) => paneIdsInColumn(layout, index)),
    [columns, layout],
  );
  const overlapsChat = !workspaceExpanded && workspaceWidth > 0 && panelWidth > workspaceWidth - MIN_CHAT_WIDTH;
  const descriptorMaxWidth = typeof activePanelMaxWidth === "number" && Number.isFinite(activePanelMaxWidth)
    ? activePanelMaxWidth
    : Number.POSITIVE_INFINITY;
  const resizeMaxWidth = workspaceWidth > 0
    ? Math.min(descriptorMaxWidth, Math.max(0, workspaceWidth - MIN_CHAT_PEEK_WIDTH))
    : descriptorMaxWidth;
  // The wall fills the region, so the region's width is the best guess
  // before the wall has been measured.
  const wallWidth = wallSize.width > 0 ? wallSize.width : panelWidth;
  const wallHeight = wallSize.height;
  const columnWidths = useMemo(
    () => columnPixelWidths(layout, Math.max(0, wallWidth - WALL_PADDING * 2), WALL_GAP),
    [layout, wallWidth],
  );
  const rowHeights = useMemo(
    () => Array.from({ length: columns }, (_, index) =>
      rowPixelHeights(layout, Math.max(0, wallHeight - WALL_PADDING * 2), WALL_GAP, index),
    ),
    [columns, layout, wallHeight],
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
    const workspace = document.querySelector(".app-workspace-row");
    if (!workspace) return;
    const measure = () => setWorkspaceWidth(workspace.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

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

  // The workspace width is measured ONCE per drag, not once per frame: a
  // `getBoundingClientRect` right after the width was written forces a
  // synchronous layout, and doing that on every frame of the drag is a
  // layout thrash. The value is read again when there is no drag in flight.
  const dragWorkspaceWidthRef = useRef<number | null>(null);

  const measureWorkspaceWidth = useCallback((): number => {
    const workspace = document.querySelector(".app-workspace-row");
    return workspace?.getBoundingClientRect().width ?? window.innerWidth;
  }, []);

  const measureWallSize = useCallback(() => {
    const wall = wallRef.current;
    if (!wall) return;
    const rect = wall.getBoundingClientRect();
    setWallSize((previous) => (
      Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
        ? previous
        : { width: rect.width, height: rect.height }
    ));
  }, []);

  const updateColumnBoundariesForWidth = useCallback((nextWallWidth: number) => {
    const wall = wallRef.current;
    if (!wall || columns < 2) return;
    const usable = Math.max(
      0,
      nextWallWidth - WALL_PADDING * 2 - WALL_GAP * (columns - 1),
    );
    let sharedRatio = 0;
    for (let index = 1; index < columns; index += 1) {
      sharedRatio += layout.columnRatios[index - 1] ?? 0;
      const separator = wall.querySelector<HTMLElement>(
        `[data-column-separator-index="${index}"]`,
      );
      if (separator) {
        separator.style.left = `${WALL_PADDING + sharedRatio * usable + index * WALL_GAP - WALL_GAP / 2}px`;
      }
    }
  }, [columns, layout.columnRatios]);

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

  // A pane can be closed from several places (the card's own close action,
  // the session-availability sweep, a session switch). Once its tab is gone
  // the wall no longer renders it, so nothing else would ever ask the main
  // process to close its detached window: without this it survives as an
  // orphan with no row to return to.
  useEffect(() => {
    const bridge = detachedBridge.current;
    if (!bridge) return;
    for (const paneId of detachedPaneIds) {
      if (!tabsById.has(paneId)) void bridge.close(paneId).catch(() => {});
    }
  }, [detachedPaneIds, tabsById]);

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
      const workspaceWidth = dragWorkspaceWidthRef.current ?? measureWorkspaceWidth();
      return clampWidthToBounds(width, {
        minWidth: activePanelMinWidth,
        maxWidth: activeDescriptor?.maxWidth,
      }, workspaceWidth);
    },
    [activePanelMinWidth, activeDescriptor, measureWorkspaceWidth]
  );

  const handleResize = useCallback(
    (delta: number) => {
      // When lowerBound > upperBound (narrow workspace), the shared clamp
      // picks upperBound so the drag never pushes the panel past the chat
      // column's protected minimum width.
      const nextWidth = clampActiveWidth(resizeStartWidthRef.current - delta);
      lastDragWidthRef.current = nextWidth;
      const zone = panelZoneRef.current;
      zone?.style.setProperty("--panel-zone-width", `${nextWidth}px`);
      zone?.style.setProperty("--panel-content-width", `${nextWidth}px`);
      if (panelInnerRef.current) panelInnerRef.current.style.width = `${nextWidth}px`;

      const workspace = dragWorkspaceWidthRef.current ?? workspaceWidth;
      const overlaps = !workspaceExpanded && workspace > 0 && nextWidth > workspace - MIN_CHAT_WIDTH;
      if (zone) {
        zone.classList.toggle("panel-zone-overlapped", overlaps);
        if (overlaps) zone.dataset.overlapsChat = "true";
        else delete zone.dataset.overlapsChat;
        zone.querySelector<HTMLElement>(".resize-handle-left")
          ?.setAttribute("aria-valuenow", String(Math.round(nextWidth)));
      }
      updateColumnBoundariesForWidth(nextWidth);
    },
    [clampActiveWidth, updateColumnBoundariesForWidth, workspaceExpanded, workspaceWidth]
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
    if (!panelOpen) return;
    const available = workspaceWidth > 0 ? Math.max(0, workspaceWidth - MIN_CHAT_PEEK_WIDTH) : activePanelMinWidth;
    const minimum = Math.min(activePanelMinWidth, available);
    if (panelWidth < minimum) setPanelWidth(minimum);
  }, [activePanelMinWidth, panelOpen, panelWidth, setPanelWidth, workspaceWidth]);

  // Measure the wall so the separators can sit in the gaps between the
  // cards. The grid itself is laid out in `fr` units, so it does not depend
  // on this measurement.
  useEffect(() => {
    const element = wallRef.current;
    if (!element) return;
    const measure = () => {
      // Resizing the outer edge changes the wall's width every frame. Its
      // grid already follows that width in CSS; publishing each measurement
      // to React would render every mounted panel again during the drag.
      if (regionResizeActiveRef.current) return;
      measureWallSize();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout.panes.length, measureWallSize, panelOpen, workspaceExpanded]);

  /** The card titles on each side of a column boundary. */
  const columnSeparatorLabel = useCallback(
    (columnIndex: number) => {
      const left: string[] = [];
      const right: string[] = [];
      layout.panes.forEach((paneId, index) => {
        const title = tabsById.get(paneId)?.title ?? "";
        ((layout.paneColumns[index] ?? 0) < columnIndex ? left : right).push(title);
      });
      return formatWallSeparatorLabel(left, right);
    },
    [layout.paneColumns, layout.panes, tabsById]
  );

  /** The card titles above / below a row boundary in one column. */
  const rowSeparatorLabel = useCallback(
    (columnIndex: number, rowIndex: number) => {
      const panes = columnPanes[columnIndex] ?? [];
      const above = panes.slice(0, rowIndex).map((paneId) => tabsById.get(paneId)?.title ?? "");
      const below = panes.slice(rowIndex).map((paneId) => tabsById.get(paneId)?.title ?? "");
      return formatWallSeparatorLabel(above, below);
    },
    [columnPanes, tabsById]
  );

  /** Move the boundary between two columns; the wall keeps its width. */
  const handleColumnResize = useCallback(
    (columnIndex: number, delta: number) => {
      const start = columnResizeStartRef.current;
      if (start.length !== columnWidths.length) return;
      const next = [...start];
      const pairTotal = start[columnIndex - 1] + start[columnIndex];
      const minimum = Math.min(MIN_PANEL_WIDTH, pairTotal / 2);
      // A right-edge handle reports positive deltas when the pane on its left
      // shrinks, so subtract the delta to keep the boundary under the pointer.
      next[columnIndex - 1] = Math.max(
        minimum,
        Math.min(pairTotal - minimum, start[columnIndex - 1] - delta),
      );
      next[columnIndex] = pairTotal - next[columnIndex - 1];
      columnResizeCurrentRef.current = next;

      const wall = wallRef.current;
      if (!wall) return;
      wall.style.gridTemplateColumns = next
        .map((width) => `minmax(0, ${Math.max(0, width)}px)`)
        .join(" ");
      const separator = wall.querySelector<HTMLElement>(
        `[data-column-separator-index="${columnIndex}"]`,
      );
      if (separator) {
        const left = WALL_PADDING
          + next.slice(0, columnIndex).reduce((sum, width) => sum + width, 0)
          + columnIndex * WALL_GAP
          - WALL_GAP / 2;
        separator.style.left = `${left}px`;
        separator.querySelector<HTMLElement>(".resize-handle")
          ?.setAttribute("aria-valuenow", String(Math.round(next[columnIndex - 1])));
      }
    },
    [columnWidths.length]
  );

  const finishColumnResize = useCallback(() => {
    const next = columnResizeCurrentRef.current;
    const start = columnResizeStartRef.current;
    if (next && next.some((width, index) => Math.abs(width - (start[index] ?? width)) >= 0.5)) {
      setColumnWidths(next);
    }
    columnResizeCurrentRef.current = null;
  }, [setColumnWidths]);

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
    (columnIndex: number, rowIndex: number, delta: number) => {
      const start = rowResizeStartRef.current[columnIndex];
      if (!start || start.length !== rowHeights[columnIndex]?.length) return;
      const next = [...start];
      // The handle is the top edge of the lower pane: moving it down grows
      // the upper pane, and moving it up shrinks the upper pane.
      next[rowIndex - 1] += delta;
      next[rowIndex] -= delta;
      rowResizeCurrentRef.current[columnIndex] = next;

      const wall = wallRef.current;
      const column = wall?.querySelector<HTMLElement>(`[data-column-index="${columnIndex}"]`);
      if (!wall || !column) return;
      column.style.gridTemplateRows = next
        .map((height) => `minmax(0, ${Math.max(0, height)}px)`)
        .join(" ");
      const separator = wall.querySelector<HTMLElement>(
        `[data-row-separator-column="${columnIndex}"][data-row-separator-index="${rowIndex}"]`,
      );
      if (separator) {
        const top = next.slice(0, rowIndex).reduce((sum, height) => sum + height, 0)
          + rowIndex * WALL_GAP
          - WALL_GAP / 2;
        separator.style.top = `${top}px`;
        separator.querySelector<HTMLElement>(".resize-handle")
          ?.setAttribute("aria-valuenow", String(Math.round(next[rowIndex])));
      }
    },
    [rowHeights]
  );

  const finishRowResize = useCallback((columnIndex: number) => {
    const next = rowResizeCurrentRef.current[columnIndex];
    const start = rowResizeStartRef.current[columnIndex];
    if (next && start && next.some((height, index) => Math.abs(height - (start[index] ?? height)) >= 0.5)) {
      setRowHeights(next, columnIndex);
    }
    rowResizeCurrentRef.current[columnIndex] = [];
  }, [setRowHeights]);

  /** Absolute height request for the row above the separator. */
  const handleRowHeightRequest = useCallback(
    (columnIndex: number, rowIndex: number, height: number) => {
      const start = rowHeights[columnIndex] ?? [];
      const next = [...start];
      const delta = next[rowIndex] - height;
      next[rowIndex - 1] += delta;
      next[rowIndex] = height;
      setRowHeights(next, columnIndex);
    },
    [rowHeights, setRowHeights]
  );

  const wallStyle = {
    gridTemplateColumns: layout.columnRatios.map((ratio) => `minmax(0, ${ratio}fr)`).join(" "),
    gridTemplateRows: "minmax(0, 1fr)",
  } as CSSProperties;

  const columnStyle = useCallback((columnIndex: number): CSSProperties => ({
    gridTemplateRows: (layout.columnRowRatios[columnIndex] ?? [1])
      .map((ratio) => `minmax(0, ${ratio}fr)`)
      .join(" "),
  }), [layout.columnRowRatios]);

  const cardStyle = useCallback(
    (): CSSProperties => {
      if (expandedPaneId) {
        // The expanded card fills the wall; the other cards stay mounted but
        // out of sight (a browser webview must keep its state).
        return { gridArea: "1 / 1 / -1 / -1" };
      }
      return {};
    },
    [expandedPaneId]
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
              ...cardStyle(),
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
            ...cardStyle(),
            display: hidden ? "none" : undefined,
          }}
        >
          <PanelCard
            tab={tab}
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

  /** The position of a row separator inside one column. */
  const rowBoundaryTop = useCallback(
    (columnIndex: number, index: number) => {
      const ratios = layout.columnRowRatios[columnIndex] ?? [];
      const rowsInColumn = columnPanes[columnIndex]?.length ?? 0;
      const shared = ratios
        .slice(0, index)
        .reduce((sum, ratio) => sum + ratio, 0);
      const gapOffset = index * WALL_GAP - WALL_GAP / 2;
      if (wallSize.height > 0) {
        const usable = Math.max(
          0,
          wallSize.height - WALL_PADDING * 2 - WALL_GAP * (rowsInColumn - 1),
        );
        return `${shared * usable + index * WALL_GAP - WALL_GAP / 2}px`;
      }
      return `calc(${shared * 100}% + ${gapOffset}px)`;
    },
    [columnPanes, layout.columnRowRatios, wallSize.height]
  );

  return (
    <div
      ref={panelZoneRef}
      className={`panel-zone ${panelOpen ? "panel-zone-open" : "panel-zone-closed"}${workspaceExpanded ? " panel-zone-expanded" : ""}${resizing ? " panel-zone-resizing" : ""}${overlapsChat ? " panel-zone-overlapped" : ""}`}
      data-page-id={activeTab?.pageId ?? "none"}
      data-wall-columns={columns}
      data-wall-rows={rows}
      data-overlaps-chat={overlapsChat ? "true" : undefined}
      style={zoneStyle}
    >
      {panelOpen && !workspaceExpanded && (
        <ResizeHandle
          side="left"
          onResizeStart={() => {
            regionResizeActiveRef.current = true;
            resizeStartWidthRef.current = panelWidth;
            lastDragWidthRef.current = panelWidth;
            dragWorkspaceWidthRef.current = measureWorkspaceWidth();
            setResizing(true);
          }}
          onResize={handleResize}
          onResizeEnd={() => {
            regionResizeActiveRef.current = false;
            dragWorkspaceWidthRef.current = null;
            setResizing(false);
            setPanelWidth(lastDragWidthRef.current);
            measureWallSize();
            if (activeTab) {
              rememberUserWidth(activeTab.pageId, lastDragWidthRef.current);
            }
          }}
          width={panelWidth}
          minWidth={Math.min(Math.max(MIN_PANEL_WIDTH, activePanelMinWidth), resizeMaxWidth)}
          maxWidth={Number.isFinite(resizeMaxWidth) ? resizeMaxWidth : undefined}
          onWidthRequest={handleWidthRequest}
          onReset={activeTab ? () => resetPanelWidth(activeTab.pageId) : undefined}
          label={t('panel.resizeHandle')}
        />
      )}

      <div
        ref={panelInnerRef}
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
          {expandedPaneId
            ? layout.panes.map((paneId) => renderCard(paneId))
            : columnPanes.map((panes, columnIndex) => (
                <div
                  key={`panel-column-${columnIndex}`}
                  className="panel-wall-column"
                  data-column-index={columnIndex}
                  style={columnStyle(columnIndex)}
                >
                  {panes.map((paneId) => renderCard(paneId))}
                  {panes.length > 1 && Array.from({ length: panes.length - 1 }, (_, index) => (
                    <div
                      key={`row-separator-${columnIndex}-${index}`}
                      className="panel-wall-separator panel-wall-separator-row"
                      data-row-separator-column={columnIndex}
                      data-row-separator-index={index + 1}
                      style={{ top: rowBoundaryTop(columnIndex, index + 1) }}
                    >
                      <ResizeHandle
                        side="top"
                        onResizeStart={() => {
                          rowResizeStartRef.current = rowHeights.map((heights) => [...heights]);
                          rowResizeCurrentRef.current = rowHeights.map((heights) => [...heights]);
                        }}
                        onResize={(delta) => handleRowResize(columnIndex, index + 1, delta)}
                        onResizeEnd={() => finishRowResize(columnIndex)}
                        width={rowHeights[columnIndex]?.[index + 1]}
                        minWidth={0}
                        onWidthRequest={(height) => handleRowHeightRequest(columnIndex, index + 1, height)}
                        label={rowSeparatorLabel(columnIndex, index + 1)}
                      />
                    </div>
                  ))}
                </div>
              ))}
          {!expandedPaneId && Array.from({ length: Math.max(0, columns - 1) }, (_, index) => (
            <div
              key={`column-separator-${index}`}
              className="panel-wall-separator panel-wall-separator-column"
              data-column-separator-index={index + 1}
              style={{ left: columnBoundaryLeft(index + 1) }}
            >
              <ResizeHandle
                side="right"
                onResizeStart={() => {
                  columnResizeStartRef.current = [...columnWidths];
                  columnResizeCurrentRef.current = [...columnWidths];
                }}
                onResize={(delta) => handleColumnResize(index + 1, delta)}
                onResizeEnd={finishColumnResize}
                width={columnWidths[index]}
                minWidth={MIN_PANEL_WIDTH}
                onWidthRequest={(width) => handleColumnWidthRequest(index + 1, width)}
                label={columnSeparatorLabel(index + 1)}
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
