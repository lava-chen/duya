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
import { listEntityDirs, isValidEntityDirName } from '../../packages/agent/src/memory-state/entity_dirs';
import type { CurationResponse } from './curation_response_parser';
import {
  applyPolicyEdits,
  readPolicyForPrompt,
} from '../../packages/agent/src/memory-rollout/stage1_policy_editor';

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
  /**
   * Rollout summary Markdown from `stage1_outputs` (DB is the source of
   * truth). The `rollout_summaries/` files are D11-named projections
   * (`<ts>-<shortid>-<slug>.md`); resolving them by `inputKey` (a UUID)
   * always misses, which made every curation input read as
   * "summary file missing" and starved Phase 2 of all content.
   */
  summaryMarkdown?: string;
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
   * Path to `stage1_policy.md`. When provided and the LLM emits
   * `stage1_policy.edits`, the edits are applied deterministically
   * (surgical rule upserts/removals, anchored by section + rule id) so
   * Stage 1 extraction adapts without full-file rewrites.
   */
  policyPath?: string;
  /**
   * Minimum interval between policy writes (ms). 0 disables. Default 30
   * minutes — stops the observed rapid-fire rewrite churn (5 writes in
   * 105 minutes) while still allowing several legitimate updates a day.
   */
  policyMinIntervalMs?: number;
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
  /**
   * Zod schema issues from a failed `parseCurationResponse`, surfaced
   * so the caller can log WHY the curator's structured output was
   * rejected (bug hunt: recurring `parse failed: response failed
   * schema validation` on 13/14/16/17/19). Populated only when the
   * final attempt failed schema validation.
   */
  parseIssues?: string[];
  /** True when a schema-validation failure was retried with feedback. */
  parseRetried?: boolean;
  /** True when the LLM's stage1_policy edits were written to disk. */
  policyUpdated?: boolean;
  /** New stage1_policy version after a successful write (0 if untouched). */
  policyVersion?: number;
  /**
   * Non-fatal policy edit rejections (unknown section/rule id, size cap,
   * rate-limit skip). The run itself still succeeded.
   */
  policyErrors?: string[];
  /**
   * Custom entity categories created by this run's `new_categories`
   * proposals (directory actually created under `global/`).
   */
  newCategoriesCreated?: string[];
  /**
   * Custom category proposals that were skipped: name failed the grammar
   * guard, or the category already existed (duplicate proposal — the
   * curator cannot see its own past proposals).
   */
  newCategoriesSkipped?: string[];
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;
/** Default minimum interval between policy writes (ms). */
const DEFAULT_POLICY_MIN_INTERVAL_MS = 30 * 60_000;

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

# Writing style (how memory files should read)

Canonical memory is READ by future agents and scanned fast, not
browsed. Write like a terse operator's manual, not a session report.

1. ASSERT, DON'T NARRATE
   - State facts directly: "User prefers X." not "It seems the user
     may prefer X."
   - No process narration: no "we tried", "after investigation", "the
     agent attempted". Memory records WHAT IS TRUE, not what happened.
   - Drop hedges ("maybe", "probably", "I think"). If uncertain, mark
     it explicitly: append "(unverified)" or "(inferred)". An explicit
     flag beats a vague word.

2. ONE FACT PER BULLET
   - Use bullet lists over paragraphs for enumerable facts.
   - Lead with the searchable key: "- **preference:xxx**: ..." or
     "- **fact:yyy**: ...". Future sessions grep these keys — never
     repeat the key inside the description.
   - Keep a bullet to 1-3 sentences. If it grows, split it.

3. PREFERENCES ARE TRIGGER-FIRST AND ACTIONABLE
   - Write preferences as "When X, do Y" so a future agent applies
     them without interpretation.
   - Bad: "User doesn't like being asked too much."
   - Good: "When the user gives a task, execute it; ask only when the
     action is destructive or irreversible."

4. CONCRETE OVER GENERIC
   - Keep paths, commands, tool names, versions verbatim
     (E:\\Projects\\duya, "python -m http.server"). Never paraphrase.
   - Keep numbers exact: ports, limits, durations, counts.
   - Dates as YYYY-MM-DD; never "yesterday" or "last week".

5. NO DUPLICATION
   - If a fact already exists in the file (or any file in the
     panorama), do NOT write it again. Only update the existing
     wording if it is wrong.
   - Summary = compressed index of Details. Do not copy Details prose
     into Summary; restate each point in one short sentence.

6. FIXED STRUCTURE
   - "# Title" (one line) / "## Summary" (3-5 sentences, whole file
     compressed) / "## Details" (bullets; group with "### <source>" or
     "### <topic>" subsections when the file gets long).
   - No frontmatter. Keys derive from directory + filename.

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

The memory panorama below already lists EVERY existing category,
including custom ones created by earlier runs. A bucket that appears
in the panorama is NOT new — do not propose it again; file into the
existing category instead. Only propose a category that appears
nowhere in the panorama.

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

# Self-improvement: keep Stage 1 sharp — edit the policy as extraction constraints

You are not just a sink for the current batch — you are the curator of
what future batches will even SEE. Stage 1 is the FIRST filter: it turns
raw transcripts into rollout summaries, and everything you absorb comes
from those summaries. If Stage 1 never captures a dimension, you can
never absorb it — so keeping Stage 1 sharp is part of your job.

Stage 1 works from a hard contract (12 claim types, immutable) plus an
editable policy file. The policy is the ONLY lever you have on Stage 1.

The CURRENT policy is included in your input as \`current_stage1_policy\`
(anchored sections S1..S9, each rule carrying a stable \`[r:<id>]\` id).
Sections and ids are FIXED — you edit rules inside them, never the
skeleton. Your edits are applied deterministically: one run changes at
most 3 rules, and every other byte of the policy stays exactly as it is.

Think of the policy as a set of extraction CONSTRAINTS, not a checklist:
each rule tells Stage 1 "in which situation, capture what, to what depth".
Two kinds of rules you maintain:

1. GENERIC CONSTRAINTS (sections S1, S3..S8, S9) — boundary and quality
   rules that apply to every rollout: paths kept verbatim, only explicitly
   stated preferences recorded, absolute dates, and so on. Phrase them as
   "when X appears, capture Y with Z detail", never as bare trigger lists.

2. FOCUS-DOMAIN RULES (section S2, rule ids [r:focus-<slug>]) — the
   positive-feedback loop. When the rollouts show the user investing in a
   NEW domain across sessions (a new creative idea, a new academic focus,
   a new project line), add ONE rule per domain so Stage 1 deep-captures
   it:
   "用户当前关注「<domain>」：凡涉及该领域，捕捉用户的观察与想法、进展与里程碑、新要求或偏好、提到的论文/工具/人。"
   Keep the domain name in the rule id (r:focus-<slug>). Update the rule
   when the domain's scope or emphasis evolves; remove it when the domain
   stops appearing for many cycles. Each domain gets at most one rule.

Evidence gate (hard) — for BOTH rule kinds:
- The pattern (a missing dimension, or a new domain) must appear in >=2
  rollouts of this batch, or be a repeat across cycles. A one-off
  observation gets absorbed as an action, NOT a policy edit.
- A single-session topic is NOT a domain. Let a new focus prove itself
  over two or three cycles before adding its rule.
- A policy edit is a commitment; do not churn it.

How to edit (surgical protocol):
- \`upsert_rule\`: ONE rule at a time. Reuse an existing rule_id to fix or
  sharpen its wording; invent a new id only for a genuinely new rule
  (including [r:focus-<slug>] domain rules). \`text\` is the full bullet
  WITHOUT the \`[r:<id>]\` prefix, <=500 chars.
- \`remove_rule\`: delete a rule that has become wrong, noisy, obsolete
  (domain faded out), or that licenses bad inference.
- NEVER emit the full policy. NEVER rename sections, reorder rules, or
  restructure the file. At most 3 edits per run.

Content discipline (what a rule may say):
- Rules state what to CAPTURE and to what depth — never an inference
  license: "interpret any question as a goal" or "record observed style
  as preference even without correction".
- Session facts do NOT belong in the policy: specific project paths,
  single failures, one-off workflows, topic snapshots ("user asked about
  PDF->xlsx this week"). Those belong in global/areas|preferences actions
  as claims. The one exception is a focus-domain rule: it names the domain
  (a durable topic) plus the capture points, never a single session's
  details.
- Keep rules phrased as durable extraction guidance, not as claims about
  the user.

Before editing, check the panorama you were given: if the dimension is
already well-covered in existing memory, the problem may be Stage 1
missing it (edit the policy) — but if it is genuinely new territory,
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
    "op": "edit|no_change",
    "edits": [
      { "op": "upsert_rule|remove_rule", "section": "S1..S9",
        "rule_id": "<existing-or-new kebab id, e.g. focus-<domain> for S2 domain rules>",
        "text": "<=500 chars, constraint text without [r:id] (upsert_rule only)",
        "reason": "<=200 chars, why this rule changes" }
    ],
    "reason": "<=500 chars, why the extraction constraints changed (op=edit only)"
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
 * content + current Stage 1 policy. Rollout bodies come from
 * `input.summaryMarkdown` (read from `stage1_outputs` by the caller) —
 * the DB is the source of truth; the `rollout_summaries/` files are
 * D11-named projections and must not be resolved by `inputKey` here.
 *
 * The existing area map is keyed by `rollout_slug` so the curator only
 * sees areas that the current batch actually targets.
 *
 * `current_stage1_policy` is the anchored-normalized policy with its
 * version. Without this baseline the curator had to regenerate the whole
 * policy from scratch on every update (Plan 433 root cause B) — with it,
 * the curator emits surgical edits against known section/rule ids.
 */
async function assembleUserPrompt(
  memoryRoot: string,
  inputs: ReadonlyArray<CurationInputForPrompt>,
  policyPath?: string,
): Promise<string> {
  const rolloutBlock = await Promise.all(
    inputs.map(async (input) => {
      const body =
        input.summaryMarkdown && input.summaryMarkdown.trim().length > 0
          ? input.summaryMarkdown
          : `<!-- empty stage1 summary for ${input.inputKey} (job_status=succeeded but no body) -->`;
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
  // a signal is new or already known. Entity buckets are discovered
  // dynamically (defaults + curator-proposed custom categories) — with a
  // hard-coded list, a custom category created by an earlier run was
  // invisible here and got re-proposed / misfiled on every cycle.
  const panorama: Array<{ bucket: string; slug: string; title: string; updated: string }> = [];
  for (const sub of (await listEntityDirs(memoryRoot)).map((e) => e.relDir)) {
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

  // Current Stage 1 policy (anchored form + version). Null when no
  // policyPath is configured or the file does not exist yet.
  let currentPolicy: { version: number; content: string } | null = null;
  if (policyPath) {
    currentPolicy = await readPolicyForPrompt(policyPath);
  }

  const payload = {
    inputs: rolloutBlock,
    existing_areas: existingAreas,
    memory_panorama: {
      // Summary line: how much of each dimension is already captured.
      note: 'Every canonical file you may update. "updated" is the date the file was last written. If a dimension from your checklist has no entry here, that dimension is blank in memory.',
      files: panorama,
    },
    current_stage1_policy: currentPolicy,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Race the LLM call against a hard wall-clock timeout. The
 * `AbortSignal` is wired into the LLM client so the SDK closes the
 * HTTP connection on abort (rather than leaving the request hanging
 * after the timeout fires).
 */
export async function chatWithTimeout(
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
  let parseIssues: string[] | undefined;
  let parseRetried = false;
  let policyUpdated: boolean | undefined;
  let policyVersion: number | undefined;
  let policyErrors: string[] = [];
  const newCategoriesCreated: string[] = [];
  const newCategoriesSkipped: string[] = [];

  try {
    const userPrompt = await assembleUserPrompt(opts.memoryRoot, opts.inputs, opts.policyPath);
    const messages: Parameters<AIClient['chat']>[0] = [
      { role: 'user', content: userPrompt },
    ];

    // One LLM call + parse, with a bounded retry on schema-validation
    // failure. The recurring `curation_run_failed: parse failed:
    // response failed schema validation` (13/14/16/17/19) wastes the
    // whole cycle: a single malformed field rejects the ENTIRE run and
    // the claimed inputs stay locked until the next cycle. One retry
    // that feeds the zod issues back to the model recovers the run the
    // vast majority of the time — LLMs fix a pointed-out schema slip
    // (e.g. a wrong enum value or a missing field) far more reliably
    // than they produce valid JSON blind on the first try.
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        break;
      } catch (err) {
        if (!(err instanceof CurationParseError)) {
          topLevelError = err instanceof Error ? err.message : String(err);
          break;
        }
        parseIssues = err.issues.length > 0 ? err.issues : undefined;
        if (attempt === 0 && err.issues.length > 0) {
          // Schema slip — ask the model to fix the shape, showing the
          // exact zod issues, then re-call. The retry reuses the full
          // conversation so the model sees its previous (invalid) output.
          parseRetried = true;
          const fixPrompt =
            'Your previous response failed schema validation. ' +
            'Fix the following issues and reply with the COMPLETE corrected JSON ' +
            '(do not paraphrase; the full document must be re-emitted):\n' +
            err.issues.map((issue) => `- ${issue}`).join('\n');
          messages.push(
            { role: 'assistant', content: rawResponse },
            { role: 'user', content: fixPrompt },
          );
          continue;
        }
        topLevelError = `parse failed: ${err.message}`;
        break;
      }
    }

    if (response !== null) {
      // New category creation (rare, evidence-gated): create the directory
      // BEFORE applying actions so same-batch writes land in a fully
      // initialized bucket. Guards:
      //   - name must match the shared category grammar (defense in depth;
      //     the zod schema already enforces this);
      //   - an EXISTING category is skipped, not re-created — the curator
      //     cannot see its own past proposals, and a duplicate proposal
      //     used to silently pass through (mkdir is idempotent).
      for (const cat of response.new_categories ?? []) {
        if (!isValidEntityDirName(cat.name)) {
          newCategoriesSkipped.push(cat.name);
          console.warn(`[memory] new category rejected (invalid name): ${cat.name}`);
          continue;
        }
        const dirPath = path.join(opts.memoryRoot, 'global', cat.name);
        try {
          let stat;
          try {
            stat = await fs.stat(dirPath);
          } catch {
            stat = null; // does not exist yet
          }
          if (stat?.isDirectory()) {
            newCategoriesSkipped.push(cat.name);
            console.warn(
              `[memory] new category already exists, skipped: global/${cat.name}`,
            );
            continue;
          }
          // recursive: parent `global/` may not exist yet on first run.
          await fs.mkdir(dirPath, { recursive: true });
          newCategoriesCreated.push(cat.name);
          console.warn(
            `[memory] new category created: global/${cat.name} (${cat.reason.slice(0, 80)})`,
          );
        } catch (err) {
          // Non-fatal: the run still succeeds; applyCurationActions's
          // atomicWrite re-creates missing parent directories on demand.
          console.warn(
            '[memory] new category creation failed',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      const applyResult = await applyCurationActions(opts.memoryRoot, response.actions);
      actionsApplied = applyResult.applied;
      errors = applyResult.errors;

      // Adaptive loop: if the curator proposed surgical policy edits
      // (Plan 433 — incremental, anchored by section + rule id, at most
      // 3 per run), apply them deterministically. The extractor reloads
      // the policy on mtime change, so the next extraction uses the
      // richer focus. A policy edit changes ONE rule, never the file.
      //
      // Guard 1: when EVERY input in this batch has an empty body, the
      // curator saw no real content and its policy "diagnosis" is a
      // hallucination (historically: it blamed Stage 1 for files it
      // could not read and churned the policy every run). Skip.
      //
      // Guard 2: minimum interval between policy writes (default 30
      // minutes) — stops the rapid-fire rewrite churn observed in
      // 2026-08-12..17 (5 writes in 105 minutes).
      const suggestion = response.stage1_policy;
      const hasAnyBody = opts.inputs.some(
        (i) => (i.summaryMarkdown ?? '').trim().length > 0,
      );
      if (suggestion?.op === 'edit' && !hasAnyBody) {
        console.warn(
          '[memory] stage1_policy edit skipped: all inputs in this batch have empty summaries',
        );
      } else if (suggestion?.op === 'edit' && opts.policyPath && suggestion.edits) {
        const minIntervalMs = opts.policyMinIntervalMs ?? DEFAULT_POLICY_MIN_INTERVAL_MS;
        if (minIntervalMs > 0) {
          try {
            const stat = await fs.stat(opts.policyPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs < minIntervalMs) {
              policyErrors.push(
                `rate-limited: last policy write ${Math.round(ageMs / 1000)}s ago (< ${Math.round(minIntervalMs / 1000)}s)`,
              );
              console.warn(`[memory] stage1_policy edit skipped: ${policyErrors[policyErrors.length - 1]}`);
            }
          } catch {
            // File missing — first write is always allowed.
          }
        }
        if (policyErrors.length === 0) {
          try {
            const res = await applyPolicyEdits(opts.policyPath, suggestion.edits);
            policyUpdated = res.changed;
            policyVersion = res.version;
            policyErrors = res.errors;
            if (res.changed) {
              console.warn(
                `[memory] stage1_policy updated to v${res.version} (${res.hash.slice(0, 8)})`,
              );
            }
            for (const errMsg of res.errors) {
              console.warn(`[memory] stage1_policy edit rejected: ${errMsg}`);
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
    ...(parseIssues !== undefined ? { parseIssues } : {}),
    ...(parseRetried ? { parseRetried } : {}),
    ...(policyUpdated !== undefined ? { policyUpdated } : {}),
    ...(policyVersion !== undefined ? { policyVersion } : {}),
    ...(policyErrors.length > 0 ? { policyErrors } : {}),
    ...(newCategoriesCreated.length > 0 ? { newCategoriesCreated } : {}),
    ...(newCategoriesSkipped.length > 0 ? { newCategoriesSkipped } : {}),
  };
}