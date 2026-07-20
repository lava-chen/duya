/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setActiveThread: vi.fn(),
  agents: [
    {
      id: 'agent-1',
      name: 'Researcher',
      color: '#a855f7',
      status: 'running' as const,
      description: 'Running in background',
      sessionId: 'sub-session-1',
    },
  ],
}));

vi.mock('@/hooks/useSubAgentProgress', () => ({
  useSubAgentProgress: () => mocks.agents,
}));

vi.mock('@/stores/conversation-store', () => {
  const state = {
    activeThreadId: 'parent-session',
    setActiveThread: mocks.setActiveThread,
  };
  const hook = (selector: (value: typeof state) => unknown) => selector(state);
  return {
    useConversationStore: Object.assign(hook, { getState: () => state }),
  };
});

vi.mock('./task-drawer-store', () => ({
  useTaskDrawerOpen: () => true,
  setTaskDrawerOpen: vi.fn(),
}));

vi.mock('./recap-store', () => ({
  useRecap: () => ({ text: '', receivedAt: null }),
  clearRecap: vi.fn(),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    aside: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => <aside {...props}>{children}</aside>,
  },
}));

vi.mock('@/components/icons', () => ({
  CaretRightIcon: () => <span />,
  CheckIcon: () => <span />,
  CircleIcon: () => <span />,
  ClockCounterClockwiseIcon: () => <span />,
  SpinnerIcon: () => <span data-testid="agent-spinner" />,
  TrashIcon: () => <span />,
  ArrowCounterClockwiseIcon: () => <span />,
  RobotIcon: () => <span data-testid="agent-icon" />,
  XIcon: () => <span />,
}));

import { TaskDrawer } from './TaskDrawer';

describe('TaskDrawer agents section', () => {
  beforeEach(() => {
    mocks.setActiveThread.mockReset();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        thread: {
          getTasks: vi.fn().mockResolvedValue([]),
        },
      },
    });
  });

  it('renders running sub-agents in the drawer and opens their session', async () => {
    render(<TaskDrawer />);

    await waitFor(() => {
      expect(window.electronAPI?.thread?.getTasks).toHaveBeenCalledWith('parent-session');
    });

    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText('1 running')).toBeInTheDocument();
    expect(screen.getByTestId('agent-spinner')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Open Researcher'));
    expect(mocks.setActiveThread).toHaveBeenCalledWith('sub-session-1');
  });
});
