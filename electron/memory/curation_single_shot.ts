/**
 * Curation single-shot orchestrator (Plan 417 Task A).
 *
 * Replaces the streaming `runCurationAgent` flow with one non-streaming
 * LLM call followed by deterministic file writes. The shape mirrors
 * grok-build's `execute_dream(lock, storage, response, ...)`:
 *
 *   1. Read each input rollout summary's file from disk.
 *   2. Read the relevant existing area file(s) (those matching each
 *      input's `rollout_slug`).
 *   3. Call `llmClient.chat()` with a curator system prompt and a JSON
 *      user prompt containing all of the above. No tools, no streaming.
 *   4. Parse the response via `parseCurationResponse` (Plan 417 Task C).
 *   5. Apply every `CurationAction` via `applyCurationActions`
 *      (Plan 417 Task D).
 *   6. Return `RunResult` with the parsed response + applied count.
 *
 * Why this fixes the bug: the streaming curator hung at Turn 5-7
 * because M3 emits a `result` SSE event (with usage) without
 * `message_stop`, leaving `for await ... streamChat` blocked
 * indefinitely. `chat()` collects the full response into a single
 * Promise; the SDK closes the request once `message_stop` is read
 * off the wire (or `stop_reason: end_turn` closes it anyway), so
 * the hang has no equivalent in this path.
 *
 * Inspired by:
 *   - grok-build/crates/codegen/xai-grok-memory/src/dream.rs:394
 *     (`execute_dream(lock, storage, response, ...)`)
 *   - hermes-agent/agent/memory_manager.py:547
 *     (`_external_prefetch_timeout` daemon-thread pattern)
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import type { AIClient } from '@duya/ai';

import { parseCurationResponse, CurationParseError } from './curation_response_parser';
import { applyCurationActions, resolveAreaPath, type ApplyResult } from './curation_file_writer';
import type { CurationResponse } from './curation_response_parser';

/**
 * Input shape — matches the rows `CurationInput[]` returned by
 * `queryEligibleInputs` in `packages/agent/src/memory-state/curation_ledger.ts`.
 */
export interface CurationInputForPrompt {
  inputKind: 'rollout' | 'ad_hoc';
  inputKey: string;
  contentHash: string;
  outputUpdatedAt: number;
  rolloutSlug?: string;
}

export interface SingleShotCurationOpts {
  /** Live memory root (e.g. ~/.duya/memory). Read + written directly. */
  memoryRoot: string;
  /** Inputs claimed for this run (from `curation_ledger.claimRun`). */
  inputs: ReadonlyArray<CurationInputForPrompt>;
  /** LLM client (chat() path; non-streaming). */
  llmClient: AIClient;
  /** Hard wall-clock budget for the LLM call (ms). Default 4 minutes. */
  timeoutMs?: number;
  /** Override the default curator system prompt (test hook). */
  systemPrompt?: string;
}

export interface RunResult {
  /** Whether every action was applied without I/O errors. */
  success: boolean;
  /** Parsed response, or `null` if the LLM call / parse failed. */
  response: CurationResponse | null;
  /** Raw assistant text (before parse), for diagnostics + replay. */
  rawResponse: string;
  /** Total wall-clock duration of the call + parse + apply phases. */
  durationMs: number;
  /** Count of `append` +`replace` operations that landed on disk. */
  actionsApplied: number;
  /** Per-action filesystem errors (empty on full success). */
  errors: ApplyResult['errors'];
  /** Top-level error if the LLM call / parse itself failed. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;

const CURATOR_SYSTEM_PROMPT = `\
You are the Memory Curator agent for the DUYA desktop client.

# Your duty

You receive 1-3 rollout summaries (plus the existing memory content for
their target areas) and decide what to persist. Your goal: turn each
rollout into the minimum set of stable, useful facts that future sessions
can rely on without re-reading the source.

# Decision boundary

For each rollout you MUST emit exactly one decision:
  - "absorbed": at least one non-trivial fact from this rollout was merged
    into an area file.
  - "no_signal": the rollout contains nothing worth persisting (chit-chat,
    test runs, ephemeral work, duplicates of existing memory).
  - "uncertain": you cannot decide safely; the next curation cycle will
    revisit it with a fresh prompt.

When you choose "absorbed", emit at least one action whose
"area_path" is the slugged area name and whose "content" is the section
to append. When you choose "no_signal" or "uncertain", you may emit zero
actions (use op="no_op") but you MUST still emit the decision.

# Hard rules

- Every action's "area_path" MUST match exactly one of the existing
  area slugs in the "existing_areas" map. Never invent new slugs; new
  topics get folded into the nearest existing one.
- "append" is the default. Only use "replace" when the existing content
  is genuinely obsolete AND you have the full replacement ready.
- Use "no_op" (with zero content) when you decide not to write anything
  for an area. Never use it for a decision row.
- Strip tool-message noise, message counts, "current state" sections,
  and relative dates ("yesterday", "last week"). Convert relative dates
  to absolute dates (YYYY-MM-DD).
- If two rollouts cover the same claim, prefer the most recent and
  drop the older one (or merge them into one section).
- Output ONE JSON object. No prose before or after. No markdown
  code-fence unless the host wraps it for you.

# JSON shape

{
  "decisions": [
    { "rollout_id": "<id>", "disposition": "absorbed|no_signal|uncertain", "reason": "<=500 chars" }
  ],
  "actions": [
    {
      "op": "append|replace|no_op",
      "area_path": "global/areas/<slug>.md",
      "content": "<=50000 chars, markdown section>",
      "reason": "<=500 chars, why this area gets this change"
    }
  ]
}`;

/**
 * Assemble the user prompt: list of input rollouts + existing area
 * content. Each input's `inputKey` is a rollout_id and we resolve it
 * to the on-disk `rollout_summaries/<id8>-<slug>.md` file.
 *
 * The existing area map is keyed by `rollout_slug` so the curator only
 * sees areas that the current batch actually targets.
 */
async function assembleUserPrompt(
  memoryRoot: string,
  inputs: ReadonlyArray<CurationInputForPrompt>,
): Promise<string> {
  const rolloutSummariesDir = path.join(memoryRoot, 'rollout_summaries');

  const rolloutBlock = await Promise.all(
    inputs.map(async (input) => {
      const filePath = path.join(rolloutSummariesDir, `${input.inputKey}.md`);
      let body = '';
      try {
        body = await fs.readFile(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        body = `<!-- summary file missing: ${filePath} -->`;
      }
      // Cap each summary to 32 KiB so a runaway rollout can't blow the prompt.
      const capped = body.length > 32_000 ? body.slice(0, 32_000) + '\n...[truncated]...' : body;
      return {
        rollout_id: input.inputKey,
        slug: input.rolloutSlug ?? '(no-slug)',
        updated_at: new Date(input.outputUpdatedAt).toISOString(),
        summary_md: capped,
      };
    }),
  );

  const slugs = Array.from(
    new Set(
      inputs
        .map((i) => i.rolloutSlug)
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    ),
  );

  const existingAreas: Record<string, string> = {};
  for (const slug of slugs) {
    for (const sub of ['global/areas', 'global/people'] as const) {
      const areaPath = `${sub}/${slug}.md`;
      try {
        const absolute = resolveAreaPath(memoryRoot, areaPath);
        const body = await fs.readFile(absolute, 'utf8');
        existingAreas[areaPath] = body.length > 16_000
          ? body.slice(0, 16_000) + '\n...[truncated for prompt]...'
          : body;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
    }
  }

  const payload = {
    inputs: rolloutBlock,
    existing_areas: existingAreas,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Race the LLM call against a hard wall-clock timeout. The
 * `AbortSignal` is wired into the LLM client so the SDK closes the
 * HTTP connection on abort (rather than leaving the request hanging
 * after the timeout fires).
 */
async function chatWithTimeout(
  llmClient: AIClient,
  messages: Parameters<AIClient['chat']>[0],
  chatOptions: Parameters<AIClient['chat']>[1],
  timeoutMs: number,
): ReturnType<NonNullable<AIClient['chat']>> {
  if (!llmClient.chat) {
    throw new Error('llmClient.chat is not implemented; pick a provider that exposes chat()');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`aborted after ${timeoutMs}ms`)), timeoutMs);
  try {
    const mergedOptions: Parameters<AIClient['chat']>[1] = {
      ...(chatOptions ?? {}),
      signal: controller.signal,
      maxTokens: chatOptions?.maxTokens ?? 8192,
      temperature: chatOptions?.temperature ?? 0.2,
    };
    return await llmClient.chat(messages, mergedOptions);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one curation cycle: assemble prompt → call LLM → parse → apply.
 * Never throws — returns `RunResult` with `success=false` and an
 * `error` field on any failure.
 */
export async function runSingleShotCuration(
  opts: SingleShotCurationOpts,
): Promise<RunResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = opts.systemPrompt ?? CURATOR_SYSTEM_PROMPT;

  let rawResponse = '';
  let response: CurationResponse | null = null;
  let actionsApplied = 0;
  let errors: ApplyResult['errors'] = [];
  let topLevelError: string | undefined;

  try {
    const userPrompt = await assembleUserPrompt(opts.memoryRoot, opts.inputs);
    const messages: Parameters<AIClient['chat']>[0] = [
      { role: 'user', content: userPrompt },
    ];

    const chatResult = await chatWithTimeout(
      opts.llmClient,
      messages,
      { systemPrompt },
      timeoutMs,
    );
    rawResponse = chatResult.content ?? '';

    if (rawResponse.trim().length === 0) {
      // Treat empty as a `no_signal` decision rather than an error: many
      // providers return whitespace when refusing. The caller will mark
      // inputs as `uncertain` so we revisit them next cycle.
      rawResponse = JSON.stringify({
        decisions: opts.inputs.map((i) => ({
          rollout_id: i.inputKey,
          disposition: 'uncertain',
          reason: 'empty LLM response',
        })),
        actions: [],
      });
    }

    try {
      response = parseCurationResponse(rawResponse);
    } catch (err) {
      if (err instanceof CurationParseError) {
        topLevelError = `parse failed: ${err.message}`;
      } else {
        topLevelError = err instanceof Error ? err.message : String(err);
      }
    }

    if (response !== null) {
      const applyResult = await applyCurationActions(opts.memoryRoot, response.actions);
      actionsApplied = applyResult.applied;
      errors = applyResult.errors;
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError' || /aborted/i.test((err as Error).message)) {
      topLevelError = `llm call timed out after ${timeoutMs}ms`;
    } else {
      topLevelError = err instanceof Error ? err.message : String(err);
    }
  }

  const success = topLevelError === undefined && errors.length === 0 && response !== null;

  return {
    success,
    response,
    rawResponse,
    durationMs: Date.now() - startedAt,
    actionsApplied,
    errors,
    ...(topLevelError !== undefined ? { error: topLevelError } : {}),
  };
}