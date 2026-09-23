/**
 * BackgroundTasksIndicator.test.tsx — composer background-task chip.
 *
 * The chip is a pure projection of the two hooks the task drawer already
 * uses (`useBashTasks` + `useSubAgentProgress`): it must vanish when
 * nothing runs, count each kind separately, and toggle the drawer.
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
  bashRunningCount: 0,
  agents: [] as Array<{ id: string; status: string }>,
  drawerOpen: false,
  setTaskDrawerOpen: vi.fn<(value: boolean) => void>(),
}));

vi.mock('@/hooks/useBashTasks', () => ({
  useBashTasks: () => ({
    tasks: [],
    runningCount: mocks.bashRunningCount,
  }),
}));

vi.mock('@/hooks/useSubAgentProgress', () => ({
  useSubAgentProgress: () => mocks.agents,
}));

vi.mock('@/components/layout/task-drawer-store', () => ({
  useTaskDrawerOpen: () => mocks.drawerOpen,
  setTaskDrawerOpen: (value: boolean) => {
    mocks.drawerOpen = value;
    mocks.setTaskDrawerOpen(value);
  },
  isTaskDrawerOpen: () => mocks.drawerOpen,
  subscribeTaskDrawer: () => () => {},
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

describe('BackgroundTasksIndicator', () => {
  beforeEach(() => {
    mocks.bashRunningCount = 0;
    mocks.agents = [];
    mocks.drawerOpen = false;
    mocks.setTaskDrawerOpen.mockClear();
  });

  it('renders nothing when no background work is running', () => {
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toBeNull();
  });

  it('renders nothing without a session id, even with live counts', () => {
    mocks.bashRunningCount = 2;
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
    mocks.bashRunningCount = 3;
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
    mocks.bashRunningCount = 1;
    const { unmount } = render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('title', 'chat.backgroundTasks.tooltipTerminal');
    unmount();

    mocks.bashRunningCount = 0;
    mocks.agents = [{ id: 'a1', status: 'running' }];
    const second = render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('title', 'chat.backgroundTasks.tooltipAgent');
    second.unmount();

    mocks.bashRunningCount = 1;
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('title', 'chat.backgroundTasks.tooltipMixed');
  });

  it('opens the task drawer on click and closes it when already open', () => {
    mocks.bashRunningCount = 1;
    const { unmount } = render(<BackgroundTasksIndicator sessionId="s1" />);
    fireEvent.click(chip() as HTMLElement);
    expect(mocks.setTaskDrawerOpen).toHaveBeenCalledWith(true);
    unmount();

    mocks.drawerOpen = true;
    render(<BackgroundTasksIndicator sessionId="s1" />);
    expect(chip()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(chip() as HTMLElement);
    expect(mocks.setTaskDrawerOpen).toHaveBeenCalledWith(false);
  });

  it('keeps both locales in sync for its copy', () => {
    const keys = [
      'chat.backgroundTasks.tooltipTerminal',
      'chat.backgroundTasks.tooltipAgent',
      'chat.backgroundTasks.tooltipMixed',
      'chat.backgroundTasks.ariaLabel',
    ] as const;
    for (const key of keys) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((zh as Record<string, string>)[key]).toBeTruthy();
    }
  });
});
