// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageTab } from "./page-tab";

const mocks = vi.hoisted(() => ({
  context: { paneId: "pane-1", pageId: "terminal", params: null as Record<string, unknown> | null },
  getState: vi.fn(async () => ({ ok: true, detached: true, alwaysOnTop: false })),
  open: vi.fn(async () => ({ ok: true })),
  close: vi.fn(async () => ({ ok: true })),
  setAlwaysOnTop: vi.fn(async () => ({ ok: true })),
  onEvent: vi.fn((_callback: (event: { type: string }) => void) => () => {}),
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./registry", () => ({
  PAGE_REGISTRY: {
    terminal: {},
    files: {},
  },
  getPageDescriptor: (id: string) => ({
    id,
    labelKey: `panel.${id}`,
    icon: () => <span data-testid="descriptor-icon" />,
    component: ({ tab }: { tab: PageTab }) => (
      <div data-testid={`panel-body-${tab.pageId}-${tab.id}`}>{JSON.stringify(tab.params)}</div>
    ),
  }),
}));

import { DetachedPanelRoot } from "./detached-panel-root";

function installBridge(overrides: Partial<typeof mocks.context> = {}) {
  const context = { ...mocks.context, ...overrides };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    panelWindow: {
      context,
      getState: mocks.getState,
      open: mocks.open,
      close: mocks.close,
      setAlwaysOnTop: mocks.setAlwaysOnTop,
      onEvent: mocks.onEvent,
    },
  };
  return () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.context.params = null;
});

describe("DetachedPanelRoot", () => {
  it("mounts only the hosted panel, with its params from the preload context", () => {
    const cleanup = installBridge({ params: { cwd: "E:/demo" } });
    render(<DetachedPanelRoot />);
    expect(screen.getByTestId("panel-body-terminal-pane-1")).toBeTruthy();
    expect(screen.getByTestId("panel-body-terminal-pane-1").textContent).toContain("E:/demo");
    expect(screen.getByText("panel.terminal")).toBeTruthy();
    // No shell chrome leaks in: no sidebar, no chat composer.
    expect(document.querySelector(".app-shell")).toBeNull();
    cleanup();
  });

  it("seeds the pin state from the main process and toggles it", async () => {
    const cleanup = installBridge();
    mocks.getState.mockResolvedValue({ ok: true, detached: true, alwaysOnTop: true });
    render(<DetachedPanelRoot />);
    const pin = await screen.findByTestId("detached-panel-pin");
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("true"));

    pin.click();
    await waitFor(() => {
      expect(mocks.setAlwaysOnTop).toHaveBeenCalledWith("pane-1", false);
    });
    cleanup();
  });

  it("returns the pane with the context-less close call", async () => {
    const cleanup = installBridge();
    render(<DetachedPanelRoot />);
    const button = await screen.findByTestId("detached-panel-return");
    button.click();
    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    // No pane id: the bridge falls back to the pane this window hosts.
    expect(mocks.close.mock.calls[0].length).toBe(0);
    cleanup();
  });

  it("renders a blank surface when the context is missing or unknown", () => {
    const cleanup = installBridge({ pageId: "not-a-page" });
    const { container } = render(<DetachedPanelRoot />);
    expect(container.querySelector(".detached-panel-root")).toBeTruthy();
    expect(container.querySelector(".detached-panel-body")).toBeNull();
    cleanup();
  });
});
