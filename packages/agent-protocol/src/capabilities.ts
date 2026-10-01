/**
 * Capability probing — the mechanism that resolves version skew.
 *
 * Design source: 07-agent-protocol-spec.md §10.
 *
 * ## Probe, don't negotiate
 *
 * semver negotiation fails OPEN: after a minor bump the runtime behaves
 * differently and nothing complains. Four hosts deploy independently
 * (Desktop app, CLI npm package, eval harness, future cloud), so a host must be
 * able to say "I need replay + pause" and receive a LOUD
 * `capability_unsupported` rather than a quietly degraded run.
 *
 * `isCompatible` (version.ts) is the only hard gate and it reads MAJOR. MINOR
 * is handled here. **No host parses a version string to decide behaviour.**
 *
 * ## Resource limits
 *
 * 07 §10 listed `maxEventBytes` with no default and no nesting/element limit.
 * pi-protocol sets all three explicitly (16 MiB / 1,000,000 / 64) and validates
 * a declared frame length BEFORE buffering its bytes; that ordering is adopted
 * here in framing.ts. See 10-reference-comparison.md §3.2(d).
 */

import type { ProtocolVersion } from './version.js';
import type { ErrorCode } from './errors.js';
import type { ResumeSupport } from './resume.js';
import type { PermissionAction } from './permission.js';
import type { EventType } from './events/registry.js';
import type { ConnectorBinding } from './primitives.js';

export type TransportKind = 'in-process' | 'subprocess' | 'http-sse';

export interface ProtocolLimits {
  /** Maximum serialized envelope size in bytes. */
  readonly maxEventBytes: number;
  /** Maximum elements in one array, or entries in one map. */
  readonly maxSequenceLength: number;
  /** Maximum object/array nesting depth. */
  readonly maxNestingDepth: number;
}

/** Defaults, matching pi-protocol so the two do not disagree silently. */
export const DEFAULT_LIMITS: ProtocolLimits = {
  maxEventBytes: 16 * 1024 * 1024,
  maxSequenceLength: 1_000_000,
  maxNestingDepth: 64,
};

export interface RuntimeCapabilities {
  readonly protocol: ProtocolVersion;
  readonly runtime: { readonly name: string; readonly version: string };
  readonly run: {
    readonly resume: ResumeSupport;
    readonly cancel: 'cooperative' | 'immediate';
    /** Grace period before a cooperative cancel escalates. */
    readonly graceMs: number;
    readonly pause: boolean;
    readonly deterministic: boolean;
    readonly maxEventBytes: number;
  };
  readonly events: {
    readonly replayWindow: number;
    readonly durable: readonly EventType[];
    readonly ephemeral: readonly EventType[];
  };
  readonly permissions: {
    readonly actions: readonly PermissionAction[];
    readonly defaultTimeoutMs: number;
    readonly maxTimeoutMs: number;
  };
  readonly catalog: {
    readonly profiles: readonly string[];
    readonly modes: readonly string[];
    readonly tools: readonly string[];
    readonly connectors: readonly ConnectorBinding[];
  };
  readonly transports: readonly TransportKind[];
  readonly limits: ProtocolLimits;
  /** Lets a host enumerate what it will actually see, so a mismatch is
   *  diagnosable rather than mysterious (07 §13.5). */
  readonly eventTypes: readonly EventType[];
}

// ── requirement shape ─────────────────────────────────────────────────────

export interface CapabilityRequirement {
  readonly needsReplayWindow?: number;
  readonly needsPause?: boolean;
  readonly needsDeterministic?: boolean;
  readonly needsTurnBoundaryResume?: boolean;
  readonly needsCheckpointResume?: boolean;
  readonly needsPermissionAction?: PermissionAction;
  readonly needsTransport?: TransportKind;
  readonly needsMaxEventBytes?: number;
  readonly needsCancel?: 'cooperative' | 'immediate';
}

export interface ProbeOptions {
  readonly require?: readonly CapabilityRequirement[];
  readonly timeoutMs?: number;
}

export class CapabilityError extends Error {
  readonly code: Extract<ErrorCode, 'capability_unsupported' | 'capability_not_ready'>;
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`capability_unsupported: ${missing.join(', ')}`);
    this.name = 'CapabilityError';
    this.code = 'capability_unsupported';
    this.missing = missing;
  }
}

function unmet(
  capabilities: RuntimeCapabilities,
  requirement: CapabilityRequirement,
): string[] {
  const missing: string[] = [];
  const r = capabilities.run;

  if (requirement.needsReplayWindow !== undefined) {
    if (!capabilities.events.replayWindow || capabilities.events.replayWindow < requirement.needsReplayWindow) {
      missing.push(`replayWindow>=${requirement.needsReplayWindow}`);
    }
  }
  if (requirement.needsPause && !r.pause) missing.push('pause');
  if (requirement.needsDeterministic && !r.deterministic) missing.push('deterministic');
  if (requirement.needsTurnBoundaryResume && !r.resume.turnBoundary) missing.push('resume.turnBoundary');
  if (requirement.needsCheckpointResume && !r.resume.checkpointGeneration) {
    missing.push('resume.checkpointGeneration');
  }
  if (requirement.needsPermissionAction && !capabilities.permissions.actions.includes(requirement.needsPermissionAction)) {
    missing.push(`permissions.actions.${requirement.needsPermissionAction}`);
  }
  if (requirement.needsTransport && !capabilities.transports.includes(requirement.needsTransport)) {
    missing.push(`transports.${requirement.needsTransport}`);
  }
  if (requirement.needsMaxEventBytes !== undefined && r.maxEventBytes < requirement.needsMaxEventBytes) {
    missing.push(`maxEventBytes>=${requirement.needsMaxEventBytes}`);
  }
  if (requirement.needsCancel && r.cancel !== requirement.needsCancel) {
    missing.push(`cancel=${requirement.needsCancel}`);
  }
  return missing;
}

/**
 * Fail LOUDLY. Throws `CapabilityError` rather than returning a degraded
 * verdict, because a silently degraded run is the failure this whole mechanism
 * exists to prevent.
 */
export function assertSatisfies(
  capabilities: RuntimeCapabilities,
  requirements: readonly CapabilityRequirement[],
): void {
  const missing: string[] = [];
  for (const requirement of requirements) {
    missing.push(...unmet(capabilities, requirement));
  }
  if (missing.length) throw new CapabilityError(missing);
}

export function satisfies(
  capabilities: RuntimeCapabilities,
  requirements: readonly CapabilityRequirement[],
): boolean {
  try {
    assertSatisfies(capabilities, requirements);
    return true;
  } catch {
    return false;
  }
}
