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
import { frameRecord, frameString, type LegacyFrame } from './blocks.js';

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

/** `45s`, `2m 05s`, `1h 03m` — compact enough for one task row. */
export function formatTaskDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
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
    lines.push('', '  The subagent runs inside this session\'s turn; its transcript is not shown here.');
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

export class BackgroundTaskModel {
  private bash: readonly BackgroundTaskSummaryV1[] = [];
  private bashObserved = false;
  private readonly subagents = new Map<string, BackgroundTaskView>();
  private readonly collapsedGroups = new Set<BackgroundTaskGroupId>();

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
   * gone (the registry evicted it), so the replacement is wholesale.
   */
  applyBashSnapshot(snapshot: BackgroundTaskListV1): boolean {
    const changed = !this.bashObserved
      || snapshot.observed !== this.bashObserved
      || !sameBashTasks(this.bash, snapshot.tasks);
    this.bashObserved = snapshot.observed;
    this.bash = snapshot.tasks.slice();
    return changed;
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

    if (eventType === 'subagent_started') {
      const name = frameString(data, 'agentName') || frameString(data, 'agentType') || 'Agent';
      const type = frameString(data, 'agentType');
      const description = frameString(data, 'agentDescription');
      const detail = description !== '' ? description : type !== '' ? type : undefined;
      const startedAtMs = this.subagents.get(id)?.startedAtMs ?? now;
      this.subagents.set(id, {
        id,
        kind: 'subagent',
        title: name,
        ...(detail === undefined ? {} : { detail }),
        status: 'running',
        startedAtMs,
      });
      return true;
    }

    if (eventType === 'subagent_completed') {
      const durationMs = typeof data['durationMs'] === 'number' && Number.isFinite(data['durationMs'])
        ? Math.max(0, data['durationMs'])
        : null;
      const existing = this.subagents.get(id);
      const status = readSubagentStatus(frameString(data, 'status'));
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

  /** Every known task, running first and newest first inside each half. */
  tasks(): BackgroundTaskView[] {
    return sortTasks([...this.bash.map(bashView), ...this.subagents.values()]);
  }

  /** Two groups in display order; an empty group is still a heading. */
  groups(): BackgroundTaskGroup[] {
    const bash = sortTasks(this.bash.map(bashView));
    const subagents = sortTasks([...this.subagents.values()]);
    return [
      {
        id: 'bash',
        label: 'Background bash',
        tasks: bash,
        running: bash.filter((task) => task.status === 'running').length,
        collapsed: this.collapsedGroups.has('bash'),
      },
      {
        id: 'subagent',
        label: 'Subagents',
        tasks: subagents,
        running: subagents.filter((task) => task.status === 'running').length,
        collapsed: this.collapsedGroups.has('subagent'),
      },
    ];
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
    title: task.command,
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

function sortTasks(tasks: readonly BackgroundTaskView[]): BackgroundTaskView[] {
  return tasks.slice().sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1;
    const bRunning = b.status === 'running' ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return b.startedAtMs - a.startedAtMs;
  });
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
