// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { PanelProvider, usePanel } from "../usePanel";
import { useConversationStore } from "@/stores/conversation-store";

const PANEL_STORAGE_KEY = "duya:panel:v2:__home__";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(PanelProvider, null, children);
}

describe("PanelProvider tab metadata", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
      tabs: [{ id: "canvas-tab", pageId: "conductor", title: "Canvas" }],
      activeTabId: "canvas-tab",
      panelOpen: true,
      panelView: "content",
      workspaceExpanded: false,
      workspaceTreeOpen: false,
    }));
  });

  it("preserves the context value when a tab title is already current", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    const initialContext = result.current;

    act(() => {
      result.current.updateTabTitle("canvas-tab", "Canvas");
    });

    expect(result.current).toBe(initialContext);
    expect(result.current.tabs[0]?.title).toBe("Canvas");
  });
});
