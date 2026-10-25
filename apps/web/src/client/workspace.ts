/**
 * The browser workspace: one immutable state object, one subscription.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns which session is selected, what the server said about that selection,
 * and which run is attached. It does NOT own run state. Turns, tools, messages
 * and permissions come from the `RunSessionSnapshot` the shared surface
 * published, passed through by reference — this file never folds an event into
 * a field of its own, so there is exactly one place where an event becomes
 * state and it is not here.
 *
 * ## Why it is a store and not a React reducer
 *
 * Three facts push this outside the render cycle:
 *
 *  - the event stream publishes faster than React should re-render, and
 *    `useSyncExternalStore` lets the surface keep its own publish cadence;
 *  - a run keeps producing events while the user switches sessions, and the
 *    switch has to abort the previous reads before the new ones start;
 *  - polling the permission ledger and the durable run status is a timer, and a
 *    timer that lives in an effect has to be cancellable from outside it.
 *
 * ## Cancellation is a two-fact problem
 *
 * `POST /api/runs/:id/cancel` answers with `requested: true` — the Host
 * ACKNOWLEDGED a request. That is not the run ending. This client therefore
 * shows "cancellation requested" until the DURABLE run status reads
 * `cancelled`, and never infers an ending from a quiet stream, a dropped
 * connection or a missing terminal event. The native cancellation path has a
 * known gap where a terminal event may never be published, so the ledger — not
 * the event stream — is what settles the question.
 */

import type { HostPermissionRequest } from '@duya/agent-protocol';
import type { RunSessionSnapshot } from '@duya/client-core';
import {
  ApiClient,
  isTerminalRunStatus,
  type DurableCompactionRow,
  type DurableMessageRow,
  type DurableRunRecord,
  type FetchLike,
  type HandshakeSummary,
  type MessagePageResult,
  type PermissionDecision,
  type SessionSummary,
} from './api.js';
import { RunEventStream, type RunStreamState } from './run-stream.js';
import { isAbortError, SelectionScope } from './selection.js';

export type WorkspacePhase = 'starting' | 'ready' | 'unreachable';

export interface WorkspaceState {
  readonly phase: WorkspacePhase;
  readonly startupError: string | null;
  readonly handshake: HandshakeSummary | null;

  readonly sessions: readonly SessionSummary[];
  readonly sessionsLoading: boolean;
  readonly sessionsError: string | null;

  readonly selectedSessionId: string | null;
  readonly selectedSession: SessionSummary | null;
  readonly selectionLoading: boolean;
  readonly selectionError: string | null;

  readonly messages: readonly DurableMessageRow[];
  readonly compactions: readonly DurableCompactionRow[];

  readonly runId: string | null;
  readonly durableRun: DurableRunRecord | null;
  /** The shared surface's own snapshot, passed through untouched. */
  readonly snapshot: RunSessionSnapshot | null;
  readonly stream: RunStreamState;

  readonly approvals: readonly HostPermissionRequest[];
  readonly approvalError: string | null;
  readonly resolvingApprovalId: string | null;

  readonly sending: boolean;
  readonly sendError: string | null;

  readonly cancelRequested: boolean;
  readonly cancelError: string | null;
}

const IDLE_STREAM_STATE: RunStreamState = {
  phase: 'stopped',
  attempt: 0,
  afterSeq: 0,
  hostError: null,
  transportError: null,
};

const INITIAL_STATE: WorkspaceState = {
  phase: 'starting',
  startupError: null,
  handshake: null,

  sessions: [],
  sessionsLoading: false,
  sessionsError: null,

  selectedSessionId: null,
  selectedSession: null,
  selectionLoading: false,
  selectionError: null,

  messages: [],
  compactions: [],

  runId: null,
  durableRun: null,
  snapshot: null,
  stream: IDLE_STREAM_STATE,

  approvals: [],
  approvalError: null,
  resolvingApprovalId: null,

  sending: false,
  sendError: null,

  cancelRequested: false,
  cancelError: null,
};

export interface WorkspaceOptions {
  readonly fetchImpl?: FetchLike;
  /** Ledger poll interval while a run is active. */
  readonly pollIntervalMs?: number;
  /** Ledger poll interval while a cancellation is still unconfirmed. */
  readonly cancelPollIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly stallTimeoutMs?: number;
}

export class Workspace {
  readonly #api: ApiClient;
  readonly #options: Required<WorkspaceOptions>;
  readonly #scope = new SelectionScope();
  readonly #listeners = new Set<() => void>();
  #state: WorkspaceState = INITIAL_STATE;
  #stream: RunEventStream | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #historyTimers: Array<ReturnType<typeof setTimeout>> = [];
  #historyRefetchedForRun: string | null = null;
  #stopped = false;

  constructor(options: WorkspaceOptions = {}) {
    const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#api = new ApiClient({ fetchImpl });
    this.#options = {
      fetchImpl,
      pollIntervalMs: options.pollIntervalMs ?? 1_500,
      cancelPollIntervalMs: options.cancelPollIntervalMs ?? 700,
      reconnectDelayMs: options.reconnectDelayMs ?? 1_000,
      stallTimeoutMs: options.stallTimeoutMs ?? 45_000,
    };
  }

  // ── store surface ────────────────────────────────────────────────────────

  getSnapshot = (): WorkspaceState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Bootstrap the transport and load the session list. */
  async start(): Promise<void> {
    try {
      await this.#api.bootstrap();
      const handshake = await this.#api.handshake();
      this.#commit({ handshake, phase: 'ready', startupError: null });
      await this.refreshSessions();
    } catch (error) {
      if (this.#stopped || isAbortError(error)) return;
      this.#commit({ phase: 'unreachable', startupError: describeError(error) });
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#clearPollTimer();
    for (const timer of this.#historyTimers) clearTimeout(timer);
    this.#historyTimers = [];
    this.#scope.end();
    this.#stream?.stop();
    this.#stream = null;
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  async refreshSessions(): Promise<void> {
    this.#commit({ sessionsLoading: true, sessionsError: null });
    try {
      const sessions = await this.#api.listSessions();
      if (this.#stopped) return;
      this.#commit({
        sessions: [...sessions].sort((left, right) => right.recencyAt - left.recencyAt),
        sessionsLoading: false,
        sessionsError: null,
      });
    } catch (error) {
      if (this.#stopped || isAbortError(error)) return;
      this.#commit({
        sessionsLoading: false,
        sessionsError: describeError(error),
      });
    }
  }

  /**
   * Select a session, or clear the selection with `null`.
   *
   * Everything the previous selection started is aborted here, before the new
   * reads begin, and every commit below re-checks the lease — so a response
   * that was already in flight when the user switched cannot land.
   */
  async select(sessionId: string | null): Promise<void> {
    this.#clearPollTimer();
    for (const timer of this.#historyTimers) clearTimeout(timer);
    this.#historyTimers = [];
    this.#historyRefetchedForRun = null;
    this.#stream?.stop();
    this.#stream = null;

    if (sessionId === null) {
      this.#scope.end();
      this.#commit({
        selectedSessionId: null,
        selectedSession: null,
        selectionLoading: false,
        selectionError: null,
        messages: [],
        compactions: [],
        runId: null,
        durableRun: null,
        snapshot: null,
        stream: IDLE_STREAM_STATE,
        approvals: [],
        approvalError: null,
        sendError: null,
        sending: false,
        cancelRequested: false,
        cancelError: null,
      });
      return;
    }

    const lease = this.#scope.begin();
    const summary = this.#state.sessions.find((session) => session.id === sessionId) ?? null;
    this.#commit({
      selectedSessionId: sessionId,
      selectedSession: summary,
      selectionLoading: true,
      selectionError: null,
      messages: [],
      compactions: [],
      runId: null,
      durableRun: null,
      snapshot: null,
      stream: IDLE_STREAM_STATE,
      approvals: [],
      approvalError: null,
      resolvingApprovalId: null,
      sending: false,
      sendError: null,
      cancelRequested: false,
      cancelError: null,
    });

    try {
      const [summaries, page, runs] = await Promise.all([
        this.#api.listSessions({ signal: lease.signal }),
        this.#readFullHistory(sessionId, lease),
        this.#api.listRuns(sessionId, { signal: lease.signal }),
      ]);
      if (!lease.isCurrent()) return;
      const sessions = [...summaries].sort((left, right) => right.recencyAt - left.recencyAt);
      const selected = sessions.find((entry) => entry.id === sessionId) ?? summary;
      this.#commit({
        sessions,
        selectedSession: selected,
        messages: page.messages,
        compactions: page.compactions,
        selectionLoading: false,
      });
      await this.#attachRun(pickRun(runs), lease);
    } catch (error) {
      if (!lease.isCurrent() || isAbortError(error)) return;
      this.#commit({ selectionLoading: false, selectionError: describeError(error) });
    }
  }

  // ── running ──────────────────────────────────────────────────────────────

  /**
   * Send one user turn.
   *
   * A refusal is surfaced verbatim, because the Host's reason is the only thing
   * that explains it — "could not start" is not an answer to why.
   */
  async send(prompt: string): Promise<void> {
    const sessionId = this.#state.selectedSessionId;
    const lease = this.#scope.current();
    if (sessionId === null || lease === null || !lease.isCurrent() || prompt.trim() === '') return;
    this.#commit({ sending: true, sendError: null });
    try {
      const outcome = await this.#api.startRun(sessionId, prompt, { signal: lease.signal });
      if (this.#stopped || !lease.isCurrent()) return;
      if (!outcome.accepted) {
        this.#commit({ sending: false, sendError: `start_refused:${outcome.stage}` });
        return;
      }
      this.#commit({ sending: false, sendError: null });
      const runLease = this.#scope.begin();
      await this.#attachRun(
        { runId: outcome.runId, sessionId, status: 'running', createdAt: Date.now(), startedAt: Date.now(), finishedAt: null },
        runLease,
      );
      await this.refreshHistory(runLease);
    } catch (error) {
      if (this.#stopped || !lease.isCurrent() || isAbortError(error)) return;
      this.#commit({ sending: false, sendError: describeError(error) });
    }
  }

  /**
   * Ask the Host to stop the selected run.
   *
   * The UI keeps saying "requested" until the durable ledger agrees. A refused
   * cancellation is reported as refused, not retried: the Host declined, and
   * silently asking again would hide that.
   */
  async cancelSelectedRun(): Promise<void> {
    const runId = this.#state.runId;
    const lease = this.#scope.current();
    if (runId === null || lease === null || !lease.isCurrent()) return;
    this.#commit({ cancelError: null });
    try {
      const outcome = await this.#api.cancelRun(runId, 'user_requested', { signal: lease.signal });
      if (this.#stopped || !lease.isCurrent()) return;
      if (!outcome.requested) {
        this.#commit({ cancelError: `cancel_refused:${outcome.reason}` });
        return;
      }
      this.#commit({ cancelRequested: true, cancelError: null });
      this.#schedulePoll(0);
    } catch (error) {
      if (this.#stopped || !lease.isCurrent() || isAbortError(error)) return;
      this.#commit({ cancelError: describeError(error) });
    }
  }

  /** Answer one pending worker permission request. */
  async resolveApproval(requestId: string, decision: PermissionDecision): Promise<void> {
    const lease = this.#scope.current();
    if (lease === null || !lease.isCurrent()) return;
    this.#commit({ resolvingApprovalId: requestId, approvalError: null });
    try {
      await this.#api.resolveApproval(requestId, decision, { signal: lease.signal });
      if (this.#stopped || !lease.isCurrent()) return;
      this.#commit({ resolvingApprovalId: null });
      await this.#refreshLedger(lease);
    } catch (error) {
      if (this.#stopped || !lease.isCurrent() || isAbortError(error)) return;
      this.#commit({ resolvingApprovalId: null, approvalError: describeError(error) });
    }
  }

  /** Re-run the selection's reads after a failure the user chose to retry. */
  async retrySelection(): Promise<void> {
    const sessionId = this.#state.selectedSessionId;
    if (sessionId !== null) await this.select(sessionId);
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #attachRun(run: DurableRunRecord | null, lease: SelectionLeaseLike): Promise<void> {
    this.#stream?.stop();
    this.#stream = null;
    if (run === null) {
      this.#commit({
        runId: null,
        durableRun: null,
        snapshot: null,
        stream: IDLE_STREAM_STATE,
        approvals: [],
        approvalError: null,
        cancelRequested: false,
        cancelError: null,
      });
      return;
    }

    this.#commit({ runId: run.runId, durableRun: run, cancelRequested: false, cancelError: null });

    // Replay from zero into a FRESH surface: a page refresh is a new session, not
    // a continuation of the old one, and the durable ledger — not any local log —
    // is what reconstructs the run.
    const stream = new RunEventStream({
      runId: run.runId,
      sessionId: run.sessionId,
      streamUrl: (runId, afterSeq) => this.#api.eventStreamUrl(runId, afterSeq),
      fetchImpl: this.#options.fetchImpl,
      signal: lease.signal,
      reconnectDelayMs: this.#options.reconnectDelayMs,
      stallTimeoutMs: this.#options.stallTimeoutMs,
      onState: (state) => {
        if (lease.isCurrent()) this.#commit({ stream: state });
      },
      onEnd: () => {
        const durableRun = this.#state.durableRun;
        if (lease.isCurrent() && durableRun?.runId === run.runId && isTerminalRunStatus(durableRun.status)) {
          this.#stream?.stop();
        }
      },
    });
    this.#stream = stream;
    stream.subscribe((snapshot) => {
      if (lease.isCurrent()) this.#commit({ snapshot });
    });
    this.#commit({ snapshot: stream.getSnapshot() });
    stream.start();

    await this.#refreshLedger(lease);
    this.#schedulePoll(this.#options.pollIntervalMs);
  }

  /**
   * Refresh the durable run status and the pending permission ledger together.
   *
   * They are one round trip on one interval because they answer one question —
   * "what is this run doing right now" — and separating them would put two
   * timers and two chances to disagree on screen.
   */
  async #refreshLedger(lease: SelectionLeaseLike | null): Promise<void> {
    if (lease === null || !lease.isCurrent()) return;
    const sessionId = this.#state.selectedSessionId;
    const runId = this.#state.runId;
    if (sessionId === null) return;
    try {
      const [runs, approvals] = await Promise.all([
        this.#api.listRuns(sessionId, { signal: lease.signal }),
        this.#api.listPendingApprovals(sessionId, { signal: lease.signal }),
      ]);
      if (!lease.isCurrent()) return;
      const durableRun = runId === null ? null : runs.find((run) => run.runId === runId) ?? this.#state.durableRun;
      this.#commit({
        durableRun,
        approvals,
        approvalError: null,
        // The ledger is what settles a cancellation. Once it reads terminal, the
        // refusal-or-confirmation question is closed and the label follows it.
        cancelRequested: durableRun !== null && isTerminalRunStatus(durableRun.status) ? false : this.#state.cancelRequested,
      });
      if (durableRun !== null && isTerminalRunStatus(durableRun.status)) {
        this.#clearPollTimer();
        this.#scheduleHistoryRefetch(lease, durableRun.runId);
      }
    } catch (error) {
      if (!lease.isCurrent() || isAbortError(error)) return;
      this.#commit({ approvalError: describeError(error) });
    }
  }

  #schedulePoll(delayMs: number): void {
    this.#clearPollTimer();
    const lease = this.#scope.current();
    if (lease === null) return;
    const wait = this.#state.cancelRequested ? this.#options.cancelPollIntervalMs : this.#options.pollIntervalMs;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void (async () => {
        await this.#refreshLedger(lease);
        if (!lease.isCurrent()) return;
        if (this.#state.durableRun !== null && isTerminalRunStatus(this.#state.durableRun.status)) return;
        this.#schedulePoll(wait);
      })();
    }, delayMs === 0 ? 0 : wait);
  }

  #clearPollTimer(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  /**
   * Re-read the durable history once a run settles.
   *
   * A run's last events and the durable row that records its final answer are
   * written at two different moments, so the first read after a terminal status
   * can legitimately arrive a beat early. Two delayed retries cover that gap
   * without polling on every run.
   */
  #scheduleHistoryRefetch(lease: SelectionLeaseLike, runId: string): void {
    if (this.#historyRefetchedForRun === runId) return;
    this.#historyRefetchedForRun = runId;
    for (const wait of [400, 1_600]) {
      const timer = setTimeout(() => {
        if (lease.isCurrent()) void this.refreshHistory(lease);
      }, wait);
      this.#historyTimers.push(timer);
    }
  }

  async refreshHistory(lease: SelectionLeaseLike | null): Promise<void> {
    if (lease === null || !lease.isCurrent()) return;
    const sessionId = this.#state.selectedSessionId;
    if (sessionId === null) return;
    try {
      const page = await this.#readFullHistory(sessionId, lease);
      if (!lease.isCurrent()) return;
      this.#commit({ messages: page.messages, compactions: page.compactions });
    } catch (error) {
      if (!lease.isCurrent() || isAbortError(error)) return;
      this.#commit({ selectionError: describeError(error) });
    }
  }

  #commit(patch: Partial<WorkspaceState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  async #readFullHistory(sessionId: string, lease: SelectionLeaseLike): Promise<MessagePageResult> {
    // The whole history in ONE read. The paged read re-projects the entire
    // transcript on every page, so paging to the end of a 10k-message session
    // costs 100 projections of 10k rows; the whole read projects it once.
    const page = await this.#api.readAllMessages(sessionId, { signal: lease.signal });
    if (!lease.isCurrent()) return { messages: [], compactions: [], nextCursor: null };
    return page;
  }
}

type SelectionLeaseLike = { readonly signal: AbortSignal; isCurrent(): boolean };

/**
 * Which run a selection opens.
 *
 * A live run wins over a finished one: reopening a session should show what it
 * is doing now, not the last thing it did. Ties break on the newer run, which
 * is the Host's own ordering.
 */
export function pickRun(runs: readonly DurableRunRecord[]): DurableRunRecord | null {
  if (runs.length === 0) return null;
  const live = runs.filter((run) => !isTerminalRunStatus(run.status));
  const pool = live.length > 0 ? live : runs;
  return [...pool].sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'request_failed';
}
