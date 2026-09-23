// @vitest-environment jsdom

/**
 * workflow-run-card.test.tsx — the run card's stop affordance and the
 * launch dialog's run-location default + memory (2026-09-23 feedback).
 *
 *  1. A running card offers an inline stop button that calls `workflow:cancel`
 *     and surfaces failures — a run must be stoppable where it stands, not
 *     only from the detail view.
 *  2. Clicking the card header dispatches `duya:open-workflow-run-panel`
 *     (the event the side panel's workflow page listens for).
 *  3. The 实参窗 defaults the run location to the workflow file's owning
 *     project, remembers a changed choice per workflow name, and pre-fills it
 *     next time.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { WorkflowRunCard } from "./WorkflowRunCard";
import {
  WorkflowLaunchDialog,
  owningProjectDirOf,
} from "./WorkflowLaunchDialog";
import type { WorkflowRunSse } from "@/types/stream";

// ─── fixtures ───

const runningRun: WorkflowRunSse = {
  runId: "run-live-9",
  workflowName: "xiaohongshu-draft-note",
  status: "active",
  startedAt: 1_000_000,
};

const failedRun: WorkflowRunSse = {
  runId: "run-done-1",
  workflowName: "xiaohongshu-draft-note",
  status: "failed",
  startedAt: 1_000_000,
  finishedAt: 1_060_000,
  error: "boom",
};

const cancel = vi.fn();

Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: {
    workflow: {
      cancel,
      // Launch-dialog success path only needs `trigger`.
      trigger: vi.fn().mockResolvedValue({ ok: true, runId: "new-run-1" }),
    },
  },
});

beforeEach(() => {
  window.localStorage.clear();
  cancel.mockReset().mockResolvedValue({ ok: true });
});

// ─── run card ───

describe("WorkflowRunCard", () => {
  it("a running card offers an inline stop that calls cancel", async () => {
    render(<WorkflowRunCard run={runningRun} />);
    const stop = screen.getByRole("button", { name: "workflow.card.stop" });
    fireEvent.click(stop);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("run-live-9"));
    // No error line appears on success.
    await waitFor(() =>
      expect(screen.queryByText(/workflow\.card\.restartFailed/)).toBeNull(),
    );
  });

  it("a failed cancel surfaces the error on the card", async () => {
    cancel.mockResolvedValue({ ok: false, error: "run is not active in this process" });
    render(<WorkflowRunCard run={runningRun} />);
    fireEvent.click(screen.getByRole("button", { name: "workflow.card.stop" }));
    // The mocked `t` drops interpolation params — the failed-stop line is
    // keyed, its presence is the assertion.
    await waitFor(() =>
      expect(screen.getByText("workflow.card.restartFailed")).toBeTruthy(),
    );
  });

  it("a terminal card has no stop button but keeps rerun", () => {
    render(<WorkflowRunCard run={failedRun} />);
    expect(screen.queryByRole("button", { name: "workflow.card.stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "workflow.card.restart" })).toBeTruthy();
  });

  it("clicking the header dispatches the open-run-panel event", () => {
    const events: Array<CustomEvent<{ runId?: string }>> = [];
    const listener = (e: Event) => events.push(e as CustomEvent<{ runId?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", listener);
    try {
      render(<WorkflowRunCard run={runningRun} />);
      fireEvent.click(screen.getByText("xiaohongshu-draft-note"));
    } finally {
      window.removeEventListener("duya:open-workflow-run-panel", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.detail.runId).toBe("run-live-9");
  });
});

// ─── launch dialog: run-location default + memory ───

describe("WorkflowLaunchDialog run location", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("owningProjectDirOf derives the project from a .dwf.ts path", () => {
    expect(owningProjectDirOf("/repo/.duya/workflows/a.dwf.ts")).toBe("/repo");
    expect(owningProjectDirOf("E:\\Projects\\duya\\.duya\\workflows\\a.dwf.ts")).toBe(
      "E:\\Projects\\duya",
    );
    expect(owningProjectDirOf(undefined)).toBeNull();
  });

  it("a global workflow never defaults its run location to the home directory", () => {
    // Scope gating happens at the call site; the derived path of a
    // `~/.duya/workflows` file is the home dir and must not be used.
    render(
      <WorkflowLaunchDialog
        entry={{
          name: "release-tag",
          scope: "global",
          path: "/home/u/.duya/workflows/release-tag.dwf.ts",
        }}
        defaultProjectDir="/sessions/cwd"
        onClose={() => {}}
      />,
    );
    const select = screen.getByTestId("workflow-launch-project-select") as HTMLSelectElement;
    expect(select.value).toBe("/sessions/cwd");
  });

  function pickCustomDir() {
    // A non-empty current value renders the select; typing an arbitrary path
    // goes through the custom option first.
    fireEvent.change(screen.getByTestId("workflow-launch-project-select"), {
      target: { value: "__custom__" },
    });
  }

  function currentDirValue(): string {
    // With no known projects the dialog renders the raw input; with options
    // it renders a select. Both carry the resolved value.
    const input = screen.queryByTestId("workflow-launch-project");
    if (input) return (input as HTMLInputElement).value;
    const select = screen.getByTestId("workflow-launch-project-select");
    return (select as HTMLSelectElement).value;
  }

  it("defaults the run location to the workflow's owning project", () => {
    render(
      <WorkflowLaunchDialog
        entry={{
          name: "repo-digest",
          scope: "project",
          path: "/repo/.duya/workflows/repo-digest.dwf.ts",
        }}
        defaultProjectDir="/sessions/cwd"
        onClose={() => {}}
      />,
    );
    expect(currentDirValue()).toBe("/repo");
  });

  it("falls back to the caller default and remembers a changed choice", async () => {
    const { unmount } = render(
      <WorkflowLaunchDialog
        entry={{ name: "release-tag", scope: "global" }}
        defaultProjectDir="/sessions/cwd"
        onClose={() => {}}
      />,
    );
    expect(currentDirValue()).toBe("/sessions/cwd");

    // Change the location and launch successfully → the choice is remembered.
    pickCustomDir();
    fireEvent.change(screen.getByTestId("workflow-launch-project"), {
      target: { value: "/other-project" },
    });
    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));
    await waitFor(() =>
      expect(window.electronAPI.workflow.trigger).toHaveBeenCalled(),
    );
    unmount();

    // Next dialog for the same workflow pre-fills the remembered directory —
    // even without a caller default at all.
    render(
      <WorkflowLaunchDialog
        entry={{ name: "release-tag", scope: "global" }}
        onClose={() => {}}
      />,
    );
    expect(currentDirValue()).toBe("/other-project");
  });

  it("a failed launch does not overwrite the remembered location", async () => {
    (window.electronAPI.workflow.trigger as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "boom",
    });
    render(
      <WorkflowLaunchDialog
        entry={{ name: "flaky", scope: "global" }}
        defaultProjectDir="/before"
        onClose={() => {}}
      />,
    );
    pickCustomDir();
    fireEvent.change(screen.getByTestId("workflow-launch-project"), {
      target: { value: "/changed" },
    });
    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));
    await waitFor(() => expect(screen.getByTestId("workflow-launch-error")).toBeTruthy());

    const raw = window.localStorage.getItem("duya:workflow:launch-dirs:v1");
    expect(raw).toBeNull();
  });
});
