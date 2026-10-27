// @vitest-environment jsdom
/**
 * BackgroundTasksPanel — the side panel that lists the background work.
 *
 * Reference parity (Claude Code desktop): live work sits at the top, flat;
 * finished work folds into one "completed N" group; a card reads
 * "title · kind · status · duration" and opens the task's output.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeThreadId: "thread-1" as string | null,
  bashTasks: [] as Array<Record<string, unknown>>,
  agents: [] as Array<Record<string, unknown>>,
  dispatchOpenSessionPanel: vi.fn(),
}));

vi.mock("@/hooks/useTranslation", () => ({
  useTranslation: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) =>
      params && params.count !== undefined ? `${key} ${params.count}` : key,
  }),
}));

vi.mock("@/hooks/useBashTasks", () => ({
  useBashTasks: () => ({ tasks: mocks.bashTasks, runningCount: 0 }),
}));

vi.mock("@/hooks/useSubAgentProgress", () => ({
  useSubAgentProgress: () => mocks.agents,
}));

vi.mock("@/stores/conversation-store", () => ({
  useConversationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ activeThreadId: mocks.activeThreadId }),
}));

vi.mock("@/lib/open-session-panel-event", () => ({
  dispatchOpenSessionPanel: mocks.dispatchOpenSessionPanel,
}));

import { BackgroundTasksPanel } from "./BackgroundTasksPanel";

const tab = { id: "tab-1", pageId: "background-tasks" as const, title: "Background Tasks" };

function renderPanel() {
  return render(<BackgroundTasksPanel tab={tab} embedded />);
}

beforeEach(() => {
  mocks.activeThreadId = "thread-1";
  mocks.bashTasks = [];
  mocks.agents = [];
  mocks.dispatchOpenSessionPanel.mockReset();
});

describe("BackgroundTasksPanel", () => {
  it("shows an empty state when nothing is running", () => {
    renderPanel();
    expect(screen.getByText("panel.backgroundTasks.empty")).toBeTruthy();
  });

  it("lists a running command with its kind and status", () => {
    mocks.bashTasks = [{
      id: "t1",
      pid: 1,
      outputFile: "/tmp/out.log",
      command: "npm run build",
      status: "running",
      startTime: 1000,
      lastProgress: { bytes: 10, pid: 1, elapsed: 5000, timestamp: 2000 },
    }];
    renderPanel();
    expect(screen.getByText("npm run build")).toBeTruthy();
    expect(screen.getByText("panel.backgroundTasks.kindCommand")).toBeTruthy();
    expect(screen.getByText("panel.backgroundTasks.bashRunning")).toBeTruthy();
    expect(screen.getByText("5.0s")).toBeTruthy();
  });

  it("folds finished work into one group that expands in place", () => {
    mocks.bashTasks = [{
      id: "done",
      pid: 2,
      outputFile: "/tmp/done.log",
      command: "npm test",
      status: "completed",
      startTime: 1000,
      endTime: 6000,
    }];
    renderPanel();
    expect(screen.getByText("panel.backgroundTasks.completed 1")).toBeTruthy();
    expect(screen.queryByText("npm test")).toBeNull();

    fireEvent.click(screen.getByText("panel.backgroundTasks.completed 1"));
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("panel.backgroundTasks.bashCompleted")).toBeTruthy();
  });

  it("opens the command output when a command card is clicked", () => {
    mocks.bashTasks = [{
      id: "t1",
      pid: 1,
      outputFile: "/tmp/out.log",
      command: "npm run build",
      status: "running",
      startTime: 1000,
    }];
    const onOpen = vi.fn();
    window.addEventListener("duya:open-bash-output-panel", onOpen);
    renderPanel();
    fireEvent.click(screen.getByText("npm run build"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const detail = (onOpen.mock.calls[0] as Array<CustomEvent>)[0].detail;
    expect(detail).toMatchObject({
      taskId: "t1",
      sessionId: "thread-1",
      outputFile: "/tmp/out.log",
      command: "npm run build",
    });
    window.removeEventListener("duya:open-bash-output-panel", onOpen);
  });

  it("opens a running agent's transcript and shows its duration", () => {
    mocks.agents = [{
      id: "agent-1",
      name: "前端工程师",
      color: "#fff",
      status: "running",
      eventCount: 3,
      sessionId: "sub-1",
      startedAt: 1000,
      endedAt: 91000,
    }];
    renderPanel();
    expect(screen.getByText("前端工程师")).toBeTruthy();
    expect(screen.getByText("panel.backgroundTasks.kindAgent")).toBeTruthy();
    expect(screen.getByText("panel.backgroundTasks.viewOutput")).toBeTruthy();
    expect(screen.getByText("1m30s")).toBeTruthy();

    fireEvent.click(screen.getByText("前端工程师"));
    expect(mocks.dispatchOpenSessionPanel).toHaveBeenCalledWith(
      "sub-1",
      "前端工程师",
      { parentSessionId: "thread-1", taskId: "agent-1" },
    );
  });

  it("keeps a finished agent inside the completed group", () => {
    mocks.agents = [{
      id: "agent-1",
      name: "写手",
      color: "#fff",
      status: "completed",
      eventCount: 3,
      sessionId: "sub-1",
      startedAt: 1000,
      endedAt: 61000,
    }];
    renderPanel();
    expect(screen.queryByText("写手")).toBeNull();
    fireEvent.click(screen.getByText("panel.backgroundTasks.completed 1"));
    expect(screen.getByText("写手")).toBeTruthy();
    expect(screen.getByText("subAgent.status.completed")).toBeTruthy();
  });
});
