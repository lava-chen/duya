// @vitest-environment jsdom

/**
 * WorkflowPanel.test.tsx — plan 552 Phase 7 console (ZCode-parity).
 *
 * Covers the two-tab shell, the definition library (scope grouping +
 * read-only path), the runs split (in-progress vs finished), the evidence
 * view (lineage, stats strip, phase N/M trail, per-step rows with exit
 * code / ms / size, artifacts), and the stop/delete affordances.
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  WorkflowPanel,
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

const list = vi.fn();
const journalFn = vi.fn();
const del = vi.fn();
const cancel = vi.fn();
const dwfList = vi.fn();
const run = vi.fn();

Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: {
    workflow: {
      list,
      journal: journalFn,
      delete: del,
      cancel,
      run,
      dwf: { list: dwfList },
    },
  },
});

beforeEach(() => {
  list.mockReset().mockResolvedValue(runs);
  journalFn.mockReset().mockResolvedValue(journal);
  del.mockReset().mockResolvedValue(true);
  cancel.mockReset().mockResolvedValue({ ok: true });
  dwfList.mockReset().mockResolvedValue({ entries: dwfEntries, invalid: dwfInvalid, dirs: [] });
  run.mockReset().mockResolvedValue({ ok: true, runId: "new-run-1" });
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

// ─── shell + definitions tab (dwf library) ───

describe("WorkflowPanel shell", () => {
  it("defaults to the definitions tab and renders scope groups", async () => {
    render(<WorkflowPanel />);
    await waitFor(() => expect(dwfList).toHaveBeenCalled());
    expect(screen.getByTestId("workflow-tab-definitions").getAttribute("aria-selected")).toBe("true");

    await waitFor(() => expect(screen.getByTestId("workflow-def-repo-digest")).toBeTruthy());
    expect(screen.getByTestId("workflow-def-release-tag-recommendation")).toBeTruthy();
    // Scope group headers carry counts.
    expect(screen.getByText(/panel\.workflow\.scopeProject · 1/)).toBeTruthy();
    expect(screen.getByText(/panel\.workflow\.scopeGlobal · 1/)).toBeTruthy();
    // Unreadable files are named, not silently dropped.
    expect(screen.getByText(/panel\.workflow\.invalidFiles · 1/)).toBeTruthy();
    expect(screen.getByText(/broken\.dwf\.ts/)).toBeTruthy();
    expect(screen.getByText(/frontmatter: missing description/)).toBeTruthy();
  });

  it("definition cards show the authoritative file path and arg metadata", async () => {
    render(<WorkflowPanel />);
    await waitFor(() => expect(screen.getByTestId("workflow-def-repo-digest")).toBeTruthy());
    const card = screen.getByTestId("workflow-def-repo-digest");
    expect(card.textContent).toContain("/repo/.duya/workflows/repo-digest.dwf.ts");
    expect(card.textContent).toContain("panel.workflow.paramsShort · 2");
  });

  it("passes the project directory through to the definition library", async () => {
    render(<WorkflowPanel tab={{ params: { workingDirectory: "/repo" } }} />);
    await waitFor(() => expect(dwfList).toHaveBeenCalledWith("/repo"));
  });

  it("the launch dialog fills declared args and runs against the chosen project", async () => {
    render(<WorkflowPanel tab={{ params: { workingDirectory: "/repo" } }} />);
    await waitFor(() => expect(screen.getByTestId("workflow-def-repo-digest")).toBeTruthy());

    // Run opens the 实参窗 (project + args), it does not fire immediately.
    fireEvent.click(within(screen.getByTestId("workflow-def-repo-digest")).getByTestId("workflow-run-repo-digest"));
    expect(screen.getByTestId("workflow-launch-repo-digest")).toBeTruthy();

    // Declared default is seeded into the string arg.
    const tagInput = within(screen.getByTestId("workflow-launch-arg-tag")).getByRole("textbox") as HTMLInputElement;
    expect(tagInput.value).toBe("latest");

    // Fill the required number arg + confirm.
    const daysInput = within(screen.getByTestId("workflow-launch-arg-days")).getByRole("spinbutton");
    fireEvent.change(daysInput, { target: { value: "7" } });
    fireEvent.change(screen.getByTestId("workflow-launch-project"), { target: { value: "/other" } });
    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));

    await waitFor(() =>
      expect(window.electronAPI.workflow.run).toHaveBeenCalledWith({
        name: "repo-digest",
        params: { days: 7, tag: "latest" },
        projectDir: "/other",
      }),
    );
  });

  it("a missing required arg blocks the launch with an inline error", async () => {
    render(<WorkflowPanel tab={{ params: { workingDirectory: "/repo" } }} />);
    await waitFor(() => expect(screen.getByTestId("workflow-def-repo-digest")).toBeTruthy());
    fireEvent.click(within(screen.getByTestId("workflow-def-repo-digest")).getByTestId("workflow-run-repo-digest"));

    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));
    await waitFor(() => expect(screen.getByTestId("workflow-launch-error")).toBeTruthy());
    expect(screen.getByTestId("workflow-launch-error").textContent).toContain("days");

    const runFn = window.electronAPI.workflow.run as unknown as ReturnType<typeof vi.fn>;
    expect(runFn).not.toHaveBeenCalled();
  });

  it("a successful launch flips the panel to the runs tab", async () => {
    render(<WorkflowPanel tab={{ params: { workingDirectory: "/repo" } }} />);
    await waitFor(() => expect(screen.getByTestId("workflow-def-repo-digest")).toBeTruthy());
    fireEvent.click(within(screen.getByTestId("workflow-def-repo-digest")).getByTestId("workflow-run-repo-digest"));
    fireEvent.change(screen.getByTestId("workflow-launch-arg-days").querySelector("input")!, {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByTestId("workflow-launch-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("workflow-tab-runs").getAttribute("aria-selected")).toBe("true"),
    );
  });
});

// ─── runs tab ───

describe("runs tab", () => {
  async function openRuns() {
    render(<WorkflowPanel />);
    fireEvent.click(screen.getByTestId("workflow-tab-runs"));
    await waitFor(() => expect(screen.getByTestId("workflow-run-run-live-1")).toBeTruthy());
  }

  it("splits in-progress from finished with counts", async () => {
    await openRuns();
    expect(screen.getByText(/panel\.workflow\.running · 2/)).toBeTruthy(); // active + blocked
    expect(screen.getByText(/panel\.workflow\.finished · 1/)).toBeTruthy(); // complete
    expect(screen.getByText("awaiting approval at approve-payment")).toBeTruthy();
  });

  it("live runs offer stop; finished runs offer delete", async () => {
    await openRuns();
    const liveRow = screen.getByTestId("workflow-run-run-live-1");
    expect(within(liveRow).getByRole("button", { name: /panel\.workflow\.stop/ })).toBeTruthy();
    const finishedRow = screen.getByTestId("workflow-run-run-2");
    expect(within(finishedRow).getByRole("button", { name: /panel\.workflow\.delete/ })).toBeTruthy();
  });

  it("expanding a run shows lineage, summary, phase timeline, per-step evidence and artifacts", async () => {
    await openRuns();
    fireEvent.click(
      within(screen.getByTestId("workflow-run-run-2")).getByRole("button", {
        name: /panel\.workflow\.(expand|collapse)/,
      }),
    );
    await waitFor(() => expect(journalFn).toHaveBeenCalledWith("run-2"));

    // Lineage (retry_of → the source run).
    await waitFor(() => expect(screen.getByTestId("workflow-lineage-run-2")).toBeTruthy());
    expect(screen.getByTestId("workflow-lineage-run-2").textContent).toContain("run-live-1".slice(0, 12));

    // Summary line (sub-agents · done/total steps · tokens).
    const statsText = screen.getByTestId("workflow-run-run-2").textContent ?? "";
    expect(statsText).toContain("panel.workflow.summaryLine");

    // Phase timeline: merged 'collect' node with N/M progress + agent lamp.
    const timeline = screen.getByTestId("workflow-phase-line-run-2");
    expect(timeline.textContent).toContain("collect");
    expect(timeline.textContent).toContain("3/3");

    // Phase expands into its per-step evidence rows.
    fireEvent.click(within(timeline).getByRole("button", { name: /collect/ }));
    const evidence = screen.getByTestId("workflow-evidence-collect");
    expect(evidence.textContent).toContain("fetch-tags");
    expect(evidence.textContent).toContain("exit 0");
    expect(evidence.textContent).toContain("12ms");
    expect(evidence.textContent).toContain("371 B");
    expect(evidence.textContent).toContain("panel.workflow.verified");
    expect(evidence.textContent).toContain("child-se"); // sub-agent lineage link

    // Artifacts section.
    const artifacts = screen.getByTestId("workflow-artifacts-run-2");
    expect(artifacts.textContent).toContain("r1/capture-0.png");
    expect(artifacts.textContent).toContain("2.0 KB");
  });

  it("stops a live run and refreshes", async () => {
    await openRuns();
    fireEvent.click(
      within(screen.getByTestId("workflow-run-run-live-1")).getByRole("button", { name: /panel\.workflow\.stop/ }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("run-live-1"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("deletes a finished run and refreshes", async () => {
    await openRuns();
    fireEvent.click(
      within(screen.getByTestId("workflow-run-run-2")).getByRole("button", { name: /panel\.workflow\.delete/ }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledWith("run-2"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
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
