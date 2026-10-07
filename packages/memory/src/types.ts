/**
 * Shared types for the structured rollout schema and expanded memory types.
 *
 * Single source of truth for:
 *   - the expanded claim-type and scope taxonomies,
 *   - the memory item lifecycle fields (confidence, status, validity window,
 *     supersession, retrieval cues),
 *   - the StructuredRollout object that replaces the flat Markdown
 *     rollout_summary,
 *   - the ActionStatus ladder that keeps 'proposed', 'executed',
 *     'tool_succeeded', 'state_changed', 'verified', and 'goal_met'
 *     strictly distinct, and
 *   - the ParsedExtraction contract consumed by the Stage 1 extractor.
 *
 * Provenance/evidence types (source_type, verification) are unchanged from
 * the v1 schema validated in extractor.ts.
 *
 * Each taxonomy is exported both as a readonly const array (for runtime
 * validation, mirroring the VALID_* sets in extractor.ts) and as a union
 * type derived from that array.
 */

// ---------------------------------------------------------------------------
// Claim type taxonomy
// ---------------------------------------------------------------------------

/**
 * Valid claim types. v1 set (preference, fact, reference, procedure, person,
 * area) expanded with decision, invariant, goal, commitment, relationship,
 * and capability.
 */
export const CLAIM_TYPES = [
  'preference',
  'fact',
  'decision',
  'invariant',
  'procedure',
  'goal',
  'commitment',
  'reference',
  'person',
  'relationship',
  'area',
  'capability',
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

// ---------------------------------------------------------------------------
// Scope taxonomy
// ---------------------------------------------------------------------------

/**
 * Valid scopes. Replaces the v1 single 'global' scope with a graduated
 * taxonomy from personal to global.
 */
export const SCOPES = [
  'personal',
  'project',
  'repository',
  'app',
  'relationship',
  'shared',
  'global',
] as const;

export type Scope = (typeof SCOPES)[number];

// ---------------------------------------------------------------------------
// Provenance / evidence (unchanged from v1)
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  'user_message',
  'local_tool_output',
  'browser_page',
  'mcp_response',
  'subagent_report',
  'assistant_only',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const VERIFICATION_LEVELS = [
  'none',
  'inferred',
  'observed',
  'verified_code',
  'verified_user',
] as const;

export type Verification = (typeof VERIFICATION_LEVELS)[number];

export interface Evidence {
  source_type: SourceType;
  source_id: string;
  verification?: Verification;
}

// ---------------------------------------------------------------------------
// Memory item lifecycle
// ---------------------------------------------------------------------------

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const MEMORY_STATUSES = ['active', 'superseded', 'retired', 'draft'] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * A candidate memory item emitted by the extractor. Carries the v1 identity
 * fields (claim, claim_type, scope, evidence, canonical_key) plus the
 * lifecycle fields that let the persistence layer reason about validity,
 * supersession, and retrieval.
 */
export interface MemoryItem {
  claim: string;
  claim_type: ClaimType;
  scope: Scope;
  /** Identifies the scope target (repo name, project slug, app name, or relationship pair). Null for personal and global scopes. */
  scope_id: string | null;
  evidence: Evidence[];
  canonical_key: string;
  confidence: Confidence;
  status: MemoryStatus;
  /** ISO-8601 date from which the claim holds; null when unknown or always valid. */
  valid_from: string | null;
  /** ISO-8601 date after which the claim no longer holds; null when open-ended. */
  valid_until: string | null;
  /** How this item relates to the existing memory with the same canonical_key. */
  relation_to_existing: string | null;
  /** canonical_keys this item replaces. */
  supersedes: string[];
  why_future_agent_needs_this: string;
  retrieval_cues: string[];
}

// ---------------------------------------------------------------------------
// Action status ladder
// ---------------------------------------------------------------------------

/**
 * Distinguishes states that must not be confused: a tool call succeeding is
 * not the same as the underlying state changing, and a state change is not
 * the same as the goal being verified and met.
 */
export const ACTION_STATUSES = [
  'proposed',
  'executed',
  'tool_succeeded',
  'state_changed',
  'verified',
  'goal_met',
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Structured rollout sub-types
// ---------------------------------------------------------------------------

/** Per-task outcome vocabulary, same as the v1 content_outcome values. */
export const TASK_OUTCOMES = ['success', 'partial', 'fail', 'uncertain'] as const;

export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export interface RolloutTask {
  goal: string;
  actions_taken: string[];
  tool_calls: string[];
  observable_results: string[];
  /** Overall task outcome. */
  status: TaskOutcome;
  /** Highest rung of the ActionStatus ladder actually reached for this task. */
  verification_status: ActionStatus;
}

export interface StateDelta {
  files_created: string[];
  files_modified: string[];
  files_deleted: string[];
  config_changes: string[];
  schema_changes: string[];
}

export interface Decision {
  decision: string;
  confirmed_by_user: boolean;
  evidence: Evidence[];
}

export interface Constraint {
  constraint: string;
  applies_to_scope: Scope;
  evidence: Evidence[];
}

export interface Failure {
  failure_mode: string;
  cause: string;
  evidence: Evidence[];
}

export const OPEN_LOOP_STATUSES = ['open', 'blocked', 'waiting', 'resolved'] as const;

export type OpenLoopStatus = (typeof OPEN_LOOP_STATUSES)[number];

export interface OpenLoop {
  description: string;
  status: OpenLoopStatus;
  blocked_by: string[];
  waiting_on: string[];
  next_action: string;
}

/** Party that made a commitment or suggested an action. */
export const ACTORS = ['user', 'agent'] as const;

export type Actor = (typeof ACTORS)[number];

export interface Commitment {
  description: string;
  made_by: Actor;
  due_context: string;
}

export interface SuggestedAction {
  description: string;
  rationale: string;
  suggested_by: Actor;
}

export const ACTIVATION_CONDITION_TYPES = ['event', 'time', 'state'] as const;

export type ActivationConditionType = (typeof ACTIVATION_CONDITION_TYPES)[number];

export interface ActivationCondition {
  condition_type: ActivationConditionType;
  description: string;
  trigger_details: string;
}

// ---------------------------------------------------------------------------
// Structured rollout
// ---------------------------------------------------------------------------

/**
 * Structured replacement for the flat Markdown rollout_summary. Captures the
 * session as machine-readable intent, tasks, state changes, decisions,
 * constraints, failures, open loops, commitments, and follow-up triggers.
 */
export interface StructuredRollout {
  user_intent: string;
  tasks: RolloutTask[];
  state_delta: StateDelta;
  decisions: Decision[];
  constraints: Constraint[];
  failures: Failure[];
  open_loops: OpenLoop[];
  commitments: Commitment[];
  suggested_next_actions: SuggestedAction[];
  activation_conditions: ActivationCondition[];
}

// ---------------------------------------------------------------------------
// Parsed extraction (Stage 1 LLM output contract)
// ---------------------------------------------------------------------------

export const JOB_STATUSES = ['succeeded', 'succeeded_no_output'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const CONTENT_OUTCOMES = ['success', 'partial', 'fail', 'uncertain'] as const;

export type ContentOutcome = (typeof CONTENT_OUTCOMES)[number];

/**
 * Validated Stage 1 extractor output. The rollout_summary is a Markdown
 * string produced directly by the LLM (not a structured JSON object).
 */
export interface ParsedExtraction {
  job_status: JobStatus;
  /** Required when job_status is 'succeeded'; null when 'succeeded_no_output'. */
  content_outcome: ContentOutcome | null;
  /** Markdown summary produced by the LLM; null when succeeded_no_output. */
  rollout_summary: string | null;
  rollout_slug: string;
  raw_memory: {
    items: MemoryItem[];
  };
}
