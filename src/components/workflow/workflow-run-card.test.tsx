// @vitest-environment jsdom

/**
 * workflow-run-card.test.tsx — the run card's stop affordance, the
 * progressive-disclosure chip rail, and the launch dialog's run-location
 * default + memory (2026-09-23 feedback).
 *
 *  1. A running card offers an inline stop button that calls `workflow:cancel`
 *     and surfaces failures — a run must be stoppable where it stands, not
 *     only from the detail view.
 *  2. Clicking the card header dispatches `duya:open-workflow-run-panel`
 *     (the event the side panel's workflow page listens for).
 *  3. The stage rail keeps its per-node chips collapsed by default; one click
 *     reveals them, clicking a chip opens the run in the side panel, and a
 *     second rail click collapses them again.
 *  4. The 实参窗 defaults the run location to the workflow file's owning
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

const steppedRun: WorkflowRunSse = {
  runId: "run-steps-1",
  workflowName: "repo-overview",
  status: "complete",
  startedAt: 1_000_000,
  finishedAt: 1_060_000,
  steps: [
    { id: "p1", label: "并行摸底", nodeKind: "phase", status: "success" },
    { id: "a1", label: "agent:项目解读员", nodeKind: "agent", status: "success" },
  ],
  artifacts: [{ name: "项目速览报告", ref: "run-steps-1/report.md" }],
};

const cancel = vi.fn();
const artifactPath = vi.fn();
const runWorkflow = vi.fn();
const statusLookup = vi.fn();

Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: {
    workflow: {
      cancel,
      artifactPath,
      // Launch-dialog success path only needs `trigger`.
      trigger: vi.fn().mockResolvedValue({ ok: true, runId: "new-run-1" }),
      run: runWorkflow,
      status: statusLookup,
    },
  },
});

beforeEach(() => {
  window.localStorage.clear();
  cancel.mockReset().mockResolvedValue({ ok: true });
  artifactPath.mockReset().mockResolvedValue({ ok: true, path: "C:/art/run-steps-1/report.md" });
  runWorkflow.mockReset().mockResolvedValue({ ok: true, runId: "new-run-2" });
  statusLookup.mockReset().mockResolvedValue(null);
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

  it("the resume button relaunches with the prior run as the cache seed", async () => {
    statusLookup.mockResolvedValue({
      id: "run-done-1",
      workflowName: "xiaohongshu-draft-note",
      params: { topic: "咖啡" },
      projectDir: "E:/proj",
      parentSessionId: "sess-9",
      status: "failed",
      createdAt: 1_000_000,
      updatedAt: 1_060_000,
    });
    render(<WorkflowRunCard run={failedRun} />);
    fireEvent.click(screen.getByRole("button", { name: "workflow.card.resume" }));
    await waitFor(() =>
      expect(runWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "xiaohongshu-draft-note",
          params: { topic: "咖啡" },
          projectDir: "E:/proj",
          sessionId: "sess-9",
          resumeFromRunId: "run-done-1",
        }),
      ),
    );
  });

  it("a failed resume surfaces the error on the card", async () => {
    statusLookup.mockResolvedValue({
      id: "run-done-1",
      workflowName: "xiaohongshu-draft-note",
      params: {},
      status: "failed",
      createdAt: 1,
      updatedAt: 2,
    });
    runWorkflow.mockResolvedValue({ ok: false, error: "agent server not running" });
    render(<WorkflowRunCard run={failedRun} />);
    fireEvent.click(screen.getByRole("button", { name: "workflow.card.resume" }));
    await waitFor(() =>
      expect(screen.getByText("workflow.card.restartFailed")).toBeTruthy(),
    );
  });

  it("the explicit ↗ button dispatches the open-run-panel event", () => {
    const events: Array<CustomEvent<{ runId?: string }>> = [];
    const listener = (e: Event) => events.push(e as CustomEvent<{ runId?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", listener);
    try {
      render(<WorkflowRunCard run={steppedRun} />);
      fireEvent.click(screen.getByRole("button", { name: "workflow.card.openDetail" }));
    } finally {
      window.removeEventListener("duya:open-workflow-run-panel", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.detail.runId).toBe("run-steps-1");
  });

  it("keeps the per-node chips collapsed until the card is clicked", () => {
    const { container } = render(<WorkflowRunCard run={steppedRun} />);
    // Collapsed: only the rail headers show — no agent chip, no script chip.
    expect(screen.queryByText("项目解读员")).toBeNull();
    expect(screen.queryByText("workflow.nodeKind.tool")).toBeNull();

    // One click anywhere on the card reveals the per-node chips.
    fireEvent.click(container.querySelector("[data-workflow-card]")!);
    expect(screen.getByText("项目解读员")).toBeTruthy();

    // Clicking again collapses them.
    fireEvent.click(container.querySelector("[data-workflow-card]")!);
    expect(screen.queryByText("项目解读员")).toBeNull();
  });

  it("an expanded chip opens the run in the side panel without collapsing", () => {
    const events: Array<CustomEvent<{ runId?: string }>> = [];
    const listener = (e: Event) => events.push(e as CustomEvent<{ runId?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", listener);
    const { container } = render(<WorkflowRunCard run={steppedRun} />);
    try {
      fireEvent.click(container.querySelector("[data-workflow-card]")!);
      fireEvent.click(screen.getByRole("button", { name: "项目解读员" }));
    } finally {
      window.removeEventListener("duya:open-workflow-run-panel", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.detail.runId).toBe("run-steps-1");
    // The chip's stopPropagation keeps the card click from toggling — the
    // chips stay open so the user keeps their place.
    expect(screen.getByText("项目解读员")).toBeTruthy();
  });

  it("an agent chip with a child session opens the watch pane instead of the run detail (plan 568)", () => {
    const runEvents: Array<CustomEvent<{ runId?: string }>> = [];
    const sessionEvents: Array<CustomEvent<{ sessionId?: string; title?: string }>> = [];
    const runListener = (e: Event) => runEvents.push(e as CustomEvent<{ runId?: string }>);
    const sessionListener = (e: Event) => sessionEvents.push(e as CustomEvent<{ sessionId?: string; title?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", runListener);
    window.addEventListener("duya:open-session-panel", sessionListener);
    const withChild: WorkflowRunSse = {
      ...steppedRun,
      steps: [
        { id: "p1", label: "并行摸底", nodeKind: "phase", status: "success" },
        { id: "a1", label: "agent:项目解读员", nodeKind: "agent", status: "success", childSessionId: "child-1" },
      ],
    };
    const { container } = render(<WorkflowRunCard run={withChild} />);
    // The chips start collapsed — one card click reveals them (the chip's own
    // stopPropagation keeps them open for the assertion below).
    fireEvent.click(container.querySelector("[data-workflow-card]")!);
    fireEvent.click(screen.getByRole("button", { name: "项目解读员" }));
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]!.detail.sessionId).toBe("child-1");
    expect(sessionEvents[0]!.detail.title).toBe("项目解读员");
    // The run detail must NOT open — the watch pane replaced it.
    expect(runEvents).toHaveLength(0);
    window.removeEventListener("duya:open-workflow-run-panel", runListener);
    window.removeEventListener("duya:open-session-panel", sessionListener);
  });

  it("clicking an artifact chip resolves its ref and opens the file preview", async () => {
    const previews: Array<CustomEvent<{ filePath?: string }>> = [];
    const listener = (e: Event) => previews.push(e as CustomEvent<{ filePath?: string }>);
    window.addEventListener("duya:open-file-preview-panel", listener);
    render(<WorkflowRunCard run={steppedRun} />);
    fireEvent.click(screen.getByRole("button", { name: "项目速览报告" }));
    // Resolution is async — the listener must outlive the click itself.
    await waitFor(() => expect(artifactPath).toHaveBeenCalledWith("run-steps-1/report.md"));
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(previews[0]!.detail.filePath).toBe("C:/art/run-steps-1/report.md");
    window.removeEventListener("duya:open-file-preview-panel", listener);
  });

  it("an artifact whose ref no longer resolves falls back to the run detail", async () => {
    artifactPath.mockResolvedValue({ ok: false, error: "not_found" });
    const runEvents: Array<CustomEvent<{ runId?: string }>> = [];
    const listener = (e: Event) => runEvents.push(e as CustomEvent<{ runId?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", listener);
    render(<WorkflowRunCard run={steppedRun} />);
    fireEvent.click(screen.getByRole("button", { name: "项目速览报告" }));
    await waitFor(() =>
      expect(runEvents.some((e) => e.detail.runId === "run-steps-1")).toBe(true),
    );
    window.removeEventListener("duya:open-workflow-run-panel", listener);
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
