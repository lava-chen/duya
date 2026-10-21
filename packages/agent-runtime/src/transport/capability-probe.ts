/**
 * The capability probe: what a transport can honestly do, and how a `since`
 * declaration earns its place.
 *
 * ## The honesty rule, and the two capabilities that fail it today
 *
 * Plan 587 requires an unproven capability to be reported as UNSUPPORTED
 * rather than claimed. Two fail that test today and this module says so:
 *
 *  - **execution resume.** `run.resume` exists as a control method and
 *    `ResumeSupport` has fields for it, but nothing in the runtime rebuilds a
 *    model/context/tool/permission index from a checkpoint. Contract section G
 *    says pause/resume/determinism stay unsupported until D7 accepts them, and
 *    D7 has not run. So `resume` is reported unsupported and a host requiring
 *    it gets `capability_unsupported` at probe time rather than a resume that
 *    quietly does nothing.
 *  - **determinism.** `run.deterministic` is `false` here. The honest reason
 *    is not "we have not implemented a seed" -- it is that a model provider
 *    cannot be made deterministic from this side of the boundary, so a
 *    capability that says `true` would be a claim about a system this code
 *    does not control.
 *
 * Both are `false` in {@link probeRuntimeCapabilities}, and both are the values
 * the plan requires. The test asserts they are false AND that requiring them
 * fails loudly, because an unsupported capability nobody asks for is a
 * capability that could have been true without anyone noticing.
 *
 * ## What `since` IS, decided rather than deferred
 *
 * The brief asks whether a declared `since` is a compile-time guarantee, a
 * runtime check, or both. The answer here is BOTH, in this order:
 *
 *  1. **Compile time.** `MessageGate` extends the event metadata, so an event
 *     cannot be declared without declaring its floor -- `registry.ts` already
 *     enforces that, and `EventMeta` is the mechanism. There is no `since?`
 *     optional field to forget.
 *  2. **Runtime, in the transport path.** {@link negotiateEventAdmission} calls
 *     `admitMessage` for every event a transport is about to send, against the
 *     peer's own declaration. An event the peer cannot admit is WITHHELD, not
 *     sent-and-ignored, and the withholding is returned to the caller rather
 *     than logged and forgotten.
 *
 * Runtime-only would fail when a peer is older than the type; compile-time-only
 * would fail the moment a real host with a real version skews the other way.
 * Both are needed, and the runtime half is the one that is easy to drop, which
 * is why the gate table is a PARAMETER: `negotiateEventAdmission` takes its
 * table, so a test can raise one event's floor and observe the transport change
 * its behaviour. A probe that ignored the table would fail that test, which is
 * what makes `since` load-bearing rather than decorative.
 *
 * ## A peer that claims a capability it does not honour
 *
 * A host DECLARING a capability it does not implement is undetectable by
 * asking: the declaration is the only evidence there is. So the handling is
 * not "trust and find out later" and not "refuse to believe anyone". It is:
 *
 *  - on the SEND side, never emit a message the peer's declaration cannot
 *    admit, so an over-claiming peer receives nothing that depends on the claim;
 *  - on the RECEIVE side, {@link admitIncoming} runs the same gate, so a peer
 *    that sends a message the receiver cannot admit is refused with a reason
 *    rather than absorbed;
 *  - and the withholding is REPORTED, so an over-claiming host is diagnosable
 *    from the host's own logs instead of from a user's bug report.
 */

import {
  DEFAULT_LIMITS,
  EVENT_REGISTRY,
  MESSAGE_GATES,
  NO_RESUME,
  admitMessage,
  assertCapabilityConsistency,
  assertSatisfies,
  isEventType,
  type CapabilityRequirement,
  type EventType,
  type GateVerdict,
  type HostDeclaration,
  type MessageGate,
  type ProtocolVersion,
  type RuntimeCapabilities,
  type RuntimeCapability,
  type TransportKind,
} from '@duya/agent-protocol';
import { TRANSPORT_FLOW_CONTROL } from '../events/control-channel.js';

/**
 * The gate table the probe consults.
 *
 * A parameter rather than a hardcoded `MESSAGE_GATES` read, and that is
 * deliberate: the test raises one event's `minProtocol` and asserts the
 * transport then withholds it. If the probe stopped consulting the table, that
 * test fails -- which is the whole reason a `since` field is not "written and
 * never read".
 */
export type GateTable = Readonly<Record<string, MessageGate>>;

/** What the probe decided about one event type. */
export interface EventAdmission {
  readonly type: EventType;
  /** False when the peer cannot admit it, so the transport must not send it. */
  readonly admitted: boolean;
  /** The gate's own reason. `unknown_message` for a type this build lacks. */
  readonly reason?: GateVerdict extends { allowed: false } ? GateVerdict['reason'] : string;
  /** What the peer would have needed, when the gate said so. */
  readonly required?: string | number;
  /** True when the message is in a reserved namespace and unreadable. */
  readonly requiresTerminal?: boolean;
}

export interface AdmissionReport {
  /** The events that may be sent, in registry order. */
  readonly admitted: readonly EventType[];
  /** The events withheld, with the reason for each. */
  readonly withheld: readonly EventAdmission[];
  /**
   * Withheld events that a reserved-namespace consumer must be told about.
   *
   * An unread `run.completed` is not a missing pixel, it is a run whose ending
   * is unknown -- so this list is what turns a version skew into a reported
   * terminal obligation rather than a silent divergence.
   */
  readonly requiresTerminal: readonly EventType[];
}

/**
 * Decide, per event, whether this peer may receive it.
 *
 * The single place `since` is consulted at runtime. Every branch of the verdict
 * comes from `admitMessage`; this function adds the registry lookup and the
 * reserved-namespace consequence, and deliberately has no policy of its own --
 * a second opinion here is how a gate stops being authoritative.
 */
export function negotiateEventAdmission(input: {
  readonly host: HostDeclaration;
  readonly protocol: ProtocolVersion;
  readonly gates?: GateTable;
  /** Restrict the decision to these types. Defaults to the whole registry. */
  readonly types?: readonly EventType[];
}): AdmissionReport {
  const gates = input.gates ?? MESSAGE_GATES;
  const types = input.types ?? EVENT_REGISTRY.all;

  const admitted: EventType[] = [];
  const withheld: EventAdmission[] = [];
  const requiresTerminal: EventType[] = [];

  for (const type of types) {
    const gate = gates[type];
    const verdict = admitMessage(type, gate, input.host, input.protocol);
    if (verdict.allowed) {
      admitted.push(type);
      continue;
    }
    // An unknown type is the forward-compatibility path, not a fault, and it is
    // not in a reserved namespace by construction. Everything else that fails
    // on a registry type is a real refusal.
    const isCritical = EVENT_REGISTRY.specOf(type)?.critical === true;
    withheld.push({
      type,
      admitted: false,
      reason: verdict.reason,
      ...('required' in verdict && verdict.required !== undefined
        ? { required: verdict.required }
        : {}),
      ...(isCritical ? { requiresTerminal: true } : {}),
    });
    if (isCritical) requiresTerminal.push(type);
  }

  return { admitted, withheld, requiresTerminal };
}

/**
 * The receive-side check, so an over-claiming peer is refused rather than
 * absorbed.
 *
 * Same gate, opposite direction. A peer that sends a message this build cannot
 * admit is not silently accepted even when it is in the forward-compatible
 * namespace: an unknown type is tolerated as an EXTENSION, and an unknown type
 * in a reserved namespace is refused -- which is T3.2's rule and is why this
 * cannot be a bare `isEventType` check.
 */
export function admitIncoming(input: {
  readonly type: string;
  readonly host: HostDeclaration;
  readonly protocol: ProtocolVersion;
  readonly gates?: GateTable;
}): GateVerdict {
  const gates = input.gates ?? MESSAGE_GATES;
  return admitMessage(input.type, gates[input.type], input.host, input.protocol);
}

/** The facts a caller must supply, because the probe may not assume them. */
export interface CapabilityProbeInput {
  readonly transport: TransportKind;
  readonly protocol: ProtocolVersion;
  readonly schemaRevision: number;
  readonly identity: { readonly name: string; readonly version: string; readonly pid?: number };
  /**
   * What the RUNTIME can provide, measured by the host that owns it.
   *
   * Passed in rather than imported so a transport cannot answer this for itself:
   * a probe that reported its own capabilities is a promise, and the honest
   * version of `checkpoint_repository` is a fact about a repository that exists
   * somewhere else.
   */
  readonly provides: readonly RuntimeCapability[];
  /** Permission actions the host can actually adjudicate. */
  readonly permissionActions: readonly string[];
  readonly permissionDefaultTimeoutMs: number;
  readonly permissionMaxTimeoutMs: number;
  /** Replay depth the store holds, as T3.3's `ReplayWindow` reports it. */
  readonly oldestAvailableSeq: number;
  readonly latestSeq: number;
  /** What the catalogue holds. A transport must not invent a provider. */
  readonly catalog: RuntimeCapabilities['catalog'];
  readonly limits?: RuntimeCapabilities['limits'];
}

/**
 * Build the probe answer from measured facts.
 *
 * ## The three refusals, stated
 *
 * These three are the load-bearing values in the whole probe and each is a
 * refusal to promise:
 *
 *  - `resume`: `unsupported` on both arms. Nothing rebuilds a run from a
 *    checkpoint; D7 owns that.
 *  - `deterministic: false`: a model provider is outside this code's control,
 *    so `true` would be a claim about a system it cannot govern.
 *  - `permissionExpiryClock: 'absent'`: there is no permission timer in the
 *    agent, so a runtime advertising `'runtime'` would render a deadline it
 *    never enforces -- and `assertCapabilityConsistency` below is what stops
 *    that combination from shipping.
 */
export function probeRuntimeCapabilities(input: CapabilityProbeInput): RuntimeCapabilities {
  const capabilities: RuntimeCapabilities = {
    protocol: input.protocol,
    runtime: input.identity,
    run: {
      // D7 has not accepted pause/resume/determinism (contract section G), so
      // this is the protocol's OWN refusal value rather than a hand-built
      // near-copy of it. Restating the shape here would be a second place for
      // the answer to drift.
      resume: NO_RESUME,
      cancel: 'cooperative',
      graceMs: 0,
      pause: false,
      deterministic: false,
      permissionExpiryClock: 'absent',
    },
    events: {
      oldestAvailableSeq: input.oldestAvailableSeq,
      latestSeq: input.latestSeq,
      durable: [...EVENT_REGISTRY.durable],
      volatile: [...EVENT_REGISTRY.volatile],
      ephemeral: [...EVENT_REGISTRY.ephemeral],
    },
    permissions: {
      actions: input.permissionActions as RuntimeCapabilities['permissions']['actions'],
      defaultTimeoutMs: input.permissionDefaultTimeoutMs,
      maxTimeoutMs: input.permissionMaxTimeoutMs,
    },
    catalog: input.catalog,
    transports: [input.transport],
    limits: input.limits ?? DEFAULT_LIMITS,
    eventTypes: [...EVENT_REGISTRY.all],
  };

  // A probe that advertises what the runtime cannot provide is the exact
  // failure this module exists to prevent, and the assertion is cheap enough to
  // run on every probe rather than only in a test.
  const problems = assertCapabilityConsistency(capabilities, input.provides);
  if (problems.length > 0) {
    throw new CapabilityProbeError(problems);
  }
  return capabilities;
}

export interface CapabilityProbeErrorDetail {
  readonly field: string;
  readonly advertised: string;
  readonly required: string;
}

export class CapabilityProbeError extends Error {
  readonly code = 'capability_unsupported' as const;
  readonly problems: readonly CapabilityProbeErrorDetail[];

  constructor(problems: readonly CapabilityProbeErrorDetail[]) {
    super(
      'the probe would advertise a capability the runtime does not provide: ' +
        problems.map((p) => `${p.field} (${p.advertised}) needs ${p.required}`).join('; '),
    );
    this.name = 'CapabilityProbeError';
    this.problems = problems;
  }
}

/**
 * Enforce a host's requirements BEFORE dispatch.
 *
 * Delegates to the protocol's own `assertSatisfies` rather than restating the
 * rules, because a probe with its own copy of "what counts as satisfied" is a
 * second negotiation, and the second one is the one that will be wrong.
 */
export function assertTransportCanStart(
  capabilities: RuntimeCapabilities,
  require: readonly CapabilityRequirement[] = [],
): void {
  assertSatisfies(capabilities, require);
}

/**
 * The seven things T3.5 asks the probe to enumerate, addressed explicitly.
 *
 * Returned as a table rather than left implicit in the object literal above,
 * because the requirement is that a reader can CHECK the enumeration. Each
 * entry names the field it reads, so a field that stops being consulted is
 * visible here and the test below asserts each one is actually read by
 * perturbing it.
 */
export interface ProbeEnumeration {
  readonly cancel: boolean;
  readonly permission: boolean;
  readonly eventReplay: boolean;
  readonly executionResume: boolean;
  readonly determinism: boolean;
  readonly expiryClock: boolean;
  readonly limits: boolean;
}

export function enumerateProbe(capabilities: RuntimeCapabilities): ProbeEnumeration {
  return {
    cancel: capabilities.run.cancel !== undefined,
    permission: capabilities.permissions.actions.length > 0,
    // Replay is DEPTH, not a boolean, and the empty case is the trap.
    //
    // `latestSeq >= oldestAvailableSeq` is the obvious spelling and it is
    // WRONG for an empty store, where both are 0 and the comparison answers
    // "you are current" for a runtime holding nothing at all. That is the same
    // defect T3.3 found and fixed in `isWithinWindow`, reproduced here in a
    // different function -- which is the argument for checking the boundary
    // rather than reasoning about it. The extra `> 0` is the whole fix: a
    // runtime that has minted nothing has nothing to replay.
    eventReplay: hasReplayableHistory(capabilities),
    // The refusal, as a boolean so a host can read it in one place. Derived
    // from the boundary flags rather than from a separate `supported` field,
    // because a second boolean beside four flags is a fifth thing to keep true.
    executionResume:
      capabilities.run.resume.turnBoundary ||
      capabilities.run.resume.checkpointGeneration ||
      capabilities.run.resume.messageIndex ||
      capabilities.run.resume.eventSeq,
    determinism: capabilities.run.deterministic,
    expiryClock: capabilities.run.permissionExpiryClock === 'runtime',
    limits: capabilities.limits.maxEventBytes > 0,
  };
}

/** True when the store holds at least one replayable `seq`. */
export function hasReplayableHistory(capabilities: RuntimeCapabilities): boolean {
  const { oldestAvailableSeq, latestSeq } = capabilities.events;
  return latestSeq > 0 && latestSeq >= oldestAvailableSeq;
}

/**
 * The capabilities T3.5 is forbidden to advertise until D7 proves them.
 *
 * Named here so a test can assert they are all false, so a future change that
 * flips one has to delete the name and say why in the commit that does it.
 */
export const UNPROVEN_CAPABILITIES = ['execution_resume', 'determinism'] as const;
export type UnprovenCapability = (typeof UNPROVEN_CAPABILITIES)[number];

/** The flow-control fact each transport kind is allowed to advertise. */
export function flowControlOf(transport: TransportKind): string {
  return TRANSPORT_FLOW_CONTROL[transport] ?? 'unknown';
}

export { isEventType };
