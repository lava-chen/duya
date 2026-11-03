/**
 * The TUI's background-task merge.
 *
 * Two producers feed one list: the Host's polled bash snapshot and the
 * `agent_progress` frames a run emits for subagents. The rules that matter
 * are the ones a reader would otherwise have to infer from the view:
 *
 * - a snapshot REPLACES the bash half (the worker's registry is the only
 *   writer, so an absent task is gone);
 * - rows keep the recency they were first seen at: status is not a sort key,
 *   because a row that moves when its task ends moves out from under the
 *   cursor that was about to open it;
 * - a subagent that finishes without a start still gets a row, because its
 *   completion is real work the user asked for.
 */

import { describe, expect, it } from 'vitest';

import {
  BackgroundTaskModel,
  backgroundTaskDetailLines,
  formatTaskDuration,
  taskStatusGlyph,
} from '../background-tasks.js';
import type { BackgroundTaskListV1, BackgroundTaskSummaryV1 } from '@duya/agent-protocol';

function snapshot(tasks: readonly BackgroundTaskSummaryV1[], observed = true): BackgroundTaskListV1 {
  return { observed, tasks };
}

function bashTask(overrides: Partial<BackgroundTaskSummaryV1> = {}): BackgroundTaskSummaryV1 {
  return {
    id: 'task-1',
    command: 'npm run dev',
    status: 'running',
    startedAtMs: 1_000,
    ...overrides,
  };
}

function startedFrame(id: string, name: string) {
  return {
    type: 'agent_progress',
    data: {
      agentEventType: 'subagent_started',
      subagentId: id,
      agentName: name,
      agentType: 'explore',
      agentDescription: `${name} description`,
    },
  };
}

function completedFrame(
  id: string,
  status: string,
  durationMs: number | undefined,
  summary?: string,
) {
  return {
    type: 'agent_progress',
    data: {
      agentEventType: 'subagent_completed',
      subagentId: id,
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(summary === undefined ? {} : { summary }),
    },
  };
}

describe('BackgroundTaskModel bash snapshots', () => {
  it('replaces the bash half wholesale and reports whether anything changed', () => {
    const model = new BackgroundTaskModel();
    const first = snapshot([bashTask()]);
    expect(model.applyBashSnapshot(first)).toBe(true);
    // The identical snapshot is not a change: the poller calls every second,
    // and a repaint per second for nothing is what this flag prevents.
    expect(model.applyBashSnapshot(snapshot([bashTask()]))).toBe(false);
    expect(model.applyBashSnapshot(snapshot([bashTask({ status: 'completed', endedAtMs: 2_000 })]))).toBe(true);
    // An absent task is gone — the registry evicted it, so keeping it would be
    // a row pointing at a process nobody is tracking.
    expect(model.applyBashSnapshot(snapshot([]))).toBe(true);
    expect(model.tasks()).toHaveLength(0);
  });

  it('treats "not observed" as a different answer from "observed and empty"', () => {
    const model = new BackgroundTaskModel();
    expect(model.observed).toBe(false);
    model.applyBashSnapshot(snapshot([], false));
    expect(model.observed).toBe(false);
    model.applyBashSnapshot(snapshot([], true));
    expect(model.observed).toBe(true);
  });

  it('orders by first-seen recency and never re-sorts on a status change', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([
      bashTask({ id: 'done-new', command: 'new', status: 'completed', startedAtMs: 3_000, endedAtMs: 4_000 }),
      bashTask({ id: 'run-old', command: 'old', status: 'running', startedAtMs: 1_000 }),
      bashTask({ id: 'done-old', command: 'old-done', status: 'completed', startedAtMs: 500, endedAtMs: 800 }),
      bashTask({ id: 'run-new', command: 'new-run', status: 'running', startedAtMs: 2_000 }),
    ]));

    // Newest first, and status is NOT a sort key: a finished task outranks a
    // running one that started earlier. Sorting running-first is what makes a
    // row jump out from under the cursor the moment its task ends.
    expect(model.tasks().map((task) => task.id)).toEqual([
      'done-new',
      'run-new',
      'run-old',
      'done-old',
    ]);

    // The same task finishing moves nothing: `run-new` completing must leave it
    // in slot 1, not below `run-old`.
    model.applyBashSnapshot(snapshot([
      bashTask({ id: 'done-new', command: 'new', status: 'completed', startedAtMs: 3_000, endedAtMs: 4_000 }),
      bashTask({ id: 'run-old', command: 'old', status: 'running', startedAtMs: 1_000 }),
      bashTask({ id: 'done-old', command: 'old-done', status: 'completed', startedAtMs: 500, endedAtMs: 800 }),
      bashTask({ id: 'run-new', command: 'new-run', status: 'completed', startedAtMs: 2_000, endedAtMs: 9_000 }),
    ]));
    expect(model.tasks().map((task) => task.id)).toEqual([
      'done-new',
      'run-new',
      'run-old',
      'done-old',
    ]);
    expect(model.bashRunningCount).toBe(1);
  });

  it('counts only running tasks in the summary counts', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([
      bashTask({ id: 'a', status: 'running' }),
      bashTask({ id: 'b', status: 'completed', endedAtMs: 2_000 }),
    ]));
    expect(model.bashRunningCount).toBe(1);
    expect(model.subagentRunningCount).toBe(0);
    expect(model.hasRunning()).toBe(true);

    model.applyBashSnapshot(snapshot([bashTask({ id: 'b', status: 'completed', endedAtMs: 2_000 })]));
    expect(model.hasRunning()).toBe(false);
  });
});

describe('BackgroundTaskModel subagent frames', () => {
  it('adds a running subagent on start and finishes it on completion', () => {
    const model = new BackgroundTaskModel();
    expect(model.applyFrame(startedFrame('sub-1', 'Scout'), 5_000)).toBe(true);

    const running = model.tasks();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      id: 'sub-1',
      kind: 'subagent',
      title: 'Scout',
      detail: 'Scout description',
      status: 'running',
      startedAtMs: 5_000,
    });

    expect(model.applyFrame(completedFrame('sub-1', 'completed', 2_500, 'found the file'), 7_500)).toBe(true);
    const done = model.tasks()[0]!;
    expect(done).toMatchObject({
      status: 'completed',
      startedAtMs: 5_000,
      endedAtMs: 7_500,
      summary: 'found the file',
      title: 'Scout',
    });
    expect(model.hasRunning()).toBe(false);
  });

  it('keeps the original start time when a second start frame arrives', () => {
    const model = new BackgroundTaskModel();
    model.applyFrame(startedFrame('sub-1', 'Scout'), 1_000);
    model.applyFrame(startedFrame('sub-1', 'Scout'), 9_000);
    expect(model.tasks()[0]?.startedAtMs).toBe(1_000);
  });

  it('keeps failed and cancelled as the outcomes they reported', () => {
    const model = new BackgroundTaskModel();
    model.applyFrame(startedFrame('sub-1', 'Scout'), 1_000);
    model.applyFrame(startedFrame('sub-2', 'Reviewer'), 1_100);
    model.applyFrame(completedFrame('sub-1', 'failed', 1_000), 2_000);
    model.applyFrame(completedFrame('sub-2', 'cancelled', 1_000), 2_100);

    expect(model.tasks().map((task) => [task.id, task.status])).toEqual([
      ['sub-2', 'cancelled'],
      ['sub-1', 'failed'],
    ]);
  });

  it('keeps existing rows in place when a new subagent joins', () => {
    const model = new BackgroundTaskModel();
    model.applyFrame(startedFrame('sub-1', 'Scout'), 1_000);
    model.applyFrame(startedFrame('sub-2', 'Reviewer'), 2_000);
    model.applyFrame(completedFrame('sub-1', 'completed', 500), 2_500);
    const before = model.tasks().map((task) => task.id);

    model.applyFrame(startedFrame('sub-3', 'Builder'), 3_000);

    // The newcomer takes the newest slot; the two that were already listed keep
    // their order relative to each other, which is the property the arrows rely
    // on when the user is mid-list.
    const after = model.tasks().map((task) => task.id);
    expect(after[0]).toBe('sub-3');
    expect(after.filter((id) => id !== 'sub-3')).toEqual(before);
  });

  it('records a completion with no matching start, deriving its start from the duration', () => {
    const model = new BackgroundTaskModel();
    // The TUI can attach mid-turn (a session resumed) or the start frame can
    // fall outside the window. Dropping the completion would hide work that
    // really ran, so the row is created from what the frame reported.
    model.applyFrame(completedFrame('orphan', 'completed', 3_000), 10_000);

    expect(model.tasks()[0]).toMatchObject({
      id: 'orphan',
      title: 'Agent',
      status: 'completed',
      startedAtMs: 7_000,
      endedAtMs: 10_000,
    });
  });

  it('treats an unrecognised completion status as terminal', () => {
    const model = new BackgroundTaskModel();
    model.applyFrame(startedFrame('sub-1', 'Scout'), 1_000);
    model.applyFrame(completedFrame('sub-1', 'something-new', 100), 2_000);
    // The protocol's union has exactly three outcomes; a fourth value means a
    // malformed or newer payload, and the frame still says the subagent
    // finished. Leaving it `running` would keep a dead row spinning forever.
    expect(model.tasks()[0]?.status).toBe('completed');
    expect(model.hasRunning()).toBe(false);
  });

  it('ignores frames that are not subagent lifecycle events', () => {
    const model = new BackgroundTaskModel();
    expect(model.applyFrame({ type: 'agent_progress', data: { agentEventType: 'tool_started' } })).toBe(false);
    expect(model.applyFrame({ type: 'text_delta', data: { content: 'hi' } })).toBe(false);
    expect(model.tasks()).toHaveLength(0);
  });

  it('caps retained finished subagents at twenty', () => {
    const model = new BackgroundTaskModel();
    for (let i = 0; i < 30; i += 1) {
      model.applyFrame(startedFrame(`sub-${i}`, `Agent ${i}`), 1_000 + i);
      model.applyFrame(completedFrame(`sub-${i}`, 'completed', 10), 2_000 + i);
    }
    const tasks = model.tasks();
    expect(tasks).toHaveLength(20);
    // The newest ten are the ones dropped; the retained window is the newest.
    expect(tasks[0]?.id).toBe('sub-29');
    expect(tasks.at(-1)?.id).toBe('sub-10');
  });
});

describe('BackgroundTaskModel rows and groups', () => {
  it('paints a heading for each group and one row per task', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([bashTask()]));
    model.applyFrame(startedFrame('sub-1', 'Scout'), 2_000);

    const groups = model.groups();
    // Subagents first: the interactive half of the list sits on top, where the
    // cursor lands; bash processes are reference material underneath it.
    expect(groups.map((group) => [group.id, group.label, group.tasks.length, group.running])).toEqual([
      ['subagent', 'Subagents', 1, 1],
      ['bash', 'Background bash', 1, 1],
    ]);

    expect(model.rows().map((row) => (row.kind === 'group' ? `group:${row.group.id}` : `task:${row.task.id}`))).toEqual([
      'group:subagent',
      'task:sub-1',
      'group:bash',
      'task:task-1',
    ]);
  });

  it('keeps an empty group as a heading so the list does not jump between modes', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([bashTask()]));
    const groups = model.groups();
    expect(groups).toHaveLength(2);
    // The empty group is the SUBAGENTS one here, and it still gets a heading:
    // a list whose first heading changes identity with its contents would make
    // the fold keys act on a different group from one second to the next.
    expect(groups[0]).toMatchObject({ id: 'subagent', tasks: [], running: 0 });
  });

  it('hides a collapsed group\'s tasks but keeps its heading', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([bashTask({ id: 'a' }), bashTask({ id: 'b', command: 'other' })]));

    model.setGroupCollapsed('bash', true);
    expect(model.rows().map((row) => row.kind)).toEqual(['group', 'group']);

    model.toggleGroup('bash');
    expect(model.rows().filter((row) => row.kind === 'task')).toHaveLength(2);
  });

  it('collapseAll folds only groups that have something to fold', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([bashTask()]));
    model.collapseAll();
    // The empty subagent group stays open; folding a heading with nothing under
    // it would only change its glyph and imply hidden content.
    expect(model.isGroupCollapsed('bash')).toBe(true);
    expect(model.isGroupCollapsed('subagent')).toBe(false);
  });
});

describe('BackgroundTaskModel clear', () => {
  it('drops both halves and forgets that the Host was observed', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([bashTask()]));
    model.applyFrame(startedFrame('sub-1', 'Scout'), 1_000);
    model.clear();
    expect(model.tasks()).toHaveLength(0);
    expect(model.observed).toBe(false);
  });
});

describe('task presentation helpers', () => {
  it('formats durations compactly without inventing precision', () => {
    expect(formatTaskDuration(999)).toBe('0s');
    expect(formatTaskDuration(45_000)).toBe('45s');
    expect(formatTaskDuration(125_000)).toBe('2m 05s');
    expect(formatTaskDuration(3_780_000)).toBe('1h 03m');
    // A clock skew must not render a negative duration.
    expect(formatTaskDuration(-5_000)).toBe('0s');
  });

  it('gives every state a glyph, collapsing the aliases deliberately', () => {
    // `failed` and `error` are the same outcome under two producers' names;
    // `killed` and `cancelled` are likewise one outcome. The glyphs say so.
    expect(taskStatusGlyph('failed', true)).toBe(taskStatusGlyph('error', true));
    expect(taskStatusGlyph('killed', true)).toBe(taskStatusGlyph('cancelled', true));
    const distinct = new Set(
      (['running', 'completed', 'failed', 'killed'] as const).map((state) => taskStatusGlyph(state, true)),
    );
    expect(distinct.size).toBe(4);
    expect(taskStatusGlyph('running', true)).toBe('●');
    expect(taskStatusGlyph('running', false)).toBe('*');
  });

  it('describes a bash task with its output tail', () => {
    const lines = backgroundTaskDetailLines(
      {
        id: 'task-1',
        kind: 'bash',
        title: 'npm run dev',
        status: 'completed',
        startedAtMs: 1_000,
        endedAtMs: 3_000,
        exitCode: 0,
        outputBytes: 42,
        autoPromoted: true,
      },
      { taskId: 'task-1', text: 'listening on 3000', totalBytes: 42, truncated: false },
      5_000,
    ).join('\n');

    expect(lines).toContain('npm run dev');
    expect(lines).toContain('completed');
    expect(lines).toContain('exit');
    expect(lines).toContain('promoted from the foreground');
    expect(lines).toContain('Output tail');
    expect(lines).toContain('listening on 3000');
  });

  it('says the output is gone rather than showing an empty body', () => {
    const lines = backgroundTaskDetailLines(
      { id: 'task-1', kind: 'bash', title: 'npm test', status: 'completed', startedAtMs: 1_000 },
      null,
    ).join('\n');
    expect(lines).toContain('Output is no longer available');
  });

  it('does not promise a subagent transcript that the view cannot show', () => {
    const lines = backgroundTaskDetailLines(
      {
        id: 'sub-1',
        kind: 'subagent',
        title: 'Scout',
        detail: 'explore',
        status: 'running',
        startedAtMs: 1_000,
        summary: 'working',
      },
      null,
    ).join('\n');
    expect(lines).toContain('agent');
    expect(lines).toContain('Scout');
    expect(lines).toContain('transcript is not shown here');
  });
});

describe('BackgroundTaskModel snapshot-carried subagents', () => {
  function agentRow(overrides: Partial<BackgroundTaskSummaryV1> = {}): BackgroundTaskSummaryV1 {
    return {
      id: 'sub-1',
      kind: 'subagent',
      label: 'Scout',
      agentType: 'Explore',
      status: 'running',
      startedAtMs: 5_000,
      ...overrides,
    };
  }

  it('folds subagent rows into the subagent half instead of the bash list', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([
      agentRow(),
      bashTask({ id: 'task-1' }),
    ]));
    const groups = model.groups();
    const subagentGroup = groups.find((group) => group.id === 'subagent');
    expect(subagentGroup?.tasks.map((task) => [task.id, task.title, task.detail])).toEqual([
      ['sub-1', 'Scout', 'Explore'],
    ]);
    expect(model.bashRunningCount).toBe(1);
    expect(model.subagentRunningCount).toBe(1);
  });

  it('maps subagent terminal statuses onto view states', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([
      agentRow({ id: 'a-done', status: 'completed', endedAtMs: 6_000 }),
      agentRow({ id: 'a-killed', status: 'killed' }),
      agentRow({ id: 'a-failed', status: 'error' }),
    ]));
    const statuses = Object.fromEntries(
      model.groups()
        .find((group) => group.id === 'subagent')
        ?.tasks.map((task) => [task.id, task.status]) ?? [],
    );
    expect(statuses).toEqual({ 'a-done': 'completed', 'a-killed': 'cancelled', 'a-failed': 'failed' });
  });

  it('never regresses a card the live frames already drew richer', () => {
    const model = new BackgroundTaskModel();
    model.applyFrame(startedFrame('sub-1', 'Scout'));
    model.applyFrame(completedFrame('sub-1', 'completed', 42_000, 'found the answer'));
    model.applyBashSnapshot(snapshot([agentRow({ status: 'running' })]));
    const card = model.groups()
      .find((group) => group.id === 'subagent')
      ?.tasks.find((task) => task.id === 'sub-1');
    expect(card).toMatchObject({
      status: 'completed',
      title: 'Scout',
      summary: 'found the answer',
      endedAtMs: expect.any(Number),
    });
  });

  it('gives a fresh attach its subagent rows even when no frames ever arrived', () => {
    const model = new BackgroundTaskModel();
    model.applyBashSnapshot(snapshot([agentRow({ status: 'completed', endedAtMs: 6_000 })]));
    expect(model.hasRunning()).toBe(false);
    expect(model.groups().find((group) => group.id === 'subagent')?.tasks).toHaveLength(1);
  });
});
