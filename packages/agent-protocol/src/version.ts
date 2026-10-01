/**
 * Protocol version and the compatibility gate.
 *
 * Design source: 07-agent-protocol-spec.md §13.
 *
 * The compatibility rule is deliberately asymmetric. MAJOR equality is the
 * only hard gate; MINOR drift is resolved by capability probing, never by
 * parsing version strings. A semver-style negotiation fails OPEN: after a
 * minor bump the runtime silently behaves differently and nothing complains.
 * Four hosts deploy independently (Desktop, CLI, eval harness, future cloud),
 * so a host must be able to say "I need replay + pause" and get a LOUD
 * `capability_unsupported` instead of a quietly degraded run.
 */

export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 0 as const;
export const PROTOCOL_VERSION = `${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}` as const;

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
 * MAJOR equality is the gate. MINOR is intentionally not consulted.
 *
 * Call this once, during probe. A host must never branch on a version string
 * to decide behaviour — that is the failure mode capability probing exists to
 * replace.
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

/**
 * Version at which a payload field or event type was introduced.
 * Used by the event registry and by the schema generator.
 */
export type Since = `${number}.${number}`;
