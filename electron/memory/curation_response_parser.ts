/**
 * Curation response parser (Plan 417 Task C).
 *
 * Parses the JSON the curator LLM returns into a typed
 * `CurationResponse` with strict validation. The protocol:
 *
 *   {
 *     "decisions": [
 *       { "rollout_id": "<id>", "disposition": "absorbed" | "no_signal" | "uncertain", "reason": "..." }
 *     ],
 *     "actions": [
 *       { "op": "append" | "replace" | "no_op",
 *         "area_path": "global/areas/foo.md",
 *         "content": "...",
 *         "reason": "..." }
 *     ]
 *   }
 *
 * Parsing rules (grok's `NO_REPLY` style):
 *   - LLM may wrap JSON in a single ```json ... ``` code fence — strip it.
 *   - LLM may prefix a short preamble ("Here is the result:") — strip the
 *     first balanced JSON object it can find.
 *   - Failure to parse OR validate raises `CurationParseError`. The caller
 *     surfaces it as a failed run (don't retry, mark inputs as `uncertain`).
 *
 * The `area_path` regex enforces the canonical `global/{areas,people}/<slug>.md`
 * shape so the file writer can validate against path traversal without
 * re-implementing the rule.
 */

import { z } from 'zod';

import {
  POLICY_EDIT_OPTS,
  POLICY_RULE_ID_RE,
  POLICY_SECTION_RE,
  POLICY_SECTION_IDS,
  MAX_EDITS_PER_RUN,
  MAX_RULE_TEXT,
} from '../../packages/agent/src/memory-rollout/stage1_policy_editor';

export type CurationOp = 'append' | 'replace' | 'no_op';
export type CurationDisposition = 'absorbed' | 'no_signal' | 'uncertain';

export interface CurationAction {
  op: CurationOp;
  area_path: string;
  content: string;
  reason: string;
}

export interface CurationDecision {
  rollout_id: string;
  disposition: CurationDisposition;
  reason: string;
}

export type PolicyEditOp = 'upsert_rule' | 'remove_rule';

/**
 * One surgical policy edit (Plan 433). Targets a rule inside a fixed
 * section by its stable id — it never carries full policy text, so a
 * single curation run cannot rewrite the policy.
 */
export interface PolicyRuleEdit {
  op: PolicyEditOp;
  /** Fixed section id: S1..S9 (see POLICY_SECTION_DEFS). */
  section: string;
  /** Stable rule id, the `[r:<id>]` anchor inside the section. */
  rule_id: string;
  /** Full bullet text WITHOUT the `[r:<id>]` prefix. Required for upsert_rule. */
  text?: string;
  /** Why this rule changed. */
  reason?: string;
}

/**
 * Stage-1 policy suggestion emitted by the curator.
 *
 * `edit` carries a small list of surgical `upsert_rule` / `remove_rule`
 * edits applied deterministically by `applyPolicyEdits`. The old
 * full-content `update` shape was removed in Plan 433: it made every
 * curation run rewrite the whole policy from scratch, shaped by the
 * latest session only. `no_change` means leave the file alone.
 */
export interface Stage1PolicySuggestion {
  op: 'edit' | 'no_change';
  /** 1..MAX_EDITS_PER_RUN surgical edits. Required when op=edit. */
  edits?: PolicyRuleEdit[];
  /** Why the extraction focus changed. Required when op=edit. */
  reason?: string;
}

export interface CurationResponse {
  decisions: CurationDecision[];
  actions: CurationAction[];
  stage1_policy?: Stage1PolicySuggestion;
  /** At most one per run — new entity category proposal. */
  new_categories?: NewCategory[];
}

/**
 * Strict whitelist of writeable canonical paths. The three default entity
 * directories are `areas` (domain knowledge), `people` (person records),
 * and `preferences` (user preferences). A curator-proposed category
 * (`new_categories`) may add a fourth directory — validated separately
 * against this same shape (single lowercase word). Everything else folds
 * into one of the default buckets.
 */
const AREA_PATH_RE = /^global\/(areas|people|preferences|[a-z][a-z0-9-]{1,20})\/[a-z0-9][a-z0-9._-]*\.md$/;

/**
 * A curator-proposed new entity category (e.g. "lessons", "company").
 * Name must be a single lowercase word; the directory is created under
 * `global/` at write time. Evidence-gated: the system prompt requires
 * multiple-rollout evidence and at most one per run.
 */
export interface NewCategory {
  name: string;
  reason: string;
}

export const NewCategorySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, {
    message: 'category name must be one lowercase word (2-21 chars)',
  }),
  reason: z.string().min(10).max(500),
});

export const CurationActionSchema = z.object({
  op: z.enum(['append', 'replace', 'no_op']),
  area_path: z.string().regex(AREA_PATH_RE, {
    message: 'area_path must match global/{areas|people}/<slug>.md',
  }),
  content: z.string().default(''),
  reason: z.string().min(1).max(500),
}).refine(
  (a) => a.op === 'no_op' || a.content.length > 0,
  { message: 'append/replace actions must include non-empty content' },
).refine(
  (a) => a.op === 'no_op' || a.content.length <= 50_000,
  { message: 'append/replace content exceeds 50000 chars (refuse and split)' },
);

export const CurationDecisionSchema = z.object({
  rollout_id: z.string().min(1),
  disposition: z.enum(['absorbed', 'no_signal', 'uncertain']),
  reason: z.string().min(1).max(500),
});

export const PolicyRuleEditSchema = z.object({
  op: z.enum(POLICY_EDIT_OPTS),
  section: z.string().regex(POLICY_SECTION_RE, {
    message: 'section must match S<n>',
  }).refine((s) => POLICY_SECTION_IDS.has(s), {
    message: 'section must be one of S1..S9',
  }),
  rule_id: z.string().regex(POLICY_RULE_ID_RE, {
    message: 'rule_id must be kebab-case, <=40 chars',
  }),
  text: z.string().max(MAX_RULE_TEXT).optional(),
  reason: z.string().max(200).optional(),
}).refine(
  (e) => e.op === 'remove_rule' || (typeof e.text === 'string' && e.text.trim().length > 0),
  { message: 'upsert_rule requires non-empty text' },
);

export const Stage1PolicySchema = z.object({
  op: z.enum(['edit', 'no_change']),
  edits: z.array(PolicyRuleEditSchema).min(1).max(MAX_EDITS_PER_RUN).optional(),
  reason: z.string().max(500).optional(),
}).refine(
  (s) => s.op === 'no_change' || (Array.isArray(s.edits) && s.edits.length >= 1),
  { message: 'stage1_policy.edit requires at least one edit' },
).refine(
  (s) => s.op === 'no_change' || (typeof s.reason === 'string' && s.reason.trim().length > 0),
  { message: 'stage1_policy.edit requires a reason' },
);

export const CurationResponseSchema = z.object({
  decisions: z.array(CurationDecisionSchema).min(1).max(20),
  actions: z.array(CurationActionSchema).max(20),
  stage1_policy: Stage1PolicySchema.optional(),
  new_categories: z.array(NewCategorySchema).max(1).optional(),
});

export class CurationParseError extends Error {
  readonly raw: string;
  readonly issues: ReadonlyArray<string>;

  constructor(message: string, raw: string, issues: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'CurationParseError';
    this.raw = raw;
    this.issues = issues;
  }
}

/**
 * Extract the first balanced JSON object from arbitrary text.
 *
 * Handles:
 *   - bare JSON: `{"actions": [...]}`
 *   - markdown fence: ```json\n{...}\n```
 *   - preamble + JSON: `Here is the curation result:\n{...}`
 *
 * Returns the substring from the first `{` to its matching `}` or `null`
 * when no balanced object exists. Does not respect JSON strings containing
 * braces (curator prompts forbid them), but does tolerate escaped quotes
 * inside string values via a simple regex.
 */
export function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  // Strip a single ```json ... ``` fence if present.
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenced) return fenced[1].trim();

  // Otherwise find the first '{' and walk to its matching '}'.
  const start = trimmed.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the LLM's raw response text into a typed `CurationResponse`.
 * Throws `CurationParseError` on failure; never returns a partial result.
 */
export function parseCurationResponse(raw: string): CurationResponse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CurationParseError('empty response', raw);
  }

  const candidate = extractFirstJsonObject(trimmed);
  if (candidate === null) {
    throw new CurationParseError(
      'no JSON object found in response',
      raw,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new CurationParseError(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }

  const result = CurationResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new CurationParseError(
      'response failed schema validation',
      raw,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }

  return result.data as CurationResponse;
}