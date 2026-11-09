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
  continuity: null as unknown,
  actionError: null as string | null,
  actionPending: false,
  continuityHasMoreActivity: false,
  activityLoading: false,
  acceptTask: vi.fn(),
  reviewDecision: vi.fn(),
  reviewMemory: vi.fn(),
  loadMoreActivity: vi.fn(),
}));

vi.mock('@/stores/project-workspace-store', () => ({
  useProjectWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      snapshot: mocks.snapshot,
      sessionStatuses: mocks.sessionStatuses,
      leases: mocks.leases,
      continuity: mocks.continuity,
      actionError: mocks.actionError,
      actionPending: mocks.actionPending,
      continuityHasMoreActivity: mocks.continuityHasMoreActivity,
      activityLoading: mocks.activityLoading,
      loadMoreActivity: mocks.loadMoreActivity,
      acceptTask: mocks.acceptTask,
      reviewDecision: mocks.reviewDecision,
      reviewMemory: mocks.reviewMemory,
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

const CONTINUITY = {
  project: SNAPSHOT.project,
  state: null,
  tasks: [
    {
      task: null,
      link: {
        taskId: 'task-1',
        acceptanceStatus: 'pending',
        workSessionId: 'session-work',
        updatedAt: 1,
      },
    },
  ],
  decisions: [
    {
      key: 'arch',
      content: '用 SQLite',
      status: 'proposed',
      revision: 2,
      source: { type: 'session', id: 'coordinator' },
      updatedAt: 1,
    },
  ],
  memories: [
    {
      key: 'owner',
      content: '负责人是 A',
      status: 'candidate',
      revision: 3,
      source: { type: 'session', id: 'coordinator' },
      updatedAt: 1,
    },
  ],
  activity: [],
  nextCursor: 0,
  transcriptRefs: [],
};

describe('ProjectWorkPanel', () => {
  beforeEach(() => {
    mocks.snapshot = SNAPSHOT;
    mocks.sessionStatuses = {};
    mocks.leases = {};
    mocks.continuity = null;
    mocks.actionError = null;
    mocks.actionPending = false;
    mocks.continuityHasMoreActivity = false;
    mocks.activityLoading = false;
    mocks.acceptTask.mockClear();
    mocks.reviewDecision.mockClear();
    mocks.reviewMemory.mockClear();
    mocks.loadMoreActivity.mockClear();
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

  it('lets the user accept or reject a task result', () => {
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getByText('project.workspace.acceptTask'));
    expect(mocks.acceptTask).toHaveBeenCalledWith('task-1', 'accepted');

    fireEvent.click(screen.getByText('project.workspace.rejectTask'));
    expect(mocks.acceptTask).toHaveBeenCalledWith('task-1', 'rejected');
  });

  it('stops offering acceptance once the task link says accepted', () => {
    mocks.continuity = {
      ...CONTINUITY,
      tasks: [{ ...CONTINUITY.tasks[0], link: { ...CONTINUITY.tasks[0].link, acceptanceStatus: 'accepted' } }],
    };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.queryByText('project.workspace.acceptTask')).toBeNull();
    expect(screen.getByText('project.workspace.acceptanceAccepted')).toBeTruthy();
  });

  it('renders only proposed decisions and candidate memories', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.getByText('用 SQLite')).toBeTruthy();
    expect(screen.getByText('负责人是 A')).toBeTruthy();
    expect(screen.getAllByTestId('project-review-candidate').length).toBe(2);
  });

  it('does not offer already-accepted decisions or active memories', () => {
    mocks.continuity = {
      ...CONTINUITY,
      decisions: [{ ...CONTINUITY.decisions[0], status: 'accepted' }],
      memories: [{ ...CONTINUITY.memories[0], status: 'active' }],
    };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.queryAllByTestId('project-review-candidate').length).toBe(0);
  });

  it('confirming a decision cites its revision and an accepted status', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getAllByText('project.workspace.reviewAccept')[0]);

    expect(mocks.reviewDecision).toHaveBeenCalledWith({
      key: 'arch',
      content: '用 SQLite',
      status: 'accepted',
      expectedRevision: 2,
    });
  });

  it('discarding a decision supersedes it instead of accepting it', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getAllByText('project.workspace.reviewDiscard')[0]);

    expect(mocks.reviewDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'superseded', expectedRevision: 2 }),
    );
  });

  it('confirming a memory activates it, which is what lets it reach the prompt', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getAllByText('project.workspace.reviewAccept')[1]);

    expect(mocks.reviewMemory).toHaveBeenCalledWith({
      key: 'owner',
      content: '负责人是 A',
      status: 'active',
      expectedRevision: 3,
    });
  });

  it('discarding a memory retires it', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getAllByText('project.workspace.reviewDiscard')[1]);

    expect(mocks.reviewMemory).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'retired', expectedRevision: 3 }),
    );
  });

  it('correcting a candidate sends the edited content, not the original', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getAllByText('project.workspace.reviewCorrect')[0]);
    fireEvent.change(screen.getByLabelText('project.workspace.reviewCorrect'), {
      target: { value: '改用 Postgres' },
    });
    fireEvent.click(screen.getByText('project.workspace.reviewSave'));

    expect(mocks.reviewDecision).toHaveBeenCalledWith({
      key: 'arch',
      content: '改用 Postgres',
      status: 'accepted',
      expectedRevision: 2,
    });
  });

  it('surfaces a failed user action instead of silently keeping the candidate', () => {
    mocks.continuity = CONTINUITY;
    mocks.actionError = 'Only an explicit user decision can accept a project decision';
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    expect(screen.getByTestId('project-action-error').textContent).toContain('explicit user decision');
  });

  const ACTIVITY = [
    {
      cursor: 1, type: 'task.created', taskId: 'task-1', sessionId: null, runId: null,
      source: { type: 'session', id: 'coordinator' }, payload: {}, createdAt: 1,
    },
    {
      cursor: 2, type: 'run.terminal', taskId: 'task-1', sessionId: 'session-work', runId: 'run-1',
      source: { type: 'run', id: 'run-1' }, payload: { status: 'completed' }, createdAt: 2,
    },
  ];

  it('shows the paged activity timeline with the newest event first', () => {
    mocks.continuity = { ...CONTINUITY, activity: ACTIVITY };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);

    const entries = screen.getAllByTestId('project-activity-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toContain('run.terminal');
    expect(entries[0].textContent).toContain('status: completed');
    expect(entries[1].textContent).toContain('task.created');
  });

  it('asks the store for the next activity page and opens the referenced session', () => {
    mocks.continuity = { ...CONTINUITY, activity: ACTIVITY };
    mocks.continuityHasMoreActivity = true;
    const onOpenSession = vi.fn();
    render(<ProjectWorkPanel onOpenSession={onOpenSession} onTakeOver={vi.fn()} />);

    fireEvent.click(screen.getByText('project.workspace.activityLoadMore'));
    expect(mocks.loadMoreActivity).toHaveBeenCalledTimes(1);

    // The activity row's own shortcut points at the Session that produced it.
    const openButtons = screen.getAllByText('project.workspace.open');
    fireEvent.click(openButtons[openButtons.length - 1]);
    expect(onOpenSession).toHaveBeenCalledWith('session-work');
  });

  it('hides the load-more control when the Host has no further page', () => {
    mocks.continuity = { ...CONTINUITY, activity: ACTIVITY };
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);
    expect(screen.queryByText('project.workspace.activityLoadMore')).toBeNull();
  });

  it('links transcript refs to the original sessions instead of copying them', () => {
    mocks.continuity = {
      ...CONTINUITY,
      transcriptRefs: [
        { sessionId: 'session-coordinator', role: 'coordinator' },
        { sessionId: 'session-work', role: 'work', taskId: 'task-1' },
      ],
    };
    const onOpenSession = vi.fn();
    render(<ProjectWorkPanel onOpenSession={onOpenSession} onTakeOver={vi.fn()} />);

    const refs = screen.getAllByTestId('project-transcript-ref');
    expect(refs).toHaveLength(2);
    expect(refs[0].textContent).toContain('project.workspace.transcriptCoordinator');
    fireEvent.click(refs[1].querySelector('button')!);
    expect(onOpenSession).toHaveBeenCalledWith('session-work');
  });

  it('says so when there is no activity yet', () => {
    mocks.continuity = CONTINUITY;
    render(<ProjectWorkPanel onOpenSession={vi.fn()} onTakeOver={vi.fn()} />);
    expect(screen.getByText('project.workspace.activityEmpty')).toBeTruthy();
    expect(screen.queryByTestId('project-activity-list')).toBeNull();
  });
});
