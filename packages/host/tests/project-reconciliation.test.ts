/**
 * project-reconciliation.test.ts — the shared Run-terminal → project feedback
 * loop: one activity row, one durable Coordinator notification, no acceptance.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectRunSettlementService,
  formatProjectRunNotice,
  type ProjectRunSettlementStores,
  type ProjectRunNotice,
} from '../src/project/reconciliation.js';
import type { ProjectActivityRow, ProjectTaskLinkRow } from '@duya/data/project-store';
import type { RunRow } from '@duya/data/run-store';
import type { MailboxItem } from '@duya/data/mailbox';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const WORK_SESSION_ID = 'work-session-1';
const COORDINATOR_ID = 'coordinator-1';
const RUN_ID = 'run-1';

interface Harness {
  readonly stores: ProjectRunSettlementStores;
  readonly activities: ProjectActivityRow[];
  readonly mailbox: MailboxItem[];
  readonly runs: Map<string, RunRow>;
  readonly events: Map<string, Array<{ seq: number; envelope_json: string }>>;
  readonly projects: Map<string, { project_id: string; coordinator_session_id: string | null }>;
  readonly links: Map<string, ProjectTaskLinkRow>;
  readonly tasks: Map<string, { id: string; subject: string; status: string }>;
}

function runRow(patch: Partial<RunRow> & Pick<RunRow, 'id' | 'session_id'>): RunRow {
  return {
    manifest_hash: 'hash',
    manifest_json: '{}',
    input_hash: null,
    epoch: 0,
    status: 'completed',
    terminal: 'completed',
    error_json: null,
    metrics_json: null,
    origin: null,
    parent_run_id: null,
    created_at: 1_000,
    started_at: 1_100,
    finished_at: 2_000,
    ...patch,
  };
}

function textEvent(seq: number, text: string): { seq: number; envelope_json: string } {
  return {
    seq,
    envelope_json: JSON.stringify({
      payload: { type: 'assistant.text_block', messageId: `m-${seq}`, index: 0, text },
    }),
  };
}

function taskLink(overrides: Partial<ProjectTaskLinkRow> = {}): ProjectTaskLinkRow {
  return {
    project_id: PROJECT_ID,
    task_id: TASK_ID,
    coordinator_session_id: COORDINATOR_ID,
    work_session_id: WORK_SESSION_ID,
    updated_at: 3_000,
    acceptance_status: 'pending',
    ...overrides,
  };
}

function createHarness(): Harness {
  const runs = new Map<string, RunRow>();
  const events = new Map<string, Array<{ seq: number; envelope_json: string }>>();
  const projectRows = new Map<string, { project_id: string; coordinator_session_id: string | null }>([
    [PROJECT_ID, { project_id: PROJECT_ID, coordinator_session_id: COORDINATOR_ID }],
  ]);
  const links = new Map<string, ProjectTaskLinkRow>([[WORK_SESSION_ID, taskLink()]]);
  const tasks = new Map<string, { id: string; subject: string; status: string }>([
    [TASK_ID, { id: TASK_ID, subject: 'Implement billing', status: 'in_progress' }],
  ]);
  const activities: ProjectActivityRow[] = [];
  const mailbox: MailboxItem[] = [];
  let nextActivityId = 1;

  const stores = {
    runs: {
      getRun: (runId: string) => runs.get(runId) ?? null,
      listEvents: (runId: string, afterSeq = 0, limit = 1_000) =>
        (events.get(runId) ?? []).filter((event) => event.seq > afterSeq).slice(0, limit),
      listRunsBySession: (sessionId: string, limit = 50) =>
        [...runs.values()]
          .filter((run) => run.session_id === sessionId)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit),
    },
    projects: {
      get: (projectId: string) => projectRows.get(projectId) ?? null,
      list: () => [...projectRows.values()],
      getTaskLinkByWorkSession: (workSessionId: string) => links.get(workSessionId) ?? null,
      listTaskLinks: (projectId: string) =>
        [...links.values()].filter((link) => link.project_id === projectId),
      appendActivityOnce: (input: Omit<ProjectActivityRow, 'event_id' | 'created_at'>) => {
        const existing = activities.find(
          (activity) =>
            activity.project_id === input.project_id &&
            activity.event_type === input.event_type &&
            activity.source_type === input.source_type &&
            activity.source_id === input.source_id,
        );
        if (existing) return { row: existing, created: false };
        const row: ProjectActivityRow = { ...input, event_id: nextActivityId, created_at: 5_000 };
        nextActivityId += 1;
        activities.push(row);
        return { row, created: true };
      },
    },
    tasks: { get: (taskId: string) => tasks.get(taskId) ?? null },
    mailbox: {
      enqueue: (input: Parameters<Harness['stores']['mailbox']['enqueue']>[0]) => {
        const existing = mailbox.find(
          (item) =>
            item.sessionId === input.sessionId &&
            input.clientMsgId !== null &&
            input.clientMsgId !== undefined &&
            item.clientMsgId === input.clientMsgId,
        );
        if (existing) return existing;
        const item = {
          id: input.id,
          sessionId: input.sessionId,
          kind: input.kind,
          status: 'pending',
          priority: 100,
          content: input.content,
          attachments: null,
          source: input.source ?? 'ui',
          clientMsgId: input.clientMsgId ?? null,
          submittedRunId: input.submittedRunId,
          claimToken: null,
          claimExpiresAt: null,
          claimAttempts: 0,
          lastClaimError: null,
          observedAt: null,
          observedAtCheckpoint: null,
          observedByRunId: null,
          injectedRunId: null,
          applyMode: null,
          meta: {},
          createdAt: 6_000,
        } as unknown as MailboxItem;
        mailbox.push(item);
        return item;
      },
    },
  } as unknown as ProjectRunSettlementStores;

  return { stores, activities, mailbox, runs, events, projects: projectRows, links, tasks };
}

function settle(harness: Harness, wake?: ReturnType<typeof vi.fn>) {
  let nextId = 0;
  return createProjectRunSettlementService({
    stores: harness.stores,
    ...(wake === undefined ? {} : { wake }),
    now: () => 10_000,
    newId: () => `mailbox-${nextId++}`,
  });
}

describe('project run settlement', () => {
  it('records one activity row and one Coordinator notification for a completed run', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID }));
    harness.events.set(RUN_ID, [
      textEvent(1, 'first draft'),
      { seq: 2, envelope_json: JSON.stringify({ payload: { type: 'tool.requested' } }) },
      textEvent(3, 'billing is implemented and tested'),
    ]);
    const wake = vi.fn();

    const result = settle(harness, wake).settleRun(RUN_ID);

    expect(result.state).toBe('recorded');
    if (result.state !== 'recorded') return;
    expect(result.activityCreated).toBe(true);
    expect(result.wakeEnqueued).toBe(true);
    expect(harness.activities).toHaveLength(1);
    expect(harness.activities[0]).toMatchObject({
      project_id: PROJECT_ID,
      event_type: 'run.terminal',
      task_id: TASK_ID,
      session_id: WORK_SESSION_ID,
      run_id: RUN_ID,
      source_type: 'run',
      source_id: RUN_ID,
    });
    const payload = JSON.parse(harness.activities[0]!.payload) as Record<string, unknown>;
    expect(payload.status).toBe('completed');
    expect(payload.summary).toContain('billing is implemented and tested');
    expect(payload.summary.endsWith('billing is implemented and tested')).toBe(true);
    expect(result.notice.summary).toBe('first draft\n\nbilling is implemented and tested');

    expect(harness.mailbox).toHaveLength(1);
    expect(harness.mailbox[0]).toMatchObject({
      sessionId: COORDINATOR_ID,
      kind: 'background_notification',
      clientMsgId: `project-run-terminal:${RUN_ID}`,
      source: 'project-run',
    });
    expect(harness.mailbox[0]!.content).toContain('billing is implemented and tested');
    expect(harness.mailbox[0]!.content).toContain('has not been accepted');
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across retries and does not wake twice', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID }));
    const wake = vi.fn();
    const service = settle(harness, wake);

    const first = service.settleRun(RUN_ID);
    const second = service.settleRun(RUN_ID);

    expect(first.state).toBe('recorded');
    expect(second.state).toBe('recorded');
    if (second.state !== 'recorded') return;
    expect(second.activityCreated).toBe(false);
    expect(second.wakeEnqueued).toBe(false);
    expect(harness.activities).toHaveLength(1);
    expect(harness.mailbox).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('enqueues the missing notification when the activity already exists', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID }));
    const firstWake = vi.fn();
    settle(harness, firstWake).settleRun(RUN_ID);
    harness.mailbox.length = 0;

    const secondWake = vi.fn();
    const result = settle(harness, secondWake).settleRun(RUN_ID);

    expect(result.state).toBe('recorded');
    if (result.state !== 'recorded') return;
    expect(result.activityCreated).toBe(false);
    expect(result.wakeEnqueued).toBe(true);
    expect(harness.mailbox).toHaveLength(1);
    expect(secondWake).toHaveBeenCalledTimes(1);
  });

  it('ignores runs that did not dispatch a project work session', () => {
    const harness = createHarness();
    harness.runs.set('coordinator-run', runRow({ id: 'coordinator-run', session_id: COORDINATOR_ID }));
    const wake = vi.fn();
    const result = settle(harness, wake).settleRun('coordinator-run');
    expect(result).toEqual({ state: 'skipped', reason: 'not_project_work' });
    expect(harness.activities).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it('ignores a run that has not settled', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID, status: 'running', terminal: null }));
    expect(settle(harness).settleRun(RUN_ID)).toEqual({ state: 'skipped', reason: 'run_active' });
    expect(settle(harness).settleRun('missing')).toEqual({ state: 'skipped', reason: 'run_not_found' });
  });

  it('reports the recorded failure instead of an empty summary', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({
      id: RUN_ID,
      session_id: WORK_SESSION_ID,
      status: 'failed',
      terminal: 'failed',
      error_json: JSON.stringify({ code: 'provider_error', message: 'stream closed' }),
    }));
    harness.events.set(RUN_ID, [textEvent(1, 'partial work')]);

    const result = settle(harness).settleRun(RUN_ID);
    expect(result.state).toBe('recorded');
    if (result.state !== 'recorded') return;
    expect(result.notice.summary).toBe('stream closed (provider_error)');
    expect(harness.mailbox[0]!.content).toContain('stream closed (provider_error)');
  });

  it('bounds the summary to the configured budget, keeping the tail', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID }));
    harness.events.set(RUN_ID, [textEvent(1, 'a'.repeat(1_000)), textEvent(2, 'z'.repeat(1_000))]);
    const service = createProjectRunSettlementService({
      stores: harness.stores,
      summaryBudget: 200,
      newId: () => 'mailbox-bounded',
      now: () => 10_000,
    });
    const result = service.settleRun(RUN_ID);
    expect(result.state).toBe('recorded');
    if (result.state !== 'recorded') return;
    expect(result.notice.summary).toHaveLength(200);
    expect(result.notice.summary.endsWith('z')).toBe(true);
  });

  it('reconciles only the newest recent terminal run per work session', () => {
    const harness = createHarness();
    harness.runs.set('old-run', runRow({
      id: 'old-run', session_id: WORK_SESSION_ID, created_at: 1_000, finished_at: 1_000,
    }));
    harness.runs.set('new-run', runRow({
      id: 'new-run', session_id: WORK_SESSION_ID, created_at: 9_000, finished_at: 9_500,
    }));
    const wake = vi.fn();
    const service = createProjectRunSettlementService({
      stores: harness.stores,
      wake,
      now: () => 10_000,
      reconcileWindowMs: 5_000,
      newId: () => 'mailbox-reconcile',
    });

    expect(service.reconcile()).toEqual({ settled: 1, skipped: 0 });
    expect(harness.activities.map((activity) => activity.run_id)).toEqual(['new-run']);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not resurface runs for tasks that were already accepted', () => {
    const harness = createHarness();
    harness.links.set(WORK_SESSION_ID, taskLink({ acceptance_status: 'accepted' }));
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID, created_at: 9_000, finished_at: 9_500 }));
    const wake = vi.fn();

    const result = serviceWith(harness, wake).reconcile();

    expect(result).toEqual({ settled: 0, skipped: 0 });
    expect(harness.activities).toHaveLength(0);
    expect(harness.mailbox).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it('does not count an already-settled run as recovered', () => {
    const harness = createHarness();
    harness.runs.set(RUN_ID, runRow({ id: RUN_ID, session_id: WORK_SESSION_ID, created_at: 9_000, finished_at: 9_500 }));
    const service = serviceWith(harness, vi.fn());
    service.settleRun(RUN_ID);

    expect(service.reconcile()).toEqual({ settled: 0, skipped: 1 });
    expect(harness.activities).toHaveLength(1);
    expect(harness.mailbox).toHaveLength(1);
  });
});

function serviceWith(harness: Harness, wake: ReturnType<typeof vi.fn>) {
  let nextId = 0;
  return createProjectRunSettlementService({
    stores: harness.stores,
    wake,
    now: () => 10_000,
    reconcileWindowMs: 5_000,
    newId: () => `mailbox-test-${nextId++}`,
  });
}

describe('formatProjectRunNotice', () => {
  it('names the task, the session and the run, and keeps acceptance explicit', () => {
    const notice: ProjectRunNotice = {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskSubject: 'Implement billing',
      taskStatus: 'in_progress',
      workSessionId: WORK_SESSION_ID,
      coordinatorSessionId: COORDINATOR_ID,
      runId: RUN_ID,
      status: 'completed',
      summary: 'done',
    };
    const text = formatProjectRunNotice(notice);
    expect(text).toContain(`Work Session ${WORK_SESSION_ID}`);
    expect(text).toContain(`task ${TASK_ID} "Implement billing"`);
    expect(text).toContain(`Run: ${RUN_ID}`);
    expect(text).toContain('has not been accepted');
  });
});
