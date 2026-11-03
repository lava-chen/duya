/**
 * project-run-settlement.ts — the durable half of "a work Session finished".
 *
 * A dispatched work Session's Run reaching a terminal is only a fact in the
 * run ledger. The project loop needs that fact in two other places:
 *
 *   1. `project_activity`, so restored project context remembers that the
 *      task produced a result and can cite the Run it came from; and
 *   2. the Coordinator's mailbox, so an idle Coordinator wakes up and reports
 *      the outcome to the user instead of leaving the work silently finished.
 *
 * Both writes are idempotent — the activity row is keyed by (project, run) and
 * the mailbox row by a `clientMsgId` derived from the run id — because the
 * live settlement hook and a restart reconciliation must converge on exactly
 * one record and at most one wake.
 *
 * The wake itself is injected rather than implemented here: the standalone
 * Host has no renderer idle dispatcher. Writing the durable mailbox row is the
 * guarantee; waking a surface is the caller's job.
 *
 * Acceptance is deliberately NOT touched. A Run ending means the Session
 * stopped, not that the Task was accepted; the Coordinator reconciles the task
 * from the recorded result.
 */

import { randomUUID } from 'node:crypto';
import type { Mailbox, MailboxItem } from '@duya/data/mailbox';
import type { ProjectActivityRow, ProjectStore } from '@duya/data/project-store';
import type { RunRow, RunStore } from '@duya/data/run-store';

export interface ProjectRunTaskPort {
  get(id: string): { id: string; subject: string; status: string } | null;
}

export interface ProjectRunSettlementStores {
  readonly runs: Pick<RunStore, 'getRun' | 'listEvents' | 'listRunsBySession'>;
  readonly projects: Pick<
    ProjectStore,
    'get' | 'list' | 'getTaskLinkByWorkSession' | 'listTaskLinks' | 'appendActivityOnce'
  >;
  readonly tasks: ProjectRunTaskPort;
  readonly mailbox: Pick<Mailbox, 'enqueue'>;
}

export interface ProjectRunNotice {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskSubject: string;
  readonly taskStatus: string;
  readonly workSessionId: string;
  readonly coordinatorSessionId: string;
  readonly runId: string;
  readonly status: RunRow['status'];
  readonly summary: string;
}

export type ProjectRunSettlementSkipReason =
  | 'run_not_found'
  | 'run_active'
  | 'not_project_work'
  | 'project_not_found';

export type ProjectRunSettlementResult =
  | { readonly state: 'skipped'; readonly reason: ProjectRunSettlementSkipReason }
  | {
      readonly state: 'recorded';
      readonly notice: ProjectRunNotice;
      readonly activity: ProjectActivityRow;
      readonly activityCreated: boolean;
      readonly wakeEnqueued: boolean;
    };

export interface ProjectRunSettlementWakeRequest {
  readonly notice: ProjectRunNotice;
  readonly mailboxItem: MailboxItem;
}

export interface ProjectRunSettlementLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ProjectRunSettlementOptions {
  readonly stores: ProjectRunSettlementStores;
  /** Best-effort surface wake; the durable mailbox row is already written. */
  readonly wake?: (request: ProjectRunSettlementWakeRequest) => void;
  readonly summaryBudget?: number;
  readonly reconcileWindowMs?: number;
  readonly logger?: ProjectRunSettlementLogger;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface ProjectRunSettlementService {
  settleRun(runId: string): ProjectRunSettlementResult;
  reconcile(): { settled: number; skipped: number };
}

const DEFAULT_SUMMARY_BUDGET = 4_000;
const DEFAULT_RECONCILE_WINDOW_MS = 72 * 60 * 60 * 1_000;
const EVENT_PAGE_SIZE = 200;
const KEPT_TEXT_BLOCKS = 24;

export function formatProjectRunNotice(notice: ProjectRunNotice): string {
  const subject = notice.taskSubject.trim();
  const task = subject === '' ? `task ${notice.taskId}` : `task ${notice.taskId} "${subject}"`;
  return [
    `[project-run:${notice.status}] Work Session ${notice.workSessionId} finished ${task}.`,
    `Run: ${notice.runId}`,
    notice.summary,
    'The task has not been accepted by this notification. Reconcile the task list from the recorded result, then report the outcome to the user.',
  ].join('\n');
}

export function createProjectRunSettlementService(
  options: ProjectRunSettlementOptions,
): ProjectRunSettlementService {
  const { stores } = options;
  const summaryBudget = Math.max(200, options.summaryBudget ?? DEFAULT_SUMMARY_BUDGET);
  const reconcileWindowMs = Math.max(0, options.reconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS);
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => randomUUID());

  function settleRun(runId: string): ProjectRunSettlementResult {
    const run = stores.runs.getRun(runId);
    if (run === null) return { state: 'skipped', reason: 'run_not_found' };
    if (run.status === 'running' || run.terminal === null) {
      return { state: 'skipped', reason: 'run_active' };
    }

    const link = stores.projects.getTaskLinkByWorkSession(run.session_id);
    if (link === null) return { state: 'skipped', reason: 'not_project_work' };
    const project = stores.projects.get(link.project_id);
    if (project === null) return { state: 'skipped', reason: 'project_not_found' };

    const task = stores.tasks.get(link.task_id);
    const summary = readRunSummary(stores.runs, run, summaryBudget);
    const notice: ProjectRunNotice = {
      projectId: project.project_id,
      taskId: link.task_id,
      taskSubject: task?.subject ?? '',
      taskStatus: task?.status ?? '',
      workSessionId: run.session_id,
      coordinatorSessionId: project.coordinator_session_id ?? '',
      runId: run.id,
      status: run.status,
      summary,
    };

    const activity = stores.projects.appendActivityOnce({
      project_id: project.project_id,
      event_type: 'run.terminal',
      task_id: link.task_id,
      session_id: run.session_id,
      run_id: run.id,
      source_type: 'run',
      source_id: run.id,
      payload: JSON.stringify({
        status: run.status,
        terminal: run.terminal,
        task_status: task?.status ?? null,
        work_session_id: run.session_id,
        coordinator_session_id: project.coordinator_session_id,
        summary,
      }),
    });

    // Enqueue even when the activity already existed: a crash between the two
    // writes must not leave a durable result with no notification pending.
    const coordinatorSessionId = project.coordinator_session_id;
    if (coordinatorSessionId === null) {
      return {
        state: 'recorded',
        notice,
        activity: activity.row,
        activityCreated: activity.created,
        wakeEnqueued: false,
      };
    }

    const mailboxId = newId();
    const mailboxItem = stores.mailbox.enqueue({
      id: mailboxId,
      sessionId: coordinatorSessionId,
      submittedRunId: '',
      content: formatProjectRunNotice(notice),
      kind: 'background_notification',
      // One wake per Run, across retries and restarts. The mailbox store
      // returns the existing row unchanged when this key already exists.
      clientMsgId: `project-run-terminal:${run.id}`,
      source: 'project-run',
    });
    const wakeEnqueued = mailboxItem.id === mailboxId;
    if (wakeEnqueued) {
      try {
        options.wake?.({ notice, mailboxItem });
      } catch (error) {
        options.logger?.warn('project run wake failed', {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      state: 'recorded',
      notice,
      activity: activity.row,
      activityCreated: activity.created,
      wakeEnqueued,
    };
  }

  function reconcile(): { settled: number; skipped: number } {
    const horizon = now() - reconcileWindowMs;
    let settled = 0;
    let skipped = 0;
    for (const project of stores.projects.list()) {
      for (const link of stores.projects.listTaskLinks(project.project_id)) {
        const workSessionId = link.work_session_id;
        if (workSessionId === null) continue;
        // A decided Task needs no recovery: its outcome already reached the
        // user through the acceptance flow, and waking for it on the first
        // boot of this version would surface old work as news.
        if (link.acceptance_status !== 'pending') continue;
        // Only the newest terminal Run is reconciled: older ones were already
        // delivered (or belong to a Session the user has since reviewed), and
        // waking once per historical Run on first upgrade would flood the
        // Coordinator instead of recovering the interrupted one.
        const latest = stores.runs
          .listRunsBySession(workSessionId, 10)
          .find(
            (run) =>
              run.terminal !== null &&
              run.status !== 'running' &&
              (run.finished_at ?? run.created_at) >= horizon,
          );
        if (latest === undefined) continue;
        const result = settleRun(latest.id);
        // Count only writes this pass actually recovered; an already-settled
        // Run returns the same rows and must not look like new feedback.
        if (
          result.state === 'recorded' &&
          (result.activityCreated || result.wakeEnqueued)
        ) {
          settled += 1;
        } else {
          skipped += 1;
        }
      }
    }
    return { settled, skipped };
  }

  return { settleRun, reconcile };
}

function readRunSummary(
  runs: ProjectRunSettlementStores['runs'],
  run: RunRow,
  budget: number,
): string {
  switch (run.status) {
    case 'completed': {
      const text = readAssistantText(runs, run.id, budget);
      return text === '' ? 'The run completed without assistant text.' : text;
    }
    case 'failed':
      return readFailureMessage(run);
    case 'cancelled':
      return 'The run was cancelled before it finished.';
    case 'budget_exhausted':
      return 'The run stopped because its budget was exhausted.';
    default:
      return `The run ended with status ${run.status}.`;
  }
}

function readFailureMessage(run: RunRow): string {
  if (run.error_json !== null) {
    try {
      const parsed = JSON.parse(run.error_json) as { code?: unknown; message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message !== '') {
        return typeof parsed.code === 'string' && parsed.code !== ''
          ? `${parsed.message} (${parsed.code})`
          : parsed.message;
      }
    } catch {
      // A malformed error column is not a reason to lose the terminal row.
    }
  }
  return 'The run failed without a recorded error message.';
}

function readAssistantText(
  runs: ProjectRunSettlementStores['runs'],
  runId: string,
  budget: number,
): string {
  // Page forward and keep only the tail: a long Run can hold thousands of
  // events, but the Coordinator only needs the final assistant output.
  const texts: string[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = runs.listEvents(runId, afterSeq, EVENT_PAGE_SIZE);
    if (page.length === 0) break;
    for (const row of page) {
      const text = readTextBlock(row.envelope_json);
      if (text === null) continue;
      texts.push(text);
      if (texts.length > KEPT_TEXT_BLOCKS) texts.splice(0, texts.length - KEPT_TEXT_BLOCKS);
    }
    afterSeq = page[page.length - 1]!.seq;
    if (page.length < EVENT_PAGE_SIZE) break;
  }
  return boundTail(texts, budget);
}

function readTextBlock(envelopeJson: string): string | null {
  try {
    const parsed = JSON.parse(envelopeJson) as {
      payload?: { type?: unknown; text?: unknown };
    };
    return parsed.payload?.type === 'assistant.text_block' &&
      typeof parsed.payload.text === 'string'
      ? parsed.payload.text
      : null;
  } catch {
    return null;
  }
}

function boundTail(texts: string[], budget: number): string {
  const kept: string[] = [];
  let size = 0;
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index]!.trim();
    if (text === '') continue;
    const remaining = budget - size;
    if (remaining <= 0) break;
    if (text.length > remaining) {
      kept.unshift(text.slice(text.length - remaining));
      break;
    }
    kept.unshift(text);
    size += text.length + 2;
  }
  return kept.join('\n\n').trim();
}
