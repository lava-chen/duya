/**
 * The one place a run's events are created.
 *
 * ## The hole this closes
 *
 * Before this module, a run had four ways for an event to appear, and only
 * three of them were honest:
 *
 *  1. `RunController.observeFrame` -> `session.observe(event)` -> `stream.push`.
 *     Ledger, counters, persistence, stream. Correct.
 *  2. `RunController.start` -> `session.observe({run.started})` -> `stream.push`.
 *     Correct, but written out by hand at the call site.
 *  3. `RunController.#failStart` -> `session.observe({run.failed})`. Correct,
 *     but never reached the stream at all.
 *  4. **The `ExecutionSink.envelope` arm -> `stream.push(envelope)`.** An
 *     executor that already speaks the protocol could push an envelope
 *     straight onto the run's stream: the executor's own `seq`, no ledger, no
 *     lifecycle check, no persistence, and no `RunSession` counters. An event
 *     that reached a host through this path existed in the UI and not in
 *     storage, and a run that had produced nothing could still show a terminal.
 *
 * (4) is the one that mattered. It is also the arm no production adapter uses
 * today — only the scripted test executor reaches it — which is exactly why it
 * survived: the path was exercised by tests that only checked the stream.
 *
 * ## The rule this class enforces
 *
 * Every event in a run is stamped with `runId`, `seq` and lifecycle by
 * {@link RunEventEmitter.emit}, checked against the registry's field manifest
 * and criticality, and persisted when durable — and there is no other method
 * that puts an event into the run. An INBOUND envelope from an executor is not
 * trusted to be numbered correctly: {@link RunEventEmitter.acceptInbound}
 * re-validates it and re-mints its sequence from the run's own ledger, so an
 * executor cannot dictate where in the run its event lands, cannot skip the
 * durable log, and cannot append after a terminal.
 *
 * ## Why `seq` is re-minted rather than adopted
 *
 * Contract §F: `runtime铸造 (runId,seq) 单调全事件顺序` — the runtime mints the
 * single monotonic per-run order. An executor that stamps its own `seq` is a
 * second numbering authority, and the disagreement between the two is
 * indistinguishable from a gap in a consumer that has no way to know which
 * counter it is reading. The producer's `seq` is not discarded: it is kept on
 * the diagnostic so the disagreement is visible instead of silent.
 */

import type { LifecycleViolationCode, RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { EVENT_REGISTRY, LifecycleViolation, checkRequiredFields, isEventType, verdictForUnknownType } from '@duya/agent-protocol';
import type { EventType } from '@duya/agent-protocol';
import type { RunSession } from '../run-session.js';

/**
 * The event types that close a run.
 *
 * Spelled out here rather than derived from the registry because the registry
 * has no `terminal` field, and adding one would put a third axis next to
 * `durability` and `critical` for a fact the ledger already owns
 * (`RunLedger.isTerminalEvent`). Two places naming the same two strings is
 * checkable — the census test asserts they agree; a third declaration axis is
 * not.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(['run.completed', 'run.failed']);

/** True when an event closes the run. */
export function isTerminalEventType(type: EventType): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

/** What the emitter refuses to do, as a machine-readable code. */
export type EmitRejectionCode =
  | 'unknown_event_type'
  | 'critical_type_not_understood'
  | 'field_manifest_violation'
  | 'run_id_mismatch'
  | 'lifecycle_violation'
  | 'after_terminal';

/** One refused event, and why. Never a throw the caller has to interpret. */
export interface EmitRejection {
  readonly ok: false;
  readonly code: EmitRejectionCode;
  readonly message: string;
  /** The offending type, when there was one to name. */
  readonly observedType: string | null;
  /** Field-level detail, for the field-manifest arm. */
  readonly issues: readonly { readonly field: string; readonly message: string }[];
  /**
   * The ledger's own code, when the ledger is what refused.
   *
   * Carried rather than thrown because the emitter's contract is that it never
   * throws — but a caller that needs to react DIFFERENTLY to a lifecycle
   * violation than to a malformed frame still needs to know which happened. The
   * controller records a lifecycle violation as the run's terminal with the
   * violation's own code as the cause; it does not do that for a bad field.
   */
  readonly violation: LifecycleViolationCode | null;
  /**
   * True when the run should be closed rather than left open.
   *
   * Set for a critical type this build does not understand and for a write
   * after a terminal. Both leave a run whose ending is unknown, and contract
   * §C says a run with no terminal must not sit in storage looking live.
   */
  readonly requiresTerminal: boolean;
}

/** One accepted event. */
export interface EmitAcceptance {
  readonly ok: true;
  readonly envelope: RunEventEnvelope;
  readonly durable: boolean;
  /** True when this event closed the run. */
  readonly terminal: boolean;
}

export type EmitResult = EmitAcceptance | EmitRejection;

/**
 * The one thing the emitter needs from a stream.
 *
 * Structural rather than `RunEventStream`, so the port says what is actually
 * used. `RunEventStream` is an async queue with a `Symbol.asyncIterator`, and
 * typing the dependency as that class would force every test double to
 * implement an iterator the emitter never calls — or to reach for the real
 * queue and drain it asynchronously to assert on what was pushed. The real
 * stream satisfies this shape, so nothing about production changes.
 */
export interface EventPublisher {
  push(envelope: RunEventEnvelope): void;
}

/**
 * Where the emitter sends the events it accepts.
 *
 * Both are supplied by the caller rather than reached for, so the emitter
 * cannot become a second place that decides where a run's events go — which is
 * what made (4) above possible in the first place.
 */
export interface RunEventEmitterPorts {
  /** The run's ledger-backed session. Mints `seq`, counts, buffers, persists. */
  readonly session: RunSession;
  /** The run's live stream, for observers. */
  readonly stream: EventPublisher;
  /**
   * The run this emitter belongs to.
   *
   * Checked against an inbound envelope's own `runId`, because an executor
   * reporting into the wrong run is a message this run must not accept on the
   * strength of the fact that it arrived here.
   */
  readonly runId: string;
}

export interface InboundAcceptance {
  readonly accepted: true;
  readonly envelope: RunEventEnvelope;
  readonly durable: boolean;
  /**
   * The producer's `seq`, when it disagreed with the minted one.
   *
   * Kept rather than dropped: two counters disagreeing is a fact about the
   * executor, and a diagnostic that says so is the only place it can surface.
   */
  readonly producerSeqDisagreed: boolean;
}

export type InboundResult =
  | InboundAcceptance
  | { readonly accepted: false; readonly rejection: EmitRejection };

/**
 * The single emit entry point for one run.
 *
 * Constructed once per run and shared by the controller, the translation path
 * and the `ExecutionSink` handed to the executor, so that "the controller
 * forgot to use the emitter" is not a state this class has to defend against —
 * there is nothing else to reach for.
 */
export class RunEventEmitter {
  readonly #ports: RunEventEmitterPorts;

  constructor(ports: RunEventEmitterPorts) {
    this.#ports = ports;
  }

  get runId(): string {
    return this.#ports.runId;
  }

  /**
   * Emit one event into the run.
   *
   * The single way an event enters a run. Every event — a `run.started` the
   * controller builds, a translated legacy frame, a synthetic `run.failed`, and
   * an envelope an executor pushed — arrives here.
   *
   * Order of checks matters and is not arbitrary:
   *
   *  1. **Known type.** An unknown type cannot be field-checked, and its
   *     verdict is the critical/extension boundary (`criticality.ts`).
   *  2. **Field manifest.** The registry's per-field required/optional table,
   *     which is the same table `validate()` uses. An event missing a required
   *     field is refused BEFORE it is buffered, so a malformed durable event is
   *     never written to storage in the first place.
   *  3. **Lifecycle.** The ledger's own invariants, last, because they are the
   *     only ones that need the run's history.
   *
   * Criticality is NOT checked here, and the absence is deliberate. `emit`
   * takes a `RunEvent`, so the type is already known — there is nothing to
   * classify. The critical/extension boundary applies to types this build does
   * NOT know, and it lives in {@link RunEventEmitter.classifyUnknown}, which
   * the inbound path calls. Checking criticality on a known type would refuse
   * every `assistant.text_delta` and every `tool.progress` the run emits.
   *
   * Never throws: a refused event is a fact about the run, and a run that dies
   * because one event was malformed is a run that never records what actually
   * went wrong. The caller turns `requiresTerminal` into `run.failed` when it
   * chooses to.
   */
  emit(event: RunEvent): EmitResult {
    const spec = EVENT_REGISTRY.specOf(event.type);
    if (spec === undefined) {
      // Unreachable through the type system — `event.type` is an `EventType` —
      // and checked anyway because this is the boundary where untrusted input
      // becomes a typed value, and a cast in a peer adapter is exactly how it
      // would be reached.
      return this.#refuse('unknown_event_type', `no registry entry for "${event.type}"`, event.type, [], false);
    }

    const issues = checkRequiredFields(event.type, event as unknown as Readonly<Record<string, unknown>>);
    if (issues.length > 0) {
      return this.#refuse(
        'field_manifest_violation',
        `${event.type} is missing ${issues.length} required field(s)`,
        event.type,
        issues,
        spec.durability === 'durable',
      );
    }

    return this.#mint(event);
  }

  /**
   * Accept an envelope an executor produced, re-numbered into this run.
   *
   * This is the arm that used to be `stream.push(envelope)`. Three things
   * change, and each one is a property the run layer was already claiming:
   *
   *  - the sequence is minted by this run's ledger, so an executor cannot
   *    dictate ordering, create a gap, or reuse a number;
   *  - the event goes through the same field manifest and lifecycle checks as
   *    every other event, so an executor cannot write past a terminal or
   *    bypass the durable log;
   *  - an unknown type is classified rather than dropped, so a reserved-
   *    namespace message the runtime does not understand refuses the write
   *    instead of disappearing.
   *
   * The producer's own `runId` must match. An envelope for a different run is
   * not a near-miss to be repaired; it is a message about a run this emitter
   * knows nothing about.
   */
  acceptInbound(envelope: RunEventEnvelope): InboundResult {
    if (envelope.runId !== this.#ports.runId) {
      return {
        accepted: false,
        rejection: this.#refuse(
          'run_id_mismatch',
          `envelope names run "${envelope.runId}", this emitter owns "${this.#ports.runId}"`,
          envelope.payload.type,
          [],
          false,
        ),
      };
    }

    // The type is checked HERE rather than assumed to have been checked by the
    // caller. `acceptInbound` is reachable without `dispatchMessage` — the
    // controller's `ExecutionSink.envelope` arm calls it directly — and an
    // emitter that answered an unknown type differently depending on which
    // door the message came through is an emitter with two opinions. Both doors
    // now ask `classifyUnknown`, so they cannot disagree.
    const type = (envelope.payload as { type?: unknown }).type;
    if (typeof type !== 'string') {
      return {
        accepted: false,
        rejection: this.#refuse('unknown_event_type', 'payload.type is not a string', null, [], false),
      };
    }
    if (!isEventType(type)) {
      const classified = this.classifyUnknown(type);
      if (!classified.ok) return { accepted: false, rejection: classified };
      // A legal extension: recorded as a diagnostic, and the extension itself
      // is NOT an accepted event. Reporting `accepted: true` here would tell a
      // caller the run acted on a message it did not.
      return {
        accepted: true,
        envelope: classified.envelope,
        durable: false,
        producerSeqDisagreed: envelope.seq !== classified.envelope.seq,
      };
    }

    const result = this.emit(envelope.payload);
    if (!result.ok) return { accepted: false, rejection: result };
    return {
      accepted: true,
      envelope: result.envelope,
      durable: result.durable,
      producerSeqDisagreed: envelope.seq !== result.envelope.seq,
    };
  }

  /**
   * Classify an event type this build does not know, without emitting it.
   *
   * The critical/extension decision, exposed on its own so a peer handshake can
   * ask the same question the emit path would answer, and answer it the same
   * way. Returns a refusal for a reserved-namespace type and a typed extension
   * plus diagnostic for a legal one.
   */
  classifyUnknown(type: string): EmitResult {
    const verdict = verdictForUnknownType(type);
    if (verdict === 'critical') {
      return this.#refuse(
        'critical_type_not_understood',
        `"${type}" claims a reserved namespace, so ignoring it would let a run end without saying how`,
        type,
        [],
        true,
      );
    }
    const minted = this.#mint({
      type: 'diagnostic',
      level: 'info',
      message: `ignored unknown extension "${type}"`,
      data: { observedType: type, verdict },
    });
    if (!minted.ok) return minted;
    return {
      ok: true,
      envelope: minted.envelope,
      durable: false,
      terminal: false,
    };
  }

  /** Mint, record and publish. The step every accepted event goes through. */
  #mint(event: RunEvent): EmitResult {
    const durability = EVENT_REGISTRY.specOf(event.type)?.durability ?? 'volatile';
    try {
      const envelope = this.#ports.session.observe(event);
      this.#ports.stream.push(envelope);
      return {
        ok: true,
        envelope,
        durable: durability === 'durable',
        terminal: isTerminalEventType(event.type),
      };
    } catch (error) {
      if (!(error instanceof LifecycleViolation)) throw error;
      const afterTerminal = error.code === 'event_after_terminal' || error.code === 'duplicate_terminal';
      return this.#refuse(
        afterTerminal ? 'after_terminal' : 'lifecycle_violation',
        error.detail,
        event.type,
        [],
        // A write after a terminal is not a run failure to report on the run
        // that already closed; it is a peer that kept talking. The refusal is
        // still flagged so the caller can diagnose it, but it must not
        // synthesise a second terminal, which the ledger would reject anyway.
        false,
        error.code,
      );
    }
  }

  #refuse(
    code: EmitRejectionCode,
    message: string,
    observedType: string | null,
    issues: readonly { readonly field: string; readonly message: string }[],
    requiresTerminal: boolean,
    violation: LifecycleViolationCode | null = null,
  ): EmitRejection {
    return { ok: false, code, message, observedType, issues, requiresTerminal, violation };
  }
}
