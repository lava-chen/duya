/**
 * permission-coordinator.ts — the Control Plane's half of a permission round
 * trip (plan 587 R2.4).
 *
 * ## What was wrong
 *
 * Three separate owners for one decision, none of which could account for it:
 *
 *  - the AGENT minted the deadline at two call sites
 *    (`tool/ToolInvokeTool/dispatcherFromRegistry.ts:152` and `mcp/apply.ts:562`),
 *    each computing `Date.now() + 5 * 60 * 1000` independently;
 *  - the WORKER armed its own independent `setTimeout(..., 300000)`
 *    (`process/agent-process-entry.ts:2328`);
 *  - the ROUTER accepted an answer, wrote nothing, forwarded it, and answered
 *    `{ ok: true }` (`agents/server/router.ts:2208`).
 *
 * So the deadline a renderer displayed and the deadline a worker enforced were
 * two independently computed values, and a decision that reached the worker had
 * no durable record that it had been made at all. Contract §E is explicit that
 * the Control Plane owns both: "CP拥有deadline和durable决策".
 *
 * ## What this class owns
 *
 *  - **The deadline.** Minted once, in `open()`, from the injected clock, and
 *    handed to the caller to display. Exactly one timer is armed per request
 *    and it is armed HERE. Nothing downstream computes a second one.
 *  - **The decision.** Written durably BEFORE the worker is told, through
 *    {@link PermissionDecisionStore}. A store that refuses or throws does not
 *    silently become an allow: `record()` returning `failed` produces a
 *    `persistence_failed` receipt and no delivery.
 *  - **The audit.** Every outcome is an {@link AuditRecord} — including
 *    timeout, cancel, defer and the unknown-action fail-closed — because a
 *    request that ended without a recorded reason is the same defect one layer
 *    up: the run said it finished and nobody can say how.
 *  - **The grant.** `allow_always` is handed to a {@link PermissionGrantStore}
 *    that is durable and session-keyed. A grant in process memory is not a
 *    session grant; it is a process grant that happens to survive while one
 *    worker serves one session.
 *
 * ## What it deliberately does not do
 *
 * It does not talk to a worker. Delivery is an injected
 * {@link PermissionDeliverer}, because the same decision is delivered by
 * `handlePostPermission` (HTTP) and by `RunHandle.respondToPermission`
 * (runtime) and those two must not become two ways to answer a prompt.
 *
 * ## `defer`
 *
 * `defer` is a real answer, not an error: it records no decision, resolves no
 * promise, and leaves the request pending. It is what the bot/wake surface has
 * always meant by `paused`. The legacy mapping said `deny` (`LEGACY_ACTION_MAP`
 * in the protocol package) and that was wrong — the card can be answered long
 * after the turn ended, and a recorded denial is a fact nobody established.
 */

import type {
  PermissionAction,
  PermissionRequest,
  PermissionResolution,
  PermissionScope,
  PermissionSource,
} from '@duya/agent-protocol';

import {
  asProtocolAction,
  bindGrantScope,
  translate,
  type PermissionSurface,
  type ToolGrantScope,
  type TranslatedDecision,
} from './permission-vocabulary.js';

// ── ports ─────────────────────────────────────────────────────────────────

/** The durable record of a decision. Injected so the coordinator has no storage. */
export interface PermissionDecisionStore {
  /**
   * Write the decision, once.
   *
   * @returns `recorded` when THIS call is the one that won, `duplicate` when a
   *   decision was already on record, `failed` when the store refused. The
   *   first-wins property is the entire late/duplicate guard, so it lives here
   *   and nowhere else.
   */
  record(row: PermissionResolution & { runId: string; sessionId: string }): 'recorded' | 'duplicate' | 'failed';
  /** The decision already on record, if any. */
  read(requestId: string): (PermissionResolution & { runId: string; sessionId: string }) | null;
}

/** Where a lasting grant is kept. Durable and keyed by a real scope, or it is not one. */
export interface PermissionGrantStore {
  /**
   * Persist "always allow this tool" for the scope the decision names.
   *
   * @returns `granted`, or `failed` when the store refused. A failed grant is
   *   reported, never treated as a one-shot allow: the user asked for
   *   something longer and the product either has it or says it does not.
   */
  grant(scope: ToolGrantScope, sessionId: string): 'granted' | 'failed';
}

/** How the answer physically reaches the thing that is waiting for one. */
export interface PermissionDeliverer {
  deliver(input: DeliveryInput): void | Promise<void>;
}

export interface DeliveryInput {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
  /** The canonical action. Never `defer` — nothing is delivered for a defer. */
  readonly action: PermissionAction;
  /**
   * Tool input the host rewrote.
   *
   * Re-validated by the CALLER before it reaches here (see
   * {@link PermissionCoordinator.resolve} `onUpdatedInput`), because "the user
   * edited the arguments" must not be a way around the checks the original
   * arguments went through.
   */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

export interface PermissionCoordinatorOptions {
  readonly store: PermissionDecisionStore;
  readonly grants: PermissionGrantStore;
  readonly deliver: PermissionDeliverer;
  /** The one clock. Mints `expiresAt` and decides what "late" means. */
  readonly now: () => number;
  /**
   * Arm a timer. Injectable so a test can drive a deadline without waiting.
   *
   * Defaults to `setTimeout`, and the returned handle is always cleared through
   * {@link TimerHandle.clear} so the coordinator never has to know whether it
   * holds a Node timer or a test double.
   */
  readonly schedule?: (ms: number, fire: () => void) => TimerHandle;
}

export interface TimerHandle {
  clear(): void;
}

// ── receipts ──────────────────────────────────────────────────────────────

/**
 * Why an answer was not applied as a new decision.
 *
 * Every value is a refusal or a non-decision. There is deliberately no member
 * that means "allowed, but do not record it": a decision nobody can find is
 * the failure mode this whole slice exists to remove.
 */
export type PermissionRefusal =
  /** The action is not one the protocol defines. Fails closed. */
  | 'not_permission_action'
  /** No such request is open. Reported as `permission_unknown_request`. */
  | 'permission_unknown_request'
  /** The request's deadline passed before the answer arrived. */
  | 'permission_expired'
  /** The run reached a terminal while the request was open. */
  | 'run_terminal'
  /** The host answered "not yet" — a real answer that decides nothing. */
  | 'permission_deferred'
  /** The durable write refused, so nothing was delivered to the worker. */
  | 'persistence_failed'
  /** A lasting grant could not be persisted, so the decision was not applied. */
  | 'grant_failed';

export interface PermissionReceipt {
  readonly requestId: string;
  /** True when THIS call made the decision. False for a late or duplicate answer. */
  readonly firstDecision: boolean;
  /** The action now on record. `null` for a defer and for a persistence failure. */
  readonly action: PermissionAction | null;
  /** Why it was refused, when it was. `null` when it was applied. */
  readonly refusal: PermissionRefusal | null;
  /** The grant scope actually persisted, when a grant was the answer. */
  readonly scope?: PermissionScope;
  /** What the audit recorded. Always present, for every outcome. */
  readonly audit: PermissionResolution;
}

/**
 * The audit line, as `closeRun` reports it.
 *
 * A named alias rather than a wider type: a `PermissionResolution` already
 * carries every field an audit needs, and a second interface with `runId` on it
 * is how the two start drifting.
 */
export type AuditRecord = PermissionResolution;

export type OpenReceipt =
  | { readonly alreadyOpen: true; readonly request: PermissionRequest }
  | { readonly alreadyOpen: false; readonly request: PermissionRequest };

// ── the coordinator ───────────────────────────────────────────────────────

interface PendingRequest {
  readonly request: PermissionRequest;
  readonly runId: string;
  readonly sessionId: string;
  readonly timer: TimerHandle;
  /** The deadline this coordinator minted. Never recomputed. */
  readonly expiresAt: number;
}

const NODE_TIMER = (ms: number, fire: () => void): TimerHandle => {
  const handle = setTimeout(fire, ms);
  // A pending approval must not by itself keep a process alive.
  (handle as { unref?: () => void }).unref?.();
  return { clear: () => clearTimeout(handle) };
};

/**
 * The single owner of a permission request's deadline, decision and audit.
 *
 * One instance per host process. Requests are keyed by `requestId`, which the
 * Control Plane minted and the worker echoes, so a run's request is answerable
 * from anywhere in the host without a session-side lookup that could be wrong.
 */
export class PermissionCoordinator {
  readonly #store: PermissionDecisionStore;
  readonly #grants: PermissionGrantStore;
  readonly #deliver: PermissionDeliverer;
  readonly #now: () => number;
  readonly #schedule: (ms: number, fire: () => void) => TimerHandle;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #closedRuns = new Set<string>();

  constructor(options: PermissionCoordinatorOptions) {
    this.#store = options.store;
    this.#grants = options.grants;
    this.#deliver = options.deliver;
    this.#now = options.now;
    this.#schedule = options.schedule ?? NODE_TIMER;
  }

  /** How long a request waits. The Control Plane's number, not the agent's. */
  #timeoutMs: number = 5 * 60 * 1000;

  /** The one deadline policy, set once at boot from the host's configuration. */
  configureTimeout(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.#timeoutMs = ms;
  }

  /**
   * Register a request and arm its ONE timer.
   *
   * The returned `expiresAt` is the same value the timer was armed from, so a
   * host that renders a countdown and a worker that enforces it cannot
   * disagree — which was possible for as long as the agent computed one and
   * the worker computed another.
   *
   * Idempotent on `requestId`: a reconnect that replays the request returns the
   * ORIGINAL request, timer included, rather than a second deadline for the
   * same question.
   */
  open(
    input: Omit<PermissionRequest, 'startedAt' | 'expiresAt'> & {
      runId: string;
      /**
       * The conversation this request belongs to.
       *
       * Not on `PermissionRequest`: a grant's lifetime is the session, and the
       * protocol's scope type cannot say which session without a value the
       * runtime has no way to know. Carried here so a lasting grant is keyed by
       * a real scope rather than by whatever session the worker happens to be
       * serving.
       */
      sessionId: string;
    },
  ): OpenReceipt {
    const existing = this.#pending.get(input.requestId);
    if (existing) return { alreadyOpen: true, request: existing.request };

    const startedAt = this.#now();
    const expiresAt = startedAt + this.#timeoutMs;
    const request: PermissionRequest = { ...input, startedAt, expiresAt };
    const timer = this.#schedule(
      this.#timeoutMs,
      () => this.#expire(input.requestId),
    );
    this.#pending.set(input.requestId, {
      request,
      runId: input.runId,
      sessionId: input.sessionId,
      timer,
      expiresAt,
    });
    return { alreadyOpen: false, request };
  }

  /**
   * Apply an answer.
   *
   * The order is the contract: **validate, persist, then deliver.** A decision
   * the worker acts on but the store never learned about is an audit that
   * claims a question was answered when nothing was recorded, which is worse
   * than the answer having been lost.
   *
   * @param surface - Which legacy vocabulary `decision` came from. `protocol`
   *   answers skip the table and are checked against the canonical set.
   * @param onUpdatedInput - Called with a host-rewritten input BEFORE the
   *   decision is recorded. Returning a rejection records nothing, so a user
   *   edit cannot be used to walk arguments past the checks the original went
   *   through. Omitting it accepts the edit unvalidated, which is why it is a
   *   required decision at the call site rather than an optional callback here.
   */
  async resolve(input: ResolveInput): Promise<PermissionReceipt> {
    const pending = this.#pending.get(input.requestId);
    const recorded = this.#store.read(input.requestId);

    // A run that was cancelled is unanswerable BY ANYONE, and that check comes
    // before "is the request still open" — a cancel removes the request, so
    // asking the second question first would report a closed prompt as merely
    // unknown, and the caller could not tell the two apart.
    if (this.#closedRuns.has(input.runId)) {
      return {
        requestId: input.requestId,
        firstDecision: false,
        action: recorded?.action ?? null,
        refusal: 'run_terminal',
        audit: recorded ?? {
          requestId: input.requestId,
          action: 'deny',
          source: 'cancelled',
          latencyMs: 0,
          reason: 'the run this request belongs to has been closed',
        },
      };
    }

    // A second answer to a request that was already decided is a receipt, not
    // an execution. The worker path had an implicit version of this (it logged
    // a missing entry and dropped it); the router had none at all. The receipt
    // reports what is actually ON RECORD, so a duplicate that contradicts the
    // first answer cannot leave the caller believing the call was authorised.
    if (!pending) {
      return {
        requestId: input.requestId,
        firstDecision: false,
        action: recorded?.action ?? null,
        refusal: 'permission_unknown_request',
        audit: recorded ?? {
          requestId: input.requestId,
          action: 'deny',
          source: 'policy',
          latencyMs: 0,
          reason: 'answer arrived for a request that is no longer open',
        },
      };
    }

    const translated = input.surface === 'protocol'
      ? protocolDecision(input.decision)
      : translate(input.surface, input.decision);

    // Unknown fails closed. It is recorded AS a denial rather than dropped,
    // because "the host sent something we do not understand" is a fact about
    // this request and the audit is where facts go.
    if (translated === null) {
      return this.#decide(
        pending,
        { action: 'deny', source: 'policy', latencyMs: this.#now() - pending.request.startedAt },
        'not_permission_action',
        `the answer "${input.decision}" is not an action this host defines`,
      );
    }

    // `defer` decides nothing: no row, no delivery, the request stays open.
    if (translated.action === 'defer') {
      const audit: PermissionResolution = {
        requestId: pending.request.requestId,
        action: 'defer',
        source: 'host',
        latencyMs: this.#now() - pending.request.startedAt,
        reason: 'the host deferred; the request remains open',
      };
      return {
        requestId: pending.request.requestId,
        firstDecision: false,
        action: null,
        refusal: 'permission_deferred',
        audit,
      };
    }

    // An edited input is re-validated before anything is recorded. A rejection
    // is a denial of the EDIT, not of the original question: the user is not
    // being told their answer was ignored.
    if (input.updatedInput !== undefined && input.onUpdatedInput) {
      const verdict = await input.onUpdatedInput(input.updatedInput, pending.request);
      if (!verdict.accepted) {
        return this.#decide(
          pending,
          { action: 'deny', source: 'host', latencyMs: this.#now() - pending.request.startedAt },
          null,
          `the edited input was rejected: ${verdict.reason}`,
        );
      }
    }

    // A lasting grant needs a tool before it can be persisted. Failing here
    // rather than falling back to a one-shot allow is deliberate: the user
    // asked for something that outlives the request, and silently downgrading
    // it to "this once" is a grant whose scope is narrower than its name.
    let scope: ToolGrantScope | undefined;
    if (translated.grants) {
      const bound = bindGrantScope(translated, pending.request.toolName);
      if (bound === null) {
        return this.#decide(
          pending,
          { action: 'deny', source: 'policy', latencyMs: this.#now() - pending.request.startedAt },
          'grant_failed',
          'a lasting grant arrived without a tool to grant',
        );
      }
      const outcome = this.#grants.grant(bound.scope, pending.sessionId);
      if (outcome === 'failed') {
        return this.#decide(
          pending,
          { action: 'deny', source: 'policy', latencyMs: this.#now() - pending.request.startedAt },
          'grant_failed',
          'the grant could not be persisted, so the decision was not applied',
        );
      }
      scope = bound.scope;
    }

    return this.#decide(
      pending,
      {
        action: translated.action,
        source: 'host',
        latencyMs: this.#now() - pending.request.startedAt,
        ...(scope ? { scope } : {}),
      },
      null,
      undefined,
      input.updatedInput,
    );
  }

  /**
   * Close every request a run has open, and record why.
   *
   * Called on cancel. A pending prompt whose run is gone is a prompt that can
   * still be answered, and the answer would be delivered to a tool call
   * nobody is waiting for — or, worse, to the next run in a recycled worker.
   * Denying here also means the audit has a line for the request rather than a
   * row that sat `pending` until something else moved it.
   */
  closeRun(runId: string, reason: string): readonly PermissionResolution[] {
    this.#closedRuns.add(runId);
    const out: PermissionResolution[] = [];
    for (const [requestId, pending] of this.#pending) {
      if (pending.runId !== runId) continue;
      this.#pending.delete(requestId);
      pending.timer.clear();
      const audit: PermissionResolution = {
        requestId,
        action: 'deny',
        source: 'cancelled',
        latencyMs: this.#now() - pending.request.startedAt,
        reason,
      };
      this.#write(pending, audit);
      out.push(audit);
    }
    return out;
  }

  /**
   * Let a run answer again.
   *
   * A run id is closed, not burned, so a host that reuses an id (a retry after
   * a refused dispatch) is not permanently unanswerable. Nothing in the
   * product reuses a run id today; the escape exists so that a future caller
   * cannot deadlock on an accident of this class's bookkeeping.
   */
  reopenRun(runId: string): void {
    this.#closedRuns.delete(runId);
  }

  /** Whether a run has been closed and is no longer answerable. */
  isRunClosed(runId: string): boolean {
    return this.#closedRuns.has(runId);
  }

  /** Open request ids for a run, for a host that renders a run's state. */
  pendingForRun(runId: string): readonly string[] {
    return [...this.#pending.values()].filter((p) => p.runId === runId).map((p) => p.request.requestId);
  }

  /** Every open request id. A test and a shutdown audit both want this. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The deadline fired. Reject, record, and do not deliver a `defer`. */
  #expire(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    this.#write(pending, {
      requestId,
      action: 'deny',
      source: 'timeout',
      latencyMs: this.#now() - pending.request.startedAt,
      reason: `no answer within ${this.#timeoutMs}ms`,
    });
  }

  /**
   * Persist, then deliver, then report.
   *
   * Delivery happens for EVERY recorded decision, including the ones that are
   * themselves refusals — an unknown action and a rejected edit both decide
   * `deny`, and the worker has a promise waiting on that answer. Withholding it
   * would leave a tool call hanging until the deadline, which is a denial
   * arriving late and unexplained rather than a faster one.
   *
   * @param refusal - What the receipt says about the ANSWER. It is not a switch
   *   for delivery: `deny` is a decision and a decision is delivered.
   */
  async #decide(
    pending: PendingRequest,
    decision: Omit<PermissionResolution, 'requestId'>,
    refusal: PermissionRefusal | null,
    reason: string | undefined,
    updatedInput?: Readonly<Record<string, unknown>>,
  ): Promise<PermissionReceipt> {
    const resolved: PermissionResolution = {
      ...decision,
      requestId: pending.request.requestId,
      ...(reason ? { reason } : {}),
    };
    const outcome = this.#write(pending, resolved);

    if (outcome === 'failed') {
      // No durable row, so nothing may be delivered. A worker that acts on a
      // decision the store never learned about is the accounting error this
      // ordering exists to prevent. The tool call then waits out its deadline
      // and is denied with a recorded `timeout` — slow, but never unauthorised
      // and never claimed as decided.
      return {
        requestId: pending.request.requestId,
        firstDecision: false,
        action: null,
        refusal: 'persistence_failed',
        audit: resolved,
      };
    }

    this.#pending.delete(pending.request.requestId);
    pending.timer.clear();

    if (outcome === 'duplicate') {
      const prior = this.#store.read(pending.request.requestId);
      return {
        requestId: pending.request.requestId,
        firstDecision: false,
        action: prior?.action ?? null,
        refusal: 'permission_unknown_request',
        ...(prior?.scope ? { scope: prior.scope } : {}),
        audit: prior ?? resolved,
      };
    }

    await this.#deliver.deliver({
      requestId: pending.request.requestId,
      runId: pending.runId,
      sessionId: pending.sessionId,
      action: decision.action,
      ...(updatedInput ? { updatedInput } : {}),
    });

    return {
      requestId: pending.request.requestId,
      firstDecision: true,
      action: decision.action,
      refusal,
      ...(decision.scope ? { scope: decision.scope } : {}),
      audit: resolved,
    };
  }

  /** The one write path. Everything that ends a request goes through here. */
  #write(
    pending: PendingRequest,
    decision: PermissionResolution,
  ): 'recorded' | 'duplicate' | 'failed' {
    return this.#store.record({
      ...decision,
      runId: pending.runId,
      sessionId: pending.sessionId,
    });
  }
}

export interface ResolveInput {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
  /** The verb. A legacy name, or a canonical action when `surface` is `protocol`. */
  readonly decision: string;
  readonly surface: PermissionSurface | 'protocol';
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  /** Re-validates a host-rewritten input. Omitting it accepts the edit as-is. */
  readonly onUpdatedInput?: (
    updated: Readonly<Record<string, unknown>>,
    original: PermissionRequest,
  ) => Promise<{ accepted: boolean; reason?: string }> | { accepted: boolean; reason?: string };
}

/** A canonical action, or `null`. `paused` and `allow_for_session` are not actions. */
function protocolDecision(decision: string): TranslatedDecision | null {
  const action = asProtocolAction(decision);
  if (action === null) return null;
  if (action === 'defer') return { action: 'defer', scope: null, grants: false };
  if (action === 'allow_always') return { action, scope: null, grants: true };
  return { action, scope: null, grants: false };
}
