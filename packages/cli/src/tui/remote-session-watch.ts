/**
 * remote-session-watch.ts — follow the turns another client runs in this session.
 *
 * ## Why polling is the right shape here
 *
 * The TUI is attached to a Host that another process drives (the Desktop). A
 * turn started over there is not on any stream this process opened: the Host
 * writes it to the run ledger and, while it executes, to the durable run event
 * log. There is no session-level subscription on the Host API, so the cheapest
 * correct reader is a periodic ledger read: one `listAgentRunsBySession` a
 * second, and — once a new run is seen — the same `watchAgentRunEvents` stream
 * this CLI already uses for its OWN runs.
 *
 * The split of what is visible is a property of the protocol, not of this file:
 * text blocks, tool calls, turn boundaries and the terminal are all durable, so
 * they replay across processes; deltas, status lines and previews are
 * ephemeral and only exist in the executing process. The view therefore updates
 * at block granularity, not character granularity.
 *
 * ## What this deliberately does NOT do
 *
 *   - It does not re-follow runs that already existed when watching began. A
 *     seed pass marks the ledger as seen so opening a session does not replay
 *     its history; a run already in flight is read from the transcript when it
 *     settles.
 *   - It does not prompt for the other run's permission requests. The approval
 *     overlay belongs to the run this surface owns; a remote ask is surfaced as
 *     a notice.
 *   - It does not start, cancel or steer anything. Visibility only.
 */

import type { AgentRunRecord, RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { LegacyFrame } from './blocks.js';
import { HostEventStream } from './host-event-stream.js';

export interface RemoteSessionWatchOptions {
  /** Ledger reads and the durable event stream. Nothing else is needed. */
  readonly client: Pick<HostSessionHttpClient, 'listAgentRunsBySession' | 'watchAgentRunEvents'>;
  readonly sessionId: SessionId;
  /**
   * True while this surface is doing something that owns the transcript: its
   * own run, a session switch, or shutdown. Polling pauses rather than races.
   */
  readonly isPaused: () => boolean;
  /** Runs this surface started itself; they are already rendered live. */
  readonly isLocalRun: (runId: RunId) => boolean;
  readonly onFrame: (frame: LegacyFrame) => void;
  readonly onNotice: (text: string) => void;
  /** Called when a remote run has settled; the caller reconciles the transcript. */
  readonly onRunSettled: () => void | Promise<void>;
  /** How many ledger rows a poll reads. Runs are ordered newest first. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 10;

/** The short form used in notices; a full run id crowds the transcript. */
function shortRun(runId: RunId): string {
  return runId.length <= 8 ? runId : runId.slice(0, 8);
}

export class RemoteSessionWatch {
  private known = new Set<RunId>();
  private followed = new Map<RunId, AbortController>();
  private seeded = false;
  private polling = false;
  private stopped = false;
  private sessionId: SessionId;

  constructor(private readonly options: RemoteSessionWatchOptions) {
    this.sessionId = options.sessionId;
  }

  /**
   * Point the watcher at another session.
   *
   * Stops following the old one and re-seeds: the new session's ledger is
   * history the user has just loaded, not news.
   */
  setSession(sessionId: SessionId): void {
    if (sessionId === this.sessionId) return;
    this.abortFollowed();
    this.sessionId = sessionId;
    this.known.clear();
    this.seeded = false;
  }

  stop(): void {
    this.stopped = true;
    this.abortFollowed();
  }

  /**
   * One ledger read.
   *
   * The first read seeds. Later reads diff against it: a run id that was not
   * there before is either still executing (follow it) or already over (refresh
   * the transcript once). A transient Host error is swallowed — a viewer must
   * not print a failure every second because the other process is busy.
   */
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    if (this.options.isPaused()) return;
    this.polling = true;
    const sessionId = this.sessionId;
    try {
      const runs = await this.options.client.listAgentRunsBySession(
        sessionId,
        this.options.limit ?? DEFAULT_LIMIT,
      );
      if (this.stopped || sessionId !== this.sessionId) return;
      if (!this.seeded) {
        for (const run of runs) this.known.add(run.runId);
        this.seeded = true;
        return;
      }
      for (const run of runs) {
        if (this.known.has(run.runId)) continue;
        this.known.add(run.runId);
        if (this.options.isLocalRun(run.runId)) continue;
        if (run.status === 'running') this.follow(run);
        else await this.reconcile(run);
      }
    } catch {
      // Keep watching. The next poll retries; the transcript is untouched.
    } finally {
      this.polling = false;
    }
  }

  private follow(run: AgentRunRecord): void {
    const controller = new AbortController();
    this.followed.set(run.runId, controller);
    this.options.onNotice(`Another client started run ${shortRun(run.runId)}; following it.`);
    void this.drain(run, controller.signal);
  }

  private async drain(run: AgentRunRecord, signal: AbortSignal): Promise<void> {
    const stream = new HostEventStream(this.sessionId, run.runId);
    const asked = new Set<string>();
    let failure: string | null = null;
    try {
      for await (const event of this.options.client.watchAgentRunEvents(run.runId, { signal })) {
        const frame = stream.push(event);
        if (frame === null) continue;
        if (frame.type === 'permission') {
          this.reportPermission(event, asked);
          continue;
        }
        // Terminal frames belong to the run this surface owns: `done`/`error`
        // are handled by the loop that started a turn. Here the settle notice
        // plus the transcript reload are the equivalent, so these are dropped.
        if (frame.type === 'done' || frame.type === 'error') continue;
        this.options.onFrame(frame);
      }
    } catch (error) {
      if (!signal.aborted) {
        failure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.followed.delete(run.runId);
    }
    if (signal.aborted || this.stopped) return;
    if (failure !== null) {
      this.options.onNotice(`Could not follow run ${shortRun(run.runId)}: ${failure}`);
    }
    this.options.onNotice(`Run ${shortRun(run.runId)} ended.`);
    await this.options.onRunSettled();
  }

  /**
   * A remote approval is NOT this surface's to answer: the overlay is wired to
   * the run this process owns. Say so once per request instead of opening a
   * picker whose answer would be dropped.
   */
  private reportPermission(event: RunEventEnvelope, asked: Set<string>): void {
    if (event.payload.type !== 'permission.requested') return;
    const requestId = event.payload.requestId;
    if (asked.has(requestId)) return;
    asked.add(requestId);
    this.options.onNotice(
      `Another client is waiting for approval of ${event.payload.toolName}; answer it there.`,
    );
  }

  private async reconcile(run: AgentRunRecord): Promise<void> {
    this.options.onNotice(`Run ${shortRun(run.runId)} finished in another client.`);
    await this.options.onRunSettled();
  }

  private abortFollowed(): void {
    for (const controller of this.followed.values()) controller.abort();
    this.followed.clear();
  }
}
