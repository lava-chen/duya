// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { PanelProvider, usePanel } from "../usePanel";
import { useConversationStore } from "@/stores/conversation-store";

const PANEL_STORAGE_KEY = "duya:panel:v2:__home__";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(PanelProvider, null, children);
}

describe("panel toggle repro (header open/close/open)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
      tabs: [],
      activeTabId: null,
      panelOpen: false,
      panelView: "picker",
      workspaceExpanded: false,
      workspaceTreeOpen: false,
    }));
  });

  it("replicates header: open -> close -> open -> close", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    // Simulate the exact BotDirectChatView header handler logic (with the
    // panelOpen guard: a collapsed-but-active settings tab must REOPEN, not close).
    const clickHeader = () => {
      const panel = result.current;
      const existing = panel.tabs.find(
        (t) => t.pageId === "bot-settings" && t.params?.agentId === "A",
      );
      if (existing && panel.panelOpen && panel.activeTabId === existing.id) {
        act(() => panel.closePanel(existing.id));
        return;
      }
      act(() => panel.openOrActivatePage("bot-settings", { agentId: "A", title: "Bot A" }));
    };

    // 1st click: opens
    clickHeader();
    expect(result.current.panelOpen).toBe(true);
    expect(result.current.tabs.length).toBe(1);

    // 2nd click: closes
    clickHeader();
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.tabs.length).toBe(0);

    // 3rd click: should reopen
    clickHeader();
    expect(result.current.panelOpen).toBe(true);
    expect(result.current.tabs.length).toBe(1);
    expect(result.current.tabs[0]?.params?.agentId).toBe("A");

    // 4th click: closes again
    clickHeader();
    expect(result.current.panelOpen).toBe(false);
  });

  it("reopens (not closes) when the settings tab is active but the panel was collapsed", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    // Open once, so the tab is installed and active.
    act(() => result.current.openOrActivatePage("bot-settings", { agentId: "A", title: "Bot A" }));
    expect(result.current.panelOpen).toBe(true);

    // Simulate collapse via the sidebar drawer toggle: panelOpen→false while
    // the active tab is left installed.
    act(() => result.current.setPanelOpen(false));
    expect(result.current.panelOpen).toBe(false);
    expect(result.current.activeTabId).not.toBeNull();

    // Header click must REOPEN (not close the leftover tab → "can't open again").
    const clickHeader = () => {
      const panel = result.current;
      const existing = panel.tabs.find(
        (t) => t.pageId === "bot-settings" && t.params?.agentId === "A",
      );
      if (existing && panel.panelOpen && panel.activeTabId === existing.id) {
        act(() => panel.closePanel(existing.id));
        return;
      }
      act(() => panel.openOrActivatePage("bot-settings", { agentId: "A", title: "Bot A" }));
    };
    clickHeader();
    expect(result.current.panelOpen).toBe(true);
    expect(result.current.tabs.some((t) => t.params?.agentId === "A")).toBe(true);
  });
});