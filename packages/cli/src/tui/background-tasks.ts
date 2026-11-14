/**
 * The TUI's view of background work.
 *
 * Two producers, one list: the Host's bash-task snapshot (polled) and the
 * `agent_progress` frames a run emits for subagents. They are merged HERE
 * rather than on the wire because they answer the same user question
 * ("what is still running?") from sources that do not share a registry —
 * a background bash is a Host process, a subagent is a run-level event.
 *
 * Completed entries are kept until the session is left or cleared: the point
 * of the task view is inspection after the fact, and a row that vanishes the
 * moment it finishes cannot be inspected.
 */

import type {
  BackgroundTaskListV1,
  BackgroundTaskOutputV1,
  BackgroundTaskStatusV1,
  BackgroundTaskSummaryV1,
} from '@duya/agent-protocol';
import type { Message as TranscriptMessage, MessageContent } from '@duya/agent-protocol/transcript';
import { frameRecord, frameString, type LegacyFrame } from './blocks.js';
import { formatTaskDuration } from './subagent.js';

/**
 * Re-exported so every existing caller keeps importing it from here.
 *
 * The definition moved to `subagent.ts` because the transcript's subagent card
 * prints a duration too, and a renderer that imported the task MODEL to format
 * a number would drag `@duya/agent-protocol` into the pure render path.
 */
export { formatTaskDuration };


export type BackgroundTaskKind = 'bash' | 'subagent';
export type BackgroundTaskGroupId = BackgroundTaskKind;
/**
 * Bash statuses plus the subagent vocabulary. A subagent reports
 * `completed | failed | cancelled`; bash reports `error`, which is the same
 * outcome under a different name, and both are kept so neither producer is
 * rewritten in the view layer.
 */
export type BackgroundTaskState = BackgroundTaskStatusV1 | 'failed' | 'cancelled';

/** One row the task view can paint and the detail window can describe. */
export interface BackgroundTaskView {
  readonly id: string;
  readonly kind: BackgroundTaskKind;
  /** Command line for bash, agent name for a subagent. */
  readonly title: string;
  /** Agent type or description, when the producer reported one. */
  readonly detail?: string;
  readonly status: BackgroundTaskState;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly exitCode?: number;
  readonly error?: string;
  readonly summary?: string;
  readonly subagentSessionId?: string;
  readonly outputBytes?: number;
  readonly pid?: number;
  readonly autoPromoted?: boolean;
}

export interface BackgroundTaskGroup {
  readonly id: BackgroundTaskGroupId;
  readonly label: string;
  readonly tasks: readonly BackgroundTaskView[];
  readonly running: number;
  readonly collapsed: boolean;
}

/** A painted row: a group heading or a task inside it. */
export type BackgroundTaskRow =
  | { readonly kind: 'group'; readonly group: BackgroundTaskGroup; readonly index: number }
  | { readonly kind: 'task'; readonly task: BackgroundTaskView; readonly index: number };

/** Terminal subagents kept per session; older ones are dropped. */
const MAX_TERMINAL_SUBAGENTS = 20;

export function isRunningState(status: BackgroundTaskState): boolean {
  return status === 'running';
}

/**
 * One-character status marker. ASCII fallbacks are plain punctuation so a
 * terminal without box-drawing support still distinguishes the states.
 */
export function taskStatusGlyph(status: BackgroundTaskState, unicode: boolean): string {
  switch (status) {
    case 'running': return unicode ? '●' : '*';
    case 'completed': return unicode ? '✓' : '+';
    case 'failed':
    case 'error': return unicode ? '✗' : 'x';
    case 'killed':
    case 'cancelled': return unicode ? '■' : '-';
    default: return '?';
  }
}

/** Local `YYYY-MM-DD HH:MM:SS`; a wall-clock time needs no timezone suffix. */
export function formatTaskTime(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The detail body: what the task is, how it ended, and (for bash) the tail of
 * its output. The output argument is `null` when the tail could not be read —
 * "no longer available" is a fact worth showing, not an empty body.
 */
export function backgroundTaskDetailLines(
  task: BackgroundTaskView,
  output: BackgroundTaskOutputV1 | null,
  now = Date.now(),
): string[] {
  const lines: string[] = [];
  const field = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') lines.push(`  ${label.padEnd(10)}${value}`);
  };
  field(task.kind === 'bash' ? 'command' : 'agent', task.title);
  if (task.detail !== undefined) field('type', task.detail);
  field('status', task.status);
  field('started', formatTaskTime(task.startedAtMs));
  field('elapsed', formatTaskDuration((task.endedAtMs ?? now) - task.startedAtMs));
  if (task.pid !== undefined) field('pid', String(task.pid));
  if (task.exitCode !== undefined) field('exit', String(task.exitCode));
  if (task.outputBytes !== undefined) field('output', formatBytes(task.outputBytes));
  if (task.error !== undefined) field('error', task.error);
  if (task.summary !== undefined) field('summary', task.summary);
  if (task.autoPromoted === true) {
    lines.push('  note      promoted from the foreground while still running; the process was never restarted');
  }
  field('id', task.id);

  if (task.kind === 'subagent') {
    lines.push('');
    if (output === null) {
      lines.push('  No subagent messages are available yet.');
      return lines;
    }
    if (output.truncated) lines.push('  Earlier activity omitted; showing the latest events.');
    lines.push(...subagentProgressLines(output.text));
    return lines;
  }

  lines.push('');
  if (output === null) {
    lines.push('  Output is no longer available for this task.');
    return lines;
  }
  lines.push(`  Output tail (${formatBytes(output.text.length)} of ${formatBytes(output.totalBytes)}${output.truncated ? ', truncated' : ''}):`);
  lines.push('');
  lines.push(output.text === '' ? '  (no output yet)' : output.text);
  return lines;
}

/** Project the append-only child activity log into the regular transcript view. */
export function backgroundTaskTranscriptMessages(output: BackgroundTaskOutputV1 | null): TranscriptMessage[] {
  if (output === null || output.text.trim() === '') {
    return [{ role: 'assistant', source: 'subagent', content: 'Waiting for the subagent to send its first event.' }];
  }
  const content: MessageContent[] = [];
  const toolIds: string[] = [];
  let nextToolId = 0;
  const appendText = (text: string): void => {
    if (text === '') return;
    const last = content[content.length - 1];
    if (last?.type === 'text') last.text += text;
    else content.push({ type: 'text', text });
  };
  if (output.truncated) appendText('Earlier activity omitted; showing the latest events.\n');
  for (const source of output.text.split(/\r?\n/u)) {
    if (source.trim() === '') continue;
    let record: unknown;
    try { record = JSON.parse(source) as unknown; } catch { appendText(`${source}\n`); continue; }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const envelope = record as Record<string, unknown>;
    const payload = envelope['payload'] !== null && typeof envelope['payload'] === 'object' && !Array.isArray(envelope['payload'])
      ? envelope['payload'] as Record<string, unknown>
      : envelope;
    const kind = typeof payload['type'] === 'string' ? payload['type']
      : typeof envelope['type'] === 'string' ? envelope['type'] : '';
    const data = typeof payload['data'] === 'string' ? payload['data'] : '';
    if (kind === 'text') appendText(data);
    else if (kind === 'thinking') {
      if (data !== '') content.push({ type: 'thinking', thinking: data });
    } else if (kind === 'tool_use') {
      const id = `subagent:${output.taskId}:${nextToolId++}`;
      const rawInput = payload['toolInput'];
      const input = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : {};
      toolIds.push(id);
      content.push({
        type: 'tool_use',
        id,
        name: typeof payload['toolName'] === 'string' && payload['toolName'] !== '' ? payload['toolName'] : 'tool',
        input,
      });
    } else if (kind === 'tool_result') {
      const result = typeof payload['toolResult'] === 'string' ? payload['toolResult'] : data;
      const id = toolIds.pop();
      if (id === undefined) appendText(`\n${typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool'} result:\n${result}\n`);
      else content.push({ type: 'tool_result', tool_use_id: id, content: result, is_error: result.includes('<tool_use_error>') });
    } else if (kind === 'error') appendText(`\nError: ${data || 'subagent reported an error'}\n`);
  }
  if (content.length === 0) appendText('Waiting for the subagent to send its first event.');
  return [{ role: 'assistant', source: 'subagent', content }];
}

/** Render the Host's append-only progress log as readable child-agent activity. */
function subagentProgressLines(text: string): string[] {
  const lines: string[] = [];
  for (const source of text.split(/\r?\n/u)) {
    if (source.trim() === '') continue;
    let record: unknown;
    try { record = JSON.parse(source) as unknown; } catch { lines.push(`  ${source}`); continue; }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const envelope = record as Record<string, unknown>;
    const payload = envelope['payload'] !== null && typeof envelope['payload'] === 'object' && !Array.isArray(envelope['payload'])
      ? envelope['payload'] as Record<string, unknown>
      : envelope;
    const kind = typeof payload['type'] === 'string' ? payload['type']
      : typeof envelope['type'] === 'string' ? envelope['type'] : 'event';
    const data = typeof payload['data'] === 'string' ? payload['data'] : '';
    if (kind === 'text' || kind === 'thinking') {
      const label = kind === 'thinking' ? 'Thinking' : 'Agent';
      for (const row of data.split(/\r?\n/u)) if (row !== '') lines.push(`  ${label}: ${row}`);
    } else if (kind === 'tool_use') {
      const name = typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool';
      const input = payload['toolInput'];
      lines.push(`  ▸ ${name}`);
      if (input !== undefined) {
        for (const row of JSON.stringify(input, null, 2).split(/\r?\n/u)) lines.push(`    ${row}`);
      }
    } else if (kind === 'tool_result') {
      const name = typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool';
      const result = typeof payload['toolResult'] === 'string' ? payload['toolResult'] : data;
      lines.push(`  ${name} result:`);
      for (const row of result.split(/\r?\n/u)) lines.push(`    ${row}`);
    } else if (kind === 'error') {
      lines.push(`  Error: ${data || 'subagent reported an error'}`);
    } else if (kind === 'started' || kind === 'completed' || kind === 'failed' || kind === 'done') {
      lines.push(`  ${kind}${data === '' ? '' : `: ${data}`}`);
    }
  }
  return lines.length === 0 ? ['  Waiting for the subagent to send its first event.'] : lines;
}

export class BackgroundTaskModel {
  private bash: readonly BackgroundTaskSummaryV1[] = [];
  private bashObserved = false;
  private readonly subagents = new Map<string, BackgroundTaskView>();
  private readonly collapsedGroups = new Set<BackgroundTaskGroupId>();
  /**
   * First-seen recency, one rank per task; higher means newer.
   *
   * ## Why the list does not re-sort
   *
   * The obvious order — running first, then newest first — is wrong for a view
   * the user NAVIGATES. A task that finishes would jump to the bottom of its
   * group, under the cursor of somebody who was about to press Enter on it, and
   * a second completion would move the row they were reading. That is the same
   * failure codex's agent list calls out by name ("if this is treated as
   * cleanup, wrap-around navigation reshapes itself mid-session").
   *
   * So a task takes a rank the first time it is seen and keeps it for the rest
   * of the session, and recency alone decides the order. Newest stays on top,
   * but nothing that already exists ever moves because of a state change.
   *
   * The two producers rank differently on purpose: a subagent frame arrives in
   * spawn order, so arrival order IS recency, while the first bash snapshot is
   * a batch that has to be ranked by start time. Both end up meaning the same
   * thing by the time `ordered()` reads them.
   */
  private readonly ranks = new Map<string, number>();
  private nextRank = 0;

  /**
   * Whether the Host answered the list request at all. False with no tasks
   * means the view cannot promise "nothing is running", only "unknown".
   */
  get observed(): boolean {
    return this.bashObserved;
  }

  /**
   * Replace the bash half with a fresh Host snapshot.
   *
   * A snapshot is a complete reading, not a delta: a task absent from it is
   * gone (the registry evicted it), so the replacement is wholesale. Rows the
   * Host marks `kind: 'subagent'` belong to the subagent half and fold into
   * the same map the live frames feed — the snapshot is what a TUI that never
   * saw the spawn (fresh attach, missed frames) reads to learn a child
   * exists at all.
   */
  applyBashSnapshot(snapshot: BackgroundTaskListV1): boolean {
    const bashRows: BackgroundTaskSummaryV1[] = [];
    for (const task of snapshot.tasks) {
      if (task.kind === 'subagent') this.foldSnapshotSubagent(task);
      else bashRows.push(task);
    }
    const changed = !this.bashObserved
      || snapshot.observed !== this.bashObserved
      || !sameBashTasks(this.bash, bashRows);
    this.bashObserved = snapshot.observed;
    this.bash = bashRows;
    // Rank the batch OLDEST-first, so the highest rank is the newest task and
    // the first poll reads the way the old start-time sort did. From here on
    // these ranks are frozen: a task that finishes keeps its slot.
    for (const task of this.bash.slice().sort((a, b) => a.startedAtMs - b.startedAtMs)) {
      this.rankOf('bash', task.id);
    }
    return changed;
  }

  /**
   * Upsert one snapshot-carried subagent row. The live frames stay the richer
   * producer (description, summary); a snapshot row only fills in what it
   * knows and never regresses a card the frames already drew.
   */
  private foldSnapshotSubagent(task: BackgroundTaskSummaryV1): void {
    const existing = this.subagents.get(task.id);
    const status = task.status === 'running'
      ? 'running'
      : task.status === 'killed'
        ? 'cancelled'
        : task.status === 'completed'
          ? 'completed'
          : 'failed';
    // A snapshot's `running` can be stale next to a terminal frame this
    // process already folded; the reverse (frames missed a completion the
    // snapshot caught) is the reason the fold exists. So a row that already
    // reached a terminal state never goes back to running.
    const effectiveStatus = existing !== undefined && existing.status !== 'running' && status === 'running'
      ? existing.status
      : status;
    this.rankOf('subagent', task.id);
    this.subagents.set(task.id, {
      id: task.id,
      kind: 'subagent',
      title: existing?.title ?? task.label ?? task.agentType ?? 'Agent',
      ...(existing?.detail === undefined
        ? (task.agentType === undefined ? {} : { detail: task.agentType })
        : { detail: existing.detail }),
      status: effectiveStatus,
      startedAtMs: existing?.startedAtMs ?? task.startedAtMs,
      ...(task.endedAtMs === undefined
        ? (existing?.endedAtMs === undefined ? {} : { endedAtMs: existing.endedAtMs })
        : { endedAtMs: task.endedAtMs }),
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(existing?.summary === undefined ? {} : { summary: existing.summary }),
      ...(task.subagentSessionId === undefined ? (existing?.subagentSessionId === undefined ? {} : { subagentSessionId: existing.subagentSessionId }) : { subagentSessionId: task.subagentSessionId }),
    });
    this.trimTerminalSubagents();
  }

  /**
   * Fold one `agent_progress` frame in. Returns whether the task list changed.
   */
  applyFrame(frame: LegacyFrame, now = Date.now()): boolean {
    if (frame.type !== 'agent_progress') return false;
    const data = frameRecord(frame.data);
    const eventType = frameString(data, 'agentEventType');
    const id = frameString(data, 'subagentId');
    if (id === '') return false;

    if (eventType === 'subagent_started' || eventType === 'started') {
      const name = frameString(data, 'agentName') || frameString(data, 'agentType') || 'Agent';
      const type = frameString(data, 'agentType');
      const description = frameString(data, 'agentDescription');
      const detail = description !== '' ? description : type !== '' ? type : undefined;
      const startedAtMs = this.subagents.get(id)?.startedAtMs ?? now;
      this.rankOf('subagent', id);
      this.subagents.set(id, {
        id,
        kind: 'subagent',
        title: name,
        ...(detail === undefined ? {} : { detail }),
        status: 'running',
        startedAtMs,
        ...(frameString(data, 'agentSessionId') === '' ? {} : { subagentSessionId: frameString(data, 'agentSessionId') }),
      });
      return true;
    }

    if (eventType === 'subagent_completed' || eventType === 'completed' || eventType === 'done' || eventType === 'failed' || eventType === 'error') {
      const durationMs = typeof data['durationMs'] === 'number' && Number.isFinite(data['durationMs'])
        ? Math.max(0, data['durationMs'])
        : null;
      const existing = this.subagents.get(id);
      const reportedStatus = frameString(data, 'status');
      const status = eventType === 'failed' || eventType === 'error'
        ? 'failed'
        : eventType === 'completed' || eventType === 'done'
          ? 'completed'
          : readSubagentStatus(reportedStatus);
      const endedAtMs = now;
      const startedAtMs = existing?.startedAtMs ?? (durationMs === null ? now : now - durationMs);
      const summary = frameString(data, 'summary');
      this.subagents.set(id, {
        id,
        kind: 'subagent',
        title: existing?.title ?? 'Agent',
        ...(existing?.detail === undefined ? {} : { detail: existing.detail }),
        status,
        startedAtMs,
        endedAtMs,
        ...(summary === '' ? {} : { summary }),
        ...(existing?.subagentSessionId === undefined ? {} : { subagentSessionId: existing.subagentSessionId }),
      });
      this.trimTerminalSubagents();
      return true;
    }

    return false;
  }

  /** Drop everything. Used by `/clear` and when the shown session changes. */
  clear(): void {
    this.bash = [];
    this.bashObserved = false;
    this.subagents.clear();
    this.ranks.clear();
    this.nextRank = 0;
  }

  /** True when any task — bash or subagent — is still running. */
  hasRunning(): boolean {
    return this.bash.some((task) => task.status === 'running')
      || [...this.subagents.values()].some((task) => task.status === 'running');
  }

  get bashRunningCount(): number {
    return this.bash.filter((task) => task.status === 'running').length;
  }

  get subagentRunningCount(): number {
    return [...this.subagents.values()].filter((task) => task.status === 'running').length;
  }

  /**
   * Every known task, in list order: the subagents, then the bash half.
   *
   * Delegates to `groups()` rather than sorting again. Two sorts over two rank
   * namespaces is two answers to "what order is this list in", and they drift
   * the first time either producer changes — a subagent ranked through
   * `tasks()` and through `groups()` would not agree with itself.
   */
  tasks(): BackgroundTaskView[] {
    return this.groups().flatMap((group) => group.tasks);
  }

  /**
   * Two groups in display order; an empty group is still a heading.
   *
   * Subagents first, and not because they are newer: a bash task is a process
   * the user is monitoring, while a subagent is an agent they talk TO and can
   * switch between. The interactive half belongs at the top, where the cursor
   * lands and where the eye starts; the process list is reference material and
   * reads fine underneath it.
   */
  groups(): BackgroundTaskGroup[] {
    const bash = this.ordered(this.bash.map((task) => ({ view: bashView(task), key: task.id })), 'bash');
    const subagents = this.ordered(
      [...this.subagents.values()].map((view) => ({ view, key: view.id })),
      'subagent',
    );
    return [
      {
        id: 'subagent',
        label: 'Subagents',
        tasks: subagents,
        running: subagents.filter((task) => task.status === 'running').length,
        collapsed: this.collapsedGroups.has('subagent'),
      },
      {
        id: 'bash',
        label: 'Background bash',
        tasks: bash,
        running: bash.filter((task) => task.status === 'running').length,
        collapsed: this.collapsedGroups.has('bash'),
      },
    ];
  }

  /** The rank a task was first seen at; 0 for one that has never been seen. */
  private rankOf(group: BackgroundTaskGroupId, id: string): number {
    const key = `${group}:${id}`;
    const existing = this.ranks.get(key);
    if (existing !== undefined) return existing;
    const rank = this.nextRank;
    this.nextRank += 1;
    this.ranks.set(key, rank);
    return rank;
  }

  /**
   * Sort one group by first-seen recency, NEWEST FIRST.
   *
   * The group is part of the rank key because two producers may mint the same
   * id: a bash task and a subagent are different things even when they are both
   * called `1`, and sharing a rank would let one group's arrival reorder the
   * other's rows.
   */
  private ordered(
    entries: ReadonlyArray<{ readonly view: BackgroundTaskView; readonly key: string }>,
    group: BackgroundTaskGroupId,
  ): BackgroundTaskView[] {
    return entries
      .map((entry) => ({ view: entry.view, rank: this.rankOf(group, entry.key) }))
      .sort((a, b) => b.rank - a.rank)
      .map((entry) => entry.view);
  }

  /** The flattened rows the task view paints and the arrows move through. */
  rows(): BackgroundTaskRow[] {
    const groups = this.groups();
    // With nothing anywhere there is no list to navigate, only the empty
    // state. Two headings over zero tasks would be selectable rows that open
    // nothing and would hide the "no tasks" / "unavailable" answer.
    if (!groups.some((group) => group.tasks.length > 0)) return [];
    const rows: BackgroundTaskRow[] = [];
    for (const group of groups) {
      rows.push({ kind: 'group', group, index: rows.length });
      if (group.collapsed) continue;
      for (const task of group.tasks) {
        rows.push({ kind: 'task', task, index: rows.length });
      }
    }
    return rows;
  }

  /** Collapse every non-empty group into one heading. */
  collapseAll(): void {
    for (const group of this.groups()) {
      if (group.tasks.length > 0) this.collapsedGroups.add(group.id);
    }
  }

  setGroupCollapsed(id: BackgroundTaskGroupId, collapsed: boolean): void {
    if (collapsed) this.collapsedGroups.add(id);
    else this.collapsedGroups.delete(id);
  }

  toggleGroup(id: BackgroundTaskGroupId): void {
    this.setGroupCollapsed(id, !this.collapsedGroups.has(id));
  }

  isGroupCollapsed(id: BackgroundTaskGroupId): boolean {
    return this.collapsedGroups.has(id);
  }

  private trimTerminalSubagents(): void {
    const terminal = [...this.subagents.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0));
    for (const task of terminal.slice(MAX_TERMINAL_SUBAGENTS)) {
      this.subagents.delete(task.id);
    }
  }
}

function readSubagentStatus(raw: string): BackgroundTaskState {
  if (raw === 'completed' || raw === 'failed' || raw === 'cancelled') return raw;
  // The protocol's union has exactly three outcomes; anything else is a
  // malformed or newer payload. The frame still reports a finish, so the row
  // must stop spinning — `running` would outlive the work.
  return 'completed';
}

function bashView(task: BackgroundTaskSummaryV1): BackgroundTaskView {
  return {
    id: task.id,
    kind: 'bash',
    title: task.command ?? task.label ?? task.id,
    status: task.status,
    startedAtMs: task.startedAtMs,
    ...(task.endedAtMs === undefined ? {} : { endedAtMs: task.endedAtMs }),
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.outputBytes === undefined ? {} : { outputBytes: task.outputBytes }),
    ...(task.pid === undefined ? {} : { pid: task.pid }),
    ...(task.autoPromoted === undefined ? {} : { autoPromoted: task.autoPromoted }),
  };
}

function sameBashTasks(
  left: readonly BackgroundTaskSummaryV1[],
  right: readonly BackgroundTaskSummaryV1[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sameBashTask(left[i]!, right[i]!)) return false;
  }
  return true;
}

function sameBashTask(
  a: BackgroundTaskSummaryV1,
  b: BackgroundTaskSummaryV1,
): boolean {
  return a.id === b.id
    && a.command === b.command
    && a.status === b.status
    && a.startedAtMs === b.startedAtMs
    && a.endedAtMs === b.endedAtMs
    && a.exitCode === b.exitCode
    && a.error === b.error
    && a.outputBytes === b.outputBytes
    && a.pid === b.pid
    && a.autoPromoted === b.autoPromoted;
}
