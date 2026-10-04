// @vitest-environment jsdom

/**
 * node-detail.test.tsx — the per-kind node detail viewers behind the
 * workflow node-card links (2026-09-27 upgrade).
 *
 *  1. Record selection: a node's `running` placeholder is superseded by its
 *     terminal record, and gui capture artifacts keyed `${nodeId}#step${i}`
 *     still attach to the node.
 *  2. Per-kind bodies: a tool node surfaces the command and exit code, a
 *     decision node its reason, a human node the verdict (or the awaiting
 *     state), a browser node the landed URL.
 *  3. The agent body's 进入会话 button enters the child session's chat view
 *     (setActiveThread) — the same path the run card's agent chip takes.
 *  4. Screenshot refs resolve through the artifact bridge to `duya-file://`
 *     URLs; unresolved refs degrade to a file chip.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { setActiveThread } = vi.hoisted(() => ({ setActiveThread: vi.fn() }));
// Selector-aware mock, and it must serve BOTH call styles this tree uses:
//   - `node-detail.tsx` reads the store imperatively
//     (`useConversationStore.getState().setActiveThread(...)`);
//   - the agent node body transitively renders `ReadOnlySessionChat`, which
//     subscribes with the zustand selector form
//     (`useConversationStore((state) => state.messages[sessionId])`).
// The previous mock only provided the `getState` object, so rendering the
// agent body threw "(0, useConversationStore) is not a function" before the
// open-session click could be observed. Same shape as ThreadListItem.test.tsx.
vi.mock("@/stores/conversation-store", () => {
  const state = {
    setActiveThread,
    // ReadOnlySessionChat subscribes to both of these on mount; without them
    // the selector returns undefined and the transcript body throws. The real
    // `loadThreadMessages` is async (ReadOnlySessionChat chains `.then` on
    // its return), so the stub must resolve rather than return undefined.
    messages: {} as Record<string, unknown>,
    loadThreadMessages: vi.fn().mockResolvedValue(undefined),
  };
  const useConversationStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  return {
    useConversationStore: Object.assign(useConversationStore, {
      getState: () => state,
    }),
  };
});

import {
  NodeDetailView,
  artifactRefsFor,
  resultScreenshotRefs,
  terminalRecordFor,
} from "./node-detail";
import type { WorkflowJournalRecord } from "@/components/layout/panels/WorkflowPanel";

const artifactPath = vi.fn();
Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: { workflow: { artifactPath } },
});

beforeEach(() => {
  artifactPath.mockReset().mockResolvedValue({ ok: false, error: "resolve failed" });
  setActiveThread.mockReset();
});

// ─── pure selection ───

describe("terminalRecordFor", () => {
  it("supersedes the running placeholder with the terminal record", () => {
    const records = [
      { seq: 1, kind: "node_result", nodeId: "n1" },
      { seq: 2, kind: "node_result", nodeId: "n1" },
    ] as WorkflowJournalRecord[];
    expect(terminalRecordFor(records, "n1")!.seq).toBe(2);
  });

  it("ignores other nodes and non-node records", () => {
    const records = [
      { seq: 1, kind: "phase", nodeId: "n1" },
      { seq: 2, kind: "node_result", nodeId: "other" },
    ] as unknown as WorkflowJournalRecord[];
    expect(terminalRecordFor(records, "n1")).toBeUndefined();
  });
});

describe("artifactRefsFor", () => {
  it("collects per-step gui capture artifacts keyed ${nodeId}#step${i}", () => {
    const records = [
      { seq: 1, kind: "artifact", nodeId: "g1#step0", result: { ref: "r1/capture-0.png" } },
      { seq: 2, kind: "artifact", nodeId: "g1#step1", result: { ref: "r1/capture-1.png" } },
      { seq: 3, kind: "artifact", nodeId: "g2#step0", result: { ref: "r1/other.png" } },
    ] as unknown as WorkflowJournalRecord[];
    expect(artifactRefsFor(records, "g1")).toEqual(["r1/capture-0.png", "r1/capture-1.png"]);
  });
});

describe("resultScreenshotRefs", () => {
  it("reads the browser outcome's screenshots list", () => {
    expect(resultScreenshotRefs({ output: { screenshots: ["r1/a.png", 3] } })).toEqual(["r1/a.png"]);
    expect(resultScreenshotRefs(null)).toEqual([]);
  });
});

// ─── per-kind bodies ───

describe("NodeDetailView", () => {
  it("a tool node surfaces the command and exit code", () => {
    const record = {
      seq: 1,
      kind: "node_result",
      nodeId: "t1",
      status: "succeeded",
      nodeKind: "tool",
      action: "bash",
      inputSummary: "git tag --list v*",
      exitCode: 0,
      result: "v0.1.4",
    } as unknown as WorkflowJournalRecord;
    render(<NodeDetailView records={[record]} nodeId="t1" />);
    expect(screen.getByText(/git tag --list v\*/)).toBeTruthy();
    // The mocked t returns the key: "workflow.step.exitCode 0".
    expect(screen.getByText(/exitCode 0/)).toBeTruthy();
  });

  it("an agent node's open-session button enters the child session chat view", () => {
    const record = {
      seq: 1,
      kind: "node_result",
      nodeId: "a1",
      status: "succeeded",
      nodeKind: "agent",
      childSessionId: "child-7",
    } as unknown as WorkflowJournalRecord;
    render(<NodeDetailView records={[record]} nodeId="a1" />);
    fireEvent.click(screen.getByTestId("workflow-node-open-session"));
    expect(setActiveThread).toHaveBeenCalledWith("child-7");
  });

  it("a decision node shows its reason", () => {
    const record = {
      seq: 1,
      kind: "decision",
      nodeId: "d1",
      status: "succeeded",
      nodeKind: "decision",
      result: { status: "ok", reason: "branch A matched the filter", output: { pick: "A" } },
    } as unknown as WorkflowJournalRecord;
    render(<NodeDetailView records={[record]} nodeId="d1" />);
    expect(screen.getByText("branch A matched the filter")).toBeTruthy();
  });

  it("an approved human node shows the verdict", () => {
    const record = {
      seq: 1,
      kind: "approval",
      nodeId: "h1",
      status: "succeeded",
      nodeKind: "human",
      result: { decision: "approve", escalated: false },
    } as unknown as WorkflowJournalRecord;
    render(<NodeDetailView records={[record]} nodeId="h1" />);
    expect(screen.getByTestId("workflow-node-human-decision").textContent).toContain(
      "workflow.node.humanApproved",
    );
  });

  it("a waiting human node shows the awaiting state instead of a verdict", () => {
    const record = {
      seq: 1,
      kind: "approval",
      nodeId: "h2",
      status: "waiting",
      nodeKind: "human",
      result: null,
    } as unknown as WorkflowJournalRecord;
    render(<NodeDetailView records={[record]} nodeId="h2" />);
    expect(screen.queryByTestId("workflow-node-human-decision")).toBeNull();
    expect(screen.getByText("workflow.step.awaitingHuman")).toBeTruthy();
  });

  it("a browser node shows the landed URL and resolves screenshots to duya-file URLs", async () => {
    artifactPath.mockResolvedValue({ ok: true, path: "C:/art/r1/shot.png" });
    const record = {
      seq: 1,
      kind: "node_result",
      nodeId: "b1",
      status: "succeeded",
      nodeKind: "browser",
      result: {
        output: { url: "https://example.com/page", title: "Example", steps: 3, screenshots: ["r1/shot.png"] },
      },
    } as unknown as WorkflowJournalRecord;
    const { container } = render(<NodeDetailView records={[record]} nodeId="b1" />);
    expect(screen.getByText("https://example.com/page")).toBeTruthy();
    expect(artifactPath).toHaveBeenCalledWith("r1/shot.png");
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("duya-file:///C:/art/r1/shot.png"),
    );
  });

  it("a gui node renders capture artifacts as thumbnails", async () => {
    artifactPath.mockResolvedValue({ ok: true, path: "C:/art/r1/capture-0.png" });
    const records = [
      {
        seq: 1,
        kind: "artifact",
        nodeId: "g1#step0",
        status: "succeeded",
        nodeKind: "gui",
        action: "capture",
        result: { ref: "r1/capture-0.png" },
      },
      {
        seq: 2,
        kind: "node_result",
        nodeId: "g1",
        status: "succeeded",
        nodeKind: "gui",
        action: "click",
      },
    ] as unknown as WorkflowJournalRecord[];
    const { container } = render(<NodeDetailView records={records} nodeId="g1" />);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("duya-file:///C:/art/r1/capture-0.png"),
    );
  });

  it("an unresolvable screenshot ref degrades to a file chip", async () => {
    const record = {
      seq: 1,
      kind: "node_result",
      nodeId: "b1",
      status: "succeeded",
      nodeKind: "browser",
      result: { output: { url: "https://example.com", screenshots: ["r1/gone.png"] } },
    } as unknown as WorkflowJournalRecord;
    render(<NodeDetailView records={[record]} nodeId="b1" />);
    await waitFor(() => expect(screen.getByTitle("gone.png")).toBeTruthy());
  });

  it("an unknown nodeId renders nothing", () => {
    const record = {
      seq: 1,
      kind: "node_result",
      nodeId: "t1",
      status: "succeeded",
      nodeKind: "tool",
    } as unknown as WorkflowJournalRecord;
    const { container } = render(<NodeDetailView records={[record]} nodeId="missing" />);
    expect(container.querySelector("[data-testid='workflow-node-detail']")).toBeNull();
  });
});
