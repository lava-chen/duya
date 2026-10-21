/**
 * Capability negotiation — the effective intersection of what a host can
 * understand and what a runtime can produce.
 *
 * ## Probe, do not negotiate
 *
 * semver negotiation fails **open**: after a minor bump the runtime behaves
 * differently and nothing complains. Four hosts deploy independently (Desktop,
 * CLI, eval harness, future cloud), so a host that says "I need `replay`" must
 * get a LOUD `capability_unsupported` rather than a quietly degraded run.
 *
 * This module therefore computes an intersection and a list of unmet
 * requirements. It never picks a lower common denominator: the caller's
 * alternative is to refuse, and that decision belongs to the host.
 *
 * ## The requirement is expressed as events, not as flags
 *
 * The registry already says which events need which capability
 * (`registry.ts:150-199`, `MessageGate.requiresCapability`). So a host declares
 * "I understand these event types", and this module derives the capability set
 * those events require. A host that adds a new event type to its list cannot
 * forget to declare the capability it depends on, because there is no separate
 * list to forget — and one that could drift.
 */

import type {
  EventType,
  MessageGate,
  ProtocolVersion,
  RuntimeCapabilities,
} from '@duya/agent-protocol';
import { EVENT_REGISTRY, MESSAGE_GATES, isCompatible } from '@duya/agent-protocol';

/** The capability names the protocol can gate on. Mirrors `MessageGate`. */
export type RequiredCapability = NonNullable<MessageGate['requiresCapability']>;

/** What a host says it can do, before any runtime is involved. */
export interface HostCapabilities {
  /** Protocol version the host speaks. */
  readonly protocol: ProtocolVersion;
  /** Event types the host can render or store. */
  readonly eventTypes: readonly EventType[];
  /** Explicit extra requirements, for capabilities no event implies. */
  readonly requires?: readonly RequiredCapability[];
  /**
   * Control methods the host will actually call — `run.pause`, `run.resume`.
   *
   * Scoped on purpose. `CONTROL_GATE` gates a METHOD, not the run as a whole,
   * so demanding `replay` from a host that never resumes would reject a
   * perfectly good pairing. Absent means "calls none", which is the honest
   * default for a chat host that streams and cancels.
   */
  readonly controlMethods?: readonly string[];
}

/** A requirement the runtime does not satisfy. */
export interface UnmetRequirement {
  readonly capability: RequiredCapability;
  /** Which event type surfaced it, when the requirement came from one. */
  readonly because?: EventType;
  /** Which control method surfaced it, when it did not come from an event. */
  readonly method?: string;
}

export interface NegotiationVerdict {
  readonly ok: boolean;
  readonly unmet: readonly UnmetRequirement[];
  /** Capabilities the host ends up relying on, deduplicated and sorted. */
  readonly effective: readonly RequiredCapability[];
  /** False when the protocol MAJOR versions differ. Hard failure, not skew. */
  readonly compatible: boolean;
}

/**
 * Derive the capabilities a set of event types requires.
 *
 * @param eventTypes - Types the host intends to handle.
 */
export function capabilitiesRequiredBy(
  eventTypes: readonly EventType[],
): readonly RequiredCapability[] {
  const needed = new Set<RequiredCapability>();
  for (const type of eventTypes) {
    const gate = EVENT_REGISTRY.specOf(type);
    if (gate?.requiresCapability !== undefined) needed.add(gate.requiresCapability);
  }
  return [...needed].sort();
}

/**
 * Which gated event types the runtime cannot actually send.
 *
 * The registry's rule is that a host that cannot render a tool preview should
 * be sent no preview rather than one it will drop (`registry.ts:143-147`). So
 * this is computed from the runtime's OWN advertisement — a runtime that
 * declares a type in `events.volatile` is expected to be able to emit it — and
 * the caller withholds rather than drops.
 */
export function unsendableEvents(
  host: HostCapabilities,
  runtime: RuntimeCapabilities,
): readonly EventType[] {
  const sendable = new Set<EventType>([
    ...runtime.events.durable,
    ...runtime.events.volatile,
    ...runtime.events.ephemeral,
  ]);
  return EVENT_REGISTRY.all.filter(
    (type) => host.eventTypes.includes(type) && !sendable.has(type),
  );
}

/**
 * Compute the effective negotiation.
 *
 * @param host - What the host can handle.
 * @param runtime - What the runtime advertises in its `ready` frame.
 */
export function negotiate(
  host: HostCapabilities,
  runtime: RuntimeCapabilities,
): NegotiationVerdict {
  const verdict = isCompatible(host.protocol, runtime.protocol);
  const unmet: UnmetRequirement[] = [];

  for (const capability of capabilitiesRequiredBy(host.eventTypes)) {
    if (!runtimeSupports(runtime, capability)) {
      unmet.push({ capability });
    }
  }
  for (const capability of host.requires ?? []) {
    if (!runtimeSupports(runtime, capability) && !unmet.some((u) => u.capability === capability)) {
      unmet.push({ capability });
    }
  }
  for (const method of host.controlMethods ?? []) {
    const gate = MESSAGE_GATES[method];
    const capability = gate?.requiresCapability;
    if (capability !== undefined && !runtimeSupports(runtime, capability)) {
      unmet.push({ capability, method });
    }
  }

  return {
    ok: verdict.ok && unmet.length === 0,
    compatible: verdict.ok,
    unmet,
    effective: capabilitiesRequiredBy(host.eventTypes),
  };
}

/**
 * Whether a runtime advertises a capability.
 *
 * The mapping is spelled out rather than read off a generic list because the
 * protocol does not carry a flat capability array — that was the whole point
 * of `assertCapabilityConsistency` in the protocol package. A runtime claims
 * capabilities by declaring the events and behaviours that need them, so this
 * inverts those declarations.
 */
function runtimeSupports(
  runtime: RuntimeCapabilities,
  capability: RequiredCapability,
): boolean {
  const sendable: ReadonlySet<EventType> = new Set([
    ...runtime.events.durable,
    ...runtime.events.volatile,
    ...runtime.events.ephemeral,
  ]);

  switch (capability) {
    case 'replay':
      // `ResumeSupport` is a capability object, not a level: a runtime that
      // advertises any of the four resume strategies can honour `run.resume`,
      // and one that advertises none cannot. Reading a `.mode` string here
      // would be reading a field this protocol version does not have.
      return (
        runtime.run.resume.turnBoundary ||
        runtime.run.resume.eventSeq ||
        runtime.run.resume.messageIndex ||
        runtime.run.resume.checkpointGeneration
      );
    case 'usage_accounting':
      return sendable.has('assistant.usage');
    case 'tool_call_preview':
      return sendable.has('tool.call_preview');
    case 'tool_outcome_detail':
      return sendable.has('tool.call_completed');
    case 'permission_expiry':
      return runtime.run.permissionExpiryClock === 'runtime';
    case 'checkpoint_resume':
      return sendable.has('checkpoint.saved');
    default:
      // An unknown capability name is not a pass. A gate nobody can evaluate
      // is a gate nobody can honour, and treating it as satisfied is the
      // fail-open behaviour this module exists to prevent.
      return false;
  }
}
