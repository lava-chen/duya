/**
 * A reference run ledger — the state machine a host uses to rebuild a run.
 *
 * ## Why this is shipped and not buried in a test
 *
 * Every invariant in `lifecycle-invariants.test.ts` is a rule a host has to
 * enforce anyway when it rebuilds a run from a stream: sequence gaps, a second
 * terminal event, a tool result with no invocation, a permission resolution for
 * a request nobody saw. Writing the rules twice — once in prose, once in each
 * host — is how they diverge.
 *
 * So the rules live here, once, and the tests assert that this implementation
 * rejects what it is supposed to reject. A host with different needs can write
 * its own; what it cannot do is claim the protocol permits something this
 * ledger calls a violation, because the ledger IS the specification of
 * "permitted".
 *
 * ## Scope
 *
 * Run-scoped. `seq` is unique within a run, so every piece of state here dies
 * with the run. There is deliberately no session-level state, because a session
 * outlives its runs and a cross-run cursor is a different number with a
 * different lifetime — see `RunEventEnvelope.seq`.
 */

import type { RunEvent, EventType } from '../events/registry.js';
import type { RunEventEnvelope } from '../envelope.js';
import { eventKey, SEQ_CONTRACT } from '../envelope.js';
import { TOOL_LIFECYCLE_EVENTS } from '../resume.js';

/** Why a stream is not a legal run. Machine-readable; tests branch on it. */
export type LifecycleViolationCode =
  | 'seq_not_monotonic'
  | 'seq_gap'
  | 'event_after_terminal'
  | 'duplicate_terminal'
  | 'tool_started_twice'
  | 'tool_completed_without_start'
  | 'tool_preview_after_start'
  | 'permission_resolved_without_request'
  | 'permission_resolved_twice'
  | 'checkpoint_seq_not_emitted'
  | 'checkpoint_generation_not_monotonic';

export class LifecycleViolation extends Error {
  readonly code: LifecycleViolationCode;
  readonly detail: string;

  constructor(code: LifecycleViolationCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'LifecycleViolation';
    this.code = code;
    this.detail = detail;
  }
}

export interface ToolState {
  previews: number;
  startedSeq: number | null;
  completedSeq: number | null;
}

export interface PermissionState {
  requestedSeq: number;
  resolvedSeq: number | null;
}

export interface CheckpointRecord {
  readonly checkpointRef: string;
  readonly generation: number;
  readonly eventSeq: number;
}

export interface RunLedgerOptions {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId?: string;
  /** Deterministic tests pass a counter; production passes a clock. */
  readonly now?: () => number;
}

export class RunLedger {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;

  #seq = 0;
  #now: () => number;
  #terminal: { readonly status: string; readonly seq: number } | null = null;
  #tools = new Map<string, ToolState>();
  #permissions = new Map<string, PermissionState>();
  #checkpoints: CheckpointRecord[] = [];
  #emittedSeqs = new Set<number>();

  constructor(opts: RunLedgerOptions) {
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
    this.traceId = opts.traceId ?? `trace-${opts.runId}`;
    this.#now = opts.now ?? (() => 0);
  }

  get seq(): number {
    return this.#seq;
  }

  get terminal(): { readonly status: string; readonly seq: number } | null {
    return this.#terminal;
  }

  get checkpoints(): readonly CheckpointRecord[] {
    return this.#checkpoints;
  }

  toolState(toolCallId: string): ToolState | undefined {
    return this.#tools.get(toolCallId);
  }

  permissionState(requestId: string): PermissionState | undefined {
    return this.#permissions.get(requestId);
  }

  isTerminalEvent(type: EventType): boolean {
    return type === 'run.completed' || type === 'run.failed';
  }

  /**
   * Append one event, enforcing every run-level invariant.
   *
   * @throws {LifecycleViolation} on any rule breach. Throwing rather than
   * collecting is deliberate: a run that has already violated an invariant is
   * not a run whose remaining events can be interpreted, so continuing would
   * produce confidently wrong derived state.
   */
  emit<T extends RunEvent>(event: T, at?: number): RunEventEnvelope<T> {
    const next = this.#seq + SEQ_CONTRACT.step;

    if (this.#terminal !== null) {
      throw new LifecycleViolation(
        'event_after_terminal',
        `${event.type} at seq ${next}, after ${this.#terminal.status} at seq ${this.#terminal.seq}`,
      );
    }

    this.#assertPayload(event, next);

    if (this.isTerminalEvent(event.type)) {
      if (this.#terminal !== null) {
        throw new LifecycleViolation('duplicate_terminal', `${event.type} after a terminal event`);
      }
      this.#terminal = { status: event.type, seq: next };
    }

    this.#seq = next;
    this.#emittedSeqs.add(next);

    return {
      runId: this.runId,
      sessionId: this.sessionId,
      seq: next,
      timestamp: at ?? this.#now(),
      traceId: this.traceId,
      payload: event,
    };
  }

  #assertPayload(event: RunEvent, next: number): void {
    switch (event.type) {
      case 'tool.call_preview': {
        const state = this.#tool(event.toolCallId);
        if (state.startedSeq !== null) {
          throw new LifecycleViolation(
            'tool_preview_after_start',
            `preview for ${event.toolCallId} after the authoritative start at seq ${state.startedSeq}`,
          );
        }
        state.previews += 1;
        return;
      }
      case 'tool.call_started': {
        const state = this.#tool(event.toolCallId);
        if (state.startedSeq !== null) {
          throw new LifecycleViolation(
            'tool_started_twice',
            `${event.toolCallId} already started at seq ${state.startedSeq}`,
          );
        }
        state.startedSeq = next;
        return;
      }
      case 'tool.call_completed':
      case 'tool.timed_out': {
        const state = this.#tools.get(event.toolCallId);
        if (state === undefined || state.startedSeq === null) {
          throw new LifecycleViolation(
            'tool_completed_without_start',
            `${event.type} for ${event.toolCallId}, which has no authoritative start`,
          );
        }
        state.completedSeq = next;
        return;
      }
      case 'permission.requested': {
        this.#permissions.set(event.requestId, { requestedSeq: next, resolvedSeq: null });
        return;
      }
      case 'permission.resolved':
      case 'permission.expired': {
        const state = this.#permissions.get(event.requestId);
        if (state === undefined) {
          throw new LifecycleViolation(
            'permission_resolved_without_request',
            `${event.type} for ${event.requestId}, which was never requested`,
          );
        }
        if (event.type === 'permission.resolved') {
          if (state.resolvedSeq !== null) {
            throw new LifecycleViolation(
              'permission_resolved_twice',
              `${event.requestId} already resolved at seq ${state.resolvedSeq}`,
            );
          }
          state.resolvedSeq = next;
        }
        return;
      }
      case 'checkpoint.saved': {
        // The checkpoint says "I stored the state as of this seq". If that seq
        // was never emitted, the boundary refers to nothing and a resume from
        // it would restore an unverified state.
        if (!this.#emittedSeqs.has(event.eventSeq)) {
          throw new LifecycleViolation(
            'checkpoint_seq_not_emitted',
            `checkpoint ${event.checkpointRef} points at seq ${event.eventSeq}, which this run has not emitted`,
          );
        }
        const previous = this.#checkpoints[this.#checkpoints.length - 1];
        if (previous !== undefined && event.generation <= previous.generation) {
          throw new LifecycleViolation(
            'checkpoint_generation_not_monotonic',
            `generation ${event.generation} does not advance past ${previous.generation}`,
          );
        }
        this.#checkpoints.push({
          checkpointRef: event.checkpointRef,
          generation: event.generation,
          eventSeq: event.eventSeq,
        });
        return;
      }
      default:
        return;
    }
  }

  #tool(toolCallId: string): ToolState {
    let state = this.#tools.get(toolCallId);
    if (state === undefined) {
      state = { previews: 0, startedSeq: null, completedSeq: null };
      this.#tools.set(toolCallId, state);
    }
    return state;
  }
}

/**
 * Replay a stream through a ledger, returning the violations instead of
 * throwing. For a test that feeds a whole sequence and wants to see everything
 * wrong with it at once.
 */
export function replayViolations(
  events: readonly RunEvent[],
  opts: RunLedgerOptions,
): LifecycleViolationCode[] {
  const ledger = new RunLedger(opts);
  const codes: LifecycleViolationCode[] = [];
  for (const event of events) {
    try {
      ledger.emit(event);
    } catch (error) {
      if (error instanceof LifecycleViolation) {
        codes.push(error.code);
        break; // state is untrustworthy after the first violation
      }
      throw error;
    }
  }
  return codes;
}

/** Re-exported so a test can assert the lifecycle set did not drift. */
export { TOOL_LIFECYCLE_EVENTS, eventKey };
