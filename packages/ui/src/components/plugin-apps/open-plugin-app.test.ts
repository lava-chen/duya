import { describe, expect, it, vi } from "vitest";
import type { PanelContextValue } from "@/hooks/usePanel";
import {
  capturePluginAppBinding,
  openPluginApp,
  readPluginAppBinding,
} from "./open-plugin-app";

function panelStub() {
  const openOrActivatePage = vi.fn(
    (_pageId: string, _params?: Record<string, unknown>) => "tab-1",
  );
  return {
    panel: { openOrActivatePage } as unknown as PanelContextValue,
    openOrActivatePage,
  };
}

describe("capturePluginAppBinding", () => {
  it("captures the chat that is selected when the App is opened", () => {
    expect(capturePluginAppBinding("session-a")).toEqual({ sessionId: "session-a" });
  });

  it("captures nothing when no chat is selected", () => {
    expect(capturePluginAppBinding(null)).toBeNull();
    expect(capturePluginAppBinding(undefined)).toBeNull();
    expect(capturePluginAppBinding("")).toBeNull();
  });
});

describe("readPluginAppBinding", () => {
  it("reads a binding out of persisted tab params", () => {
    expect(readPluginAppBinding({ binding: { sessionId: "session-a" } })).toEqual({
      sessionId: "session-a",
    });
  });

  it("treats a missing or malformed binding as absent", () => {
    // Tabs written before bindings existed carry none; they must not crash.
    expect(readPluginAppBinding(undefined)).toBeNull();
    expect(readPluginAppBinding({})).toBeNull();
    expect(readPluginAppBinding({ binding: null })).toBeNull();
    expect(readPluginAppBinding({ binding: "session-a" })).toBeNull();
    expect(readPluginAppBinding({ binding: [] })).toBeNull();
    expect(readPluginAppBinding({ binding: { sessionId: "" } })).toBeNull();
    expect(readPluginAppBinding({ binding: { sessionId: 7 } })).toBeNull();
  });
});

describe("openPluginApp", () => {
  it("opens the plugin-app page with the captured binding", () => {
    const { panel, openOrActivatePage } = panelStub();

    const tabId = openPluginApp(panel, {
      pluginId: "com.duya.demo",
      appId: "board",
      surfaceId: "board-view",
      server: "app",
      title: "Board",
      icon: "panel",
      availability: "session",
      binding: { sessionId: "session-a" },
    });

    expect(tabId).toBe("tab-1");
    expect(openOrActivatePage).toHaveBeenCalledWith("plugin-app", {
      pluginId: "com.duya.demo",
      appId: "board",
      surfaceId: "board-view",
      server: "app",
      title: "Board",
      icon: "panel",
      availability: "session",
      binding: { sessionId: "session-a" },
    });
  });

  it("omits the binding entirely when there is none", () => {
    const { panel, openOrActivatePage } = panelStub();

    openPluginApp(panel, {
      pluginId: "com.duya.demo",
      appId: "board",
      availability: "always",
      binding: null,
    });

    const params = openOrActivatePage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("binding" in params).toBe(false);
    expect(params.availability).toBe("always");
  });

  it("defaults availability to session", () => {
    const { panel, openOrActivatePage } = panelStub();

    openPluginApp(panel, {
      pluginId: "com.duya.demo",
      appId: "board",
      binding: { sessionId: "session-a" },
    });

    const params = openOrActivatePage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.availability).toBe("session");
  });

  it("does nothing outside a panel host", () => {
    expect(openPluginApp(null, {
      pluginId: "com.duya.demo",
      appId: "board",
      binding: { sessionId: "session-a" },
    })).toBeUndefined();
  });
});
