// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeThreadId: null as string | null,
  includeStaticApp: false,
  translate: (key: string) => key,
  openOrActivatePage: vi.fn(),
  openApp: vi.fn(),
  listSurfaces: vi.fn(),
  onChanged: undefined as ((payload: { pluginId: string }) => void) | undefined,
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
      apps: mocks.includeStaticApp ? [{ appId: "legacy-view", entry: "index.html" }] : [],
    }] }) },
    uiSurfaces: { list: mocks.listSurfaces },
  }),
}));

vi.mock("@/lib/plugin-app-ipc", () => ({
  getPluginAppAPI: () => ({
    open: mocks.openApp,
    onChanged: (callback: (payload: { pluginId: string }) => void) => {
      mocks.onChanged = callback;
      return () => { mocks.onChanged = undefined; };
    },
  }),
}));

import { MiniAppsView } from "./MiniAppsView";
import { PluginAppHost } from "./PluginAppHost";

const alwaysSurface = {
  id: "overview", pluginId: "com.duya.viewer", pluginName: "Viewer", appId: "reports",
  title: { en: "Overview", zh: "概览" }, icon: "chart-bar", server: "reports",
  resourceUri: "ui://reports/overview", availability: "always" as const,
};
const sessionSurface = {
  ...alwaysSurface, id: "activity", title: { en: "Activity", zh: "活动" }, availability: "session" as const,
};

beforeEach(() => {
  mocks.activeThreadId = null;
  mocks.includeStaticApp = false;
  mocks.openOrActivatePage.mockReset();
  mocks.openApp.mockReset();
  mocks.listSurfaces.mockReset().mockResolvedValue({
    success: true, data: { surfaces: [alwaysSurface, sessionSurface], conflicts: [] },
  });
  mocks.onChanged = undefined;
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

  it("keeps static entry launchers available if the surface directory API is unavailable", async () => {
    mocks.includeStaticApp = true;
    mocks.listSurfaces.mockRejectedValue(new Error("surface directory unavailable"));
    render(<MiniAppsView />);
    expect(await screen.findByRole("button", { name: "legacy-view" })).toBeTruthy();
    expect(await screen.findByRole("alert")).toHaveTextContent("surface directory unavailable");
  });
});
