// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; pageId: string; title: string }>,
}));

vi.mock("@/hooks/usePanel", () => ({
  usePanel: () => ({
    tabs: mocks.tabs,
    activeTabId: "tab-one",
    activateTab: vi.fn(),
    closePanel: vi.fn(),
    openOrActivatePage: vi.fn(),
    reorderTabs: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/conversation-store", () => ({
  useConversationStore: (selector: (state: unknown) => unknown) => selector({
    activeThreadId: "thread-1",
    threads: [],
  }),
}));

vi.mock("./panels/registry", () => {
  const icon = () => null;
  return {
    PAGE_REGISTRY: {
      files: { id: "files", labelKey: "panel.files", icon },
      review: { id: "review", labelKey: "panel.review", icon },
      conductor: { id: "conductor", labelKey: "panel.conductor", icon },
      terminal: { id: "terminal", labelKey: "panel.terminal", icon },
      browser: { id: "browser", labelKey: "panel.browser", icon },
      office: { id: "office", labelKey: "panel.office", icon },
      preview: { id: "preview", labelKey: "panel.preview", icon },
    },
    getPageDescriptor: (id: string) => ({
      id,
      labelKey: `panel.${id}`,
      icon,
    }),
  };
});

import { PanelHeader } from "./PanelHeader";

describe("PanelHeader tab strip", () => {
  it("renders the add button and menu outside the scrolling tab strip", () => {
    mocks.tabs = [
      { id: "tab-one", pageId: "files", title: "src" },
      { id: "tab-two", pageId: "terminal", title: "bash" },
    ];

    render(<PanelHeader />);

    // Both tabs and the add control are rendered.
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTitle("panel.addPage")).toBeTruthy();

    // Opening the menu must not remove it from the DOM tree on next click.
    const addButton = screen.getByTitle("panel.addPage");
    fireEvent.click(addButton);
    const menu = document.querySelector(".panel-add-menu");
    expect(menu).toBeTruthy();
    expect(within(menu as HTMLElement).getByText("panel.files")).toBeTruthy();

    // The menu lives outside the tab strip container: the tab strip
    // scrolls horizontally and would clip an in-flow menu.
    const tabsEl = document.querySelector(".panel-header-tabs");
    expect(tabsEl).toBeTruthy();
    expect(tabsEl as HTMLElement).not.toContainElement(menu as HTMLElement);
  });
});
