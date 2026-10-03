/**
 * RunManifest — the complete, immutable description of one run.
 *
 * Every field is `readonly` at the type level, and drift test #11 checks it at
 * runtime by taking the fingerprint at `start` and re-verifying it at `resume`.
 * A rewritten manifest is `manifest_mismatch`, not a silently different run.
 *
 * ## Three fields the current code cannot supply
 *
 * These are declared because the protocol needs them, and flagged because they
 * are NOT yet backed by real data. Do not pretend otherwise when wiring a host.
 *
 *  1. `permissionPolicy.rules` is `PermissionRulesWire`. The in-repo
 *     `ToolPermissionRulesBySource` already matches that shape, but the
 *     `ToolPermissionContext` that carries it does not — its
 *     `additionalWorkingDirectories` is a `ReadonlyMap`, and a `Map`
 *     serialises to `{}`. Convert at the boundary; do not forward the context.
 *  2. `env` is `{ ref, hash }`, but credentials are still inlined in several
 *     places in the current code. **A Control Plane secret resolver must exist
 *     before this field means anything.**
 *  3. `budget` has no direct counterpart. The nearest thing is the
 *     `max_turns` agent setting.
 *
 * ## `runId` vs `WorkflowRunCommand.runId`
 *
 * These are DIFFERENT concepts. The chat path has never carried a `runId`;
 * worker events only carry `sessionId`, and `WorkflowRunCommand.runId` is a
 * workflow run, not an agent run. Conflating them is the easiest mistake to
 * make while migrating.
 */

import type {
  AgentProfileId,
  ConnectorBinding,
  EnvReference,
  GoalId,
  PermissionPolicyMode,
  PermissionRulesWire,
  ProjectId,
  ProviderId,
  RunBudget,
  RunId,
  TaskId,
  WorkspaceId,
} from './primitives.js';
import type { ResumeBoundary } from './resume.js';
import { canonicalJson, sha256Hex } from './hash.js';
import type { JsonValue } from './hash.js';

export interface PermissionPolicy {
  readonly mode: PermissionPolicyMode;
  /** permissions/types.ts:63 */
  readonly hostSwitch: 'ask' | 'always' | 'never';
  /** Default 300_000, matching the hardcoded value at
   *  agent-process-entry.ts:2240. */
  readonly defaultTimeoutMs: number;
  readonly rules?: PermissionRulesWire;
}

export interface RunAgentSelection {
  readonly profileId: AgentProfileId | null;
  readonly model: string;
  readonly providerId: ProviderId;
  readonly effort?: string;
}

export interface RunCheckpoint {
  readonly generation: number;
  readonly messageCount: number;
}

/**
 * The manifest fields that carry a configuration decision, and therefore carry
 * a {@link ManifestProvenance} entry.
 *
 * A CLOSED set on purpose. `RunManifest.provenance` is a
 * `Record<ManifestField, …>`, so a field added to `RunManifest` without one is
 * a compile error here rather than a silently unattributed value in the run
 * row — which is the failure the contract's §B "express the missing case as
 * unknown AND attributed" exists to prevent.
 */
export type ManifestField =
  | 'roots'
  | 'cwd'
  | 'permissionPolicy'
  | 'capabilities'
  | 'connectorBindings'
  | 'env'
  | 'agent'
  | 'budget'
  | 'workspaceId'
  | 'deterministic';

/**
 * Where a manifest value was read from.
 *
 * `unsupported` is the important one, and it is a first-class value rather
 * than an omission: it says "no configuration source for this exists yet", and
 * it is what lets the factory write an honest empty value instead of a
 * plausible-looking one. Before this existed, that distinction lived only in
 * a file header comment, which is no place a reader of a run row will ever
 * look.
 */
export type ManifestSource =
  /** The chat turn's own request. */
  | 'host_chat_request'
  /** Persisted per-session configuration. */
  | 'session_row'
  /** The project entity resolved from the cwd. */
  | 'project_binding'
  /** A fact about the runtime, not configuration. */
  | 'runtime_fact'
  /** Computed by the Control Plane from the sources above. */
  | 'derived'
  /** NO source exists. The value is a placeholder and is not configuration. */
  | 'unsupported';

export interface ManifestProvenance {
  readonly source: ManifestSource;
  /**
   * The version of that source, when it is versioned.
   *
   * Absent means "this source carries no version" — never "the version is
   * unknown but the value is fine". A caller that knows a version supplies it
   * through `RunIntent.sourceVersions`; the factory does not invent one.
   */
  readonly sourceVersion?: string;
  /**
   * True when the Control Plane supplied this value itself rather than reading
   * it from `source`.
   *
   * An invariant the factory maintains and the drift tests check: `source ===
   * 'unsupported'` implies `synthesised === true`. A value with no origin
   * that is not marked synthesised would be claiming to be a fact.
   */
  readonly synthesised: boolean;
}

export interface RunManifest {
  readonly version: 1;
  readonly runId: RunId;
  readonly projectId: ProjectId | null;
  readonly workspaceId: WorkspaceId;
  readonly goalId?: GoalId;
  readonly taskId?: TaskId;
  /** Absolute paths, ALREADY VALIDATED by the Control Plane. The protocol
   *  never resolves or checks a path; it only carries the decision. */
  readonly roots: readonly string[];
  readonly cwd: string;
  readonly permissionPolicy: PermissionPolicy;
  readonly capabilities: {
    readonly profiles: readonly string[];
    readonly modes: readonly string[];
    readonly tools: readonly string[];
  };
  /**
   * What this run cannot proceed without (plan 587 R2.2).
   *
   * The distinction this field exists for, and it is the difference between
   * refusing a run and degrading it:
   *
   *  - a capability named HERE and unavailable in the executor means the
   *    Control Plane has decided the run cannot do its job. The executor
   *    refuses. Substituting a near-equivalent capability is the silent
   *    substitution the plan forbids.
   *  - a capability named in `capabilities` and unavailable is version skew.
   *    `capabilities` is a SNAPSHOT OF WHAT THE CONTROL PLANE BELIEVES EXISTS,
   *    not a demand, so a missing one is recorded and the run continues.
   *
   * Absent means the run demands nothing by name, which is legal and common:
   * most turns need nothing beyond the configuration the manifest already
   * carries.
   */
  readonly requiredCapabilities?: readonly string[];
  readonly connectorBindings: readonly ConnectorBinding[];
  /** NO SECRETS. See the header note. */
  readonly env: EnvReference;
  readonly agent?: RunAgentSelection;
  readonly checkpoint?: RunCheckpoint;
  readonly budget: RunBudget;
  readonly deterministic: boolean;
  readonly parentRunId?: RunId;
  readonly resumeFrom?: ResumeBoundary;
  /**
   * Where each configuration value came from, and whether the Control Plane
   * supplied it (plan 587 R2.2).
   *
   * Required and closed, and hashed: the provenance is part of the
   * configuration the fingerprint attests to, so two runs resolved against
   * different source versions are two different runs and cannot share a hash.
   */
  readonly provenance: Readonly<Record<ManifestField, ManifestProvenance>>;
}

export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

/**
 * Fingerprint = sha256 of the canonical JSON.
 *
 * `canonicalJson` sorts object keys so the digest is a function of the VALUE,
 * not of the order the object was built in. Without that, two structurally
 * identical manifests would fingerprint differently and a legitimate resume
 * would be rejected.
 *
 * The digest is dependency-free (see hash.ts) because drift test #1 forbids
 * `node:*`, and `node:crypto` is the obvious way to do this and the one thing
 * that is forbidden.
 */
export function manifestFingerprint(manifest: RunManifest): string {
  return sha256Hex(canonicalJson(toWire(manifest)));
}

/** Strip undefined-valued optional keys so they do not affect the digest. */
function toWire(manifest: RunManifest): JsonValue {
  return JSON.parse(JSON.stringify(manifest)) as JsonValue;
}

export interface ManifestMismatch {
  readonly expected: string;
  readonly actual: string;
}

export function manifestsMatch(
  a: RunManifest,
  b: RunManifest,
): { ok: true } | ({ ok: false } & ManifestMismatch) {
  const expected = manifestFingerprint(a);
  const actual = manifestFingerprint(b);
  return expected === actual ? { ok: true } : { ok: false, expected, actual };
}
