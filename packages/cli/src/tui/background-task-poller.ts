/**
 * Polls the Host's background-task snapshot while there is something to watch.
 *
 * The Host pushes `bash_task:update` at the worker boundary, but no push path
 * reaches the TUI over the HTTP session API, so the wizard reads a cached
 * snapshot instead. One second is the same cadence the CLI already uses for
 * pending permissions: fast enough that a promoted command appears while the
 * user is still looking at the turn, slow enough to be a rounding error next
 * to the run's own event stream.
 *
 * The poller goes quiet on its own. A turn that finished with only completed
 * tasks needs no more reads — a later `refresh()` (opening the task view) is
 * an explicit request for one.
 */

import type { BackgroundTaskListV1 } from '@duya/agent-protocol';

export const BACKGROUND_TASK_POLL_INTERVAL_MS = 1000;

export interface BackgroundTaskPollerOptions {
  /** Reads the Host snapshot for a session. */
  readonly list: (sessionId: string) => Promise<BackgroundTaskListV1>;
  /** The session being shown, or null while one is being switched. */
  readonly sessionId: () => string | null;
  /** Whether another read is worth making (turn running or tasks still live). */
  readonly isActive: () => boolean;
  readonly onChange: (snapshot: BackgroundTaskListV1) => void;
  /** Called once per failure burst; success resets it. */
  readonly onError?: (error: unknown) => void;
  readonly intervalMs?: number;
}

export class BackgroundTaskPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private errorReported = false;
  /** Set while the poller is started, so a late response cannot land after stop. */
  private started = false;

  constructor(private readonly options: BackgroundTaskPollerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const interval = this.options.intervalMs ?? BACKGROUND_TASK_POLL_INTERVAL_MS;
    this.timer = setInterval(() => { void this.poll(); }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One read, now. Used on `/tasks`, when the view opens, and by the timer.
   * Returns the snapshot it applied, or null when the read was skipped.
   */
  async poll(): Promise<BackgroundTaskListV1 | null> {
    if (!this.started || this.inFlight) return null;
    if (!this.options.isActive()) return null;
    const sessionId = this.options.sessionId();
    if (sessionId === null) return null;

    this.inFlight = true;
    try {
      const snapshot = await this.options.list(sessionId);
      if (!this.started) return null;
      this.errorReported = false;
      this.options.onChange(snapshot);
      return snapshot;
    } catch (error) {
      if (this.started && !this.errorReported) {
        this.errorReported = true;
        this.options.onError?.(error);
      }
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
