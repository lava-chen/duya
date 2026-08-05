/**
 * Stage 1 prompt canary (Plan 405, design §5.3–5.4).
 *
 * Prompt edits are decoupled from memory publication. The curator may edit
 * memory files AND propose a policy change in the same run; the memory edits
 * publish normally, the policy proposal enters an async canary pipeline.
 *
 * Flow:
 *   1. Curator writes `memory-config/policy_proposals/<id>.candidate.md`
 *   2. `runCanary` replays fixed transcript fixtures through Stage 1 with the
 *      candidate policy + hard contract, computes metrics against ground truth
 *   3. If all metrics pass, `promotePolicy` atomically renames the candidate
 *      to `stage1_policy.md` + bumps the version sidecar
 *   4. If any metric fails, the candidate is discarded; last-known-good stays
 *
 * Canary failure does NOT block the memory publication that accompanied the
 * proposal. The two are independent.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AIClient } from '@duya/ai';
import { parseAndValidate } from '../../packages/agent/src/memory-rollout/extractor.js';
import { STAGE1_USER_PROMPT_TEMPLATE } from '../../packages/agent/src/memory-rollout/prompt.js';
import { assembleStage1Prompt } from '../../packages/agent/src/memory-rollout/stage1_prompt_loader.js';
import type { Message, SSEEvent } from '../../packages/agent/src/types.js';

// ---------------------------------------------------------------------------
// CanaryFixture type (§5.4)
// ---------------------------------------------------------------------------

export interface CanaryFixture {
  fixture_id: string;
  transcript: string;
  /** canonical_keys that MUST appear in the extracted output. */
  expected_required_keys: string[];
  /** canonical_keys that MUST NOT appear. */
  forbidden_keys: string[];
  /** true if "no items extracted" is acceptable for this fixture. */
  allowed_empty: boolean;
  /** per-canonical_key expected scope. */
  expected_scope: Record<string, string>;
  /** per-canonical_key expected claim_type. */
  expected_kind: Record<string, string>;
  /** structural rule description that must hold. */
  schema_invariant: string;
}

// ---------------------------------------------------------------------------
// loadFixtures
// ---------------------------------------------------------------------------

/**
 * Load canary fixtures from a directory. Each `.json` file is parsed as a
 * `CanaryFixture`; files that fail to parse are skipped (not fatal — a broken
 * fixture should not block the whole canary).
 *
 * @param fixturesDir absolute path to `memory-config/.canary/fixtures/`
 * @returns array of valid fixtures; empty array if the directory does not
 *   exist or contains no parseable fixture files.
 */
export async function loadFixtures(fixturesDir: string): Promise<CanaryFixture[]> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(fixturesDir);
  } catch {
    return [];
  }

  const fixtures: CanaryFixture[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(fixturesDir, entry);
    try {
      const raw = await fsPromises.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CanaryFixture>;
      if (
        typeof parsed.fixture_id === 'string' &&
        typeof parsed.transcript === 'string' &&
        Array.isArray(parsed.expected_required_keys) &&
        Array.isArray(parsed.forbidden_keys) &&
        typeof parsed.allowed_empty === 'boolean'
      ) {
        fixtures.push({
          fixture_id: parsed.fixture_id,
          transcript: parsed.transcript,
          expected_required_keys: parsed.expected_required_keys,
          forbidden_keys: parsed.forbidden_keys,
          allowed_empty: parsed.allowed_empty,
          expected_scope: parsed.expected_scope ?? {},
          expected_kind: parsed.expected_kind ?? {},
          schema_invariant: parsed.schema_invariant ?? '',
        });
      }
    } catch {
      // skip unparseable fixture files
    }
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// CanaryResult
// ---------------------------------------------------------------------------

export interface CanaryMetrics {
  /** Fraction of fixtures whose LLM output parsed as valid Stage 1 JSON. */
  schemaSuccessRate: number;
  /** Required-keys recall across all fixtures (1.0 = all required keys present). */
  requiredKeysRecall: number;
  /** Forbidden-keys precision across all fixtures (1.0 = no forbidden keys appeared). */
  forbiddenKeysPrecision: number;
}

export interface CanaryResult {
  passed: boolean;
  metrics: CanaryMetrics;
  failures: string[];
}

export interface RunCanaryOptions {
  candidatePolicy: string;
  fixtures: CanaryFixture[];
  llmClient: AIClient;
  hardContract: string;
}

/**
 * Run the canary: replay each fixture's transcript through Stage 1 using the
 * candidate policy + hard contract, then compute metrics against ground truth.
 *
 * passed = schema success rate = 1.0 AND required_keys recall = 1.0 AND
 * forbidden_keys precision = 1.0 across ALL fixtures.
 */
export async function runCanary(opts: RunCanaryOptions): Promise<CanaryResult> {
  const { candidatePolicy, fixtures, llmClient, hardContract } = opts;
  const systemPrompt = assembleStage1Prompt(candidatePolicy);

  const failures: string[] = [];
  let schemaSuccessCount = 0;
  let totalRequiredKeys = 0;
  let matchedRequiredKeys = 0;
  let totalExtractedKeys = 0;
  let forbiddenHits = 0;

  for (const fixture of fixtures) {
    // Build the user prompt: no existing_keys section (canary is standalone),
    // transcript is the fixture's frozen content.
    const userContent = STAGE1_USER_PROMPT_TEMPLATE
      .replace('{{existing_keys}}', '')
      .replace('{{compacted}}', fixture.transcript);
    const userMessage: Message = { role: 'user', content: userContent };

    let responseText = '';
    try {
      const generator = llmClient.streamChat([userMessage], { systemPrompt, maxTokens: 8192 });
      const chunks: string[] = [];
      for await (const event of generator as AsyncGenerator<SSEEvent>) {
        if (event.type === 'text' || event.type === 'text_delta') {
          chunks.push(event.data);
        } else if (event.type === 'error') {
          throw new Error(event.data);
        }
      }
      responseText = chunks.join('');
    } catch (err) {
      failures.push(`fixture ${fixture.fixture_id}: LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Schema validation.
    const parsed = parseAndValidate(responseText);
    if (!parsed.valid) {
      failures.push(`fixture ${fixture.fixture_id}: schema failure — ${parsed.error}`);
      continue;
    }
    schemaSuccessCount++;

    const extractedKeys = (parsed.result.raw_memory?.items ?? [])
      .map((item: { canonical_key?: string }) => item.canonical_key ?? '')
      .filter((k: string) => k.length > 0);
    totalExtractedKeys += extractedKeys.length;

    // Required keys recall.
    for (const requiredKey of fixture.expected_required_keys) {
      totalRequiredKeys++;
      if (extractedKeys.includes(requiredKey)) {
        matchedRequiredKeys++;
      } else {
        failures.push(`fixture ${fixture.fixture_id}: missing required key "${requiredKey}"`);
      }
    }

    // Forbidden keys precision.
    for (const forbiddenKey of fixture.forbidden_keys) {
      if (extractedKeys.includes(forbiddenKey)) {
        forbiddenHits++;
        failures.push(`fixture ${fixture.fixture_id}: forbidden key "${forbiddenKey}" appeared`);
      }
    }

    // allowed_empty check: if not allowed_empty and items is empty, that's a failure
    // (unless there are no required keys — then empty is acceptable).
    if (!fixture.allowed_empty && fixture.expected_required_keys.length > 0 && extractedKeys.length === 0) {
      // already covered by required-keys recall above; no extra failure needed
    }
  }

  const schemaSuccessRate = fixtures.length === 0 ? 1.0 : schemaSuccessCount / fixtures.length;
  const requiredKeysRecall = totalRequiredKeys === 0 ? 1.0 : matchedRequiredKeys / totalRequiredKeys;
  const forbiddenKeysPrecision = totalExtractedKeys === 0
    ? 1.0
    : (totalExtractedKeys - forbiddenHits) / totalExtractedKeys;

  const passed =
    schemaSuccessRate === 1.0 &&
    requiredKeysRecall === 1.0 &&
    forbiddenKeysPrecision === 1.0 &&
    failures.length === 0;

  return {
    passed,
    metrics: { schemaSuccessRate, requiredKeysRecall, forbiddenKeysPrecision },
    failures,
  };
}

// ---------------------------------------------------------------------------
// promotePolicy
// ---------------------------------------------------------------------------

export interface PromotePolicyOptions {
  /** Path to the candidate proposal file (e.g. policy_proposals/prop-001.candidate.md). */
  proposalPath: string;
  /** Path to the live policy file (e.g. memory-config/stage1_policy.md). */
  livePolicyPath: string;
  fixtures: CanaryFixture[];
  llmClient: AIClient;
  hardContract: string;
}

export interface PromotePolicyResult {
  promoted: boolean;
  result: CanaryResult;
}

/**
 * Promote a candidate policy through the canary.
 *
 * 1. Read candidate content from proposalPath.
 * 2. runCanary(candidatePolicy, fixtures, ...).
 * 3. If passed:
 *    - Write candidate content to livePolicyPath (atomic: write .tmp then rename).
 *    - Read current version sidecar; bump by 1; write new version sidecar.
 *    - Delete the proposal file.
 *    - Return promoted=true.
 * 4. If failed:
 *    - Delete the proposal file.
 *    - Return promoted=false.
 *
 * The live policy swap is atomic at the filesystem level (rename). The version
 * sidecar write is best-effort after the content swap — a crash between the
 * two leaves the version stale by 1, which is recoverable on next promote.
 */
export async function promotePolicy(opts: PromotePolicyOptions): Promise<PromotePolicyResult> {
  const { proposalPath, livePolicyPath, fixtures, llmClient, hardContract } = opts;

  let candidateContent: string;
  try {
    candidateContent = await fsPromises.readFile(proposalPath, 'utf8');
  } catch {
    // Proposal missing — nothing to promote.
    return {
      promoted: false,
      result: {
        passed: false,
        metrics: { schemaSuccessRate: 0, requiredKeysRecall: 0, forbiddenKeysPrecision: 0 },
        failures: ['proposal file not readable or missing'],
      },
    };
  }

  const canaryResult = await runCanary({
    candidatePolicy: candidateContent,
    fixtures,
    llmClient,
    hardContract,
  });

  if (!canaryResult.passed) {
    // Discard the proposal; last-known-good stays.
    try { await fsPromises.unlink(proposalPath); } catch { /* best-effort */ }
    return { promoted: false, result: canaryResult };
  }

  // Read current version (default 0 if sidecar missing).
  const versionPath = `${livePolicyPath}.version`;
  let currentVersion = 0;
  try {
    const raw = await fsPromises.readFile(versionPath, 'utf8');
    const parsed = parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) currentVersion = parsed;
  } catch { /* no sidecar yet — start at 0 */ }

  const newVersion = currentVersion + 1;

  // Atomic content swap: write .tmp then rename.
  const tmpPath = `${livePolicyPath}.tmp`;
  await fsPromises.writeFile(tmpPath, candidateContent, 'utf8');
  await fsPromises.rename(tmpPath, livePolicyPath);

  // Bump version sidecar.
  await fsPromises.writeFile(versionPath, String(newVersion), 'utf8');

  // Remove the proposal.
  try { await fsPromises.unlink(proposalPath); } catch { /* best-effort */ }

  return { promoted: true, result: canaryResult };
}

// ---------------------------------------------------------------------------
// triggerPostCurationCanary — orchestrator integration (§5.3)
// ---------------------------------------------------------------------------

export interface TriggerCanaryOptions {
  /** Path to memory-config/ (holds policy_proposals/ + stage1_policy.md). */
  configRoot: string;
  /** Path to the fixtures directory (memory-config/.canary/fixtures/). */
  fixturesDir: string;
  /** Path to the live policy file (memory-config/stage1_policy.md). */
  livePolicyPath: string;
  llmClient: AIClient;
  hardContract: string;
}

/**
 * Post-curation canary trigger. Called after a curation run completes (non-
 * blocking from the publication pipeline's perspective — the caller invokes
 * this and awaits it, but it does not gate memory publication).
 *
 * Scans `configRoot/policy_proposals/` for `*.candidate.md` files. For each:
 *   - Load fixtures from fixturesDir.
 *   - Call promotePolicy (canary + atomic swap if passed, discard if failed).
 *
 * Returns one PromotePolicyResult per proposal. If no proposals exist or the
 * proposals directory is missing, returns an empty array without throwing.
 *
 * Multiple proposals are processed sequentially; each promotion that passes
 * overwrites the live policy and bumps the version. The last passing
 * proposal wins.
 */
export async function triggerPostCurationCanary(opts: TriggerCanaryOptions): Promise<PromotePolicyResult[]> {
  const { configRoot, fixturesDir, livePolicyPath, llmClient, hardContract } = opts;
  const proposalsDir = path.join(configRoot, 'policy_proposals');

  let entries: string[];
  try {
    entries = await fsPromises.readdir(proposalsDir);
  } catch {
    return []; // proposals dir missing — nothing to do
  }

  const candidateFiles = entries.filter((f) => f.endsWith('.candidate.md'));
  if (candidateFiles.length === 0) return [];

  const fixtures = await loadFixtures(fixturesDir);
  if (fixtures.length === 0) {
    // No fixtures to validate against — cannot run canary. Leave proposals in place.
    return [];
  }

  const results: PromotePolicyResult[] = [];
  for (const candidateFile of candidateFiles) {
    const proposalPath = path.join(proposalsDir, candidateFile);
    const result = await promotePolicy({
      proposalPath,
      livePolicyPath,
      fixtures,
      llmClient,
      hardContract,
    });
    results.push(result);
  }
  return results;
}