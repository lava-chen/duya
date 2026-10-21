// @vitest-environment jsdom

/**
 * WorkflowPanel.test.tsx — the workflow console (plan 552 Phase 7).
 *
 * Commit 43e003be moved the desktop renderer into `@duya/ui` and re-cut the
 * console: `WorkflowPanel` is now a navigation stub, and the surface the user
 * actually drives lives under `components/workflow/`:
 *
 *   WorkflowPage          the page shell (定义 / 录制)
 *   WorkflowLibraryView   the saved definition library (scope groups)
 *   WorkflowDetailView    one definition (file path + arg table + history)
 *   WorkflowRunHistory    one workflow's run rows
 *   WorkflowRunDetailView one run (stage rail + per-node evidence)
 *   WorkflowLaunchDialog  the 实参窗 (target project + declared args)
 *
 * The pure helpers (computeRunStats / computePhaseTrail / EvidenceRow / …)
 * still live in WorkflowPanel.tsx and are covered here too.
 */

import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// `t` returns the key, so every assertion below names the exact i18n key the
// product renders — a wording change cannot silently pass. The function is
// stable: a fresh `t` on every render would re-trigger the effects that
// depend on it (the run detail refetches its record on every `t` change).
vi.mock("@/hooks/useTranslation", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

// The agent node body renders its child session as an embedded read-only
// chat, which subscribes to the conversation store. The mock serves both call
// styles this tree uses: the imperative `getState()` and the zustand
// selector form.
const { setActiveThread } = vi.hoisted(() => ({ setActiveThread: vi.fn() }));
vi.mock("@/stores/conversation-store", () => {
  const state = {
    setActiveThread,
    setCurrentView: vi.fn(),
    startNewChat: vi.fn(),
    updateNewChatDraft: vi.fn(),
    messages: {} as Record<string, unknown>,
    loadThreadMessages: vi.fn().mockResolvedValue(undefined),
  };
  const useConversationStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  return {
    useConversationStore: Object.assign(useConversationStore, { getState: () => state }),
  };
});

import {
  EvidenceRow,
  computeRunStats,
  computePhaseTrail,
  computePhaseDetail,
  computeArtifacts,
  evidenceRows,
  statusClass,
  isRunning,
  formatDuration,
  formatCount,
  formatBytes,
  type WorkflowRunRow,
  type DwfWorkflowEntry,
  type WorkflowJournalRecord,
} from "./WorkflowPanel";
import { WorkflowPage } from "@/components/workflow/WorkflowPage";
import { WorkflowLibraryView } from "@/components/workflow/WorkflowLibraryView";
import { WorkflowRunHistory } from "@/components/workflow/WorkflowRunHistory";
import { WorkflowRunDetailView } from "@/components/workflow/WorkflowRunDetailView";
import { WorkflowRunCard } from "@/components/workflow/WorkflowRunCard";
import type { WorkflowRunRecord } from "@/lib/workflow-ipc";
import type { WorkflowRunSse } from "@/types/stream";

// ─── fixtures ───

const runs: WorkflowRunRow[] = [
  {
    id: "run-live-1",
    workflowName: "invoice-sync",
    workflowVersionId: "invoice-sync@1",
    status: "active",
    triggerKind: "cron",
    dedupKey: "cron:invoice-sync:2026-09-21T01:00",
    waitTill: null,
    pauseMessage: null,
    retryOf: null,
    createdAt: 1_000_000,
    updatedAt: 1_120_000,
  },
  {
    id: "run-2",
    workflowName: "invoice-sync",
    workflowVersionId: "invoice-sync@2",
    status: "complete",
    triggerKind: "http",
    dedupKey: null,
    waitTill: null,
    pauseMessage: null,
    retryOf: "run-live-1",
    createdAt: 2_000_000,
    updatedAt: 2_125_000,
  },
  {
    id: "run-3",
    workflowName: "pay-run",
    workflowVersionId: null,
    status: "blocked",
    triggerKind: null,
    dedupKey: null,
    waitTill: 9_000_000,
    pauseMessage: "awaiting approval at approve-payment",
    retryOf: null,
    createdAt: 3_000_000,
    updatedAt: 3_060_000,
  },
];

/** The run-anchored record shape the library surfaces read (WorkflowRunRecord). */
const runRecords: WorkflowRunRecord[] = [
  {
    id: "run-live-1",
    workflowName: "invoice-sync",
    status: "active",
    origin: "library",
    scope: "project",
    projectDir: "/repo",
    parentSessionId: null,
    params: { days: 7 },
    artifacts: [],
    summary: "Digest the repo and report the release tag",
    spentTokens: 1020,
    createdAt: 1_000_000,
    updatedAt: 1_120_000,
    finishedAt: null,
  },
  {
    id: "run-2",
    workflowName: "invoice-sync",
    status: "complete",
    origin: "library",
    scope: "project",
    projectDir: "/repo",
    parentSessionId: null,
    params: { days: 7 },
    artifacts: [],
    summary: "Second pass finished",
    spentTokens: 900,
    createdAt: 2_000_000,
    updatedAt: 2_125_000,
    finishedAt: 2_125_000,
  },
  {
    id: "run-3",
    workflowName: "invoice-sync",
    status: "blocked",
    origin: "library",
    scope: "project",
    projectDir: "/repo",
    parentSessionId: null,
    params: {},
    artifacts: [],
    summary: null,
    spentTokens: null,
    createdAt: 3_000_000,
    updatedAt: 3_060_000,
    finishedAt: null,
  },
];

const journal: WorkflowJournalRecord[] = [
  { seq: 0, kind: "phase", nodeId: "collect", status: "running" },
  {
    seq: 1,
    kind: "node_result",
    nodeId: "fetch-tags",
    status: "succeeded",
    nodeKind: "tool",
    action: "git.tag.list",
    exitCode: 0,
    durationMs: 12,
    outputSize: 371,
    result: "v0.1.1",
  },
  {
    seq: 2,
    kind: "node_result",
    nodeId: "review",
    status: "succeeded",
    nodeKind: "agent",
    action: "general-purpose",
    durationMs: 4200,
    outputSize: 14400,
    childSessionId: "child-session-abcdef",
    usage: { inputTokens: 900, outputTokens: 120 },
    verification: "verified",
    result: { ok: true },
  },
  { seq: 3, kind: "phase", nodeId: "collect", status: "succeeded" },
  {
    seq: 4,
    kind: "artifact",
    nodeId: "shot",
    status: "succeeded",
    action: "capture",
    outputSize: 2048,
    result: { ref: "r1/capture-0.png" },
  },
  {
    seq: 5,
    kind: "decision",
    nodeId: "route",
    status: "succeeded",
    nodeKind: "decision",
    action: "decide",
    result: { department: "billing" },
  },
];

const dwfEntries: DwfWorkflowEntry[] = [
  {
    name: "repo-digest",
    scope: "project",
    description: "Digest the repo",
    path: "/repo/.duya/workflows/repo-digest.dwf.ts",
    args: {
      days: { type: "number", required: true, description: "lookback window" },
      tag: { type: "string", default: "latest" },
    },
  },
  {
    name: "release-tag-recommendation",
    scope: "global",
    description: "Recommend the next tag",
    path: "/home/u/.duya/workflows/release-tag-recommendation.dwf.ts",
  },
];

const dwfInvalid = [
  { path: "/repo/.duya/workflows/broken.dwf.ts", reason: "frontmatter: missing description" },
];

/** The one definition's own detail — its file path and its arg declarations. */
const dwfDetail = {
  ok: true,
  name: "repo-digest",
  path: "/repo/.duya/workflows/repo-digest.dwf.ts",
  scope: "project",
  meta: {
    description: "Digest the repo",
    whenToUse: "before a release",
    args: {
      days: { type: "number", required: true, description: "lookback window" },
      tag: { type: "string", default: "latest" },
    },
  },
  script: "",
  source: "",
  bodyLineOffset: 0,
};

/** The run card's view of one run — the same shape the SSE frames carry. */
const steppedRun: WorkflowRunSse = {
  runId: "run-2",
  workflowName: "invoice-sync",
  status: "complete",
  startedAt: 2_000_000,
  finishedAt: 2_125_000,
  steps: [
    { id: "collect", label: "collect", nodeKind: "phase", status: "success" },
    { id: "fetch-tags", label: "git.tag.list", nodeKind: "tool", status: "success" },
    {
      id: "review",
      label: "general-purpose",
      nodeKind: "agent",
      status: "success",
      childSessionId: "child-session-abcdef",
    },
  ],
  artifacts: [{ name: "capture-0.png", ref: "r1/capture-0.png" }],
};

const list = vi.fn();
const listRuns = vi.fn();
const journalFn = vi.fn();
const del = vi.fn();
const cancel = vi.fn();
const dwfList = vi.fn();
const dwfGet = vi.fn();
const run = vi.fn();
// Plan 560: the 实参窗 submits to the run anchor, not the session anchor.
const trigger = vi.fn();
// The run detail fetches the record by id.
const statusFn = vi.fn();

Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: {
    workflow: {
      list,
      listRuns,
      journal: journalFn,
      delete: del,
      cancel,
      run,
      trigger,
      status: statusFn,
      dwf: { list: dwfList, get: dwfGet },
    },
  },
});

beforeEach(() => {
  // The launch dialog remembers the last run location and the typed args per
  // workflow name — clear them so each case starts from a blank dialog.
  window.localStorage.clear();
  list.mockReset().mockResolvedValue(runs);
  listRuns.mockReset().mockResolvedValue(runRecords);
  journalFn.mockReset().mockResolvedValue(journal);
  del.mockReset().mockResolvedValue(true);
  cancel.mockReset().mockResolvedValue({ ok: true });
  dwfList.mockReset().mockResolvedValue({ entries: dwfEntries, invalid: dwfInvalid, dirs: [] });
  dwfGet.mockReset().mockResolvedValue(dwfDetail);
  run.mockReset().mockResolvedValue({ ok: true, runId: "new-run-1" });
  trigger.mockReset().mockResolvedValue({ ok: true, runId: "new-run-1" });
  statusFn.mockReset().mockImplementation(async (id: string) => runRecords.find((r) => r.id === id) ?? null);
  setActiveThread.mockReset();
});

// ─── pure helpers ───

describe("console helpers", () => {
  it("splits live from finished statuses", () => {
    expect(isRunning("active")).toBe(true);
    expect(isRunning("blocked")).toBe(true);
    expect(isRunning("awaiting_confirm")).toBe(true);
    expect(isRunning("complete")).toBe(false);
    expect(isRunning("failed")).toBe(false);
  });

  it("status classes cover terminal and paused families", () => {
    expect(statusClass("complete")).toContain("emerald");
    expect(statusClass("failed")).toContain("red");
    expect(statusClass("blocked")).toContain("amber");
    expect(statusClass("mystery")).toBeTruthy();
  });

  it("formats duration, counts and bytes", () => {
    expect(formatDuration(0, 45_000)).toBe("45s");
    expect(formatDuration(0, 125_000)).toBe("2m 5s");
    expect(formatCount(1_724_345)).toBe("1.72M");
    expect(formatCount(950)).toBe("950");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("computes run stats from journal evidence (code computes, not the model)", () => {
    const stats = computeRunStats(runs[0], journal);
    expect(stats.durationMs).toBe(120_000);
    expect(stats.tokens).toBe(1020); // 900+120
    expect(stats.subAgents).toBe(1); // one succeeded agent record
    expect(stats.phases).toBe(1); // 'collect'
  });

  it("phase trail carries N/M step progress", () => {
    const trail = computePhaseTrail(journal);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ phaseId: "collect", done: 2, total: 2, status: "succeeded" });
  });

  it("phase detail merges start/end records into one node and groups its steps", () => {
    const detail = computePhaseDetail(journal);
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({
      phaseId: "collect",
      status: "succeeded",
      done: 3,
      total: 3,
    });
    expect(detail[0]!.steps.map((s) => s.nodeId)).toEqual(["fetch-tags", "review", "route"]);
    // Sub-agent climb: the agent-kind step is surfaced for the avatar cluster.
    const agents = detail[0]!.steps.filter((s) => s.nodeKind === "agent");
    expect(agents.map((a) => a.nodeId)).toEqual(["review"]);
  });

  it("phase detail maps failed and pending statuses honestly", () => {
    const failed: WorkflowJournalRecord[] = [
      { seq: 0, kind: "phase", nodeId: "p", status: "running" },
      { seq: 1, kind: "node_result", nodeId: "s1", status: "failed" },
      { seq: 2, kind: "phase", nodeId: "p", status: "failed" },
      { seq: 3, kind: "phase", nodeId: "q", status: "running" },
    ];
    const detail = computePhaseDetail(failed);
    expect(detail).toHaveLength(2);
    expect(detail[0]).toMatchObject({ phaseId: "p", status: "failed", done: 0, total: 1 });
    expect(detail[1]).toMatchObject({ phaseId: "q", status: "running", total: 0 });
  });

  it("artifacts and evidence rows are separated by kind", () => {
    expect(computeArtifacts(journal)).toHaveLength(1);
    const rows = evidenceRows(journal);
    expect(rows.map((r) => r.kind)).toEqual(["node_result", "node_result", "decision"]);
  });
});

// ─── definition library (WorkflowPage / WorkflowLibraryView) ───

describe("definition library", () => {
  it("opens on the definitions tab and renders the library's scope groups", async () => {
    render(<WorkflowPage projectDir="/repo" projectName="repo-project" />);

    // The page opens on the definitions tab, not on the recordings.
    const tabs = screen.getByTestId("automation-tabs");
    expect(
      within(tabs).getByRole("tab", { name: "recorder.tabDefinitions" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(tabs).getByRole("tab", { name: /^recorder\.tab$/ }).getAttribute("aria-selected"),
    ).toBe("false");

    // Both entries are listed, grouped by scope, each group carrying its count.
    await waitFor(() => expect(screen.getByText("repo-digest")).toBeTruthy());
    const globalGroup = screen.getByText("workflow.scopeGlobal");
    expect(within(globalGroup).getByText("1")).toBeTruthy();
    expect(screen.getByText("release-tag-recommendation")).toBeTruthy();
    const projectGroup = screen.getByText("repo-project");
    expect(within(projectGroup).getByText("1")).toBeTruthy();
    expect(screen.getByText("repo-digest")).toBeTruthy();

    // Unreadable files are named, not silently dropped.
    expect(screen.getByText(/1 个 workflow 文件无法识别/)).toBeTruthy();
    expect(screen.getByText(/broken\.dwf\.ts/)).toBeTruthy();
    expect(screen.getByText(/frontmatter: missing description/)).toBeTruthy();
  });

  it("the definition detail shows the authoritative file path and arg metadata", async () => {
    render(<WorkflowPage projectDir="/repo" projectName="repo-project" />);
    await waitFor(() => expect(screen.getByText("repo-digest")).toBeTruthy());

    // The library card opens the definition's own page.
    fireEvent.click(screen.getByText("repo-digest"));
    await waitFor(() =>
      expect(screen.getByText("/repo/.duya/workflows/repo-digest.dwf.ts")).toBeTruthy(),
    );
    // The path shown is the one the loader reported, not a guess.
    expect(dwfGet).toHaveBeenCalledWith({ name: "repo-digest", projectDir: "/repo" });

    // Arg metadata: the declared names, their types, the required flag, the
    // defaults and the per-arg docs.
    const nameInputs = screen.getAllByLabelText("workflow.field.parameters.name") as HTMLInputElement[];
    expect(nameInputs.map((i) => i.value)).toEqual(["days", "tag"]);
    const typeSelects = screen.getAllByLabelText("workflow.field.parameters.type") as HTMLSelectElement[];
    expect(typeSelects.map((s) => s.value)).toEqual(["number", "string"]);
    expect(
      screen.getByLabelText("days workflow.field.parameters.required").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByLabelText("tag workflow.field.parameters.required").getAttribute("aria-checked"),
    ).toBe("false");
    const defaultInputs = screen.getAllByLabelText(
      "workflow.field.parameters.default",
    ) as HTMLInputElement[];
    expect(defaultInputs.map((i) => i.value)).toEqual(["", "latest"]);
    const descInputs = screen.getAllByLabelText("workflow.field.parameters.desc") as HTMLInputElement[];
    expect(descInputs.map((i) => i.value)).toEqual(["lookback window", ""]);
  });

  it("passes the project directory through to the definition library", async () => {
    render(<WorkflowLibraryView projectDir="/repo" />);
    await waitFor(() => expect(dwfList).toHaveBeenCalledWith("/repo"));
  });
});

// ─── launch dialog (WorkflowLaunchDialog) ───

describe("launch dialog", () => {
  /** The library card's ▶ — the entry point into the 实参窗. */
  function openLaunchDialogFor(name: string) {
    const card = screen.getByText(name).parentElement!;
    fireEvent.click(within(card).getByRole("button", { name: "workflow.action.run" }));
  }

  it("the launch dialog fills declared args and runs against the chosen project", async () => {
    render(<WorkflowLibraryView projectDir="/repo" projectName="repo-project" />);
    await waitFor(() => expect(screen.getByText("repo-digest")).toBeTruthy());

    // Run opens the 实参窗 (project + args), it does not fire immediately.
    openLaunchDialogFor("repo-digest");
    expect(screen.getByTestId("workflow-launch-repo-digest")).toBeTruthy();
    expect(trigger).not.toHaveBeenCalled();

    // Declared default is seeded into the string arg.
    const tagInput = within(screen.getByTestId("workflow-launch-arg-tag")).getByRole("textbox") as HTMLInputElement;
    expect(tagInput.value).toBe("latest");

    // Fill the required number arg + confirm. The dialog owns a project
    // option for repo-digest, so the location renders as a select — picking
    // the custom option swaps in the raw path input.
    const daysInput = within(screen.getByTestId("workflow-launch-arg-days")).getByRole("spinbutton");
    fireEvent.change(daysInput, { target: { value: "7" } });
    fireEvent.change(screen.getByTestId("workflow-launch-project-select"), {
      target: { value: "__custom__" },
    });
    fireEvent.change(screen.getByTestId("workflow-launch-project"), { target: { value: "/other" } });
    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));

    await waitFor(() =>
      expect(window.electronAPI.workflow.trigger).toHaveBeenCalledWith({
        name: "repo-digest",
        params: { days: 7, tag: "latest" },
        projectDir: "/other",
        scope: "project",
      }),
    );
    // The run anchor is the only path taken: the session-anchored trigger must
    // not also fire (that would run the workflow twice, in two places).
    expect(window.electronAPI.workflow.run).not.toHaveBeenCalled();
  });

  it("a missing required arg blocks the launch with an inline error", async () => {
    render(<WorkflowLibraryView projectDir="/repo" />);
    await waitFor(() => expect(screen.getByText("repo-digest")).toBeTruthy());
    openLaunchDialogFor("repo-digest");

    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));
    await waitFor(() => expect(screen.getByTestId("workflow-launch-error")).toBeTruthy());
    expect(screen.getByTestId("workflow-launch-error").textContent).toContain("days");

    const triggerFn = window.electronAPI.workflow.trigger as unknown as ReturnType<typeof vi.fn>;
    expect(triggerFn).not.toHaveBeenCalled();
  });

  it("a successful launch hands the new run to the run panel", async () => {
    const events: Array<CustomEvent<{ runId?: string }>> = [];
    const listener = (e: Event) => events.push(e as CustomEvent<{ runId?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", listener);
    try {
      render(<WorkflowLibraryView projectDir="/repo" />);
      await waitFor(() => expect(screen.getByText("repo-digest")).toBeTruthy());
      openLaunchDialogFor("repo-digest");
      fireEvent.change(screen.getByTestId("workflow-launch-arg-days").querySelector("input")!, {
        target: { value: "7" },
      });
      fireEvent.click(screen.getByTestId("workflow-launch-confirm"));

      await waitFor(() => expect(trigger).toHaveBeenCalled());
      // The launch lands on the new run: the app shell turns this event into
      // the run panel (App.tsx listens for it).
      expect(events).toHaveLength(1);
      expect(events[0]!.detail.runId).toBe("new-run-1");
      // The dialog closes on success.
      expect(screen.queryByTestId("workflow-launch-repo-digest")).toBeNull();
    } finally {
      window.removeEventListener("duya:open-workflow-run-panel", listener);
    }
  });
});

// ─── run card + run history + run detail ───

describe("run history and run detail", () => {
  it("a run card's plain click expands the per-node chips instead of opening the detail", () => {
    const events: Array<CustomEvent<{ runId?: string }>> = [];
    const listener = (e: Event) => events.push(e as CustomEvent<{ runId?: string }>);
    window.addEventListener("duya:open-workflow-run-panel", listener);
    try {
      render(<WorkflowRunCard run={steppedRun} />);
      // Collapsed first: the rail headers show, no node chips anywhere.
      expect(screen.queryByText("workflow.nodeKind.tool")).toBeNull();
      // One plain click on the card reveals the chips…
      fireEvent.click(screen.getByText("invoice-sync"));
      expect(screen.getByText("workflow.nodeKind.tool")).toBeTruthy();
      // …and never yanks the user into the run detail.
      expect(events).toHaveLength(0);
      // The explicit ↗ is the path into the run detail.
      fireEvent.click(screen.getByRole("button", { name: "workflow.card.openDetail" }));
      expect(events).toHaveLength(1);
      expect(events[0]!.detail.runId).toBe("run-2");
    } finally {
      window.removeEventListener("duya:open-workflow-run-panel", listener);
    }
  });

  it("the run history marks every run with its own state", async () => {
    const onOpenRun = vi.fn();
    render(
      <WorkflowRunHistory
        workflowName="invoice-sync"
        scope="project"
        projectDir="/repo"
        onOpenRun={onOpenRun}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("workflow-run-history")).toBeTruthy());
    // The history is scoped to one workflow.
    expect(listRuns).toHaveBeenCalledWith({ workflowName: "invoice-sync", limit: 100 });

    // Every run of the workflow is listed, each carrying its own state: the
    // live one, the finished one and the parked one are told apart.
    expect(
      within(screen.getByTestId("workflow-history-row-run-live-1")).getByText("workflow.runUi.running"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("workflow-history-row-run-2")).getByText("workflow.runUi.complete"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("workflow-history-row-run-3")).getByText("workflow.runUi.paused"),
    ).toBeTruthy();
  });

  it("the run detail renders the stage rail from the journal", async () => {
    render(<WorkflowRunDetailView runId="run-2" onBack={() => {}} />);
    await waitFor(() => expect(journalFn).toHaveBeenCalledWith("run-2"));

    const graph = screen.getByTestId("workflow-run-node-graph");
    const rail = within(graph).getByTestId("workflow-stage-rail");
    // The rail shows the phase name and the step counts derived from the journal.
    expect(rail.textContent).toContain("collect");
    expect(rail.textContent).toContain("3/3");
  });

  it("clicking a history row opens the run detail with the run's evidence", async () => {
    const onOpenRun = vi.fn();
    const { unmount } = render(
      <WorkflowRunHistory
        workflowName="invoice-sync"
        scope="project"
        projectDir="/repo"
        onOpenRun={onOpenRun}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("workflow-history-row-run-2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("workflow-history-row-run-2"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    expect(onOpenRun.mock.calls[0]![0].id).toBe("run-2");
    unmount();

    // The run detail that opens carries the run's summary, its stage rail and
    // the per-node evidence behind the rail.
    render(<WorkflowRunDetailView runId="run-2" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("workflow-run-node-graph")).toBeTruthy());
    expect(screen.getByText("Second pass finished")).toBeTruthy();

    const rail = within(screen.getByTestId("workflow-run-node-graph")).getByTestId("workflow-stage-rail");
    expect(rail.textContent).toContain("collect");
    expect(rail.textContent).toContain("3/3");

    // The tool node's evidence: exit code, duration and output size.
    fireEvent.click(screen.getByRole("button", { name: "workflow.nodeKind.tool" }));
    const toolDetail = screen.getByTestId("workflow-node-detail");
    expect(toolDetail.textContent).toContain("workflow.step.exitCode 0");
    expect(toolDetail.textContent).toContain("12ms");
    expect(toolDetail.textContent).toContain("371 B");

    // The agent node's evidence: the verification mark and the child session.
    // The agent body mounts the child's transcript, whose async load settles
    // in a microtask — hence the async act() around the click.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "general-purpose" }));
    });
    const agentDetail = screen.getByTestId("workflow-node-detail");
    expect(agentDetail.textContent).toContain("panel.workflow.verified");
    expect(agentDetail.textContent).toContain("child-session-abcdef");

    // The artifacts the run published ride on the card.
    expect(screen.getByText("capture-0.png")).toBeTruthy();
  });

  it("a live run's detail offers stop and keeps refreshing", async () => {
    render(<WorkflowRunDetailView runId="run-live-1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("workflow-run-node-graph")).toBeTruthy());

    // A live run is stoppable where it stands.
    fireEvent.click(screen.getByRole("button", { name: "workflow.card.stop" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("run-live-1"));

    // The live run keeps being re-read, so the card never goes stale. The
    // poll lands outside React's event loop, hence the act() wrapper.
    await act(async () => {
      await waitFor(() => expect(statusFn.mock.calls.length).toBeGreaterThanOrEqual(2), {
        timeout: 5000,
      });
    });
  });

  it("the back button returns from the run detail to the library", async () => {
    const consumed = vi.fn();
    render(
      <WorkflowPage
        projectDir="/repo"
        projectName="repo-project"
        runRequest={{ runId: "run-2" }}
        onRunRequestConsumed={consumed}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("workflow-run-node-graph")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /workflow\.action\.back/ }));
    await waitFor(() => expect(screen.queryByTestId("workflow-run-node-graph")).toBeNull());
    expect(screen.getByTestId("workflow-library-embedded")).toBeTruthy();
  });
});

// ─── evidence row interaction ───

describe("EvidenceRow", () => {
  it("expands the cached result on click", () => {
    const record = journal[1];
    render(<EvidenceRow record={record} />);
    const row = screen.getByTestId(`evidence-${record.seq}`);
    expect(row.querySelector("pre")).toBeNull();
    fireEvent.click(within(row).getByRole("button"));
    expect(row.querySelector("pre")?.textContent).toContain("v0.1.1");
  });

  it("rows without a result stay collapsed (no affordance)", () => {
    render(<EvidenceRow record={{ seq: 99, kind: "node_result", nodeId: "x", status: "skipped" }} />);
    const row = screen.getByTestId("evidence-99");
    fireEvent.click(within(row).getByRole("button"));
    expect(row.querySelector("pre")).toBeNull();
  });
});
