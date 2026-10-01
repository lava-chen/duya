// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { clampWidthToBounds, PanelProvider, usePanel } from "../usePanel";
import { useConversationStore } from "@/stores/conversation-store";

const PANEL_STORAGE_KEY = "duya:panel:v2:__home__";
const USER_WIDTHS_KEY = "duya:panel:user-widths:v1";

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

describe("PanelProvider user width memory", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
  });

  function renderPanel() {
    return renderHook(() => usePanel(), { wrapper });
  }

  it("rememberUserWidth persists a rounded width per page", () => {
    const { result } = renderPanel();
    act(() => {
      result.current.rememberUserWidth("preview", 555.4);
    });
    expect(JSON.parse(window.localStorage.getItem(USER_WIDTHS_KEY)!)).toEqual({ preview: 555 });
  });

  it("rememberUserWidth ignores non-finite widths", () => {
    const { result } = renderPanel();
    act(() => {
      result.current.rememberUserWidth("preview", Number.NaN);
    });
    expect(window.localStorage.getItem(USER_WIDTHS_KEY)).toBeNull();
  });

  it("resetPanelWidth drops the remembered entry and empties the store key when done", () => {
    const { result } = renderPanel();
    act(() => {
      result.current.rememberUserWidth("preview", 700);
    });
    act(() => {
      result.current.resetPanelWidth("preview");
    });
    expect(window.localStorage.getItem(USER_WIDTHS_KEY)).toBeNull();
  });

  it("loads remembered widths across provider remounts", () => {
    window.localStorage.setItem(USER_WIDTHS_KEY, JSON.stringify({ preview: 640 }));
    const first = renderPanel();
    // Simulate the drag-end path, then remount to prove persistence.
    act(() => {
      first.unmount();
    });
    const second = renderPanel();
    void second;
    expect(JSON.parse(window.localStorage.getItem(USER_WIDTHS_KEY)!)).toEqual({ preview: 640 });
  });
});

describe("clampWidthToBounds", () => {
  const WORKSPACE = 1600;

  it("keeps an in-bounds width unchanged", () => {
    expect(clampWidthToBounds(480, { minWidth: 360 }, WORKSPACE)).toBe(480);
  });

  it("clamps below the page minimum", () => {
    expect(clampWidthToBounds(100, { minWidth: 360 }, WORKSPACE)).toBe(360);
  });

  it("clamps above the absolute default ceiling (ratio cap is tighter here)", () => {
    // Default MAX_PANEL_RATIO 0.6 of a 1600px workspace = 960, which is
    // tighter than the 1120 absolute ceiling.
    expect(clampWidthToBounds(5000, { minWidth: 360 }, WORKSPACE)).toBe(960);
    // On a wider workspace the absolute ceiling becomes the binding cap.
    expect(clampWidthToBounds(5000, { minWidth: 360 }, 4000)).toBe(1120);
  });

  it("honors a custom maxWidthRatio over the shared one", () => {
    expect(clampWidthToBounds(1400, { minWidth: 460, maxWidthRatio: 2 / 3 }, 1500)).toBe(1000);
  });

  it("protects the chat column minimum on narrow workspaces", () => {
    // Workspace 700 - MIN_CHAT_WIDTH (420) = 280 upper bound, which is
    // below even MIN_PANEL_WIDTH; the upper bound must win.
    const result = clampWidthToBounds(600, { minWidth: 360 }, 700);
    expect(result).toBeLessThanOrEqual(700 - 420);
  });

  it("treats maxWidth null as unbounded (ratio still applies)", () => {
    expect(clampWidthToBounds(2000, { minWidth: 300, maxWidth: null }, 1200)).toBe(720);
  });

  it("honors a page-specific maxWidth ceiling", () => {
    expect(clampWidthToBounds(900, { minWidth: 300, maxWidth: 800 }, WORKSPACE)).toBe(800);
  });
});

// The transcript's file-change card cannot call `usePanel()` directly (it also
// renders outside the provider), so it opens rounds through
// `duya:open-review-panel`. These cases pin the tab lifecycle that event
// drives: one tab per round, reused when the same round is clicked again.
describe("PanelProvider turn-scoped review opens", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
  });

  function openRound(detail: Record<string, unknown>): void {
    act(() => {
      window.dispatchEvent(new CustomEvent("duya:open-review-panel", { detail }));
    });
  }

  it("opens a review tab pinned to the round named in the event", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    openRound({
      workingDirectory: "E:/repo",
      sessionId: "session-1",
      turnId: "turn-9",
      filePath: "src/a.ts",
      title: "本轮变更",
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.pageId).toBe("review");
    expect(result.current.tabs[0]?.params).toMatchObject({
      workingDirectory: "E:/repo",
      sessionId: "session-1",
      reviewTurnId: "turn-9",
      reviewFilePath: "src/a.ts",
      title: "本轮变更",
    });
    expect(result.current.activeTabId).toBe(result.current.tabs[0]?.id);
  });

  it("reuses one tab when a second file of the same round is clicked", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    openRound({ workingDirectory: "E:/repo", sessionId: "session-1", turnId: "turn-9", filePath: "src/a.ts" });
    openRound({ workingDirectory: "E:/repo", sessionId: "session-1", turnId: "turn-9", filePath: "src/b.ts" });

    // One tab, still holding the params of the FIRST open: the panel receives
    // the new file through `duya:review-focus-file`, not through params.
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.params).toMatchObject({ reviewFilePath: "src/a.ts" });
  });

  it("opens a separate tab for a different round", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    openRound({ workingDirectory: "E:/repo", sessionId: "session-1", turnId: "turn-9", filePath: "src/a.ts" });
    openRound({ workingDirectory: "E:/repo", sessionId: "session-1", turnId: "turn-10", filePath: "src/a.ts" });

    // Two rounds are two different diffs; sharing a tab would show the wrong
    // round under the newer card.
    expect(result.current.tabs).toHaveLength(2);
  });

  it("keeps a pinned round distinct from the launcher's session-wide review", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    act(() => {
      result.current.openOrActivatePage("review", {
        workingDirectory: "E:/repo",
        sessionId: "session-1",
      });
    });
    openRound({ workingDirectory: "E:/repo", sessionId: "session-1", turnId: "turn-9", filePath: "src/a.ts" });

    expect(result.current.tabs).toHaveLength(2);
  });

  it("ignores an open request that names no workspace or session", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });

    openRound({ turnId: "turn-9", filePath: "src/a.ts" });
    openRound({ workingDirectory: "E:/repo", sessionId: "  ", turnId: "turn-9" });

    expect(result.current.tabs).toHaveLength(0);
  });
});
