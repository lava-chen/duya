// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageTab } from "./panels/registry";
import type { WorkspaceLayout } from "./panels/layout-model";

const mocks = vi.hoisted(() => ({
  activeTabId: "agent-one" as string | null,
  panelOpen: true,
  panelRenders: 0,
  resizeHandles: {} as Record<string, {
    side?: string;
    onResizeStart?: () => void;
    onResize?: (delta: number) => void;
    onResizeEnd?: () => void;
  }>,
  setColumnWidths: vi.fn(),
  setRowHeights: vi.fn(),
  setPanelWidth: vi.fn(),
  tabs: [] as PageTab[],
  layout: {
    panes: [],
    paneColumns: [],
    columns: 1,
    columnRatios: [1],
    columnRowRatios: [[]],
    expandedPaneId: null,
    activePaneId: null,
  } as WorkspaceLayout,
  panelWindow: {
    context: { paneId: null, pageId: null, params: null },
    getState: vi.fn(async () => ({ ok: true, detached: false, alwaysOnTop: false })),
    open: vi.fn(async () => ({ ok: true, paneId: "files", windowId: 2 })),
    close: vi.fn(async () => ({ ok: true, paneId: "files" })),
    setAlwaysOnTop: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((_callback: (event: { type: string }) => void) => () => {}),
  },
}));

function installPanelWindowBridge() {
  (window as unknown as { electronAPI: { panelWindow: unknown } }).electronAPI = {
    panelWindow: mocks.panelWindow,
  };
  return () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  };
}

vi.mock("@/hooks/usePanel", () => ({
  MAX_PANEL_RATIO: 0.6,
  MAX_PANEL_WIDTH: 1120,
  clampWidthToBounds: (width: number) => width,
  MIN_CHAT_WIDTH: 680,
  MIN_PANEL_WIDTH: 300,
  usePanel: () => ({
    panelOpen: mocks.panelOpen,
    setPanelOpen: vi.fn(),
    setPanelWidth: mocks.setPanelWidth,
    togglePanel: vi.fn(),
    openOrActivatePage: vi.fn(),
    activateTab: vi.fn(),
    closePanel: vi.fn(),
    rememberUserWidth: vi.fn(),
    resetPanelWidth: vi.fn(),
    tabs: mocks.tabs,
    activeTabId: mocks.activeTabId,
    workspaceExpanded: false,
    setWorkspaceExpanded: vi.fn(),
    setColumnWidths: mocks.setColumnWidths,
    setRowHeights: mocks.setRowHeights,
    togglePaneExpanded: vi.fn(),
  }),
  // The geometry has its own context: it changes on every frame of a drag,
  // so it is not part of the shared one.
  usePanelGeometry: () => ({
    panelWidth: 760,
    layout: mocks.layout,
  }),
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/conversation-store", () => ({
  useConversationStore: (selector: (state: unknown) => unknown) => selector({
    activeThreadId: "thread-1",
    currentView: "chat",
    threads: [],
  }),
}));

// The real handle carries the accessible name of the separator, so the mock
// keeps the same attributes: the naming of the wall is what is under test.
vi.mock("./ResizeHandle", () => ({
  ResizeHandle: (props: {
    label?: string;
    side?: string;
    width?: number;
    onResizeStart?: () => void;
    onResize?: (delta: number) => void;
    onResizeEnd?: () => void;
  }) => {
    mocks.resizeHandles[`${props.side ?? "left"}:${props.label ?? ""}`] = props;
    return (
      <div
        data-testid={`resize-handle-${props.side}`}
        role="separator"
        aria-label={props.label}
        aria-valuenow={props.width}
      />
    );
  },
}));
vi.mock("./task-drawer-store", () => ({
  setTaskDrawerOpen: vi.fn(),
  useTaskDrawerOpen: () => false,
}));
vi.mock("./panels/registry", () => {
  const Browser = ({ tab }: { tab: PageTab }) => {
    mocks.panelRenders += 1;
    return <div data-testid={`browser-${tab.id}`}>{tab.title}</div>;
  };
  const Icon = () => <span data-testid="page-icon" />;
  const make = (id: string) => ({
    id,
    labelKey: `panel.${id}`,
    minWidth: 300,
    available: true,
    icon: Icon,
    component: Browser,
  });
  const registry = {
    workspace: make("workspace"),
    review: make("review"),
    browser: make("browser"),
    terminal: make("terminal"),
    "plugin-app": {
      ...make("plugin-app"),
      component: ({ tab }: { tab: PageTab }) => <iframe data-testid={`plugin-frame-${tab.id}`} />,
    },
  };
  return {
    PAGE_REGISTRY: registry,
    getPageDescriptor: (id: keyof typeof registry) => registry[id],
  };
});

import { PanelZone } from "./PanelZone";

function wall(panes: string[], overrides: Partial<WorkspaceLayout> = {}): WorkspaceLayout {
  const columns = panes.length <= 2 ? 1 : 2;
  const paneColumns = panes.map((_, index) => columns === 1 || index < 2 ? 0 : 1);
  const counts = new Array(columns).fill(0);
  paneColumns.forEach((column) => { counts[column] += 1; });
  return {
    panes,
    paneColumns,
    columns,
    columnRatios: new Array(columns).fill(1 / columns),
    columnRowRatios: counts.map((count) => count > 0 ? new Array(count).fill(1 / count) : []),
    expandedPaneId: null,
    activePaneId: panes[0] ?? null,
    ...overrides,
  };
}

describe("PanelZone panel wall", () => {
  beforeEach(() => {
    mocks.panelRenders = 0;
    mocks.resizeHandles = {};
    mocks.setColumnWidths.mockClear();
    mocks.setRowHeights.mockClear();
    mocks.setPanelWidth.mockClear();
  });

  it("measures the wall when panes are opened after the zone mounts", async () => {
    mocks.tabs = [];
    mocks.activeTabId = null;
    mocks.layout = wall([]);
    const wallRect = {
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("panel-wall") ? wallRect : { ...wallRect, width: 0, height: 0 } as DOMRect;
    });

    const { container, rerender } = render(<PanelZone />);
    mocks.tabs = [
      { id: "files-1", pageId: "workspace", title: "Files 1" },
      { id: "files-2", pageId: "workspace", title: "Files 2" },
      { id: "files-3", pageId: "workspace", title: "Files 3" },
      { id: "files-4", pageId: "workspace", title: "Files 4" },
    ];
    mocks.activeTabId = "files-4";
    mocks.layout = wall(["files-1", "files-2", "files-3", "files-4"]);
    rerender(<PanelZone />);

    const rightRowHandle = container.querySelector(
      '[data-column-index="1"] [data-testid="resize-handle-top"]',
    );
    await waitFor(() => expect(rightRowHandle?.getAttribute("aria-valuenow")).toBe("290"));
    vi.restoreAllMocks();
  });

  it("keeps every open card mounted", () => {
    mocks.tabs = [
      { id: "agent-one", pageId: "browser", title: "First agent tab", params: { kind: "agent", sessionId: "one" } },
      { id: "agent-two", pageId: "browser", title: "Second agent tab", params: { kind: "agent", sessionId: "two" } },
    ];
    mocks.activeTabId = "agent-one";
    mocks.layout = wall(["agent-one", "agent-two"]);

    const { rerender } = render(<PanelZone />);
    expect(screen.getByTestId("browser-agent-one")).toBeTruthy();
    expect(screen.getByTestId("browser-agent-two")).toBeTruthy();

    mocks.activeTabId = "agent-two";
    mocks.layout = wall(["agent-one", "agent-two"], { activePaneId: "agent-two" });
    rerender(<PanelZone />);
    expect(screen.getByTestId("browser-agent-one")).toBeTruthy();
    expect(screen.getByTestId("browser-agent-two")).toBeTruthy();
  });

  it("renders one card per open page", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
    ];
    mocks.activeTabId = "terminal";
    mocks.layout = wall(["files", "terminal"]);

    const { container } = render(<PanelZone />);
    expect(container.querySelectorAll(".panel-wall-cell")).toHaveLength(2);
    expect(container.querySelectorAll(".panel-card")).toHaveLength(2);
  });

  it("keeps card actions without repeating the page title in the card chrome", () => {
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    expect(container.querySelector(".panel-card-title")).toBeNull();
    expect(container.querySelector(".panel-card-header-compact .panel-card-actions")).toBeTruthy();
  });

  it("splits the wall into two columns from the third card on", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
      { id: "browser", pageId: "browser", title: "Browser" },
    ];
    mocks.activeTabId = "browser";
    mocks.layout = wall(["files", "terminal", "browser"]);

    const { container } = render(<PanelZone />);
    expect(container.querySelector(".panel-zone")?.getAttribute("data-wall-columns")).toBe("2");
    expect(container.querySelectorAll(".panel-wall-column")).toHaveLength(2);
    expect(container.querySelectorAll(".panel-wall-cell")).toHaveLength(3);
    expect(container.querySelectorAll(".panel-card")).toHaveLength(3);
  });

  it("stacks the third and fourth cards in separate columns", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
      { id: "browser", pageId: "browser", title: "Browser" },
      { id: "review", pageId: "review", title: "Review" },
    ];
    mocks.activeTabId = "review";
    mocks.layout = wall(["files", "terminal", "browser", "review"]);

    const { container } = render(<PanelZone />);
    const columns = Array.from(container.querySelectorAll<HTMLElement>(".panel-wall-column"));
    expect(columns).toHaveLength(2);
    expect(columns[0]?.querySelectorAll(".panel-wall-cell")).toHaveLength(2);
    expect(columns[1]?.querySelectorAll(".panel-wall-cell")).toHaveLength(2);
    expect(container.querySelectorAll(".panel-wall-separator-row")).toHaveLength(2);
  });

  it("previews column resizing without re-rendering panel bodies and commits once", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
      { id: "browser", pageId: "browser", title: "Browser" },
    ];
    mocks.activeTabId = "browser";
    mocks.layout = wall(["files", "terminal", "browser"]);

    const { container } = render(<PanelZone />);
    const renderedBeforeDrag = mocks.panelRenders;
    const columnHandle = Object.values(mocks.resizeHandles).find((handle) => handle.side === "right");
    expect(columnHandle).toBeTruthy();

    act(() => {
      columnHandle?.onResizeStart?.();
      // The right-side handle reports a negative delta when dragged right.
      columnHandle?.onResize?.(-40);
    });

    expect(mocks.panelRenders).toBe(renderedBeforeDrag);
    expect(container.querySelector(".panel-wall")?.getAttribute("style")).toContain("410px");
    expect(container.querySelector("[data-column-separator-index='1']")?.getAttribute("style")).toContain("420px");

    act(() => columnHandle?.onResizeEnd?.());
    expect(mocks.setColumnWidths).toHaveBeenCalledTimes(1);
    expect(mocks.setColumnWidths).toHaveBeenCalledWith([410, 330]);
    expect(mocks.panelRenders).toBe(renderedBeforeDrag);
  });

  it("previews row resizing without re-rendering panel bodies and commits once", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
    ];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files", "terminal"]);
    const wallRect = {
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("panel-wall")
        ? wallRect
        : { ...wallRect, width: 0, height: 0 } as DOMRect;
    });

    const { container } = render(<PanelZone />);
    const renderedBeforeDrag = mocks.panelRenders;
    const rowHandle = Object.values(mocks.resizeHandles).find((handle) => handle.side === "top");
    expect(rowHandle).toBeTruthy();

    act(() => {
      rowHandle?.onResizeStart?.();
      rowHandle?.onResize?.(-50);
    });

    expect(mocks.panelRenders).toBe(renderedBeforeDrag);
    expect(container.querySelector("[data-column-index='0']")?.getAttribute("style")).toContain("240px");
    expect(container.querySelector("[data-row-separator-column='0']")?.getAttribute("style")).toContain("242px");

    act(() => rowHandle?.onResizeEnd?.());
    expect(mocks.setRowHeights).toHaveBeenCalledTimes(1);
    expect(mocks.setRowHeights).toHaveBeenCalledWith([240, 340], 0);
    expect(mocks.panelRenders).toBe(renderedBeforeDrag);
    vi.restoreAllMocks();
  });

  it("previews the panel edge without re-rendering panel bodies and commits on release", () => {
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    const edgeHandle = Object.values(mocks.resizeHandles).find((handle) => handle.side === "left");
    expect(edgeHandle).toBeTruthy();

    act(() => edgeHandle?.onResizeStart?.());
    const renderedAfterStart = mocks.panelRenders;

    act(() => {
      edgeHandle?.onResize?.(20);
      edgeHandle?.onResize?.(36);
    });

    expect(mocks.panelRenders).toBe(renderedAfterStart);
    expect(container.querySelector(".panel-zone")?.getAttribute("style")).toContain("724px");
    expect(container.querySelector(".sidebar-panel-inner")?.getAttribute("style")).toContain("724px");
    expect(mocks.setPanelWidth).not.toHaveBeenCalled();

    act(() => edgeHandle?.onResizeEnd?.());
    expect(mocks.setPanelWidth).toHaveBeenCalledTimes(1);
    expect(mocks.setPanelWidth).toHaveBeenCalledWith(724);
    vi.restoreAllMocks();
  });

  it("names the separator between two columns after the cards on both sides", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
      { id: "browser", pageId: "browser", title: "Browser" },
    ];
    mocks.activeTabId = "browser";
    mocks.layout = wall(["files", "terminal", "browser"]);

    render(<PanelZone />);
    const labels = screen.getAllByRole("separator")
      .map((separator) => separator.getAttribute("aria-label"));
    expect(labels).toContain("调整 Files 和 Terminal 和 Browser 的大小");
  });

  it("names the separator between two rows after the cards above and below", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
    ];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files", "terminal"]);

    render(<PanelZone />);
    const labels = screen.getAllByRole("separator")
      .map((separator) => separator.getAttribute("aria-label"));
    expect(labels).toContain("调整 Files 和 Terminal 的大小");
  });

  it("hides the other cards while one card fills the wall", () => {
    mocks.tabs = [
      { id: "files", pageId: "workspace", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
    ];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files", "terminal"], { expandedPaneId: "files" });

    const { container } = render(<PanelZone />);
    const cells = container.querySelectorAll<HTMLElement>(".panel-wall-cell");
    expect(cells).toHaveLength(2);
    const hidden = Array.from(cells).find((cell) => cell.style.display === "none");
    expect(hidden?.getAttribute("data-pane-id")).toBe("terminal");
  });

  it("unmounts plugin surfaces when their card is hidden or the panel is closed", () => {
    mocks.panelOpen = true;
    mocks.tabs = [
      { id: "surface", pageId: "plugin-app", title: "Overview", params: { availability: "always" } },
      { id: "browser", pageId: "browser", title: "Browser" },
    ];
    mocks.activeTabId = "browser";
    mocks.layout = wall(["surface", "browser"], { expandedPaneId: "browser" });

    const { rerender } = render(<PanelZone />);
    expect(screen.queryByTestId("plugin-frame-surface")).toBeNull();

    mocks.layout = wall(["surface", "browser"]);
    rerender(<PanelZone />);
    expect(screen.getByTestId("plugin-frame-surface")).toBeTruthy();

    mocks.panelOpen = false;
    rerender(<PanelZone />);
    expect(screen.queryByTestId("plugin-frame-surface")).toBeNull();
  });
});

describe("PanelZone detached panes", () => {
  it("shows no popout action without the Electron bridge", () => {
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    expect(screen.queryByTestId("panel-popout-workspace")).toBeNull();
    expect(container.querySelectorAll(".panel-card")).toHaveLength(1);
  });

  it("renders a detached pane as a placeholder that mounts no panel component", async () => {
    const cleanup = installPanelWindowBridge();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: true, alwaysOnTop: false });
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    await waitFor(() => {
      expect(container.querySelector(".panel-card-detached")).toBeTruthy();
    });
    // The placeholder keeps the grid slot but mounts no panel surface.
    expect(screen.queryByTestId("browser-files")).toBeNull();
    expect(screen.getByTestId("panel-return-workspace")).toBeTruthy();
    cleanup();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: false, alwaysOnTop: false });
  });

  it("closes the detached window when its tab is closed from the wall", async () => {
    const cleanup = installPanelWindowBridge();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: true, alwaysOnTop: false });
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container, rerender } = render(<PanelZone />);
    await waitFor(() => {
      expect(container.querySelector(".panel-card-detached")).toBeTruthy();
    });
    mocks.panelWindow.close.mockClear();

    // The tab is gone, so the wall has nothing left to return the pane to.
    mocks.tabs = [];
    mocks.layout = wall([]);
    rerender(<PanelZone />);

    await waitFor(() => {
      expect(mocks.panelWindow.close).toHaveBeenCalledWith("files");
    });

    cleanup();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: false, alwaysOnTop: false });
  });

  it("pops a card out through the bridge and swaps it for the placeholder", async () => {
    const cleanup = installPanelWindowBridge();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: false, alwaysOnTop: false });
    mocks.panelWindow.open.mockResolvedValue({ ok: true, paneId: "files", windowId: 2 });
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files", params: { filePath: "E:/demo/AGENTS.md" } }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    render(<PanelZone />);
    const popout = await screen.findByTestId("panel-popout-workspace");
    popout.click();

    await waitFor(() => {
      expect(mocks.panelWindow.open).toHaveBeenCalledWith(
        "files",
        "workspace",
        "Files",
        { filePath: "E:/demo/AGENTS.md" },
      );
      expect(screen.getByTestId("panel-return-workspace")).toBeTruthy();
    });
    expect(screen.queryByTestId("browser-files")).toBeNull();
    cleanup();
  });

  it("hands a detached pane back on the placeholder's return action", async () => {
    const cleanup = installPanelWindowBridge();
    const eventSink: { current: null | ((event: { type: string; paneId?: string }) => void) } = { current: null };
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: true, alwaysOnTop: false });
    mocks.panelWindow.onEvent.mockImplementation(
      (callback: (event: { type: string; paneId?: string }) => void) => {
        eventSink.current = callback;
        return () => {};
      },
    );
    mocks.tabs = [{ id: "files", pageId: "workspace", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    render(<PanelZone />);
    // Wait until the effect has subscribed, so the sink holds the callback.
    await screen.findByTestId("panel-return-workspace");
    expect(eventSink.current).not.toBeNull();

    const returnBtn = screen.getByTestId("panel-return-workspace");
    returnBtn.click();
    expect(mocks.panelWindow.close).toHaveBeenCalledWith("files");

    // The pane is back on the wall once the main process confirms the return.
    eventSink.current?.({ type: "returned", paneId: "files" });
    await screen.findByTestId("browser-files");

    cleanup();
    mocks.panelWindow.onEvent.mockImplementation((_callback: unknown) => () => {});
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: false, alwaysOnTop: false });
  });
});
