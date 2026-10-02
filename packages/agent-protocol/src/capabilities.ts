/**
 * Capability probing — the mechanism that resolves version skew.
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
 * The first draft declared `maxEventBytes` with no default and no
 * nesting/element limit. pi-protocol sets all three explicitly (16 MiB /
 * 1,000,000 / 64) and validates a declared frame length BEFORE buffering its
 * bytes; that ordering is adopted here in framing.ts.
 */

import type { ProtocolVersion } from './version.js';
import type { ErrorCode } from './errors.js';
import type { ResumeSupport } from './resume.js';
import type { PermissionAction } from './permission.js';
import type { EventType } from './events/registry.js';

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
    /**
     * Who owns the permission expiry clock.
     *
     * `runtime` means exactly one thing: the runtime mints `expiresAt` AND runs
     * the timer, so the deadline a host sees and the deadline the runtime
     * enforces are the same number. The legacy wire let the agent mint the
     * value while the worker set the timer, which is two clocks that can
     * disagree.
     *
     * `absent` means there is no clock. It is a legal advertisement and it is
     * the honest one today: there is no permission timer anywhere in the agent.
     * A runtime that emits `permission.requested` with an `expiresAt` while
     * advertising `absent` is lying, and `assertCapabilityConsistency` is what
     * catches it.
     */
    readonly permissionExpiryClock: 'runtime' | 'absent';
  };
  readonly events: {
    /** Oldest `seq` the runtime can still replay. A resume below this is refused
     *  — see `ResumeSupport`, which is why this is a seq and not a count. */
    readonly oldestAvailableSeq: number;
    /** Highest `seq` minted so far. */
    readonly latestSeq: number;
    /**
     * All three durability buckets, and all three are REQUIRED.
     *
     * An earlier draft carried `durable` and `ephemeral` but no `volatile`,
     * which meant the eleven volatile events a host genuinely receives —
     * `run.paused`, `tool.progress`, `tool.call_preview`, `assistant.status`,
     * `compaction.step` and the rest — were never declared anywhere in the
     * handshake. That directly contradicted the stated purpose of this field
     * ("lets a host enumerate what it will actually see"): a host could not
     * enumerate eleven of the events it was about to be sent.
     *
     * It also made `assertCapabilityConsistency` unable to fire, because the
     * `tool.call_preview` check read `events.ephemeral` for an event the
     * registry classifies as volatile. The guard against lying about
     * `tool_preview` was structurally dead.
     */
    readonly durable: readonly EventType[];
    readonly volatile: readonly EventType[];
    readonly ephemeral: readonly EventType[];
  };
  readonly permissions: {
    readonly actions: readonly PermissionAction[];
    readonly defaultTimeoutMs: number;
    readonly maxTimeoutMs: number;
  };
  /**
   * What the runtime CAN do, not what this run IS configured to do.
   *
   * Deliberately no `connectionId` anywhere in here. A `ConnectorBinding` names
   * a specific user's connection, which belongs to the Agent Profile or the
   * RunManifest; a capability probe runs before any profile is chosen, and
   * echoing per-user connection ids back to a host is a small information leak
   * with no upside. What belongs here is the set of connector *providers* the
   * runtime can speak to.
   */
  readonly catalog: {
    readonly profiles: readonly string[];
    readonly modes: readonly string[];
    readonly tools: readonly string[];
    readonly connectorProviders: readonly string[];
  };
  readonly transports: readonly TransportKind[];
  /** The single source of truth for size limits. `run` carries behaviour, not numbers. */
  readonly limits: ProtocolLimits;
  /** Lets a host enumerate what it will actually see, so a mismatch is
   *  diagnosable rather than mysterious. */
  readonly eventTypes: readonly EventType[];
}

// ── requirement shape ─────────────────────────────────────────────────────

export interface CapabilityRequirement {
  /** How many `seq` of replay history the host needs. Checked against the depth
   *  the runtime advertises, never against an absolute sequence number. */
  readonly needsReplayDepth?: number;
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

  if (requirement.needsReplayDepth !== undefined) {
    // Depth, not a count of seqs: the runtime advertises the range it holds,
    // so the only meaningful question is how many seqs of history it can serve.
    const depth = Math.max(0, capabilities.events.latestSeq - capabilities.events.oldestAvailableSeq + 1);
    if (depth < requirement.needsReplayDepth) {
      missing.push(`replayDepth>=${requirement.needsReplayDepth}`);
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
  if (requirement.needsMaxEventBytes !== undefined && capabilities.limits.maxEventBytes < requirement.needsMaxEventBytes) {
    missing.push(`limits.maxEventBytes>=${requirement.needsMaxEventBytes}`);
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

// ── self-consistency ───────────────────────────────────────────────────────

/**
 * A capability the runtime can PROVIDE, as distinct from what a host can
 * CONSUME (`ProtocolCapability` in version.ts).
 *
 * Kept separate on purpose. Mixing the two is the mistake that produces a
 * handshake where the runtime concludes a host can execute something because
 * the host offered to serve it.
 */
export const RUNTIME_CAPABILITIES = [
  /** A durable checkpoint repository exists and `checkpoint.saved` can be emitted. */
  'checkpoint_repository',
  /** The runtime owns the permission expiry clock. */
  'permission_coordinator',
  /** The executor can emit the provisional `tool.call_preview` before dispatch. */
  'tool_preview',
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface CapabilityConsistencyProblem {
  readonly field: string;
  readonly advertised: string;
  readonly required: string;
}

/**
 * Cross-check what a runtime advertises against what it actually provides.
 *
 * This exists because the alternative is a promise nobody keeps. Two real
 * examples from the current codebase:
 *
 *  - `resume.checkpointGeneration: true` with no checkpoint repository and no
 *    `checkpoint.saved` anywhere in the registry. A host would learn a
 *    generation exists only by being told a number to resume from.
 *  - `permissionExpiryClock: 'runtime'` with no coordinator. A host would render
 *    a deadline the runtime never enforces, and the request would sit open
 *    until the run ended.
 *
 * Both are "the type allows it, the code does not do it" gaps, and a probe is
 * the only place they can be caught before a host trusts them.
 */
export function assertCapabilityConsistency(
  capabilities: RuntimeCapabilities,
  provides: readonly RuntimeCapability[],
): readonly CapabilityConsistencyProblem[] {
  const problems: CapabilityConsistencyProblem[] = [];
  const has = (c: RuntimeCapability) => provides.includes(c);

  if (capabilities.run.resume.checkpointGeneration && !has('checkpoint_repository')) {
    problems.push({
      field: 'run.resume.checkpointGeneration',
      advertised: 'true',
      required: 'runtime capability `checkpoint_repository`',
    });
  }
  if (capabilities.run.permissionExpiryClock === 'runtime' && !has('permission_coordinator')) {
    problems.push({
      field: 'run.permissionExpiryClock',
      advertised: 'runtime',
      required: 'runtime capability `permission_coordinator`',
    });
  }
  // `tool.call_preview` is VOLATILE, not ephemeral (`EVENT_META` in
  // registry.ts). The earlier check read `events.ephemeral`, so it could never
  // be true and this guard never fired — the exact "promise nobody keeps" case
  // this function exists to catch, catching nothing.
  if (capabilities.events.volatile.includes('tool.call_preview') && !has('tool_preview')) {
    problems.push({
      field: 'events.volatile',
      advertised: "includes 'tool.call_preview'",
      required: 'runtime capability `tool_preview`',
    });
  }
  return problems;
}
