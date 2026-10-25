// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageTab } from "./panels/registry";
import type { WorkspaceLayout } from "./panels/layout-model";

const mocks = vi.hoisted(() => ({
  activeTabId: "agent-one",
  panelOpen: true,
  tabs: [] as PageTab[],
  layout: {
    panes: [],
    columns: 1,
    columnRatios: [1],
    rowRatios: [1],
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
  MIN_CHAT_WIDTH: 680,
  MIN_PANEL_WIDTH: 300,
  usePanel: () => ({
    panelOpen: mocks.panelOpen,
    panelWidth: 760,
    setPanelOpen: vi.fn(),
    setPanelWidth: vi.fn(),
    togglePanel: vi.fn(),
    openOrActivatePage: vi.fn(),
    activateTab: vi.fn(),
    closePanel: vi.fn(),
    rememberUserWidth: vi.fn(),
    resetPanelWidth: vi.fn(),
    tabs: mocks.tabs,
    activeTabId: mocks.activeTabId,
    layout: mocks.layout,
    workspaceExpanded: false,
    setWorkspaceExpanded: vi.fn(),
    setColumnWidths: vi.fn(),
    setRowHeights: vi.fn(),
    togglePaneExpanded: vi.fn(),
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
  ResizeHandle: ({ label, side }: { label?: string; side?: string }) => (
    <div data-testid={`resize-handle-${side}`} role="separator" aria-label={label} />
  ),
}));
vi.mock("./task-drawer-store", () => ({
  setTaskDrawerOpen: vi.fn(),
  useTaskDrawerOpen: () => false,
}));
vi.mock("./panels/registry", () => {
  const Browser = ({ tab }: { tab: PageTab }) => <div data-testid={`browser-${tab.id}`}>{tab.title}</div>;
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
    files: make("files"),
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
  const rows = panes.length === 0 ? 0 : Math.ceil(panes.length / columns);
  return {
    panes,
    columns,
    columnRatios: new Array(columns).fill(1 / columns),
    rowRatios: new Array(rows).fill(1 / Math.max(1, rows)),
    expandedPaneId: null,
    activePaneId: panes[0] ?? null,
    ...overrides,
  };
}

describe("PanelZone panel wall", () => {
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
      { id: "files", pageId: "files", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
    ];
    mocks.activeTabId = "terminal";
    mocks.layout = wall(["files", "terminal"]);

    const { container } = render(<PanelZone />);
    expect(container.querySelectorAll(".panel-wall-cell")).toHaveLength(2);
    expect(container.querySelectorAll(".panel-card")).toHaveLength(2);
  });

  it("shows the card title in the card header", () => {
    mocks.tabs = [{ id: "files", pageId: "files", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    expect(container.querySelector(".panel-card-title")?.textContent).toBe("Files");
  });

  it("splits the wall into two columns from the third card on", () => {
    mocks.tabs = [
      { id: "files", pageId: "files", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
      { id: "browser", pageId: "browser", title: "Browser" },
    ];
    mocks.activeTabId = "browser";
    mocks.layout = wall(["files", "terminal", "browser"]);

    const { container } = render(<PanelZone />);
    expect(container.querySelector(".panel-zone")?.getAttribute("data-wall-columns")).toBe("2");
    // Three cards plus the empty cell that offers another panel.
    expect(container.querySelectorAll(".panel-wall-cell")).toHaveLength(4);
    expect(container.querySelectorAll(".panel-card")).toHaveLength(3);
  });

  it("names the separator between two columns after the cards on both sides", () => {
    mocks.tabs = [
      { id: "files", pageId: "files", title: "Files" },
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
      { id: "files", pageId: "files", title: "Files" },
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
      { id: "files", pageId: "files", title: "Files" },
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
    mocks.tabs = [{ id: "files", pageId: "files", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    expect(screen.queryByTestId("panel-popout-files")).toBeNull();
    expect(container.querySelectorAll(".panel-card")).toHaveLength(1);
  });

  it("renders a detached pane as a placeholder that mounts no panel component", async () => {
    const cleanup = installPanelWindowBridge();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: true, alwaysOnTop: false });
    mocks.tabs = [{ id: "files", pageId: "files", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    const { container } = render(<PanelZone />);
    await waitFor(() => {
      expect(container.querySelector(".panel-card-detached")).toBeTruthy();
    });
    // The placeholder keeps the grid slot but mounts no panel surface.
    expect(screen.queryByTestId("browser-files")).toBeNull();
    expect(screen.getByTestId("panel-return-files")).toBeTruthy();
    cleanup();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: false, alwaysOnTop: false });
  });

  it("pops a card out through the bridge and swaps it for the placeholder", async () => {
    const cleanup = installPanelWindowBridge();
    mocks.panelWindow.getState.mockResolvedValue({ ok: true, detached: false, alwaysOnTop: false });
    mocks.panelWindow.open.mockResolvedValue({ ok: true, paneId: "files", windowId: 2 });
    mocks.tabs = [{ id: "files", pageId: "files", title: "Files", params: { filePath: "E:/demo/AGENTS.md" } }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    render(<PanelZone />);
    const popout = await screen.findByTestId("panel-popout-files");
    popout.click();

    await waitFor(() => {
      expect(mocks.panelWindow.open).toHaveBeenCalledWith(
        "files",
        "files",
        "Files",
        { filePath: "E:/demo/AGENTS.md" },
      );
      expect(screen.getByTestId("panel-return-files")).toBeTruthy();
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
    mocks.tabs = [{ id: "files", pageId: "files", title: "Files" }];
    mocks.activeTabId = "files";
    mocks.layout = wall(["files"]);

    render(<PanelZone />);
    // Wait until the effect has subscribed, so the sink holds the callback.
    await screen.findByTestId("panel-return-files");
    expect(eventSink.current).not.toBeNull();

    const returnBtn = screen.getByTestId("panel-return-files");
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
