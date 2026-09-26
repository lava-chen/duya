/**
 * BackgroundTasksIndicator.test.tsx — composer background-task chip.
 *
 * The chip is a pure projection of the two hooks the task drawer already
 * uses (`useBashTasks` + `useSubAgentProgress`): it must vanish when
 * nothing runs, count each kind separately, and — since plan 566 — expand
 * into a task list on click where command rows open the side-panel output
 * viewer and sub-agent rows jump into that session.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/en';
import zh from '@/i18n/zh';
import { BackgroundTasksIndicator } from '../BackgroundTasksIndicator';

const mocks = vi.hoisted(() => ({
  bashTasks: [] as Array<{
    id: string;
    pid: number;
    outputFile: string;
    command: string;
    status: string;
    startTime: number;
    endTime?: number;
  }>,
  bashRunningCount: 0,
  agents: [] as Array<{ id: string; name?: string; status: string; sessionId?: string }>,
  setActiveThread: vi.fn<(id: string) => void>(),
}));

vi.mock('@/hooks/useBashTasks', () => ({
  useBashTasks: () => ({
    tasks: mocks.bashTasks,
    runningCount: mocks.bashTasks.filter((t) => t.status === 'running').length,
  }),
}));

vi.mock('@/hooks/useSubAgentProgress', () => ({
  useSubAgentProgress: () => mocks.agents,
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: {
    getState: () => ({ setActiveThread: mocks.setActiveThread }),
  },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    locale: 'en',
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

vi.mock('@/components/icons', () => ({
  TerminalIcon: () => <span data-icon="terminal" />,
  TablerRobotIcon: () => <span data-icon="robot" />,
}));

function chip() {
  return screen.queryByTestId('composer-background-tasks');
}

function taskList() {
  return screen.queryByTestId('composer-background-tasks-list');
}

describe('BackgroundTasksIndicator', () => {
  beforeEach(() => {
    mocks.bashTasks = [];
    mocks.agents = [];
    mocks.setActiveThread.mockClear();
  });

  it('renders nothing when no background work is running', () => {
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toBeNull();
  });

  it('renders nothing without a session id, even with live counts', () => {
    mocks.bashTasks = [
      { id: 't1', pid: 1, outputFile: '/o1', command: 'npm run build', status: 'running', startTime: 1 },
    ];
    render(<BackgroundTasksIndicator sessionId={null} />);
    expect(chip()).toBeNull();
  });

  it('counts only running sub-agents, not finished ones', () => {
    mocks.agents = [
      { id: 'a1', status: 'running' },
      { id: 'a2', status: 'completed' },
      { id: 'a3', status: 'error' },
      { id: 'a4', status: 'running' },
    ];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('data-background-subagent-count', '2');
    expect(chip()).toHaveAttribute('data-background-total-count', '2');
    // Terminal cluster stays hidden: no bash commands to report.
    expect(screen.queryByText('2', { selector: '[data-icon="terminal"] + span' })).toBeNull();
  });

  it('shows both kinds with a per-kind breakdown in the aria label', () => {
    mocks.bashTasks = [
      { id: 't1', pid: 1, outputFile: '/o1', command: 'a', status: 'running', startTime: 1 },
      { id: 't2', pid: 2, outputFile: '/o2', command: 'b', status: 'running', startTime: 2 },
      { id: 't3', pid: 3, outputFile: '/o3', command: 'c', status: 'running', startTime: 3 },
    ];
    mocks.agents = [{ id: 'a1', status: 'running' }];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    const el = chip();
    expect(el).toHaveAttribute('data-background-bash-count', '3');
    expect(el).toHaveAttribute('data-background-subagent-count', '1');
    expect(el).toHaveAttribute('data-background-total-count', '4');
    expect(el?.getAttribute('aria-label')).toContain('chat.backgroundTasks.ariaLabel');
    expect(el?.getAttribute('aria-label')).toContain('"bashCount":3');
    expect(el?.getAttribute('aria-label')).toContain('"subagentCount":1');
  });

  it('names the single active kind in the tooltip, generic when mixed', () => {
    mocks.bashTasks = [
      { id: 't1', pid: 1, outputFile: '/o1', command: 'a', status: 'running', startTime: 1 },
    ];
    const { unmount } = render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('title', 'chat.backgroundTasks.tooltipTerminal');
    unmount();

    mocks.bashTasks = [];
    mocks.agents = [{ id: 'a1', status: 'running' }];
    const second = render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('title', 'chat.backgroundTasks.tooltipAgent');
    second.unmount();

    mocks.bashTasks = [
      { id: 't1', pid: 1, outputFile: '/o1', command: 'a', status: 'running', startTime: 1 },
    ];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('title', 'chat.backgroundTasks.tooltipMixed');
  });

  it('expands the task list on click and collapses on the second click', () => {
    mocks.bashTasks = [
      { id: 't1', pid: 1, outputFile: '/o1', command: 'npm run dev', status: 'running', startTime: 1 },
    ];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(taskList()).toBeNull();
    expect(chip()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(chip() as HTMLElement);
    expect(taskList()).not.toBeNull();
    expect(chip()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(chip() as HTMLElement);
    expect(taskList()).toBeNull();
    expect(chip()).toHaveAttribute('aria-expanded', 'false');
  });

  it('dispatches the output-panel event with task details when a command row is clicked', () => {
    mocks.bashTasks = [
      {
        id: 't1',
        pid: 1,
        outputFile: '/tmp/out.log',
        command: 'npm run build',
        status: 'running',
        startTime: 42,
      },
    ];
    const onOpen = vi.fn();
    window.addEventListener('duya:open-bash-output-panel', onOpen);
    render(<BackgroundTasksIndicator sessionId="s1" />);
    fireEvent.click(chip() as HTMLElement);
    fireEvent.click(screen.getByTestId('background-task-row-t1'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const detail = (onOpen.mock.calls[0] as Array<CustomEvent>)[0].detail;
    expect(detail).toMatchObject({
      taskId: 't1',
      sessionId: 's1',
      outputFile: '/tmp/out.log',
      command: 'npm run build',
      startTime: 42,
    });
    // The list closes after opening the output panel.
    expect(taskList()).toBeNull();
    window.removeEventListener('duya:open-bash-output-panel', onOpen);
  });

  it('lists running tasks before ended ones', () => {
    mocks.bashTasks = [
      { id: 'ended', pid: 1, outputFile: '/o1', command: 'old', status: 'completed', startTime: 10, endTime: 20 },
      { id: 'live', pid: 2, outputFile: '/o2', command: 'new', status: 'running', startTime: 5 },
    ];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    fireEvent.click(chip() as HTMLElement);
    const rows = screen.getAllByTestId(/^background-task-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'background-task-row-live');
    expect(rows[1]).toHaveAttribute('data-testid', 'background-task-row-ended');
  });

  it('jumps into the sub-agent session when its row is clicked', () => {
    mocks.agents = [{ id: 'a1', name: 'a1', status: 'running', sessionId: 'child-1' }];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    fireEvent.click(chip() as HTMLElement);
    fireEvent.click(screen.getByTitle('a1'));
    expect(mocks.setActiveThread).toHaveBeenCalledWith('child-1');
    expect(taskList()).toBeNull();
  });

  it('closes on Escape', () => {
    mocks.bashTasks = [
      { id: 't1', pid: 1, outputFile: '/o1', command: 'a', status: 'running', startTime: 1 },
    ];
    render(<BackgroundTasksIndicator sessionId="s1" />);
    fireEvent.click(chip() as HTMLElement);
    expect(taskList()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(taskList()).toBeNull();
  });

  it('keeps both locales in sync for its copy', () => {
    const keys = [
      'chat.backgroundTasks.tooltipTerminal',
      'chat.backgroundTasks.tooltipAgent',
      'chat.backgroundTasks.tooltipMixed',
      'chat.backgroundTasks.ariaLabel',
      'chat.backgroundTasks.listTitle',
      'chat.backgroundTasks.sectionCommands',
      'chat.backgroundTasks.sectionAgents',
      'chat.backgroundTasks.openOutput',
      'bashTaskOutput.status.running',
      'bashTaskOutput.status.completed',
      'bashTaskOutput.status.killed',
      'bashTaskOutput.status.error',
      'bashTaskOutput.status.disk_limit',
      'bashTaskOutput.status.lost',
      'bashTaskOutput.fullFile',
      'bashTaskOutput.empty',
      'bashTaskOutput.retry',
      'bashTaskOutput.readError',
      'bashTaskOutput.jumpToBottom',
    ] as const;
    for (const key of keys) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((zh as Record<string, string>)[key]).toBeTruthy();
    }
  });
});
