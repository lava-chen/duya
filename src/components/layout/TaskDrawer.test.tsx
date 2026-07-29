/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
  // Git status mock — defaults to "not a git repo" so the
  // EnvironmentInfoSection returns null. Individual tests override
  // this to assert the rendered content of the section.
  gitStatus: {
    isGitRepo: false,
    fileChanges: [] as Array<{ path: string; additions: number; removals: number }>,
    totals: { additions: 0, removals: 0, fileCount: 0 },
  },
}));

vi.mock('@/hooks/useSubAgentProgress', () => ({
  useSubAgentProgress: () => mocks.agents,
}));

vi.mock('@/hooks/useSessionArtifacts', () => ({
  useSessionArtifacts: () => ({ fileChanges: [], artifacts: mocks.artifacts }),
}));

vi.mock('@/hooks/useSessionSources', () => ({
  useSessionSources: () => mocks.sources,
}));

vi.mock('@/hooks/useGitStatus', () => ({
  useGitStatus: () => mocks.gitStatus,
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
  GitBranchIcon: () => <span />,
  SpinnerIcon: () => <span data-testid="agent-spinner" />,
  StopIcon: () => <span />,
  TrashIcon: () => <span />,
  ArrowCounterClockwiseIcon: () => <span />,
  RobotIcon: () => <span data-testid="agent-icon" />,
  WarningIcon: () => <span />,
  XIcon: () => <span />,
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
    // Default: not a git repo — EnvironmentInfoSection should not render.
    mocks.gitStatus = {
      isGitRepo: false,
      fileChanges: [],
      totals: { additions: 0, removals: 0, fileCount: 0 },
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {},
    });
  });

  it('renders running sub-agents and lets the user jump into their session', () => {
    render(<TaskDrawer />);

    expect(screen.getByText('Sub-agents')).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByTestId('agent-spinner')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Open Researcher'));
    expect(mocks.setActiveThread).toHaveBeenCalledWith('sub-session-1');
  });

  it('hides empty sections entirely when not a git repo', () => {
    render(<TaskDrawer />);

    // Not a git repo → the section is gone (label and row are both gone).
    expect(screen.queryByText('环境信息')).not.toBeInTheDocument();
    expect(screen.queryByText('变更')).not.toBeInTheDocument();

    // Empty sections are also hidden so only Sub-agents remains.
    expect(screen.queryByText('来源')).not.toBeInTheDocument();
    expect(screen.queryByText('产物')).not.toBeInTheDocument();
  });

  it('renders EnvironmentInfoSection when the cwd is a git repo with changes', () => {
    mocks.gitStatus = {
      isGitRepo: true,
      fileChanges: [
        { path: 'README.md', additions: 12, removals: 3 },
        { path: 'src/foo.ts', additions: 5, removals: 0 },
      ],
      totals: { additions: 17, removals: 3, fileCount: 2 },
    };

    render(<TaskDrawer />);

    expect(screen.getByText('环境信息')).toBeInTheDocument();
    expect(screen.getByText('变更')).toBeInTheDocument();
    expect(screen.getByText('+17')).toBeInTheDocument();
    expect(screen.getByText('-3')).toBeInTheDocument();
    expect(screen.getByText('2 个文件')).toBeInTheDocument();
  });

  it('never renders a header, agent profile selector, or model label', () => {
    render(<TaskDrawer />);

    // The old header is gone.
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    // The agent selector and main-agent label are gone too.
    expect(screen.queryByTestId('agent-profile-selector')).not.toBeInTheDocument();
    expect(screen.queryByText('Main Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Refactor session')).not.toBeInTheDocument();
    expect(screen.queryByText('claude-sonnet')).not.toBeInTheDocument();
  });
});