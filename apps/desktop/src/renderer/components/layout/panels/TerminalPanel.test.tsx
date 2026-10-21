// @vitest-environment jsdom

// Component tests for the terminal appearance upgrade (plan: sidebar terminal
// rendering upgrade). xterm and the terminal IPC bridge are mocked so the
// renderer paths — WebGL/Unicode11 wiring, font zoom, theme presets — can be
// asserted without a real Electron preload.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";
import type { PageTab } from "./registry";
import { useTerminalAppearanceStore } from "@/stores/terminal-appearance-store";

interface SpawnParamsStub {
  id: string;
  shell?: string;
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
}

const mocks = vi.hoisted(() => {
  const termSurface = {
    cols: 80,
    rows: 24,
    options: { fontSize: 13, theme: {} as Record<string, unknown> },
    unicode: { activeVersion: "" },
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    getSelection: vi.fn(() => ""),
    clearSelection: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
  };
  return {
    termSurface,
    termCtorOptions: [] as Record<string, unknown>[],
    addonInstances: { unicode11: [] as unknown[], webgl: [] as unknown[] },
    webglShouldThrow: { value: false },
    spawnTerminal: vi.fn(),
    resizeTerminal: vi.fn(async () => true),
    writeToTerminal: vi.fn(async () => true),
    killTerminal: vi.fn(async () => true),
    suggestTerminalCommand: vi.fn(async () => []),
    onTerminalOutput: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {}),
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    constructor(options: Record<string, unknown>) {
      mocks.termCtorOptions.push(options);
      Object.assign(this, mocks.termSurface);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit() {
      /* no-op */
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class WebLinksAddon {
    /* no-op */
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class Unicode11Addon {
    constructor() {
      mocks.addonInstances.unicode11.push(this);
    }
    activate() {
      /* no-op */
    }
    dispose() {
      /* no-op */
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    constructor() {
      if (mocks.webglShouldThrow.value) throw new Error("WebGL2 unavailable");
      mocks.addonInstances.webgl.push(this);
    }
    onContextLoss() {
      return { dispose() {} };
    }
    dispose() {
      /* no-op */
    }
  },
}));

vi.mock("@/lib/terminal-ipc", () => ({
  spawnTerminal: mocks.spawnTerminal,
  resizeTerminal: mocks.resizeTerminal,
  writeToTerminal: mocks.writeToTerminal,
  killTerminal: mocks.killTerminal,
  suggestTerminalCommand: mocks.suggestTerminalCommand,
  onTerminalOutput: mocks.onTerminalOutput,
  onTerminalExit: mocks.onTerminalExit,
}));

class ResizeObserverStub {
  observe() {
    /* no-op */
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    /* no-op */
  }
}

const TAB: PageTab = { id: "term-1", pageId: "terminal", title: "Terminal" };

function appearanceButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".terminal-appearance-btn"));
}

function openMenu(container: HTMLElement) {
  fireEvent.click(appearanceButtons(container)[2]);
}

function rendererBadge(container: HTMLElement) {
  return container.querySelector(".terminal-appearance-menu-foot-renderer")?.textContent;
}

function themeBackground(): string | undefined {
  const theme = mocks.termSurface.options.theme as { background?: string };
  return theme.background;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  mocks.termCtorOptions.length = 0;
  mocks.addonInstances.unicode11.length = 0;
  mocks.addonInstances.webgl.length = 0;
  mocks.webglShouldThrow.value = false;
  mocks.termSurface.options = { fontSize: 13, theme: {} };
  mocks.termSurface.unicode = { activeVersion: "" };
  useTerminalAppearanceStore.setState({ fontSize: 13, themeId: "auto" });
  mocks.spawnTerminal.mockImplementation(async (params: SpawnParamsStub) => ({
    ok: true,
    handle: {
      id: params.id,
      pid: 4321,
      shell: params.shell ?? "bash",
      cwd: params.cwd ?? "/workspace",
      title: params.title ?? "Terminal",
      status: "running",
      createdAt: 0,
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TerminalPanel appearance", () => {
  it("enables the proposed API, loads Unicode 11 and activates version 11", async () => {
    render(<TerminalPanel tab={TAB} />);
    await waitFor(() => expect(mocks.spawnTerminal).toHaveBeenCalled());

    expect(mocks.termCtorOptions[0]?.allowProposedApi).toBe(true);
    expect(mocks.addonInstances.unicode11).toHaveLength(1);
    expect(mocks.termSurface.unicode.activeVersion).toBe("11");
  });

  it("loads the WebGL renderer and reports it in the menu", async () => {
    const { container } = render(<TerminalPanel tab={TAB} />);
    await waitFor(() => expect(mocks.addonInstances.webgl).toHaveLength(1));
    expect(mocks.termSurface.loadAddon).toHaveBeenCalledWith(mocks.addonInstances.webgl[0]);

    openMenu(container);
    await waitFor(() => expect(rendererBadge(container)).toBe("WebGL"));
  });

  it("falls back to the DOM renderer when WebGL is unavailable", async () => {
    mocks.webglShouldThrow.value = true;
    const { container } = render(<TerminalPanel tab={TAB} />);
    await waitFor(() => expect(mocks.spawnTerminal).toHaveBeenCalled());

    expect(mocks.addonInstances.webgl).toHaveLength(0);
    openMenu(container);
    await waitFor(() => expect(rendererBadge(container)).toBe("DOM"));
  });

  it("zooms the font size from the control and applies it to the terminal", async () => {
    const { container } = render(<TerminalPanel tab={TAB} />);
    await waitFor(() => expect(mocks.spawnTerminal).toHaveBeenCalled());

    const [decrease, increase] = appearanceButtons(container);
    fireEvent.click(increase);
    await waitFor(() => expect(mocks.termSurface.options.fontSize).toBe(14));
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(14);

    fireEvent.click(decrease);
    await waitFor(() => expect(mocks.termSurface.options.fontSize).toBe(13));
  });

  it("zooms via the Ctrl/Cmd +/-/0 shortcuts", async () => {
    render(<TerminalPanel tab={TAB} />);
    await waitFor(() => expect(mocks.spawnTerminal).toHaveBeenCalled());

    const handler = mocks.termSurface.attachCustomKeyEventHandler.mock.calls[0][0] as (
      event: Partial<KeyboardEvent>,
    ) => boolean;

    act(() => {
      expect(handler({ type: "keydown", ctrlKey: true, key: "=" })).toBe(false);
    });
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(14);

    act(() => {
      expect(handler({ type: "keydown", ctrlKey: true, key: "-" })).toBe(false);
    });
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(13);

    act(() => {
      expect(handler({ type: "keydown", ctrlKey: true, key: "0" })).toBe(false);
    });
    expect(useTerminalAppearanceStore.getState().fontSize).toBe(13);

    // Unmodified keys pass through to the shell.
    expect(handler({ type: "keydown", key: "=" })).toBe(true);
  });

  it("applies a selected theme preset to the terminal", async () => {
    const { container } = render(<TerminalPanel tab={TAB} />);
    await waitFor(() => expect(mocks.spawnTerminal).toHaveBeenCalled());

    openMenu(container);
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".terminal-appearance-menu-item"),
    );
    // Preset order: auto, tokyonight, dracula, nord, solarized, gruvbox.
    expect(items.length).toBeGreaterThan(2);
    fireEvent.click(items[2]);

    await waitFor(() => expect(useTerminalAppearanceStore.getState().themeId).toBe("dracula"));
    await waitFor(() => expect(themeBackground()).toBe("#282a36"));
  });
});
