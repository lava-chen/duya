// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { WorkflowPanel, RunRow, statusClass, formatDuration } from "./WorkflowPanel";
import type { WorkflowRunRow, WorkflowJournalRecord } from "./WorkflowPanel";

const runs: WorkflowRunRow[] = [
  {
    id: "run-1",
    workflowName: "invoice-sync",
    workflowVersionId: "invoice-sync@1",
    status: "complete",
    triggerKind: "cron",
    dedupKey: "cron:invoice-sync:2026-09-21T01:00",
    waitTill: null,
    pauseMessage: null,
    createdAt: 1_000_000,
    updatedAt: 1_005_000,
  },
  {
    id: "run-2",
    workflowName: "pay-run",
    workflowVersionId: null,
    status: "blocked",
    triggerKind: "http",
    dedupKey: null,
    waitTill: 9_000_000,
    pauseMessage: "awaiting approval at approve-payment",
    createdAt: 2_000_000,
    updatedAt: 2_010_000,
  },
];

const journal: WorkflowJournalRecord[] = [
  { seq: 0, kind: "phase", nodeId: "work", status: "running", result: { index: 0 } },
  { seq: 1, kind: "phase", nodeId: "work", status: "succeeded", result: { index: 0 } },
  {
    seq: 2,
    kind: "node_result",
    nodeId: "a1",
    status: "succeeded",
    result: null,
    verification: "verified",
  },
];

const list = vi.fn();
const journalFn = vi.fn();
const del = vi.fn();

Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: { workflow: { list, journal: journalFn, delete: del } },
});

describe("WorkflowPanel", () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(runs);
    journalFn.mockReset().mockResolvedValue(journal);
    del.mockReset().mockResolvedValue(true);
  });

  it("renders the run list with status and trigger badges", async () => {
    render(<WorkflowPanel />);
    await waitFor(() => expect(screen.getByText("invoice-sync")).toBeTruthy());
    expect(screen.getByText("pay-run")).toBeTruthy();
    expect(screen.getByText("cron")).toBeTruthy();
    expect(screen.getByText("awaiting approval at approve-payment")).toBeTruthy();
    expect(screen.getByTestId("workflow-run-run-1").className.length).toBeGreaterThan(0);
  });

  it("expands a run and shows the phase trail + journal rows", async () => {
    render(<WorkflowPanel />);
    await waitFor(() => expect(screen.getByText("invoice-sync")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: /show|expand|展开/i })[0]);
    await waitFor(() => expect(journalFn).toHaveBeenCalledWith("run-1"));
    await waitFor(() => expect(screen.getByTestId("workflow-phase-trail-run-1")).toBeTruthy());
    expect(screen.getByText("a1")).toBeTruthy();
    expect(screen.getByText("verified")).toBeTruthy();
  });

  it("deletes a finished run and refreshes", async () => {
    render(<WorkflowPanel />);
    await waitFor(() => expect(screen.getByText("invoice-sync")).toBeTruthy());
    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    // run-1 is complete (deletable); run-2 is blocked (no delete button).
    expect(deleteButtons).toHaveLength(1);
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => expect(del).toHaveBeenCalledWith("run-1"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

describe("RunRow helpers", () => {
  it("status classes cover terminal + paused families", () => {
    expect(statusClass("complete")).toContain("green");
    expect(statusClass("failed")).toContain("red");
    expect(statusClass("blocked")).toContain("yellow");
    expect(statusClass("mystery")).toBeTruthy();
  });

  it("formatDuration renders seconds and minutes", () => {
    expect(formatDuration(0, 45_000)).toBe("45s");
    expect(formatDuration(0, 125_000)).toBe("2m 5s");
  });
});
