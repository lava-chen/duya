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
import { writePolicy } from '../../packages/agent/src/memory-rollout/stage1_prompt_loader';

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
  /**
   * Path to `stage1_policy.md`. When provided and the LLM emits a
   * `stage1_policy.update` suggestion, the policy file is rewritten
   * (atomic write + version bump) so Stage 1 extraction adapts.
   */
  policyPath?: string;
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
  /** True when the LLM's stage1_policy.update was written to disk. */
  policyUpdated?: boolean;
  /** New stage1_policy version after a successful write (0 if untouched). */
  policyVersion?: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;

const CURATOR_SYSTEM_PROMPT = `\
You are the Memory Curator agent for the DUYA desktop client.

# Your duty

You receive 1-3 rollout summaries (plus a panorama of what memory already
holds) and decide what to persist. Your goal: turn each rollout into the
minimum set of stable, useful facts that future sessions can rely on
without re-reading the source. You are also the agent that keeps
improving what future rollouts will capture (see "Self-improvement").

# The user profile dimensions you maintain

Memory exists to answer "who is this user, what do they care about, and
how do they work?". When scanning a rollout, check each dimension below
for NEW signal. These are deliberately abstract so they cover any
concrete situation (project paths, news taste, a favorite YouTuber, an
environment quirk, ...):

1. PROJECT & ENVIRONMENT TOPOLOGY — where the user's projects live
   (E:\\Projects\\..., E:\\cloned-projects\\..., workspace dirs), toolchain,
   platform limits, machines, shells, common directories. Signals:
   "the project is at ...", "installed via ...", "this machine lacks ...".
2. ACTIVE FOCUS — what the user is currently doing: recently started /
   newly added projects, the main thing they are working on, near-term
   plans and goals. Signals: "user just started ...", "the focus is ...",
   "next step is ...".
3. COMMUNICATION & INTERACTION STYLE — how the user wants replies
   (language, length, format, emoji/table habits, when to ask vs act),
   small quirks and pet peeves, how they steer mid-task. Signals: "user
   prefers ...", "user corrected ...", "user stopped me when ...".
4. RECURRING WORKFLOWS & TASK PATTERNS — tasks the user repeatedly asks
   for and HOW to execute them fast: news investigation, transcription
   of a favorite commentator, daily briefs, site cloning, report
   generation. Capture the full recipe: tools, search style, output
   format, target paths. Signals: "user often asks ...", "the usual
   pipeline is ...", "again the same workflow ...".
5. CONTENT TASTE & INFORMATION DIET — what the user follows (news
   domains, topics, specific YouTubers/authors), search style and
   sources they trust, depth vs brevity preference for research.
   Signals: "user tracks ...", "user liked this angle ...", "user
   follows ...".
6. FAILURE MODES & ENVIRONMENT PITFALLS — errors the user repeatedly
   hits, environment limitations discovered, workarounds that worked.
   Signals: "hit ... again", "that fails because ...", "the fix is ...".
7. PEOPLE & RELATIONSHIPS — the user's own profile (background, role,
   skills), collaborators, named people, how they relate to projects.
8. PREFERENCES & CORRECTIONS — explicit "always / never / prefer"
   statements and correction patterns. The highest-value dimension: a
   stated preference beats an inferred one every time.

# Where facts live (three buckets — pick the right one)

Canonical memory is split into THREE entity directories, each mapping to
a claim type. Choose the bucket by what the fact IS, not where it
happened:

1. "global/preferences/<slug>.md" — USER PREFERENCES (dimensions 3, 4,
   5, 8): durable "the user wants / likes / prefers / always / never"
   statements — communication style, workflow recipes, content taste,
   correction patterns. The HIGHEST value memory — always prefer this
   bucket over burying a preference in an area.
2. "global/people/<slug>.md" — PERSON RECORDS (dimension 7): a specific
   human (the user, collaborators, named people). Identity facts,
   roles, skills, working style, relationship to projects. One file per
   person.
3. "global/areas/<slug>.md" — DOMAIN KNOWLEDGE (dimensions 1, 2, 6,
   plus secondary claim types fact/decision/procedure/reference/
   invariant/goal/capability/commitment/relationship): stable reusable
   knowledge — project architecture, environment topology, active
   focus, failure modes, procedures.

Classification rules:
- If a rollout reveals a preference, workflow recipe, or taste signal
  (dimensions 3/4/5/8), ALWAYS emit an action into "global/preferences/".
  Do not let it ride along in an area.
- If a rollout names a person with stable attributes (dimension 7),
  emit an action into "global/people/".
- Only when a fact is clearly domain knowledge with no preference or
  person component, emit into "global/areas/".
- Reuse an existing slug when one covers the same topic; create a new
  slug only when no existing file fits.

# Restraint: quality over quantity

The memory store must stay SMALL and DENSE. Small, well-maintained
files beat many thin ones:

- APPEND is almost always right. New facts about an existing topic go
  into the existing file — do not spin up a new slug because a session
  felt different. Only create a new file when the topic is genuinely
  absent from the panorama and cannot reasonably live inside an
  existing one.
- One topic, one file. If two existing files cover the same topic,
  prefer the more established one and note the overlap in your reason.
- The panorama shows you every file that exists. Before creating a new
  slug, scan it: is there already a file this belongs in? If yes,
  append.
- A new file should have a DISTINCT title and a real Summary. A
  one-session observation is not a file.

# New categories (rare, evidence-gated)

The three buckets (preferences / people / areas) are the default and
should cover ~all cases. A NEW category directory is justified only
when a whole CLASS of user activity is recurring and none of the three
buckets fits — e.g. the user is clearly a learner whose sessions are
almost all coursework (a "lessons" category) or mostly company work
(a "company" category).

To propose a new category you must satisfy ALL of:
- the pattern spans MULTIPLE rollouts in this batch or is clearly a
  long-term class of activity, not one session;
- none of the three buckets can hold it (it is not a preference, not a
  person, and not domain knowledge of one project);
- you can name the class and its distinguishing signals.

Emit at most ONE "new_categories" entry per run. When you do, also
write your first file into it (an action targeting the new directory)
and emit a stage1_policy update so Stage 1 starts watching the
signals. If in doubt, fold into "global/areas/" instead — you can
always promote a category later.

# Decision boundary

For each rollout you MUST emit exactly one decision:
  - "absorbed": at least one non-trivial fact from this rollout was merged
    into a canonical file.
  - "no_signal": the rollout contains nothing worth persisting (chit-chat,
    test runs, ephemeral work, duplicates of existing memory).
  - "uncertain": you cannot decide safely; the next curation cycle will
    revisit it with a fresh prompt.

When you choose "absorbed", emit at least one action whose
"area_path" targets one of the three entity directories and whose
"content" is the section to append. When you choose "no_signal" or
"uncertain", you may emit zero actions (use op="no_op") but you MUST
still emit the decision.

# Hard rules

- Every action's "area_path" must be one of:
  "global/preferences/<slug>.md", "global/people/<slug>.md", or
  "global/areas/<slug>.md". Prefer matching an existing slug from the
  "existing_areas" map; create a new slug only when no existing file
  fits the bucket.
- "append" is the default. Only use "replace" when the existing content
  is genuinely obsolete AND you have the full replacement ready.
- Use "no_op" (with zero content) when you decide not to write anything
  for an entity. Never use it for a decision row.
- Strip tool-message noise, message counts, "current state" sections,
  and relative dates ("yesterday", "last week"). Convert relative dates
  to absolute dates (YYYY-MM-DD).
- If two rollouts cover the same claim, prefer the most recent and
  drop the older one (or merge them into one section).
- Output ONE JSON object. No prose before or after. No markdown
  code-fence unless the host wraps it for you.

# Self-improvement: teach Stage 1 to watch missing dimensions

You are not just a sink for the current batch — you are the curator of
what future batches will even SEE. Stage 1 is the FIRST filter: it turns
raw transcripts into rollout summaries, and everything you absorb comes
from those summaries. If Stage 1 never captures a dimension, you can
never absorb it — so keeping Stage 1 sharp is part of your job.

Stage 1 works from a hard contract (12 claim types, immutable) plus an
editable policy file. The policy is the ONLY lever you have on Stage 1.

Emit a "stage1_policy" update when a dimension from the eight above is
RECURRING in user behavior but consistently absent from the rollouts you
see. Concrete signals it is time to update:
- The same kind of signal appears in rollout after rollout but never as
  an extracted item (e.g. user keeps discussing their plans, but no
  summary ever contains goal/commitment items).
- A stable fact you know exists (project path, toolchain, workflow) was
  missing from every summary of a session where it clearly appeared.
- You keep having to infer something from scattered prose that Stage 1
  could have captured directly.

When you update:
  - op="update" with the FULL new policy text (markdown, <=8 KiB). Stage 1
    appends it after its immutable hard contract; do NOT repeat the hard
    contract. Structure the policy as a dimension checklist: which
    dimensions to watch (reuse the eight names), how to recognize each,
    which claim types to prefer, example signals, and any extraction
    rules specific to this user (e.g. "always capture project paths
    verbatim", "record the user's news sources").
  - reason: <=500 chars, which dimension was missing and how this change
    fixes future rollouts.
  - Otherwise emit op="no_change" (or omit the field).

Do NOT update the policy for one-off observations — only for recurring
patterns that repeated rollouts keep missing. A policy update is a
commitment to watch a dimension permanently; do not churn it.

Before updating, check the panorama you were given: if the dimension is
already well-covered in existing memory, the problem may be Stage 1
missing it (update the policy) — but if it is genuinely new territory,
start by absorbing what you have and let the pattern prove itself over
two or three more cycles.

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
  ],
  "stage1_policy": {
    "op": "update|no_change",
    "content": "<=8192 chars, full new Stage 1 policy markdown (op=update only)",
    "reason": "<=500 chars, why the extraction focus changed (op=update only)"
  },
  "new_categories": [
    {
      "name": "lessons",
      "reason": "<=500 chars, evidence the user's activity is a recurring class that no bucket fits"
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
      // Cap each summary to 12 KiB so a runaway rollout can't blow the prompt
      // (real summaries are 2-8 KiB; the cap is only a safety net).
      const capped = body.length > 12_000 ? body.slice(0, 12_000) + '\n...[truncated]...' : body;
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

  // Read existing canonical files across all three entity directories,
  // keyed by the rollout slug first and the directory second. The curator
  // sees what already exists so it can append instead of duplicate.
  const existingAreas: Record<string, string> = {};
  for (const slug of slugs) {
    for (const sub of ['global/preferences', 'global/people', 'global/areas'] as const) {
      const areaPath = `${sub}/${slug}.md`;
      try {
        const absolute = resolveAreaPath(memoryRoot, areaPath);
        const body = await fs.readFile(absolute, 'utf8');
        existingAreas[areaPath] = body.length > 8_000
          ? body.slice(0, 8_000) + '\n...[truncated for prompt]...'
          : body;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
    }
  }

  // Memory panorama: the slug + title + recency of EVERY canonical file,
  // so the curator can tell which dimensions are covered, which are thin,
  // and which are missing entirely. Without this it cannot decide whether
  // a signal is new or already known.
  const panorama: Array<{ bucket: string; slug: string; title: string; updated: string }> = [];
  for (const sub of ['global/preferences', 'global/people', 'global/areas'] as const) {
    const dir = path.join(memoryRoot, sub);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // directory not created yet
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md') || name === 'index.md') continue;
      const absolute = path.join(dir, name);
      try {
        const [body, stat] = await Promise.all([
          fs.readFile(absolute, 'utf8'),
          fs.stat(absolute),
        ]);
        const title = (body.split('\n').find((l) => /^#\s+/.test(l)) ?? '')
          .replace(/^#\s+/, '')
          .trim();
        panorama.push({
          bucket: sub.replace('global/', ''),
          slug: name.replace(/\.md$/, ''),
          title,
          updated: new Date(stat.mtimeMs).toISOString().slice(0, 10),
        });
      } catch {
        // unreadable file — skip
      }
    }
  }
  // Most recently updated first, so the curator sees the freshest focus.
  panorama.sort((a, b) => b.updated.localeCompare(a.updated));

  const payload = {
    inputs: rolloutBlock,
    existing_areas: existingAreas,
    memory_panorama: {
      // Summary line: how much of each dimension is already captured.
      note: 'Every canonical file you may update. "updated" is the date the file was last written. If a dimension from your checklist has no entry here, that dimension is blank in memory.',
      files: panorama,
    },
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
  let policyUpdated: boolean | undefined;
  let policyVersion: number | undefined;

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

      // New category creation (rare, evidence-gated): create the directory
      // so subsequent actions in this batch (and later cycles) can write
      // into it. Non-fatal on failure — the run still succeeded.
      for (const cat of response.new_categories ?? []) {
        try {
          await fs.mkdir(path.join(opts.memoryRoot, 'global', cat.name), { recursive: true });
          console.warn(`[memory] new category created: global/${cat.name} (${cat.reason.slice(0, 80)})`);
        } catch (err) {
          console.warn(
            '[memory] new category creation failed',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Adaptive loop: if the curator asked Stage 1 to watch a missing
      // dimension, write the new policy (atomic + version bump). The
      // extractor reloads it on mtime change, so the very next extraction
      // uses the richer focus.
      const suggestion = response.stage1_policy;
      if (suggestion?.op === 'update' && opts.policyPath && suggestion.content) {
        try {
          const res = await writePolicy(opts.policyPath, suggestion.content);
          policyUpdated = res.changed;
          policyVersion = res.version;
          if (res.changed) {
            console.warn(
              `[memory] stage1_policy updated to v${res.version} (${res.hash.slice(0, 8)})`,
            );
          }
        } catch (err) {
          // Policy write failure is non-fatal — the run still succeeded.
          console.warn(
            '[memory] stage1_policy write failed',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
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
    ...(policyUpdated !== undefined ? { policyUpdated } : {}),
    ...(policyVersion !== undefined ? { policyVersion } : {}),
  };
}