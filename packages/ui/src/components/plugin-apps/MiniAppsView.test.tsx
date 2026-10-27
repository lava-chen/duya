// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TestStreamEvent =
  | { type: "tool_use"; toolUse: { id: string; name: string; input: unknown } }
  | { type: "tool_result"; toolResult: { tool_use_id: string; is_error?: boolean } };

const mocks = vi.hoisted(() => ({
  activeThreadId: null as string | null,
  includeStaticApp: false,
  /** Overrides the registry's app list; null keeps the default. */
  registryApps: null as ReadonlyArray<{ appId: string; entry?: string; runtime?: 'agent-run' | 'standalone' }> | null,
  translate: (key: string) => key,
  openOrActivatePage: vi.fn(),
  openApp: vi.fn(),
  listSurfaces: vi.fn(),
  onChanged: undefined as ((payload: { pluginId: string }) => void) | undefined,
  streamListener: undefined as ((events: TestStreamEvent[]) => void) | undefined,
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ locale: "en", t: mocks.translate }),
}));

vi.mock("@/hooks/usePanel", () => ({
  useOptionalPanel: () => ({ openOrActivatePage: mocks.openOrActivatePage }),
}));

vi.mock("@/stores/conversation-store", () => ({
  useConversationStore: (selector: (state: { activeThreadId: string | null }) => unknown) =>
    selector({ activeThreadId: mocks.activeThreadId }),
}));

vi.mock("@/lib/plugin-ipc", () => ({
  getPluginAPI: () => ({
    registry: { list: async () => ({ success: true, data: [{
      id: "com.duya.viewer", name: "Viewer", description: "Read-only view", enabled: true,
      apps: mocks.registryApps ?? (mocks.includeStaticApp ? [{ appId: "legacy-view", entry: "index.html" }] : []),
    }] }) },
    uiSurfaces: { list: mocks.listSurfaces },
  }),
}));

vi.mock("@/lib/plugin-app-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugin-app-ipc")>();
  return {
    ...actual,
    getPluginAppAPI: () => ({
      open: mocks.openApp,
      close: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: (callback: (payload: { pluginId: string }) => void) => {
        mocks.onChanged = callback;
        return () => { mocks.onChanged = undefined; };
      },
    }),
  };
});

vi.mock("@/lib/stream-session-manager", () => ({
  subscribeToStreamingEvents: (_sessionId: string, listener: (events: TestStreamEvent[]) => void) => {
    mocks.streamListener = listener;
    listener([]);
    return () => { mocks.streamListener = undefined; };
  },
}));

import { MiniAppsView } from "./MiniAppsView";
import { PluginAppHost } from "./PluginAppHost";
import { pluginUiEventToolName } from "@/lib/plugin-app-ui-events";
import { getPluginAppDocumentToken, isPluginAppEntryUrl } from "@/lib/plugin-app-ipc";

const alwaysSurface = {
  id: "overview", pluginId: "com.duya.viewer", pluginName: "Viewer", appId: "reports",
  title: { en: "Overview", zh: "姒傝" }, icon: "chart-bar", server: "reports",
  resourceUri: "ui://reports/overview", availability: "always" as const,
};
const sessionSurface = {
  ...alwaysSurface, id: "activity", title: { en: "Activity", zh: "娲诲姩" }, availability: "session" as const,
};

beforeEach(() => {
  mocks.activeThreadId = null;
  mocks.includeStaticApp = false;
  mocks.registryApps = null;
  mocks.openOrActivatePage.mockReset();
  mocks.openApp.mockReset();
  mocks.listSurfaces.mockReset().mockResolvedValue({
    success: true, data: { surfaces: [alwaysSurface, sessionSurface], conflicts: [] },
  });
  mocks.onChanged = undefined;
  mocks.streamListener = undefined;
  // The host reads the theme from <html data-theme>; keep it deterministic.
  document.documentElement.setAttribute("data-theme", "dark");
});

describe("Mini Apps Plugin UI surface directory", () => {
  it("hides session surfaces without a chat and opens always surfaces in the existing panel tabs", async () => {
    render(<MiniAppsView />);
    const overview = await screen.findByRole("button", { name: "Overview" });
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
    fireEvent.click(overview);
    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("plugin-app", expect.objectContaining({
      pluginId: "com.duya.viewer", appId: "reports", surfaceId: "overview", availability: "always",
    }));
  });

  it("shows session surfaces with an active chat and refreshes on plugin lifecycle changes", async () => {
    mocks.activeThreadId = "thread-1";
    render(<MiniAppsView />);
    expect(await screen.findByRole("button", { name: "Activity" })).toBeTruthy();
    const refresh = mocks.onChanged;
    expect(refresh).toBeTypeOf("function");
    await act(async () => {
      refresh?.({ pluginId: "com.duya.viewer" });
    });
    await waitFor(() => expect(mocks.listSurfaces).toHaveBeenCalledTimes(2));
  });

  it("shows a localized failure when the resource cannot be displayed", async () => {
    mocks.openApp.mockResolvedValue({ ok: false, error: "resource_too_large" });
    render(<PluginAppHost pluginId="com.duya.viewer" appId="reports" surfaceId="overview" />);
    expect((await screen.findByRole("alert")).textContent).toBe("apps.resourceTooLarge");
  });

  it("relays only the current surface event from the current opaque-origin frame", async () => {
    const token = "A".repeat(43);
    const entryUrl = `http://127.0.0.1:43127/${token}/index.html`;
    expect(isPluginAppEntryUrl(entryUrl)).toBe(true);
    expect(getPluginAppDocumentToken(entryUrl)).toBe(token);
    mocks.openApp.mockResolvedValue({
      ok: true,
      sessionId: "launch-1",
      launchNonce: "nonce-1",
      entryUrl,
    });
    render(<PluginAppHost
      pluginId="com.duya.viewer"
      appId="reports"
      surfaceId="overview"
      server="reports"
      chatSessionId="thread-1"
      title="Overview"
    />);

    const frame = await screen.findByTitle("Overview") as HTMLIFrameElement;
    const guest = frame.contentWindow;
    expect(guest).toBeTruthy();
    const postMessage = vi.spyOn(guest!, "postMessage");
    // The host also pushes the theme into the frame; this test is about the
    // tool-driven event relay, so count only the event messages.
    const eventMessages = () => postMessage.mock.calls
      .map(([data]) => data as { type?: string })
      .filter((data) => data?.type === "event");
    await waitFor(() => expect(mocks.streamListener).toBeTypeOf("function"));

    const sendMessage = (data: unknown, source: MessageEventSource | null, origin = "null") => {
      window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
    };
    const ready = { channel: "duya.plugin-app", method: "ready", documentToken: token };

    sendMessage(ready, window);
    mocks.streamListener?.([{
      type: "tool_use",
      toolUse: {
        id: "event-1",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "overview" },
      },
    }]);
    expect(eventMessages()).toHaveLength(0);

    sendMessage(ready, guest, "https://remote.example");
    expect(eventMessages()).toHaveLength(0);
    sendMessage(ready, guest);
    expect(eventMessages()).toHaveLength(0);

    mocks.streamListener?.([{
      type: "tool_use",
      toolUse: {
        id: "event-1",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "overview", payload: { recordId: "r-17" } },
      },
    }]);
    expect(eventMessages()).toHaveLength(0);
    mocks.streamListener?.([{
      type: "tool_use",
      toolUse: {
        id: "event-1",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "overview", payload: { recordId: "r-17" } },
      },
    }, {
      type: "tool_result",
      toolResult: { tool_use_id: "event-1", is_error: false },
    }]);
    expect(eventMessages()).toHaveLength(1);

    mocks.streamListener?.([{
      type: "tool_use",
      toolUse: {
        id: "event-1",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "overview", payload: { recordId: "r-17" } },
      },
    }, {
      type: "tool_result",
      toolResult: { tool_use_id: "event-1", is_error: false },
    }, {
      type: "tool_use",
      toolUse: {
        id: "event-2",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "another", payload: { recordId: "r-17" } },
      },
    }, {
      type: "tool_result",
      toolResult: { tool_use_id: "event-2", is_error: false },
    }, {
      type: "tool_use",
      toolUse: {
        id: "event-3",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "overview", payload: { recordId: "r-23" } },
      },
    }, {
      type: "tool_result",
      toolResult: { tool_use_id: "event-3", is_error: false },
    }, {
      type: "tool_use",
      toolUse: {
        id: "event-4",
        name: pluginUiEventToolName("com.duya.viewer", "reports", "select"),
        input: { surfaceId: "overview", payload: { recordId: "report-31" } },
      },
    }, {
      type: "tool_result",
      toolResult: { tool_use_id: "event-4", is_error: true },
    }]);

    expect(eventMessages()).toHaveLength(2);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "duya.plugin-app",
      type: "event",
      documentToken: token,
      surfaceId: "overview",
      eventName: "select",
      payload: { recordId: "r-17" },
    }, "*");
  });

  it("pushes duya's theme into the App and follows later theme switches", async () => {
    const token = "B".repeat(43);
    const entryUrl = `http://127.0.0.1:43128/${token}/index.html`;
    mocks.openApp.mockResolvedValue({
      ok: true,
      sessionId: "launch-2",
      launchNonce: "nonce-2",
      entryUrl,
    });
    // The App cannot read `data-theme` across the sandbox boundary, so the
    // host has to tell it which token set to use.
    document.documentElement.setAttribute("data-theme", "dark");
    render(<PluginAppHost pluginId="com.duya.viewer" appId="canvas" surfaceId="overview" />);

    const frame = await screen.findByTitle("com.duya.viewer app") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const themeMessages = () => postMessage.mock.calls
      .map(([data]) => data as { type?: string; theme?: string })
      .filter((data) => data?.type === "theme");

    // The host pushes the theme once the document has loaded, and again
    // whenever duya's own theme changes.
    fireEvent.load(frame);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "duya.plugin-app",
      type: "theme",
      documentToken: token,
      theme: "dark",
    }, "*");

    document.documentElement.setAttribute("data-theme", "light");
    await waitFor(() => expect(themeMessages().some((data) => data.theme === "light")).toBe(true));
    postMessage.mockRestore();
  });

  it("keeps static entry launchers available if the surface directory API is unavailable", async () => {
    mocks.includeStaticApp = true;
    mocks.listSurfaces.mockRejectedValue(new Error("surface directory unavailable"));
    render(<MiniAppsView />);
    expect(await screen.findByRole("button", { name: "legacy-view" })).toBeTruthy();
    expect(await screen.findByRole("alert")).toHaveTextContent("surface directory unavailable");
  });

  it("opens a static entry App as a panel tab instead of a fullscreen overlay", async () => {
    mocks.includeStaticApp = true;
    mocks.activeThreadId = "thread-1";
    render(<MiniAppsView />);
    fireEvent.click(await screen.findByRole("button", { name: "legacy-view" }));
    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("plugin-app", expect.objectContaining({
      pluginId: "com.duya.viewer", appId: "legacy-view", title: "legacy-view", availability: "session",
    }));
  });

  it("opens a standalone App as a session-independent panel without a chat", async () => {
    mocks.registryApps = [{ appId: "canvas", entry: "index.html", runtime: "standalone" }];
    render(<MiniAppsView />);
    fireEvent.click(await screen.findByRole("button", { name: "canvas" }));
    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("plugin-app", expect.objectContaining({
      pluginId: "com.duya.viewer", appId: "canvas", title: "canvas", availability: "always",
    }));
  });

  it("refuses an agent-run App without a chat session instead of opening a panel", async () => {
    mocks.includeStaticApp = true;
    mocks.activeThreadId = null;
    render(<MiniAppsView />);
    fireEvent.click(await screen.findByRole("button", { name: "legacy-view" }));
    expect(mocks.openOrActivatePage).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("apps.selectChat");
  });
});
