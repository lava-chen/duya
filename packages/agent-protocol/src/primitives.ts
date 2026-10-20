/**
 * Primitive scalar types shared by every part of the protocol.
 *
 * The `Millis` / `RunId` / `SessionId` aliases exist for one reason: they make
 * unit confusion a TYPE error rather than a comment. A `seq` is a number, an
 * epoch-ms timestamp is a number, and a byte budget is a number — three
 * different clocks that get confused when they share a bare `number`. Naming
 * them costs nothing at runtime (they are erased) and turns several classes of
 * bug into compile errors.
 */

import type { JsonValue } from './hash.js';

export type { JsonValue, JsonObject } from './hash.js';

/** Epoch milliseconds. Never seconds, never a monotonic clock. */
export type Millis = number;

/** Wall-clock milliseconds, but the sender may substitute a virtual clock
 *  when `RunManifest.deterministic` is set. */
export type EventTimestamp = Millis;

export type RunId = string;
export type SessionId = string;
export type TurnId = string;
export type RequestId = string;
export type ToolCallId = string;
export type CompactionId = string;
export type SubagentId = string;
export type TraceId = string;
export type SpanId = string;
export type ProjectId = string;
export type WorkspaceId = string;
export type GoalId = string;
export type TaskId = string;
export type AgentProfileId = string;
export type ProviderId = string;

/** Opaque host-minted id. Prefix identifies the minting authority. */
export type HostId = string;

export interface TraceContext {
  readonly traceId: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
}

/** A source of permission rules, flattened for the wire. */
export type PermissionRuleSource =
  | 'workspace'
  | 'project'
  | 'settings'
  | 'session'
  | 'cli'
  | 'runtime';

/** How the run as a whole is configured. Distinct from `PermissionRequestMode`,
 *  which describes one request's interactive situation. */
export type PermissionPolicyMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk';

/**
 * Every policy mode, in one place.
 *
 * A closed list is what lets a boundary REJECT an unknown mode instead of
 * storing it: a mode the Host does not recognise is a request it cannot
 * honour, and honouring it by falling back to a default is the silent
 * substitution this package exists to prevent.
 */
export const PERMISSION_POLICY_MODES: readonly PermissionPolicyMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
];

/** Narrow an unknown value to a policy mode, or refuse it. */
export function isPermissionPolicyMode(value: unknown): value is PermissionPolicyMode {
  return typeof value === 'string' && (PERMISSION_POLICY_MODES as readonly string[]).includes(value);
}

/**
 * How permissive each policy mode is, least first.
 *
 * The order is the product's, not a guess: `plan` is read-only planning;
 * `default` asks; `acceptEdits` answers the edit tier without asking;
 * `dontAsk` never asks but keeps the tools' own safety checks; and
 * `bypassPermissions` never asks and skips them too (the policy module's
 * `isBypassMode` treats the last two as bypass, and only
 * `bypassPermissions` additionally drops the internal path checks).
 *
 * It exists so a delegated run can be held to its parent's policy: a child
 * may ask for a NARROWER mode than the run that spawned it, and never a
 * wider one. Without an order that rule cannot be stated, and a rule that
 * cannot be stated is a rule that is not enforced.
 */
export const PERMISSION_POLICY_MODE_PERMISSIVENESS: Readonly<Record<PermissionPolicyMode, number>> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  dontAsk: 3,
  bypassPermissions: 4,
};

/** The narrower of two policy modes. Ties resolve to the first argument. */
export function lessPermissivePermissionMode(
  requested: PermissionPolicyMode,
  ceiling: PermissionPolicyMode,
): PermissionPolicyMode {
  return PERMISSION_POLICY_MODE_PERMISSIVENESS[requested] <= PERMISSION_POLICY_MODE_PERMISSIVENESS[ceiling]
    ? requested
    : ceiling;
}

/**
 * Permission rules keyed by source, in a form that survives JSON.
 *
 * The in-repo `ToolPermissionRulesBySource` is already `{ [source]?: string[] }`
 * and is wire-safe as written. The sibling `ToolPermissionContext` is not: its
 * `additionalWorkingDirectories` is a `ReadonlyMap`, and a `Map` serialises to
 * `{}`. The protocol names the safe shape explicitly so adapters convert at
 * the boundary instead of inheriting whichever shape they happened to be handed.
 */
export type PermissionRulesWire = Readonly<Record<PermissionRuleSource, readonly string[]>>;

export interface ConnectorBinding {
  readonly provider: string;
  readonly connectionId: string;
  readonly pluginId?: string;
}

/** Env reference for a run. Never inline credentials. */
export interface EnvReference {
  /** Opaque handle resolved by the Control Plane's secret resolver. */
  readonly ref: string;
  /** Digest of the resolved env, so drift is detectable without the value. */
  readonly hash: string;
}

export interface RunBudget {
  readonly maxTurns?: number;
  readonly maxWallClockMs?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
}

/** Anything JSON-parseable that is safe to place in `details`.
 *
 *  pi-protocol's README states "Validation errors do not retain rejected
 *  payloads", and credentials are forbidden both in the manifest and on the
 *  wire. Together those mean `details` is for DIAGNOSTIC FACTS
 *  (counts, durations, capability names) and must never carry the offending
 *  payload, a header, or a token. `test/12-no-secret-in-manifest.test.ts`
 *  pins the rule for the manifest; this comment is the same rule for errors. */
export type DiagnosticDetail = JsonValue;
