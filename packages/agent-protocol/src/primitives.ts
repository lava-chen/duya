/**
 * Primitive scalar types shared by every part of the protocol.
 *
 * Design source: 07-agent-protocol-spec.md §2.
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

export type PermissionModeName =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk';

/** A resolved tool permission table, flattened from `ReadonlyMap` to `Record`.
 *
 *  07 §3.1: the in-repo `ToolPermissionRulesBySource` holds three
 *  `ReadonlyMap`s and cannot cross a JSON boundary. The protocol flattens it
 *  here so the flattening is explicit and testable rather than accidental. */
export type PermissionRulesWire = Readonly<Record<PermissionRuleSource, readonly string[]>>;

export interface ConnectorBinding {
  readonly provider: string;
  readonly connectionId: string;
  readonly pluginId?: string;
}

/** Env reference for a run. NEVER inline credentials — see 07 §3.1 and §14. */
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
 *  payloads"; 07 §3 forbids credentials in the manifest and §14 forbids secrets
 *  on the wire. Together those mean `details` is for DIAGNOSTIC FACTS
 *  (counts, durations, capability names) and must never carry the offending
 *  payload, a header, or a token. `test/12-no-secret-in-manifest.test.ts`
 *  pins the rule for the manifest; this comment is the same rule for errors. */
export type DiagnosticDetail = JsonValue;
