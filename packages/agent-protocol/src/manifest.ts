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
 *  1. `permissionPolicy.rules` CANNOT be the in-repo
 *     `ToolPermissionRulesBySource` — it holds three `ReadonlyMap`s
 *     (permissions/types.ts:427-434) and does not survive JSON. Use the
 *     flattened `PermissionRulesWire`.
 *  2. `env` is `{ ref, hash }`, but credentials are inlined in two places today
 *     (`worker-protocol.ts:7` and `types.ts:141,152,158`). **A Control Plane
 *     secret resolver must exist before this field means anything.**
 *  3. `budget` has no counterpart. The nearest thing is `maxTurns`
 *     (types.ts:289) plus the `agent.max_turns` setting.
 *
 * ## `runId` vs `WorkflowRunCommand.runId`
 *
 * These are DIFFERENT concepts. The chat path has never carried a `runId`;
 * worker events only carry `sessionId` (worker-protocol.ts:258), and
 * `WorkflowRunCommand.runId` (:218) is a workflow run, not an agent run.
 * Conflating them is the easiest mistake to make while migrating.
 */

import type {
  AgentProfileId,
  ConnectorBinding,
  EnvReference,
  GoalId,
  PermissionModeName,
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
  readonly mode: PermissionModeName;
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
  readonly connectorBindings: readonly ConnectorBinding[];
  /** NO SECRETS. See the header note. */
  readonly env: EnvReference;
  readonly agent?: RunAgentSelection;
  readonly checkpoint?: RunCheckpoint;
  readonly budget: RunBudget;
  readonly deterministic: boolean;
  readonly parentRunId?: RunId;
  readonly resumeFrom?: ResumeBoundary;
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
