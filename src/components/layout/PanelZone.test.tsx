// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageTab } from "./panels/registry";

const mocks = vi.hoisted(() => ({
  activeTabId: "agent-one",
  tabs: [] as PageTab[],
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
    workspaceExpanded: false,
    setWorkspaceExpanded: vi.fn(),
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
vi.mock("./ResizeHandle", () => ({ ResizeHandle: () => null }));
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
  return {
    PAGE_REGISTRY: { browser: descriptor },
    getPageDescriptor: () => descriptor,
  };
});

import { PanelZone } from "./PanelZone";

describe("PanelZone browser tabs", () => {
  it("keeps inactive browser tabs mounted while another browser tab is active", () => {
    mocks.tabs = [
      { id: "agent-one", pageId: "browser", title: "First agent tab", params: { kind: "agent", sessionId: "one" } },
      { id: "agent-two", pageId: "browser", title: "Second agent tab", params: { kind: "agent", sessionId: "two" } },
    ];
    mocks.activeTabId = "agent-one";

    const { rerender } = render(<PanelZone />);
    expect(screen.getByTestId("browser-agent-one")).toBeTruthy();
    expect(screen.getByTestId("browser-agent-two")).toBeTruthy();

    mocks.activeTabId = "agent-two";
    rerender(<PanelZone />);
    expect(screen.getByTestId("browser-agent-one")).toBeTruthy();
    expect(screen.getByTestId("browser-agent-two")).toBeTruthy();
  });
});
