// @vitest-environment jsdom

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  setConfig: vi.fn(),
  subscribeConfigUpdates: vi.fn(() => () => {}),
  cleanupCheckouts: vi.fn(),
}));

vi.mock("@/lib/config-port-bus", () => ({
  getConfigValue: mocks.getConfigValue,
  setConfig: mocks.setConfig,
  subscribeConfigUpdates: mocks.subscribeConfigUpdates,
}));

vi.mock("@/lib/workspace-lifecycle-ipc", () => ({
  cleanupCheckouts: mocks.cleanupCheckouts,
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k) }),
}));

// The settings barrel pulls in `SettingsSelect` (antd); stub the primitives.
vi.mock("@/components/settings/ui", () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsCardFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsInput: ({
    label,
    value,
    onChange,
    disabled,
    error,
    action,
    onKeyDown,
  }: {
    label?: string;
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    error?: string;
    action?: React.ReactNode;
    onKeyDown?: (e: React.KeyboardEvent) => void;
  }) => (
    <div>
      {label && <label>{label}</label>}
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && <p role="alert">{error}</p>}
      {action}
    </div>
  ),
  SettingsInputRow: ({
    label,
    value,
    onChange,
    onBlur,
    disabled,
    error,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    onBlur?: () => void;
    disabled?: boolean;
    error?: string;
  }) => (
    <div>
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  ),
  SettingsToggle: ({
    label,
    checked,
    onCheckedChange,
    disabled,
  }: {
    label: string;
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
      />
      {label}
    </label>
  ),
}));

import { WorktreesSection } from "../WorktreesSection";

function installBridge(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getConfigPort: () => ({}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfigValue.mockResolvedValue(undefined);
  mocks.subscribeConfigUpdates.mockReturnValue(() => {});
  Reflect.deleteProperty(window, "electronAPI");
});

describe("WorktreesSection", () => {
  it("is read-only without a config port", () => {
    render(<WorktreesSection />);

    expect(screen.getByLabelText("settings.worktrees.location")).toBeDisabled();
    expect(screen.getByLabelText("settings.worktrees.cleanupToggle")).toBeDisabled();
    expect(screen.getAllByText("settings.worktrees.readOnly").length).toBeGreaterThan(0);
    expect(mocks.getConfigValue).not.toHaveBeenCalled();
  });

  it("loads the configured root and cleanup settings", async () => {
    installBridge();
    mocks.getConfigValue.mockImplementation(async (key: string) => {
      if (key === "worktreeRoot") return "/data/wt";
      if (key === "worktreeAutoCleanupEnabled") return true;
      if (key === "worktreeKeepCount") return 7;
      return undefined;
    });

    render(<WorktreesSection />);

    await waitFor(() =>
      expect(screen.getByLabelText("settings.worktrees.location")).toHaveValue("/data/wt"),
    );
    expect(screen.getByLabelText("settings.worktrees.cleanupToggle")).toBeChecked();
    expect(screen.getByLabelText("settings.worktrees.keepCount")).toHaveValue("7");
  });

  it("saves an absolute path and rejects a relative one", async () => {
    installBridge();
    mocks.getConfigValue.mockImplementation(async (key: string) =>
      key === "worktreeRoot" ? "" : undefined,
    );

    render(<WorktreesSection />);
    await waitFor(() => expect(mocks.getConfigValue).toHaveBeenCalled());

    const input = screen.getByLabelText("settings.worktrees.location");
    fireEvent.change(input, { target: { value: "relative/path" } });
    fireEvent.click(screen.getByText("settings.worktrees.save"));
    expect(screen.getByRole("alert")).toHaveTextContent("settings.worktrees.invalidPath");
    expect(mocks.setConfig).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "D:\\checkouts" } });
    fireEvent.click(screen.getByText("settings.worktrees.save"));
    expect(mocks.setConfig).toHaveBeenCalledWith("worktreeRoot", "D:\\checkouts");
  });

  it("reset writes an empty root", async () => {
    installBridge();
    mocks.getConfigValue.mockImplementation(async (key: string) =>
      key === "worktreeRoot" ? "/data/wt" : undefined,
    );

    render(<WorktreesSection />);
    await waitFor(() =>
      expect(screen.getByLabelText("settings.worktrees.location")).toHaveValue("/data/wt"),
    );

    fireEvent.click(screen.getByText("settings.worktrees.reset"));
    expect(mocks.setConfig).toHaveBeenCalledWith("worktreeRoot", "");
    expect(screen.getByLabelText("settings.worktrees.location")).toHaveValue("");
  });

  it("toggles automatic cleanup and validates the keep count", async () => {
    installBridge();
    render(<WorktreesSection />);
    await waitFor(() => expect(mocks.getConfigValue).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("settings.worktrees.cleanupToggle"));
    expect(mocks.setConfig).toHaveBeenCalledWith("worktreeAutoCleanupEnabled", true);

    const keep = screen.getByLabelText("settings.worktrees.keepCount");
    fireEvent.change(keep, { target: { value: "0" } });
    fireEvent.blur(keep);
    expect(screen.getByRole("alert")).toHaveTextContent("settings.worktrees.keepCountInvalid");
    expect(mocks.setConfig).not.toHaveBeenCalledWith("worktreeKeepCount", expect.anything());

    fireEvent.change(keep, { target: { value: "25" } });
    fireEvent.blur(keep);
    expect(mocks.setConfig).toHaveBeenCalledWith("worktreeKeepCount", 25);
  });

  it("requires two clicks before cleaning up and reports the result", async () => {
    installBridge();
    mocks.cleanupCheckouts.mockResolvedValue({
      dryRun: false,
      keepCount: 15,
      examined: 4,
      removed: ["/a"],
      retained: [{ root: "/b", reason: "dirty" }],
      failed: [{ root: "/c", message: "boom" }],
    });

    render(<WorktreesSection />);
    await waitFor(() => expect(mocks.getConfigValue).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "settings.worktrees.cleanupNow" }));
    expect(mocks.cleanupCheckouts).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "settings.worktrees.confirmCleanup" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "settings.worktrees.confirmCleanup" }));
    await waitFor(() => expect(mocks.cleanupCheckouts).toHaveBeenCalledWith({ dryRun: false }));

    await waitFor(() => expect(screen.getByText("/a")).toBeInTheDocument());
    expect(screen.getByText("/b — dirty")).toBeInTheDocument();
    expect(screen.getByText("/c — boom")).toBeInTheDocument();
  });
});
