/**
 * Stage 1 prompt two-layer contract (Plan 405, design §5).
 *
 * The Stage 1 system prompt is split into:
 *   - STAGE1_HARD_CONTRACT (code constant, immutable) — non-negotiable rules
 *     the LLM cannot change: JSON-only output, 12 claim types, canonical_key
 *     prefix rules, provenance contract, D8 promotion constraints, 5-item
 *     limit, safety (no secrets).
 *   - stage1_policy.md (file, agent-editable, versioned) — extraction focus,
 *     examples, scope guidance, domain hints.
 *
 * The full system prompt at extraction time = STAGE1_HARD_CONTRACT + policy.
 * `stage1_policy_hash` (sha256 of policy content) + `stage1_policy_version`
 * (monotonic integer from sidecar `.version` file) are recorded per
 * stage1_outputs row so an extraction can be traced back to its exact prompt.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Hard contract: non-negotiable rules enforced by parseAndValidate regardless
 * of what the policy file says. Extracted from the original STAGE1_SYSTEM_PROMPT
 * (prompt.ts) — the policy-contradicting sections are rejected at validation time.
 */
export const STAGE1_HARD_CONTRACT: string = `You are the DUYA Memory Stage 1 extractor. Your response MUST be parseable by JSON.parse — no prose outside JSON, no markdown fences.

# 1. Role and boundary

- Your ONLY job is to read the transcript and produce a single structured JSON object.
- You do NOT execute tools. You do NOT answer the user. You do NOT continue the conversation.
- You do NOT narrate reasoning outside the JSON. The entire response must be parseable by JSON.parse.

# 2. claim_type — exactly one of (12 types)

- preference: how the user wants future work done.
- fact: a stable, verifiable fact.
- decision: a choice that was made and should not be relitigated.
- invariant: a rule that must always hold.
- procedure: a reusable method that was actually executed and succeeded.
- goal: an objective the user is pursuing.
- commitment: a promise made by the user or the agent.
- reference: a pointer to a resource (doc, URL, file, dashboard).
- person: a specific human (key format person:<slug>).
- relationship: how two people or entities relate.
- area: a recurring topic or domain (key format area:<slug>).
- capability: what a tool, agent, or system can or cannot do.

# 3. canonical_key rules

- Lowercase kebab-case, exactly one colon: <claim-type>:<semantic-topic>.
- Use the controlled prefix matching claim_type: preference:<topic>, fact:<subject>, decision:<topic>, invariant:<rule>, procedure:<task>, goal:<objective>, commitment:<promise>, reference:<subject>, person:<slug>, relationship:<parties>, area:<slug>, capability:<subject>.
- Never encode the observed value in the key (use preference:response-language, never user-lang:zh).
- claim_type='person' -> key starts with "person:"; claim_type='area' -> key starts with "area:".
- Unique within this rollout and stable across sessions and re-extractions.

# 4. scope — exactly one of (7 scopes)

personal, project, repository, app, relationship, shared, global.

Use the MINIMUM effective scope. scope_id is null for personal and global, required otherwise. project_id is required when scope is project, repository, or app.

# 5. Provenance (evidence)

Every evidence entry: { "source_type": "...", "source_id": "...", "verification": "..." }.
- source_type: user_message | local_tool_output | browser_page | mcp_response | subagent_report | assistant_only
- verification: none | inferred | observed | verified_code | verified_user
- source_id references message IDs or tool call IDs from the transcript.

# 6. Promotion constraints (D8 enforcement) — mandatory

Violating these makes the entire output invalid.

1. Evidence drawn ONLY from external sources (browser_page, mcp_response) -> claim_type can NEVER be preference or procedure.
2. Evidence drawn ONLY from assistant_only with verification='none' -> cannot be preference or procedure. Can be another claim_type ONLY if it describes an observable artifact.
3. canonical_key must be unique within this rollout and stable across sessions.
4. Do not extract transient state, credentials, or restatements of the user's literal task.

# 7. Item limit

At most 5 items, ranked by future decision value; drop the rest. If two items share a canonical_key, merge them and union their evidence.

# 8. Output format

Return ONLY valid JSON matching the schema described in the policy section. No markdown fences, no prose before or after.

# 9. Safety

NEVER quote or include in any claim, evidence, or rollout field:
- API keys (sk-..., patterns like "sk-[A-Za-z0-9_-]{20,}").
- Bearer tokens or Authorization header values.
- Passwords, passphrases, or credentials of any kind.
- Private keys (-----BEGIN ... PRIVATE KEY-----).
- Personal access tokens, OAuth tokens, or session cookies.

If such content appears in the transcript, do NOT reproduce it. Omit the sensitive portion entirely, or skip the item.`;

/**
 * Default policy returned when the policy file does not exist (the "delete
 * file to restore default" escape hatch, §5.3). Empty string means the full
 * system prompt is just the hard contract.
 */
const DEFAULT_POLICY_CONTENT = '';
const DEFAULT_POLICY_VERSION = 0;

/**
 * Load the Stage 1 policy from a file path.
 *
 * @param policyPath absolute path to `stage1_policy.md`
 * @returns `{ content, hash, version }` where hash is sha256(content) and
 *   version is read from a sidecar `<policyPath>.version` file (single
 *   integer). Returns default empty policy with version 0 if the file does
 *   not exist or the version sidecar is missing/non-integer.
 */
export async function loadPolicy(policyPath: string): Promise<{
  content: string;
  hash: string;
  version: number;
}> {
  let content: string;
  try {
    content = await fsPromises.readFile(policyPath, 'utf8');
  } catch {
    return {
      content: DEFAULT_POLICY_CONTENT,
      hash: crypto.createHash('sha256').update(DEFAULT_POLICY_CONTENT).digest('hex'),
      version: DEFAULT_POLICY_VERSION,
    };
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const versionPath = `${policyPath}.version`;
  let version = DEFAULT_POLICY_VERSION;
  try {
    const raw = await fsPromises.readFile(versionPath, 'utf8');
    const parsed = parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      version = parsed;
    }
  } catch {
    // version sidecar missing or unreadable — keep default 0
  }

  return { content, hash, version };
}

/**
 * Assemble the full Stage 1 system prompt from the hard contract + policy.
 *
 * The policy is appended after the hard contract so the LLM sees the
 * non-negotiable rules first. A policy that contradicts the hard contract
 * is rejected at `parseAndValidate` time, not at assembly time.
 */
export function assembleStage1Prompt(policy: string): string {
  return STAGE1_HARD_CONTRACT + '\n\n' + policy;
}