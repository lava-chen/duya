// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageTab } from "./panels/registry";
import type { WorkspaceLayout } from "./panels/layout-model";

const mocks = vi.hoisted(() => ({
  activeTabId: "agent-one",
  tabs: [] as PageTab[],
  layout: { columns: [], activePaneId: null } as WorkspaceLayout,
}));

vi.mock("@/hooks/usePanel", () => ({
  MAX_PANEL_RATIO: 0.6,
  MAX_PANEL_WIDTH: 1120,
  MIN_CHAT_WIDTH: 680,
  MIN_PANEL_WIDTH: 300,
  usePanel: () => ({
    panelOpen: true,
    panelWidth: 760,
    setPanelOpen: vi.fn(),
    setPanelWidth: vi.fn(),
    togglePanel: vi.fn(),
    openOrActivatePage: vi.fn(),
    rememberUserWidth: vi.fn(),
    resetPanelWidth: vi.fn(),
    tabs: mocks.tabs,
    activeTabId: mocks.activeTabId,
    layout: mocks.layout,
    workspaceExpanded: false,
    setWorkspaceExpanded: vi.fn(),
    setColumnWidths: vi.fn(),
    setPaneRatio: vi.fn(),
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

vi.mock("./PanelHeader", () => ({ PanelHeader: () => <div data-testid="panel-header" /> }));
// The real handle carries the accessible name of the separator, so the mock
// keeps the same attributes: the naming of the pane tree is what is under
// test here.
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
  const descriptor = {
    id: "browser",
    labelKey: "panel.browser",
    minWidth: 460,
    component: Browser,
  };
  const launcher = { ...descriptor, id: "review", labelKey: "panel.review" };
  return {
    PAGE_REGISTRY: { browser: descriptor, review: launcher },
    getPageDescriptor: () => descriptor,
  };
});

import { PanelZone } from "./PanelZone";

function column(id: string, panes: string[], widthRatio: number) {
  return {
    id,
    widthRatio,
    panes,
    ratios: panes.map(() => 1 / panes.length),
  };
}

describe("PanelZone browser tabs", () => {
  it("keeps inactive browser tabs mounted while another browser tab is active", () => {
    mocks.tabs = [
      { id: "agent-one", pageId: "browser", title: "First agent tab", params: { kind: "agent", sessionId: "one" } },
      { id: "agent-two", pageId: "browser", title: "Second agent tab", params: { kind: "agent", sessionId: "two" } },
    ];
    mocks.activeTabId = "agent-one";
    mocks.layout = {
      columns: [column("column-1", ["agent-one", "agent-two"], 1)],
      activePaneId: "agent-one",
    };

    const { rerender } = render(<PanelZone />);
    expect(screen.getByTestId("browser-agent-one")).toBeTruthy();
    expect(screen.getByTestId("browser-agent-two")).toBeTruthy();

    mocks.activeTabId = "agent-two";
    mocks.layout = { ...mocks.layout, activePaneId: "agent-two" };
    rerender(<PanelZone />);
    expect(screen.getByTestId("browser-agent-one")).toBeTruthy();
    expect(screen.getByTestId("browser-agent-two")).toBeTruthy();
  });
});

describe("PanelZone column tree", () => {
  it("renders one column per layout column", () => {
    mocks.tabs = [
      { id: "files", pageId: "files", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
    ];
    mocks.activeTabId = "terminal";
    mocks.layout = {
      columns: [column("column-1", ["files"], 0.5), column("column-2", ["terminal"], 0.5)],
      activePaneId: "terminal",
    };

    const { container } = render(<PanelZone />);
    expect(container.querySelectorAll(".panel-column")).toHaveLength(2);
    expect(container.querySelectorAll(".panel-column-pane")).toHaveLength(2);
  });

  it("names the separator between two columns after the panes on both sides", () => {
    mocks.tabs = [
      { id: "files", pageId: "files", title: "Files" },
      { id: "terminal", pageId: "terminal", title: "Terminal" },
      { id: "browser", pageId: "browser", title: "Browser" },
    ];
    mocks.activeTabId = "browser";
    mocks.layout = {
      columns: [
        column("column-1", ["files"], 0.4),
        column("column-2", ["terminal"], 0.3),
        column("column-3", ["browser"], 0.3),
      ],
      activePaneId: "browser",
    };

    render(<PanelZone />);
    const separators = screen.getAllByRole("separator");
    const labels = separators.map((separator) => separator.getAttribute("aria-label"));
    expect(labels).toContain("调整 Files 和 Terminal，Browser 的大小");
    expect(labels).toContain("调整 Files，Terminal 和 Browser 的大小");
  });

  it("names the separator between two stacked panes after the panes above and below", () => {
    mocks.tabs = [
      { id: "term-1", pageId: "terminal", title: "First terminal" },
      { id: "term-2", pageId: "terminal", title: "Second terminal" },
    ];
    mocks.activeTabId = "term-1";
    mocks.layout = {
      columns: [column("column-1", ["term-1", "term-2"], 1)],
      activePaneId: "term-1",
    };

    render(<PanelZone />);
    // The region's own edge handle is a separator too, so the naming is
    // checked by label rather than by count.
    const labels = screen.getAllByRole("separator")
      .map((separator) => separator.getAttribute("aria-label"));
    expect(labels).toContain("调整 First terminal 和 Second terminal 的大小");
  });
});
