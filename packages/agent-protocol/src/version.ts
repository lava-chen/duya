/**
 * Version axes and the compatibility model.
 *
 * ## Two axes, not one
 *
 * `PROTOCOL_MAJOR.MINOR` is the WIRE contract: it changes when a host and a
 * runtime can no longer talk at all. `PROTOCOL_SCHEMA_REVISION` is the PAYLOAD
 * shape: it changes when a message grows a field or tightens a type, which an
 * older host can ignore.
 *
 * Conflating them makes the second kind of change look like the first. A MINOR
 * bump sends every independently-deployed host back to full re-probing for
 * something they would have handled correctly. Two harnesses in the reference
 * set keep the axes apart for exactly this reason — one of them leaves a comment
 * saying outright that a wire-framing change must not rewrite the legacy
 * version.
 *
 * The earlier draft of this package had a `since` field per event and no second
 * axis. It was worse than useless: thirty events all read `1.0`, the only
 * consumer was a test asserting the string's shape, and nothing ever gated on
 * it. A version annotation that no code reads is documentation, not a
 * compatibility mechanism, and it is worse than none because it looks like one.
 *
 * ## Two sides, because refusing is a capability too
 *
 * `RuntimeCapabilities` says what the runtime can do. `HostDeclaration` says
 * what the host can consume. Both are needed: a runtime that streams tool
 * previews to a host that cannot render them produces a broken UI, and a host
 * that asks for checkpoint resume against a runtime with no checkpoint
 * repository gets a promise nobody keeps. Neither side can be inferred from the
 * other, and a protocol that models only one has to guess about the other.
 */

export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 0 as const;
export const PROTOCOL_VERSION = `${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}` as const;

/**
 * Payload-shape revision. Independent of `PROTOCOL_MAJOR.MINOR`.
 *
 * Bump this when an existing payload changes shape. Do NOT bump
 * `PROTOCOL_MINOR` for the same change: the wire still means the same thing.
 */
export const PROTOCOL_SCHEMA_REVISION = 1 as const;

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export const CURRENT_VERSION: ProtocolVersion = {
  major: PROTOCOL_MAJOR,
  minor: PROTOCOL_MINOR,
};

export interface CompatibilityVerdict {
  readonly ok: boolean;
  /** Present only when `ok` is false. Machine-readable, not prose. */
  readonly reason?: 'major_mismatch' | 'invalid_version';
}

/**
 * MAJOR equality is the hard gate. MINOR is handled by capability probing.
 *
 * Call this once, during probe. A host must never branch on a version string to
 * decide behaviour.
 */
export function isCompatible(host: ProtocolVersion, runtime: ProtocolVersion): CompatibilityVerdict {
  if (!Number.isInteger(host.major) || !Number.isInteger(host.minor)) {
    return { ok: false, reason: 'invalid_version' };
  }
  if (!Number.isInteger(runtime.major) || !Number.isInteger(runtime.minor)) {
    return { ok: false, reason: 'invalid_version' };
  }
  if (runtime.major !== host.major) return { ok: false, reason: 'major_mismatch' };
  return { ok: true };
}

// ── capability vocabulary ──────────────────────────────────────────────────

/**
 * What a consumer must be able to handle for a message to be useful to it.
 *
 * Derived from protocol features that actually exist, not from a plausible
 * taxonomy. Every entry names something a host either understands or does not,
 * and dropping one makes the corresponding message safe to withhold.
 *
 * This is NOT the runtime's capability list — that lives on
 * `RuntimeCapabilities` and describes what the runtime can DO. This is the
 * consumer side, and the two are checked against each other.
 */
export const PROTOCOL_CAPABILITIES = [
  /** Host renders the provisional tool announcement and tolerates its absence. */
  'tool_call_preview',
  /** Host understands the discriminated `tool.call_completed` outcome union. */
  'tool_outcome_detail',
  /** Host consumes `assistant.usage` for cost accounting. */
  'usage_accounting',
  /** Host resumes a run from an event `seq` rather than a turn boundary. */
  'replay',
  /** Host consumes `checkpoint.saved` and resumes from a generation. */
  'checkpoint_resume',
  /** Host renders `expiresAt` and handles `permission.expired`. */
  'permission_expiry',
] as const;

/** One of the consumer capabilities a host may declare. */
export type ProtocolCapability = (typeof PROTOCOL_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(PROTOCOL_CAPABILITIES);

export function isProtocolCapability(value: unknown): value is ProtocolCapability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

/**
 * What a host says about itself, sent with the handshake.
 *
 * `capabilities` is what the host can CONSUME, not what it offers. Mixing the
 * two directions is the mistake this type exists to make impossible: a runtime
 * reading a host's declaration must never conclude the host can execute
 * something just because the host offered to serve it.
 */
export interface HostDeclaration {
  readonly host: { readonly name: string; readonly version: string };
  readonly protocol: ProtocolVersion;
  /** Highest `PROTOCOL_SCHEMA_REVISION` whose payload shapes this host handles. */
  readonly schemaRevision: number;
  readonly capabilities: readonly ProtocolCapability[];
}

/**
 * A host that can handle everything in the current schema. Useful as a default
 * in tests and in the CLI, where there is exactly one host in the repo and
 * version skew is impossible.
 */
export const CURRENT_HOST_DECLARATION: HostDeclaration = {
  host: { name: 'duya-reference-host', version: '0.0.0' },
  protocol: CURRENT_VERSION,
  schemaRevision: PROTOCOL_SCHEMA_REVISION,
  capabilities: PROTOCOL_CAPABILITIES,
};
