/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setActiveThread: vi.fn(),
  threads: [
    {
      id: 'parent-session',
      title: 'Refactor session',
      workingDirectory: 'E:/Projects/duya',
      projectName: 'duya',
      agentProfileId: null,
      model: 'claude-sonnet',
    },
  ],
  messages: {} as Record<string, unknown[]>,
  fileChanges: [] as Array<{ path: string; name: string; additions: number; removals: number; kind: 'edit' | 'create' }>,
  artifacts: [] as Array<{ path: string; name: string; kindLabel: string }>,
  sources: {
    userAttachments: [] as Array<{ id: string; name: string; kind?: string; metadata?: unknown }>,
    browserUrls: [] as Array<{ id: string; name: string; kind?: string; metadata?: unknown }>,
    others: [] as Array<{ id: string; name: string; kind?: string; metadata?: unknown }>,
  },
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

vi.mock('@/hooks/useSessionArtifacts', () => ({
  useSessionArtifacts: () => ({ fileChanges: mocks.fileChanges, artifacts: mocks.artifacts }),
}));

vi.mock('@/hooks/useSessionSources', () => ({
  useSessionSources: () => mocks.sources,
}));

vi.mock('@/stores/conversation-store', () => {
  const state = {
    activeThreadId: 'parent-session',
    threads: mocks.threads,
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
  FileTextIcon: () => <span />,
  FileIcon: () => <span />,
  FolderIcon: () => <span />,
  ImageIcon: () => <span />,
  GlobeIcon: () => <span />,
  TerminalIcon: () => <span />,
  CaretDownIcon: () => <span />,
  ExternalLinkIcon: () => <span />,
  SpinnerIcon: () => <span data-testid="agent-spinner" />,
  TrashIcon: () => <span />,
  ArrowCounterClockwiseIcon: () => <span />,
  RobotIcon: () => <span data-testid="agent-icon" />,
  XIcon: () => <span />,
}));

vi.mock('@/components/chat/AgentProfileSelector', () => ({
  AgentProfileSelector: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="agent-profile-selector" data-session-id={sessionId ?? ''}>
      Default Agent
    </div>
  ),
}));

import { TaskDrawer } from './TaskDrawer';

describe('TaskDrawer session-detail panel', () => {
  beforeEach(() => {
    mocks.setActiveThread.mockReset();
    mocks.agents = [
      {
        id: 'agent-1',
        name: 'Researcher',
        color: '#a855f7',
        status: 'running' as const,
        description: 'Running in background',
        sessionId: 'sub-session-1',
      },
    ];
    mocks.fileChanges = [];
    mocks.artifacts = [];
    mocks.sources = { userAttachments: [], browserUrls: [], others: [] };
    mocks.threads = [
      {
        id: 'parent-session',
        title: 'Refactor session',
        workingDirectory: 'E:/Projects/duya',
        projectName: 'duya',
        agentProfileId: null,
        model: 'claude-sonnet',
      },
    ];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        thread: {
          getTasks: vi.fn().mockResolvedValue([]),
        },
      },
    });
  });

  it('renders running sub-agents and lets the user jump into their session', async () => {
    render(<TaskDrawer />);

    await waitFor(() => {
      expect(window.electronAPI?.thread?.getTasks).toHaveBeenCalledWith('parent-session');
    });

    expect(screen.getByText('Sub-agents')).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByTestId('agent-spinner')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Open Researcher'));
    expect(mocks.setActiveThread).toHaveBeenCalledWith('sub-session-1');
  });

  it('renders all sections with no header at the top', () => {
    render(<TaskDrawer />);

    // Environment info section
    expect(screen.getByText('环境信息')).toBeInTheDocument();
    expect(screen.getByText('Refactor session')).toBeInTheDocument();
    expect(screen.getByText('duya')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet')).toBeInTheDocument();

    // Main agent section
    expect(screen.getByText('Main Agent')).toBeInTheDocument();
    expect(screen.getByTestId('agent-profile-selector')).toBeInTheDocument();

    // Sources + Artifacts labels render even when empty
    expect(screen.getByText('来源')).toBeInTheDocument();
    expect(screen.getByText('产物')).toBeInTheDocument();

    // No leftover header chrome (header had a Tasks title + Close button)
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });
});