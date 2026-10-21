/**
 * The compatibility gate — executable, not documentary.
 *
 * ## What this replaces
 *
 * The earlier draft carried a `since` field on every event and nothing read it.
 * That is the failure mode this module exists to end: a version annotation with
 * no enforcement is a comment that will rot, and a host written against it will
 * branch on a value nobody maintains.
 *
 * ## The rule
 *
 * A message is admitted to a host only when ALL of the following hold:
 *
 *   1. the host's protocol MAJOR matches the runtime's;
 *   2. the host's `schemaRevision` is at least the message's `minSchemaRevision`;
 *   3. the host declares `requiresCapability`, if the message names one.
 *
 * The same three checks apply to control methods. A control method that reaches
 * a host which cannot implement it is worse than one that never arrives: it
 * produces a promise the host will keep.
 *
 * ## Refusal is a first-class outcome
 *
 * A runtime can also REQUIRE something of a host — a policy the host must have
 * acknowledged, a capability without which the runtime cannot operate safely.
 * When that is unmet the correct answer is to refuse the connection, not to
 * connect and degrade. `negotiate` returns the refusal instead of a session in
 * that case, so "the runtime cannot work with this host" is expressible without
 * inventing a degraded mode for it.
 *
 * This is the one capability in the reference set that no other harness models.
 * Every other approach either connects and hopes, or adds a boolean to the
 * handshake and leaves the enforcement to whoever reads it.
 */

import {
  isCompatible,
  type HostDeclaration,
  type ProtocolCapability,
  type ProtocolVersion,
} from './version.js';

// ── message gating ─────────────────────────────────────────────────────────

/**
 * The compatibility requirements attached to one event type or control method.
 *
 * `minProtocol` is the wire version the message first appeared in;
 * `minSchemaRevision` is the payload-shape revision it reached its current form
 * at. They are separate because a payload can be reshaped without touching the
 * wire contract, and collapsing them would make every reshape look like a
 * breaking change.
 */
export interface MessageGate {
  /** Wire version at which this message type first appeared. */
  readonly minProtocol: `${number}.${number}`;
  /** Payload-shape revision at which this message reached its current form. */
  readonly minSchemaRevision: number;
  /**
   * A consumer that lacks this cannot make sense of the message, so it is
   * withheld rather than sent-and-ignored. Omit when the message is safe for
   * any host to receive and ignore.
   */
  readonly requiresCapability?: ProtocolCapability;
}

/** Why the gate refused. Machine-readable; a host branches on this, not prose. */
export type GateRefusalReason =
  | 'unknown_message'
  | 'major_mismatch'
  | 'min_protocol'
  | 'min_schema_revision'
  | 'missing_capability';

export type GateVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: GateRefusalReason;
      /** The gate that refused. Present for every reason except `unknown_message`. */
      readonly message: string;
      /** What the receiving side would have needed. */
      readonly required?: string | number;
      readonly hostHad?: string | number;
    };

const ALLOWED: GateVerdict = { allowed: true };

function parseProtocol(v: string): ProtocolVersion {
  const [major, minor] = v.split('.');
  return { major: Number(major), minor: Number(minor) };
}

/**
 * Admit one message to one host.
 *
 * @param message - Event type or control method name, for the refusal text.
 * @param gate - Its declared requirements, or `undefined` when it is unknown.
 * @param host - The receiving side's declaration.
 * @param runtime - The sending side's protocol version.
 */
export function admitMessage(
  message: string,
  gate: MessageGate | undefined,
  host: HostDeclaration,
  runtime: ProtocolVersion,
): GateVerdict {
  if (gate === undefined) {
    // Not a failure by itself: unknown message types are the forward-
    // compatibility path, and `unknown_event_type` handling lives in the
    // decoder. The caller decides whether an unknown message is tolerable.
    return {
      allowed: false,
      reason: 'unknown_message',
      message,
    };
  }

  const wire = isCompatible(host.protocol, runtime);
  if (!wire.ok) {
    return {
      allowed: false,
      reason: 'major_mismatch',
      message,
      required: runtime.major,
      hostHad: host.protocol.major,
    };
  }

  const min = parseProtocol(gate.minProtocol);
  // The FULL version is compared here, not just MAJOR. `isCompatible` checks
  // MAJOR only, which is right for a session-level handshake and wrong for a
  // per-message floor: a message introduced in 1.3 must not reach a 1.0 host,
  // even though the two can still hold a conversation about older messages.
  // An earlier version of this function reused `isCompatible` and let every
  // MINOR floor pass silently, which is the same fail-open the whole module
  // exists to prevent.
  if (host.protocol.major < min.major || (host.protocol.major === min.major && host.protocol.minor < min.minor)) {
    return {
      allowed: false,
      reason: 'min_protocol',
      message,
      required: gate.minProtocol,
      hostHad: `${host.protocol.major}.${host.protocol.minor}`,
    };
  }

  if (host.schemaRevision < gate.minSchemaRevision) {
    return {
      allowed: false,
      reason: 'min_schema_revision',
      message,
      required: gate.minSchemaRevision,
      hostHad: host.schemaRevision,
    };
  }

  if (gate.requiresCapability && !host.capabilities.includes(gate.requiresCapability)) {
    return {
      allowed: false,
      reason: 'missing_capability',
      message,
      required: gate.requiresCapability,
    };
  }

  return ALLOWED;
}

// ── session negotiation ────────────────────────────────────────────────────

/** Something the runtime needs from a host before it will talk to it. */
export interface RuntimeRequirement {
  readonly capability: ProtocolCapability;
  /** Why the runtime cannot proceed. Shown to an operator, not to a host. */
  readonly because: string;
}

/** A refusal to connect at all. */
export interface SessionRefusal {
  readonly reason: 'major_mismatch' | 'missing_required_capability';
  readonly message: string;
  readonly required?: string;
}

export interface NegotiatedSession {
  readonly host: HostDeclaration;
  readonly protocol: ProtocolVersion;
  /** The lower of the two schema revisions — what both sides can actually speak. */
  readonly schemaRevision: number;
  /** Capabilities both sides declared. A message needing anything else is withheld. */
  readonly capabilities: readonly ProtocolCapability[];
}

export type NegotiationOutcome =
  | { readonly accepted: true; readonly session: NegotiatedSession }
  | { readonly accepted: false; readonly refusals: readonly SessionRefusal[] };

/**
 * Negotiate a session, refusing outright when the runtime needs something the
 * host does not have.
 *
 * Degrading is not an option offered here on purpose. A runtime that needs a
 * capability the host lacks should not connect and then behave as if it did not
 * need it.
 *
 * @param host - The connecting side.
 * @param runtime - The serving side's protocol version and schema revision.
 * @param requirements - What the runtime needs from the host.
 */
export function negotiate(
  host: HostDeclaration,
  runtime: { readonly protocol: ProtocolVersion; readonly schemaRevision: number },
  requirements: readonly RuntimeRequirement[] = [],
): NegotiationOutcome {
  const wire = isCompatible(host.protocol, runtime.protocol);
  if (!wire.ok) {
    return {
      accepted: false,
      refusals: [
        {
          reason: 'major_mismatch',
          message: `host speaks protocol ${host.protocol.major}.${host.protocol.minor}, runtime speaks ${runtime.protocol.major}.${runtime.protocol.minor}`,
          required: String(runtime.protocol.major),
        },
      ],
    };
  }

  const refusals: SessionRefusal[] = [];
  for (const req of requirements) {
    if (!host.capabilities.includes(req.capability)) {
      refusals.push({
        reason: 'missing_required_capability',
        message: req.because,
        required: req.capability,
      });
    }
  }
  if (refusals.length > 0) return { accepted: false, refusals };

  // Everything the host declared is usable: at schema revision 1 every
  // capability in the vocabulary exists, so the intersection is the host's set
  // unchanged. It is computed as a filter rather than assigned so that adding a
  // capability with a higher `minSchemaRevision` later has an obvious place to
  // go — narrowing the set is then a one-line change, not a redesign.
  const capabilities = host.capabilities.filter((c) =>
    CAPABILITY_MIN_SCHEMA_REVISION[c] <= Math.min(host.schemaRevision, runtime.schemaRevision),
  );

  return {
    accepted: true,
    session: {
      host,
      protocol: host.protocol,
      schemaRevision: Math.min(host.schemaRevision, runtime.schemaRevision),
      capabilities,
    },
  };
}

/**
 * The schema revision each capability entered at.
 *
 * Every entry is 1 today, which is the honest value rather than a placeholder:
 * the vocabulary was introduced with schema revision 1. The map exists so that
 * "can this negotiated pair use capability X" has one answer instead of being
 * re-derived at each call site.
 */
export const CAPABILITY_MIN_SCHEMA_REVISION: Readonly<Record<ProtocolCapability, number>> = {
  tool_call_preview: 1,
  tool_outcome_detail: 1,
  usage_accounting: 1,
  replay: 1,
  checkpoint_resume: 1,
  permission_expiry: 1,
};

/**
 * Build the gate table for a set of message gates, so callers gate by lookup
 * rather than by trusting that every call site remembered to check.
 */
export function defineGateTable<G extends Readonly<Record<string, MessageGate>>>(table: G): {
  readonly gateOf: (message: string) => MessageGate | undefined;
  readonly admit: (message: string, host: HostDeclaration, runtime: ProtocolVersion) => GateVerdict;
} {
  return {
    gateOf: (message) => (table as Readonly<Record<string, MessageGate>>)[message],
    admit: (message, host, runtime) => admitMessage(message, (table as Readonly<Record<string, MessageGate>>)[message], host, runtime),
  };
}
