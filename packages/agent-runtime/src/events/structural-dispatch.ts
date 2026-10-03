/**
 * Structural dispatch: the one place a message from a peer is decided on.
 *
 * ## What "structural" means here
 *
 * Contract §F asks for `structuraldecode严格` — strict structural decode. The
 * existing `fromEnvelope` in the protocol package is LENIENT by design and
 * stays that way: it ignores unknown fields, because an old host that throws on
 * a field a new runtime added is a crashed client rather than a caught error.
 * That leniency is about FIELDS.
 *
 * This module is strict about the thing leniency must not cover: whether a
 * message is admissible AT ALL. A peer that sends something we cannot
 * interpret has to produce one of three named outcomes, never silence.
 *
 * ## The three outcomes
 *
 *  - **Accepted** — a known type whose payload satisfies its field manifest.
 *  - **Extension** — a legal unknown type. Carried as a typed extension plus a
 *    diagnostic, ignored, and the run keeps whatever terminal it had. This is
 *    the forward-compatibility path the contract requires.
 *  - **Rejected** — either a malformed message, or a type claiming a reserved
 *    namespace that this build does not understand. A rejection carries
 *    `requiresTerminal`, so the caller cannot quietly continue and let a run
 *    look successful when the message that would have said otherwise was
 *    dropped.
 *
 * ## Why the switch is complete
 *
 * `dispatchMessage` switches on the message KIND, not on the event type, and
 * every kind is handled. Adding a kind to `MessageKind` without a new arm is a
 * compile error, which is the same property `legacy-sse-projector.ts` relies
 * on. Within each arm the per-field check is the registry's own
 * `REQUIRED_FIELDS` table, so the schema for every message is the same table
 * `validate()` and the emitter use — one schema, three call sites, and no
 * second list that can disagree with the first.
 */

import type { EventType, RunEvent, RunEventEnvelope, WireEnvelope } from '@duya/agent-protocol';
import { CONTROL_GATE, EVENT_REGISTRY, checkRequiredFields, isEventType, verdictForUnknownType } from '@duya/agent-protocol';
import { RunEventEmitter, type EmitRejection } from './event-emitter.js';

/**
 * The kinds of message that can arrive from a peer.
 *
 * Declared as a closed union so the dispatch switch below is checked against
 * it. A fourth kind needs an arm, and a forgotten arm is a build failure
 * rather than a message that falls through unhandled.
 */
export type InboundMessageKind = 'native_envelope' | 'legacy_frame' | 'control_frame';

export interface DispatchIssue {
  readonly path: string;
  readonly message: string;
}

export interface DispatchRejection {
  readonly admitted: false;
  readonly kind: 'rejected';
  readonly code:
    | 'not_a_message'
    | 'missing_payload'
    | 'unknown_event_type'
    | 'critical_type_not_understood'
    | 'field_manifest_violation'
    | 'run_id_mismatch';
  readonly message: string;
  readonly issues: readonly DispatchIssue[];
  /** See {@link EmitRejection.requiresTerminal}. */
  readonly requiresTerminal: boolean;
}

export interface DispatchExtension {
  readonly admitted: true;
  readonly kind: 'extension';
  /**
   * A legal unknown type. Deliberately NOT a `RunEvent`: the registry has no
   * payload for it, and inventing one is how an unknown message starts
   * looking like a known one. The raw type is carried instead.
   */
  readonly observedType: string;
  readonly diagnostic: RunEvent;
}

export interface DispatchAccepted {
  readonly admitted: true;
  readonly kind: 'accepted';
  readonly envelope: RunEventEnvelope;
  readonly durable: boolean;
}

/**
 * A control method this host implements.
 *
 * Separate from {@link DispatchAccepted} because there is no envelope: a control
 * method is an instruction, and the runtime's `AgentRuntimeApi` carries it out
 * rather than recording it as an event. Folding the two together would mean
 * either minting a sequence number for a request (a second meaning for `seq`)
 * or putting `null` in a field typed as an envelope — and the second is the
 * kind of lie a caller stops noticing.
 */
export interface DispatchAcceptedControl {
  readonly admitted: true;
  readonly kind: 'control';
  readonly method: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export type DispatchResult = DispatchAccepted | DispatchAcceptedControl | DispatchExtension | DispatchRejection;

/**
 * Which shape the peer used.
 *
 * Decided by the wire, not by the caller: a native envelope has a `payload`
 * object and a `seq`, a legacy frame is the `{ type, data }` pair every
 * agent-server client already speaks, and a control frame is a method name
 * with a body. Getting this wrong is what makes a dispatcher accept a legacy
 * frame as if it were already a protocol event, so the test asserts each shape
 * routes to the right arm.
 */
export function classifyMessageKind(raw: unknown): InboundMessageKind | 'not_a_message' {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not_a_message';
  const record = raw as Readonly<Record<string, unknown>>;
  if (typeof record['seq'] === 'number' && typeof record['payload'] === 'object') return 'native_envelope';
  if (typeof record['method'] === 'string') return 'control_frame';
  if (typeof record['type'] === 'string') return 'legacy_frame';
  return 'not_a_message';
}

export interface DispatchOptions {
  /** The run this message claims to belong to, when the message names one. */
  readonly runId: string;
  /** The emitter that will accept the message if it survives validation. */
  readonly emitter: RunEventEmitter;
  /**
   * What this host can actually do.
   *
   * Consulted for control methods only, and it is a real capability set rather
   * than a flag: a host that answers `run.resume` without `replay` is a host
   * that acknowledged a resume it cannot honour.
   */
  readonly supportedCapabilities: ReadonlySet<string>;
}

/**
 * Decide one inbound message.
 *
 * Never throws. The whole point is that a message we cannot handle produces a
 * decision, and the decision is what stops a peer from ending a run by saying
 * something we do not understand.
 */
export function dispatchMessage(raw: unknown, options: DispatchOptions): DispatchResult {
  switch (classifyMessageKind(raw)) {
    case 'native_envelope':
      return dispatchNativeEnvelope(raw as WireEnvelope, options);
    case 'legacy_frame':
      // A legacy frame is a translation concern, not a structural one: it has
      // no protocol payload to check until the translator has run, and the
      // translator already refuses to invent one. Admitting it here would mean
      // admitting a frame whose fields have not been mapped, which is the
      // adapter-becomes-the-authority failure T3.2 forbids.
      return reject(
        'not_a_message',
        'a legacy frame has no protocol payload to validate; route it through translateFrame',
        [],
        false,
      );
    case 'control_frame':
      return dispatchControlFrame(raw as Readonly<Record<string, unknown>>, options);
    case 'not_a_message':
      return reject('not_a_message', 'the value is not a message this runtime can route', [], false);
  }
}

/**
 * A native envelope: the shape a peer that already speaks the protocol sends.
 *
 * Decided in three steps, in this order, because each one is cheaper and more
 * decisive than the next: is the payload an object with a type at all; is the
 * type one we know; does the payload satisfy that type's field manifest. Only
 * then is it handed to the emitter, which re-mints `seq` — so a peer cannot
 * dictate ordering even when everything else about the message is correct.
 */
function dispatchNativeEnvelope(raw: WireEnvelope, options: DispatchOptions): DispatchResult {
  const payload = raw.payload as Readonly<Record<string, unknown>> | undefined;
  if (typeof payload !== 'object' || payload === null) {
    return reject('missing_payload', 'the envelope has no payload object', [], false);
  }

  const type = payload['type'];
  if (typeof type !== 'string') {
    return reject('unknown_event_type', 'payload.type is not a string', [{ path: '$.payload.type', message: 'must be a string' }], false);
  }

  if (!isEventType(type)) {
    return classifyUnknownType(type, options);
  }

  const issues = checkRequiredFields(type, payload);
  if (issues.length > 0) {
    return reject(
      'field_manifest_violation',
      `${type} is missing ${issues.length} required field(s)`,
      issues.map((issue) => ({ path: `$.payload.${issue.field}`, message: issue.message })),
      // A malformed CRITICAL message is as uninterpretable as an unknown one:
      // a `run.completed` with no `status` is not a completion this runtime can
      // act on, and treating a half-parseable terminal as silence is precisely
      // the "quietly becomes success" failure the contract names.
      (EVENT_REGISTRY.specOf(type)?.critical ?? false),
    );
  }

  if (raw.runId !== options.runId) {
    return reject(
      'run_id_mismatch',
      `envelope names run "${raw.runId}", this runtime owns "${options.runId}"`,
      [{ path: '$.runId', message: 'does not match the run this dispatcher serves' }],
      false,
    );
  }

  // The emitter owns numbering. Handing it the payload — not the envelope — is
  // deliberate: the producer's `seq` is a claim, and `acceptInbound` records
  // whether it agreed with what the run minted.
  const inbound = options.emitter.acceptInbound({ ...raw, payload: payload as unknown as RunEvent });
  if (!inbound.accepted) {
    return {
      admitted: false,
      kind: 'rejected',
      code: inbound.rejection.code === 'critical_type_not_understood' ? 'critical_type_not_understood' : 'field_manifest_violation',
      message: inbound.rejection.message,
      issues: inbound.rejection.issues.map((issue) => ({ path: `$.payload.${issue.field}`, message: issue.message })),
      requiresTerminal: inbound.rejection.requiresTerminal,
    };
  }

  return { admitted: true, kind: 'accepted', envelope: inbound.envelope, durable: inbound.durable };
}

/**
 * A control frame: a method a peer wants the run to act on.
 *
 * Gated on `CONTROL_GATE` rather than on an event field manifest, because a
 * control method has no payload schema in `RunEventPayloads` — it is a
 * request, not an observation, and the runtime's `AgentRuntimeApi` is what
 * validates its arguments. What this arm decides is only whether the method is
 * one this host can IMPLEMENT, which is the same rule `compatibility.ts`
 * applies and the reason a refusal here is a refusal and not a warning.
 */
function dispatchControlFrame(raw: Readonly<Record<string, unknown>>, options: DispatchOptions): DispatchResult {
  const method = String(raw['method']);
  if (!CONTROL_METHODS.has(method)) {
    return classifyUnknownType(method, options);
  }
  // `run.pause` and `run.resume` are the two methods the registry gates behind
  // the `replay` capability, and both are critical: a resume that is
  // acknowledged and does nothing is a promise the host keeps. Refuse them
  // explicitly rather than admitting a method whose gate this host fails —
  // `CONTROL_GATE` is the authority for which capability each method needs, and
  // re-deriving that here would be a second table.
  const gate = CONTROL_GATE[method];
  if (gate?.requiresCapability !== undefined && !options.supportedCapabilities.has(gate.requiresCapability)) {
    return reject(
      'critical_type_not_understood',
      `${method} requires the "${gate.requiresCapability}" capability, which this host does not declare`,
      [{ path: '$.method', message: `requires capability "${gate.requiresCapability}"` }],
      true,
    );
  }
  return { admitted: true, kind: 'control', method, body: raw };
}

/**
 * The critical/extension boundary, applied to a type this build does not know.
 *
 * The one place a peer message becomes an ignorable extension or a refusal.
 * `requiresTerminal` is what makes the refusal load-bearing: a caller that
 * drops the message and carries on is producing the "unknown critical event
 * quietly became success" outcome the contract forbids, and the flag is what it
 * would have to act on to avoid that.
 */
function classifyUnknownType(type: string, options: DispatchOptions): DispatchResult {
  if (verdictForUnknownType(type) === 'critical') {
    return reject(
      'critical_type_not_understood',
      `"${type}" claims a reserved namespace, so ignoring it could let a run end without saying how`,
      [{ path: '$.payload.type', message: `unrecognised critical type "${type}"` }],
      true,
    );
  }
  // A legal extension. The diagnostic is emitted through the same emitter, so
  // the record that something arrived and was ignored is itself stamped and
  // sequenced — and the extension itself is never persisted, which is what
  // `UnknownRunEvent` guarantees everywhere else in the protocol.
  const result = options.emitter.classifyUnknown(type);
  if (!result.ok) {
    return {
      admitted: false,
      kind: 'rejected',
      code: 'unknown_event_type',
      message: result.message,
      issues: [],
      requiresTerminal: false,
    };
  }
  return {
    admitted: true,
    kind: 'extension',
    observedType: type,
    diagnostic: result.envelope.payload as RunEvent,
  };
}

/**
 * Control methods this host implements.
 *
 * The same list `registry.ts` gates in `CONTROL_GATE`, read from the runtime's
 * own API surface rather than restated: a method the runtime cannot execute is
 * a promise the host would keep, which is the failure `CONTROL_GATE`'s header
 * describes. Kept as a set because membership is the whole question here.
 */
const CONTROL_METHODS: ReadonlySet<string> = new Set([
  'run.start',
  'run.cancel',
  'run.pause',
  'run.resume',
  'permission.respond',
  'permission.setMode',
]);

function reject(
  code: DispatchRejection['code'],
  message: string,
  issues: readonly DispatchIssue[],
  requiresTerminal: boolean,
): DispatchRejection {
  return { admitted: false, kind: 'rejected', code, message, issues, requiresTerminal };
}
