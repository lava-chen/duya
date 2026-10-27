// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { clampWidthToBounds, PanelProvider, usePanel, usePanelGeometry } from "../usePanel";
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
      tabs: [{ id: "canvas-tab", pageId: "workspace", title: "Preview" }],
      activeTabId: "canvas-tab",
      panelOpen: true,
      panelView: "content",
      workspaceExpanded: false,
    }));
  });

  it("preserves the context value when a tab title is already current", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    const initialContext = result.current;

    act(() => {
      result.current.updateTabTitle("canvas-tab", "Preview");
    });

    expect(result.current).toBe(initialContext);
    expect(result.current.tabs[0]?.title).toBe("Preview");
  });

  it("drops persisted tabs whose page no longer exists", () => {
    // A stale localStorage payload written before a page was removed from the
    // registry must not crash (or resurrect) the provider.
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
      tabs: [{ id: "stale", pageId: "preview", title: "Preview" }],
      activeTabId: "stale",
      panelOpen: true,
      panelView: "content",
      workspaceExpanded: false,
    }));
    const { result } = renderHook(() => usePanel(), { wrapper });
    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeTabId).toBeNull();
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
      result.current.rememberUserWidth("workspace", 555.4);
    });
    expect(JSON.parse(window.localStorage.getItem(USER_WIDTHS_KEY)!)).toEqual({ workspace: 555 });
  });

  it("rememberUserWidth ignores non-finite widths", () => {
    const { result } = renderPanel();
    act(() => {
      result.current.rememberUserWidth("workspace", Number.NaN);
    });
    expect(window.localStorage.getItem(USER_WIDTHS_KEY)).toBeNull();
  });

  it("resetPanelWidth drops the remembered entry and empties the store key when done", () => {
    const { result } = renderPanel();
    act(() => {
      result.current.rememberUserWidth("workspace", 700);
    });
    act(() => {
      result.current.resetPanelWidth("workspace");
    });
    expect(window.localStorage.getItem(USER_WIDTHS_KEY)).toBeNull();
  });

  it("loads remembered widths across provider remounts", () => {
    window.localStorage.setItem(USER_WIDTHS_KEY, JSON.stringify({ workspace: 640 }));
    const first = renderPanel();
    // Simulate the drag-end path, then remount to prove persistence.
    act(() => {
      first.unmount();
    });
    const second = renderPanel();
    void second;
    expect(JSON.parse(window.localStorage.getItem(USER_WIDTHS_KEY)!)).toEqual({ workspace: 640 });
  });
});

describe("PanelProvider opening width", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
    // A wide viewport: the chat column keeps a protected minimum, so on a
    // narrow window even a remembered width gets clamped and the two cases
    // below could not tell "remembered" from "clamped".
    Object.defineProperty(window, "innerWidth", { value: 1600, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, writable: true, configurable: true });
  });

  function renderPanel() {
    // The region's width lives in the geometry context, not the panel
    // context — a drag changes it every frame and must not re-render
    // every panel consumer.
    return renderHook(
      () => ({ panel: usePanel(), geometry: usePanelGeometry() }),
      { wrapper },
    );
  }

  it("settles the region width from the page's width ratio when the first card opens", () => {
    // The file panel declares a share of the workspace rather than a fixed
    // pixel width, so opening it must size the region from that share —
    // otherwise the panel opens at its bare minimum.
    const { result } = renderPanel();
    act(() => {
      result.current.panel.openOrActivatePage("workspace", { workingDirectory: "E:/repo" });
    });

    const workspaceWidth = window.innerWidth;
    // The ratio is the contract; the exact pixel value carries a float tail
    // (1600 * 0.55 = 880.0000000000001), so assert the share, not the pixel.
    expect(result.current.geometry.panelWidth / workspaceWidth).toBeCloseTo(0.55, 4);
  });

  it("prefers a remembered width over the page's ratio", () => {
    window.localStorage.setItem(USER_WIDTHS_KEY, JSON.stringify({ workspace: 700 }));
    const { result } = renderPanel();
    act(() => {
      result.current.panel.openOrActivatePage("workspace", { workingDirectory: "E:/repo" });
    });
    expect(result.current.geometry.panelWidth).toBe(700);
  });

  it("restores a wide remembered width after an intentional overlay resize", () => {
    Object.defineProperty(window, "innerWidth", { value: 2400, writable: true, configurable: true });
    window.localStorage.setItem(USER_WIDTHS_KEY, JSON.stringify({ workspace: 1800 }));
    const { result } = renderPanel();
    act(() => {
      result.current.panel.openOrActivatePage("workspace", { workingDirectory: "E:/repo" });
    });
    expect(result.current.geometry.panelWidth).toBe(1800);
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

  it("allows an intentional drag to overlap the chat while preserving a peek", () => {
    expect(clampWidthToBounds(5000, { minWidth: 360 }, WORKSPACE)).toBe(WORKSPACE - 160);
    expect(clampWidthToBounds(5000, { minWidth: 360 }, 4000)).toBe(3840);
  });

  it("uses the page ratio only for its initial width, not for a deliberate drag", () => {
    expect(clampWidthToBounds(1400, { minWidth: 460, maxWidthRatio: 2 / 3 }, 1500)).toBe(1340);
  });

  it("preserves the visible chat strip on narrow workspaces", () => {
    const result = clampWidthToBounds(600, { minWidth: 360 }, 700);
    expect(result).toBeLessThanOrEqual(700 - 160);
  });

  it("treats maxWidth null as unbounded up to the chat peek", () => {
    expect(clampWidthToBounds(2000, { minWidth: 300, maxWidth: null }, 1200)).toBe(1040);
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

describe("PanelProvider plugin UI surfaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
  });

  it("activates the existing tab for repeated opens of the same plugin surface", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    let firstTabId = "";
    act(() => {
      firstTabId = result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.viewer", appId: "reports", surfaceId: "overview", title: "Overview",
      });
    });
    let secondTabId = "";
    act(() => {
      secondTabId = result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.viewer", appId: "reports", surfaceId: "overview", title: "Overview",
      });
    });

    expect(secondTabId).toBe(firstTabId);
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe(firstTabId);
  });

  it("keeps different surfaces as separate tabs", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    act(() => {
      result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.viewer", appId: "reports", surfaceId: "overview", title: "Overview",
      });
      result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.viewer", appId: "reports", surfaceId: "activity", title: "Activity",
      });
    });
    expect(result.current.tabs).toHaveLength(2);
  });

  it("folds repeated opens of an entry App and separates entry Apps by appId", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    let firstTabId = "";
    act(() => {
      firstTabId = result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.canvas", appId: "canvas", title: "canvas",
      });
    });
    act(() => {
      result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.canvas", appId: "canvas", title: "canvas",
      });
    });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe(firstTabId);

    act(() => {
      result.current.openOrActivatePage("plugin-app", {
        pluginId: "com.duya.canvas", appId: "notes", title: "notes",
      });
    });
    expect(result.current.tabs).toHaveLength(2);
  });
});
