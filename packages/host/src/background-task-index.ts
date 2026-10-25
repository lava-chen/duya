/**
 * The Host's view of the background bash tasks its workers reported.
 *
 * ## Why the Host needs a copy at all
 *
 * `BashTaskRegistry` is a singleton inside the worker process. It already
 * publishes `bash_task:update` on every change, but that message travels the
 * parent IPC link, which only the process that spawned the worker can read.
 * The Desktop Agent Server forwards it to the renderer; a standalone Host used
 * to drop it. This index is the missing consumer: it keeps the latest snapshot
 * per session and serves it over HTTP.
 *
 * ## Replacement, not merge
 *
 * Every push is a complete snapshot from the worker's own registry, so it
 * replaces the previous one wholesale. Merging would invent a second writer
 * for task state and make a deleted task linger forever.
 */

import type {
  BackgroundTaskListV1,
  BackgroundTaskOutputV1,
  BackgroundTaskStatusV1,
  BackgroundTaskSummaryV1,
  HostLocalBackgroundTaskApiV1,
} from '@duya/agent-protocol';
import { readOutputTail } from './managed-shell/task-registry.js';

/** Default tail the detail view asks for. */
export const BACKGROUND_TASK_OUTPUT_DEFAULT_BYTES = 16 * 1024;

interface IndexedTask {
  readonly summary: BackgroundTaskSummaryV1;
  /** Kept out of the summary on purpose; see the protocol file. */
  readonly outputFile: string;
}

const STATUSES: ReadonlySet<string> = new Set<BackgroundTaskStatusV1>([
  'running', 'completed', 'killed', 'disk_limit', 'error', 'lost',
]);

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow one task from untrusted worker IPC.
 *
 * Returns null instead of a half-filled row: a summary with a guessed status
 * would make the list claim something the worker never said.
 */
export function narrowBackgroundTask(raw: unknown): IndexedTask | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as Record<string, unknown>;
  const id = task.id;
  const command = task.command;
  const status = task.status;
  const startTime = finite(task.startTime);
  if (typeof id !== 'string' || id === '') return null;
  if (typeof command !== 'string') return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  if (startTime === undefined) return null;

  const outputFile = typeof task.outputFile === 'string' ? task.outputFile : '';
  const progress = task.lastProgress;
  const progressBytes = progress !== null && typeof progress === 'object' && !Array.isArray(progress)
    ? finite((progress as Record<string, unknown>).bytes)
    : undefined;
  const pid = finite(task.pid);
  const endTime = finite(task.endTime);
  const exitCode = finite(task.exitCode);

  return {
    outputFile,
    summary: {
      id,
      command,
      status: status as BackgroundTaskStatusV1,
      startedAtMs: startTime,
      ...(endTime === undefined ? {} : { endedAtMs: endTime }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(typeof task.error === 'string' && task.error !== '' ? { error: task.error } : {}),
      ...(progressBytes === undefined ? {} : { outputBytes: progressBytes }),
      ...(pid === undefined ? {} : { pid }),
      ...(task.autoPromoted === true ? { autoPromoted: true } : {}),
    },
  };
}

export class BackgroundTaskIndex implements HostLocalBackgroundTaskApiV1 {
  readonly #bySession = new Map<string, readonly IndexedTask[]>();

  /** Replace the session's snapshot with what the worker just reported. */
  apply(sessionId: string, tasks: unknown): void {
    if (sessionId === '') return;
    const source = Array.isArray(tasks) ? tasks : [];
    const indexed: IndexedTask[] = [];
    for (const raw of source) {
      const task = narrowBackgroundTask(raw);
      if (task !== null) indexed.push(task);
    }
    this.#bySession.set(sessionId, indexed);
  }

  /** Forget a session (worker terminated, session archived). */
  forget(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }

  async listBackgroundTasks(sessionId: string): Promise<BackgroundTaskListV1> {
    const tasks = this.#bySession.get(sessionId);
    if (tasks === undefined) return { observed: false, tasks: [] };
    const summaries = tasks.map((task) => task.summary);
    // Running first, then newest first: the row a reader wants is the one that
    // is still moving. Mirrors the ordering the Desktop section already uses.
    summaries.sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1;
      const br = b.status === 'running' ? 0 : 1;
      if (ar !== br) return ar - br;
      return b.startedAtMs - a.startedAtMs;
    });
    return { observed: true, tasks: summaries };
  }

  async readBackgroundTaskOutput(
    sessionId: string,
    taskId: string,
    maxBytes?: number,
  ): Promise<BackgroundTaskOutputV1 | null> {
    const task = this.#bySession.get(sessionId)?.find((entry) => entry.summary.id === taskId);
    if (task === undefined) return null;
    const limit = maxBytes !== undefined && Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? maxBytes
      : BACKGROUND_TASK_OUTPUT_DEFAULT_BYTES;
    const tail = readOutputTail(task.outputFile, limit);
    if (tail === null) return { taskId, text: '', totalBytes: 0, truncated: false };
    return {
      taskId,
      text: tail.text,
      totalBytes: tail.totalBytes,
      truncated: tail.truncated,
    };
  }
}
