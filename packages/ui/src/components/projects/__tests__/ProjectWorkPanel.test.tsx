// @vitest-environment jsdom
/**
 * ProjectWorkPanel tests — the project state beside the coordinator
 * conversation.
 *
 * ## What is under test
 *
 * The three things the panel says, and the two things it lets the user do:
 *
 *   - the project's TASKS and WORKING SESSIONS, with the state they are in;
 *   - opening a working session (read-only) and taking it over;
 *   - a session the user already holds says so, instead of offering a
 *     takeover of a session they are already in.
 *
 * The store is stubbed, so the store's own guarantees are not re-tested here.
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  snapshot: null as unknown,
  sessionStatuses: {} as Record<string, string>,
  leases: {} as Record<string, unknown>,
}));

vi.mock('@/stores/project-workspace-store', () => ({
  useProjectWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      snapshot: mocks.snapshot,
      sessionStatuses: mocks.sessionStatuses,
      leases: mocks.leases,
    }),
  // The same rule the store applies: a lease is the user's only when the user
  // holds it. The helper itself is covered by the store's own test.
  isLocalUserLease: (lease: { holder?: { kind?: string } } | null | undefined) =>
    lease?.holder?.kind === 'user',
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

import { ProjectWorkPanel } from '../ProjectWorkPanel';

const SNAPSHOT = {
  project: {
    project_id: 'project-1',
    canonical_root: 'E:/Projects/duya',
    name: 'duya',
    description: null,
    paths: [],
    icon: null,
    color: null,
    created_at: 0,
    last_seen_at: 0,
    coordinator_session_id: 'session-coordinator',
  },
  coordinatorSessionId: 'session-coordinator',
  tasks: [
    {
      taskId: 'task-1',
      subject: '实现登录',
      description: '',
      status: 'in_progress',
      activeForm: null,
      owner: null,
      blocks: [],
      blockedBy: [],
      coordinatorSessionId: 'session-coordinator',
      workSessionId: 'session-work',
      updatedAt: 1,
    },
  ],
  workSessions: [
    {
      sessionId: 'session-work',
      title: '登录实现',
      workingDirectory: 'E:/Projects/duya',
      status: 'active',
      updatedAt: 1,
      taskId: 'task-1',
      origin: 'bound' as const,
    },
  ],
  observedAt: 1,
};

describe('ProjectWorkPanel', () => {
  beforeEach(() => {
    mocks.snapshot = SNAPSHOT;
    mocks.sessionStatuses = {};
    mocks.leases = {};
  });

  it('lists the project tasks and their state', () => {
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    // The task subject appears in the task list and again under the working
    // session that executes it — both are the same fact, shown where it is
    // read.
    expect(screen.getAllByText('实现登录').length).toBeGreaterThan(0);
    expect(screen.getByText(/project\.workspace\.taskInProgress/)).toBeTruthy();
  });

  it('lists the working sessions with their live state', () => {
    mocks.sessionStatuses = { 'session-work': 'STREAMING' };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.getByText('登录实现')).toBeTruthy();
    expect(screen.getByText('project.workspace.statusRunning')).toBeTruthy();
  });

  it('says "unknown" for a session it has no live state for', () => {
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.getByText('project.workspace.statusUnknown')).toBeTruthy();
  });

  it('opens a working session without taking it over', () => {
    const onOpenSession = vi.fn();
    const onTakeOver = vi.fn();
    render(<ProjectWorkPanel onOpenSession={onOpenSession} onTakeOver={onTakeOver} />);

    fireEvent.click(screen.getByText('project.workspace.open'));

    expect(onOpenSession).toHaveBeenCalledWith('session-work');
    expect(onTakeOver).not.toHaveBeenCalled();
  });

  it('takes a working session over when the user asks for it', () => {
    const onOpenSession = vi.fn();
    const onTakeOver = vi.fn();
    render(<ProjectWorkPanel onOpenSession={onOpenSession} onTakeOver={onTakeOver} />);

    fireEvent.click(screen.getByText('project.workspace.takeOver'));

    expect(onTakeOver).toHaveBeenCalledWith('session-work');
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('says the user is working here when the session is already held', () => {
    mocks.leases = {
      'session-work': {
        sessionId: 'session-work',
        leaseId: 'lease-1',
        holder: { kind: 'user', id: 'local' },
        revision: 3,
        requestId: 'request-1',
        expiresAt: 999,
      },
    };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.getByText('project.workspace.holding')).toBeTruthy();
    expect(screen.queryByText('project.workspace.takeOver')).toBeNull();
  });

  it('says so when the project has neither tasks nor working sessions', () => {
    mocks.snapshot = { ...SNAPSHOT, tasks: [], workSessions: [] };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.getByText('project.workspace.noTasks')).toBeTruthy();
    expect(screen.getByText('project.workspace.noWorkSessions')).toBeTruthy();
  });

  it('does not claim the user holds a session another owner holds', () => {
    mocks.leases = {
      'session-work': {
        sessionId: 'session-work',
        leaseId: 'lease-1',
        holder: { kind: 'bot', id: 'some-bot' },
        revision: 3,
        requestId: 'request-1',
        expiresAt: 999,
      },
    };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.queryByText('project.workspace.holding')).toBeNull();
    expect(screen.getByText('project.workspace.takeOver')).toBeTruthy();
  });
});
