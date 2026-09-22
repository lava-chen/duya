// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeReviewPanel } from "./CodeReviewPanel";
import type { PageTab } from "./registry";

const mocks = vi.hoisted(() => ({
  getGitReviewScoped: vi.fn(),
  getGitLatestTurnReview: vi.fn(),
  getGitTurnHistory: vi.fn(),
  getGitTurnDetail: vi.fn(),
  getGitCommits: vi.fn(),
}));

vi.mock("@/lib/git-ipc", () => ({
  getGitReviewScoped: mocks.getGitReviewScoped,
  getGitLatestTurnReview: mocks.getGitLatestTurnReview,
  getGitTurnHistory: mocks.getGitTurnHistory,
  getGitTurnDetail: mocks.getGitTurnDetail,
  getGitCommits: mocks.getGitCommits,
}));

vi.mock("@/hooks/usePanel", () => ({
  useOptionalPanel: () => ({ workspaceExpanded: true }),
}));

vi.mock("@/components/icons", () => {
  const MockIcon = () => <span />;
  return {
    IconAlertCircle: MockIcon,
    IconChevronDown: MockIcon,
    IconColumns2: MockIcon,
    IconCopy: MockIcon,
    IconFileCode: MockIcon,
    IconFileDiff: MockIcon,
    IconFileMinus: MockIcon,
    IconFilePlus: MockIcon,
    IconFileX: MockIcon,
    IconFold: MockIcon,
    IconGitBranch: MockIcon,
    IconGitCompare: MockIcon,
    IconHistory: MockIcon,
    IconLayoutSidebarRight: MockIcon,
    IconMessagePlus: MockIcon,
    IconRefresh: MockIcon,
    IconRoute: MockIcon,
    IconSearch: MockIcon,
    IconTextWrap: MockIcon,
  };
});

const SAMPLE_PATCH = [
  "diff --git a/src/file1.ts b/src/file1.ts",
  "index 123..456 100644",
  "--- a/src/file1.ts",
  "+++ b/src/file1.ts",
  "@@ -1,3 +1,5 @@",
  "+const newLine = true;",
  " const oldLine = true;",
  "-const removedLine = true;",
  "+const changedLine = true;",
  "}",
  "",
  "diff --git a/src/file2.ts b/src/file2.ts",
  "index 789..012 100644",
  "--- /dev/null",
  "+++ b/src/file2.ts",
  "@@ -0,0 +1,2 @@",
  "+const brandNew = true;",
  "+const secondLine = true;",
].join("\n");

function workspaceTab(): PageTab {
  return {
    id: "review-test",
    pageId: "review",
    title: "Code Review",
    params: { workingDirectory: "/test/workspace", sessionId: "" },
  };
}

function latestTurnTab(): PageTab {
  return {
    id: "review-test",
    pageId: "review",
    title: "Code Review",
    params: { workingDirectory: "/test/workspace", sessionId: "session-1" },
  };
}

describe("CodeReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no persisted turns — keeps the history dropdown hidden
    // unless a test opts in.
    mocks.getGitTurnHistory.mockResolvedValue({ isGitRepo: true, turns: [] });
  });

  it("shows non-git-repo error when workspace is not a git repository", async () => {
    mocks.getGitReviewScoped.mockResolvedValue({ isGitRepo: false, files: [] });

    render(<CodeReviewPanel tab={workspaceTab()} embedded />);

    const error = await screen.findByText("此项目不是 Git 仓库，或 Git 当前不可用。");
    expect(error).toBeTruthy();
  });

  it("renders workspace review with file list and inline diff", async () => {
    mocks.getGitReviewScoped.mockResolvedValue({
      isGitRepo: true,
      branch: "main",
      baseRef: "HEAD",
      files: [
        { path: "src/file1.ts", status: "modified", additions: 5, removals: 3, oldPath: undefined },
        { path: "src/file2.ts", status: "added", additions: 10, removals: 0, oldPath: undefined },
      ],
      totals: { additions: 15, removals: 3, fileCount: 2 },
      patch: SAMPLE_PATCH,
    });

    render(<CodeReviewPanel tab={workspaceTab()} embedded />);

    // Wait for the scope label to appear, indicating the review has loaded
    await screen.findByText("未提交 (HEAD → 工作区)");

    // Totals — use getAllByText for values that appear in both totals and per-file stats
    expect(screen.getByText("+15")).toBeTruthy();
    const removals = screen.getAllByText("−3");
    expect(removals.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2 个文件")).toBeTruthy();

    // File list items
    expect(screen.getByText("src/file1.ts")).toBeTruthy();
    expect(screen.getByText("src/file2.ts")).toBeTruthy();

    // Per-file stats — these appear only in the file list
    const plusFives = screen.getAllByText("+5");
    expect(plusFives.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("+10")).toBeTruthy();

    // Diff content rendered inline from the scoped review result
    expect(await screen.findByText("const newLine = true;")).toBeTruthy();
    expect(await screen.findByText("const brandNew = true;")).toBeTruthy();
  });

  it("renders latest-turn review", async () => {
    mocks.getGitLatestTurnReview.mockResolvedValue({
      isGitRepo: true,
      review: {
        id: "review-1",
        sessionId: "session-1",
        turnId: "turn-1",
        workingDirectory: "/test/workspace",
        files: [
          { path: "src/file1.ts", status: "modified", additions: 5, removals: 3, oldPath: undefined },
        ],
        totals: { additions: 5, removals: 3, fileCount: 1 },
        patch: SAMPLE_PATCH,
        binary: false,
        truncated: false,
        capturedAt: Date.now(),
      },
    });

    render(<CodeReviewPanel tab={latestTurnTab()} embedded />);

    await screen.findByText("上一轮");

    // Totals — use getAllByText for values that appear in both totals and per-file stats
    const plusFives = screen.getAllByText("+5");
    expect(plusFives.length).toBeGreaterThanOrEqual(1);
    const removals = screen.getAllByText("−3");
    expect(removals.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1 个文件")).toBeTruthy();

    // File list
    expect(screen.getByText("src/file1.ts")).toBeTruthy();
  });

  it("shows empty state when no files changed in latest-turn", async () => {
    mocks.getGitLatestTurnReview.mockResolvedValue({
      isGitRepo: true,
      review: null,
    });

    render(<CodeReviewPanel tab={latestTurnTab()} embedded />);

    const empty = await screen.findByText("上一轮对话没有文件变更。");
    expect(empty).toBeTruthy();
  });

  it("shows empty state when workspace has no changes", async () => {
    mocks.getGitReviewScoped.mockResolvedValue({
      isGitRepo: true,
      files: [],
      totals: { additions: 0, removals: 0, fileCount: 0 },
    });

    render(<CodeReviewPanel tab={workspaceTab()} embedded />);

    const empty = await screen.findByText("工作区没有相对 HEAD 的未提交改动。");
    expect(empty).toBeTruthy();
  });

  it("shows error when git fetch fails", async () => {
    mocks.getGitReviewScoped.mockRejectedValue(new Error("network error"));

    render(<CodeReviewPanel tab={workspaceTab()} embedded />);

    const error = await screen.findByText("无法读取变更。");
    expect(error).toBeTruthy();
  });

  it("shows error from latest-turn review result", async () => {
    mocks.getGitLatestTurnReview.mockResolvedValue({
      isGitRepo: true,
      error: "Failed to load turn review data",
    });

    render(<CodeReviewPanel tab={latestTurnTab()} embedded />);

    const error = await screen.findByText("Failed to load turn review data");
    expect(error).toBeTruthy();
  });

  it("lists prior turns and swaps in the selected turn's detail", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    mocks.getGitTurnHistory.mockResolvedValue({
      isGitRepo: true,
      turns: [
        { id: "row-latest", turnId: "turn-2", additions: 3, removals: 1, fileCount: 1, capturedAt: now },
        { id: "row-old", turnId: "turn-1", additions: 9, removals: 0, fileCount: 2, capturedAt: now - 3_600_000 },
      ],
    });
    mocks.getGitLatestTurnReview.mockResolvedValue({
      isGitRepo: true,
      review: {
        id: "row-latest",
        sessionId: "session-1",
        turnId: "turn-2",
        workingDirectory: "/test/workspace",
        files: [
          { path: "src/turn-file.ts", status: "modified", additions: 3, removals: 1, oldPath: undefined },
        ],
        totals: { additions: 3, removals: 1, fileCount: 1 },
        patch: SAMPLE_PATCH,
        binary: false,
        truncated: false,
        capturedAt: now,
      },
    });
    mocks.getGitTurnDetail.mockResolvedValue({
      isGitRepo: true,
      review: {
        id: "row-old",
        sessionId: "session-1",
        turnId: "turn-1",
        workingDirectory: "/test/workspace",
        files: [
          { path: "src/old-turn-file.ts", status: "modified", additions: 9, removals: 0, oldPath: undefined },
        ],
        totals: { additions: 9, removals: 0, fileCount: 1 },
        patch: SAMPLE_PATCH,
        binary: false,
        truncated: false,
        capturedAt: now - 3_600_000,
      },
    });

    render(<CodeReviewPanel tab={latestTurnTab()} embedded />);

    expect(await screen.findByText("src/turn-file.ts")).toBeTruthy();

    // History dropdown shows both persisted turns; picking the older one
    // loads its detail and replaces the diff.
    const turnSelect = screen.getByLabelText("选择轮次");
    await user.selectOptions(turnSelect, "row-old");

    await waitFor(() => {
      expect(mocks.getGitTurnDetail).toHaveBeenCalledWith("/test/workspace", "row-old");
    });
    expect(await screen.findByText("src/old-turn-file.ts")).toBeTruthy();
    expect(screen.queryByText("src/turn-file.ts")).not.toBeTruthy();
  });

  it("switches scope between latest-turn and workspace via the scope select", async () => {
    const user = userEvent.setup();

    mocks.getGitLatestTurnReview.mockResolvedValue({
      isGitRepo: true,
      review: {
        id: "review-1",
        sessionId: "session-1",
        turnId: "turn-1",
        workingDirectory: "/test/workspace",
        files: [
          { path: "src/turn-file.ts", status: "modified", additions: 3, removals: 1, oldPath: undefined },
        ],
        totals: { additions: 3, removals: 1, fileCount: 1 },
        patch: "",
        binary: false,
        truncated: false,
        capturedAt: Date.now(),
      },
    });
    mocks.getGitReviewScoped.mockResolvedValue({
      isGitRepo: true,
      branch: "main",
      baseRef: "HEAD",
      files: [
        { path: "src/workspace-file.ts", status: "modified", additions: 7, removals: 2, oldPath: undefined },
      ],
      totals: { additions: 7, removals: 2, fileCount: 1 },
    });

    render(<CodeReviewPanel tab={latestTurnTab()} embedded />);

    // Initially shows latest-turn scope
    expect(await screen.findByText("src/turn-file.ts")).toBeTruthy();

    // Switch the scope select to uncommitted (workspace review)
    const scopeSelect = screen.getByLabelText("审阅范围");
    await user.selectOptions(scopeSelect, "uncommitted");

    await waitFor(() => {
      expect(mocks.getGitReviewScoped).toHaveBeenCalledWith(
        "/test/workspace",
        { type: "uncommitted" },
      );
    });

    // Workspace files replace the latest-turn ones
    expect(await screen.findByText("src/workspace-file.ts")).toBeTruthy();
    expect(screen.queryByText("src/turn-file.ts")).not.toBeTruthy();
  });

  it("fires a commit-scope review only after both commits are chosen", async () => {
    mocks.getGitCommits.mockResolvedValue({
      commits: [
        { hash: "aaaaaaa", subject: "second", author: "a", date: "2026-01-02" },
        { hash: "bbbbbbb", subject: "first", author: "a", date: "2026-01-01" },
      ],
    });
    mocks.getGitReviewScoped.mockResolvedValue({ isGitRepo: true, files: [] });

    render(<CodeReviewPanel tab={workspaceTab()} embedded />);

    const scopeSelect = screen.getByLabelText("审阅范围");
    fireEvent.change(scopeSelect, { target: { value: "commit" } });

    await waitFor(() => {
      expect(mocks.getGitCommits).toHaveBeenCalledWith("/test/workspace", 50);
    });

    // Default commit pair (commits[1] → commits[0]) triggers a scoped review.
    await waitFor(() => {
      expect(mocks.getGitReviewScoped).toHaveBeenCalledWith("/test/workspace", {
        type: "commit",
        commitFrom: "bbbbbbb",
        commitTo: "aaaaaaa",
      });
    });
  });
});
