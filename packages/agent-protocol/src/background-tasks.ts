/**
 * Background bash tasks as this Host observed them.
 *
 * ## Why this is a pull contract, not an event stream
 *
 * The worker already publishes `bash_task:update` over the parent IPC link
 * whenever its registry changes (`packages/host/src/worker-process-entry.ts`).
 * That link belongs to whoever spawned the worker; a standalone Host exposes
 * nothing over HTTP, which is why a TUI client could not see them at all.
 *
 * A reader asks this Host for the latest snapshot it received. The snapshot is
 * replaced wholesale on every worker push, so there is no merge rule to get
 * wrong and no second source of truth: the worker's registry stays the only
 * writer of task state.
 *
 * ## Why the output file is not part of the summary
 *
 * `outputFile` is an absolute local path. A summary that carried it would tempt
 * a client into reading the file itself and skipping the Host's containment,
 * so the tail is served by {@link HostLocalBackgroundTaskApiV1.readBackgroundTaskOutput}
 * instead.
 */

export type BackgroundTaskStatusV1 =
  | 'running'
  | 'completed'
  | 'killed'
  | 'disk_limit'
  | 'error'
  | 'lost';

/** One background bash task, as last reported by the owning worker. */
export interface BackgroundTaskSummaryV1 {
  readonly id: string;
  readonly command: string;
  readonly status: BackgroundTaskStatusV1;
  /** Epoch milliseconds. */
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly exitCode?: number;
  readonly error?: string;
  /** Bytes written to the output file at the last progress report. */
  readonly outputBytes?: number;
  readonly pid?: number;
  /**
   * Set when a foreground call stopped waiting instead of the command being
   * started in the background. The process was never restarted.
   */
  readonly autoPromoted?: boolean;
}

export interface BackgroundTaskListV1 {
  /**
   * Whether this Host has received any snapshot for the session.
   *
   * False is not an error: a session that never spawned a worker, or one whose
   * worker has not reported yet, has nothing to list. A client must not read it
   * as "no background work" — it means "not measured".
   */
  readonly observed: boolean;
  readonly tasks: readonly BackgroundTaskSummaryV1[];
}

export interface BackgroundTaskOutputV1 {
  readonly taskId: string;
  readonly text: string;
  readonly totalBytes: number;
  /** True when the tail was clipped, so the text does not start at byte 0. */
  readonly truncated: boolean;
}

export interface HostLocalBackgroundTaskApiV1 {
  listBackgroundTasks(sessionId: string): Promise<BackgroundTaskListV1>;
  /**
   * Read the tail of one task's output.
   *
   * Returns null when the session is unknown to this Host or the task is not
   * in the session's snapshot. A task that is known but whose output file is
   * gone answers with an empty text rather than null, because the task itself
   * did exist.
   */
  readBackgroundTaskOutput(
    sessionId: string,
    taskId: string,
    maxBytes?: number,
  ): Promise<BackgroundTaskOutputV1 | null>;
}
