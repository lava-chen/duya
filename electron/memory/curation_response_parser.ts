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

export interface CurationResponse {
  decisions: CurationDecision[];
  actions: CurationAction[];
}

/** Strict whitelist of writeable area paths. */
const AREA_PATH_RE = /^global\/(areas|people)\/[a-z0-9][a-z0-9._-]*\.md$/;

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

export const CurationResponseSchema = z.object({
  decisions: z.array(CurationDecisionSchema).min(1).max(20),
  actions: z.array(CurationActionSchema).max(20),
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