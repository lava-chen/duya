// @vitest-environment jsdom
/**
 * PanelMoreMenu — the "more" menu at the end of the launcher row.
 *
 * The contract pinned here:
 *   - the app catalogue is read lazily (the launcher row is mounted for
 *     every chat, the plugin registry is not needed until the menu opens);
 *   - Mini Apps is a second level: picking an app opens it in the panel;
 *   - the background-task entry opens the background-tasks panel, and
 *     leaves the menu once the panel is open (one-time opener, the way the
 *     reference product treats it).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeThreadId: "thread-1" as string | null,
  openOrActivatePage: vi.fn(),
  setCurrentView: vi.fn(),
  panelTabs: [] as Array<{ id: string; pageId: string }>,
  registryList: vi.fn(),
  listSurfaces: vi.fn(),
  onChanged: undefined as (() => void) | undefined,
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));

vi.mock("@/hooks/usePanel", () => ({
  useOptionalPanel: () => ({
    openOrActivatePage: mocks.openOrActivatePage,
    tabs: mocks.panelTabs,
  }),
}));

vi.mock("@/stores/conversation-store", () => ({
  useConversationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeThreadId: mocks.activeThreadId,
      setCurrentView: mocks.setCurrentView,
    }),
}));

vi.mock("@/lib/plugin-ipc", () => ({
  getPluginAPI: () => ({
    registry: { list: mocks.registryList },
    uiSurfaces: { list: mocks.listSurfaces },
  }),
}));

vi.mock("@/lib/plugin-app-ipc", () => ({
  getPluginAppAPI: () => ({
    open: vi.fn(),
    close: vi.fn(),
    onChanged: (callback: () => void) => {
      mocks.onChanged = callback;
      return () => {
        mocks.onChanged = undefined;
      };
    },
  }),
}));

import { PanelMoreMenu } from "./PanelMoreMenu";

const alwaysSurface = {
  id: "overview",
  pluginId: "com.duya.viewer",
  pluginName: "Viewer",
  appId: "reports",
  title: { en: "Overview", zh: "概览" },
  icon: "chart-bar",
  server: "reports",
  resourceUri: "ui://reports/overview",
  availability: "always" as const,
};

const sessionSurface = {
  ...alwaysSurface,
  id: "activity",
  title: { en: "Activity", zh: "活动" },
  availability: "session" as const,
};

async function openMenu() {
  render(<PanelMoreMenu />);
  fireEvent.click(screen.getByRole("button", { name: "panel.more" }));
  await screen.findByText("apps.title");
}

beforeEach(() => {
  mocks.activeThreadId = "thread-1";
  mocks.panelTabs = [];
  mocks.openOrActivatePage.mockReset();
  mocks.setCurrentView.mockReset();
  mocks.onChanged = undefined;
  mocks.registryList.mockReset().mockResolvedValue({
    success: true,
    data: [{
      id: "com.duya.viewer",
      name: "Viewer",
      description: "Read-only view",
      enabled: true,
      apps: [{ appId: "legacy-view", entry: "index.html" }],
    }],
  });
  mocks.listSurfaces.mockReset().mockResolvedValue({
    success: true,
    data: { surfaces: [alwaysSurface, sessionSurface], conflicts: [] },
  });
});

describe("PanelMoreMenu", () => {
  /**
   * The three cases that wait for the Mini App surface directory carry an
   * explicit timeout.
   *
   * They are the only slow cases in this file: the two that never wait for
   * `listSurfaces` finish in 8-53 ms, while these three measure 10.9-11.6 s
   * each on a developer machine. The vitest default is 30 s per test, so on a
   * loaded CI runner the catalogue read crosses it and the job fails on a
   * timeout that has nothing to do with the assertion.
   *
   * This is not a new problem: the same file failed on master (run #1314) on
   * all three runner images. The cost is in the catalogue read path, which
   * belongs to the UI side; what this file stops doing is turning that cost
   * into a red build for every branch that happens to touch the repo.
   *
   * The assertions are unchanged. Only the deadline moved.
   */
  const SLOW_CATALOGUE_TIMEOUT_MS = 60_000;

  it("reads the app catalogue only after the menu is opened", async () => {
    render(<PanelMoreMenu />);
    expect(mocks.registryList).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "panel.more" }));
    await waitFor(() => expect(mocks.registryList).toHaveBeenCalledTimes(1));
  });

  it("lists the mini apps in a second level and opens the picked one", async () => {
    await openMenu();
    await waitFor(() => expect(mocks.listSurfaces).toHaveBeenCalled());

    fireEvent.mouseEnter(screen.getByText("apps.title"));
    fireEvent.click(await screen.findByText("Overview"));

    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("plugin-app", expect.objectContaining({
      pluginId: "com.duya.viewer",
      appId: "reports",
      surfaceId: "overview",
      server: "reports",
      title: "Overview",
      availability: "always",
    }));
  }, SLOW_CATALOGUE_TIMEOUT_MS);

  it("opens the static entry app of a plugin without a surface", async () => {
    await openMenu();
    await waitFor(() => expect(mocks.listSurfaces).toHaveBeenCalled());

    fireEvent.mouseEnter(screen.getByText("apps.title"));
    fireEvent.click(await screen.findByText("legacy-view"));

    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("plugin-app", expect.objectContaining({
      pluginId: "com.duya.viewer",
      appId: "legacy-view",
      availability: "session",
    }));
  }, SLOW_CATALOGUE_TIMEOUT_MS);

  it("hides a session-scoped app when no chat is active", async () => {
    mocks.activeThreadId = null;
    await openMenu();
    await waitFor(() => expect(mocks.listSurfaces).toHaveBeenCalled());

    fireEvent.mouseEnter(screen.getByText("apps.title"));
    expect(await screen.findByText("Overview")).toBeTruthy();
    expect(screen.queryByText("Activity")).toBeNull();
  }, SLOW_CATALOGUE_TIMEOUT_MS);

  it("offers an App that declared a session-panel placement", async () => {
    mocks.listSurfaces.mockResolvedValue({
      success: true,
      data: {
        surfaces: [alwaysSurface],
        conflicts: [],
        placements: [{
          pluginId: "com.duya.board",
          pluginName: "Board",
          appId: "sprint",
          slot: "session.panel",
          scope: "session",
          surfaceId: "overview",
          server: "reports",
          availability: "always",
          title: { en: "Sprint", zh: "冲刺" },
          icon: "chart-bar",
        }],
      },
    });

    await openMenu();
    await waitFor(() => expect(mocks.listSurfaces).toHaveBeenCalled());

    fireEvent.mouseEnter(screen.getByText("apps.title"));
    fireEvent.click(await screen.findByText("Sprint"));

    // A placement is an entry, not a component: it opens the same sandboxed
    // panel page the catalogue does.
    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("plugin-app", expect.objectContaining({
      pluginId: "com.duya.board",
      appId: "sprint",
      surfaceId: "overview",
      server: "reports",
      availability: "always",
    }));
  });

  it("opens the background-tasks panel from the menu", async () => {
    await openMenu();
    fireEvent.click(screen.getByText("panel.backgroundTasks"));
    expect(mocks.openOrActivatePage).toHaveBeenCalledWith("background-tasks");
  });

  it("drops the background-task entry once the panel is open", async () => {
    mocks.panelTabs = [{ id: "tab-1", pageId: "background-tasks" }];
    await openMenu();
    expect(screen.queryByText("panel.backgroundTasks")).toBeNull();
  });
});
