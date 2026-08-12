/**
 * Goal evaluator — independent completion verification (plan 411 Phase 2/3).
 *
 * When the model self-reports `update_goal(completed: true)`, the harness
 * does NOT trust it verbatim (plan 411 §2.5). Instead it runs a panel of
 * verifier sub-agents (the built-in `verification` agent) against the
 * objective + final summary, and maps the aggregate verdict back onto the
 * goal state machine:
 *
 *   PASS    → achieved        (goal complete)
 *   FAIL    → not_achieved    (goal continues; gaps inlined next round)
 *   PARTIAL → blocked         (environmental limitation; needs user input)
 *
 * Phase 2 shipped the single-verifier MVP; Phase 3 extends it to the
 * N-skeptic adversarial panel (plan 411 §4.5); the grok-learning pass adds:
 *  - **parallel panel**: all `verifierCount` skeptics run concurrently via
 *    `Promise.all` (grok `spawn_parallel`) instead of serially — the
 *    verification stage is the goal's slowest path;
 *  - **JSON verdicts**: each skeptic is asked for a structured JSON verdict
 *    (`{refuted, evidence, confidence, blocking, findings}`) mirroring grok's
 *    `SkepticVerdict`; the JSON is authoritative and the legacy
 *    `VERDICT: PASS|FAIL|PARTIAL` terminal line is the fast-path fallback;
 *  - conservative aggregation (any refuted → not_achieved; all-refuted
 *    non-blocking with contradictions → blocked);
 *  - repeated identical gap fingerprints increment the stall counter;
 *  - after `strategistEvery` consecutive not-achieved rounds, a strategist
 *    sub-agent proposes a fresh approach.
 */

import type { AgentDefinition } from '../../tool/SubagentTool/loadAgentsDir.js';
import { runAgentSync } from '../../tool/SubagentTool/runAgent.js';
import type { Message, ToolUseContext } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { goalModeTracker } from './goal-tracker.js';
import { getGoalConfig } from './goal-config.js';
import { serializeRepoChanges } from './goal-changes.js';

export type GoalVerdict = 'achieved' | 'not_achieved' | 'blocked';

export interface GoalVerificationResult {
  verdict: GoalVerdict;
  /** Human-readable gaps summary (FAIL → what to fix next round). */
  gapsSummary?: string;
  /** Stable fingerprint of the gaps for stall detection (Phase 3). */
  gapFingerprint?: string;
  /** Raw verifier report tail (for debugging / UI). */
  details?: string;
  /** Per-skeptic verdicts (Phase 3 panel). */
  skepticVerdicts?: Array<{ skeptic: number; verdict: GoalVerdict }>;
  /** Strategist proposal, when a strategist round fired (Phase 3). */
  strategyProposal?: string;
}

export interface GoalVerificationParams {
  objective: string;
  /** The model's final summary message (what it believes it delivered). */
  finalSummary: string;
  /** Baseline commit captured at goal start (verifier compares working tree). */
  baselineCommit?: string;
  planFile?: string;
  /** Tool use context of the calling turn — required to spawn a sub-agent. */
  context: ToolUseContext;
  /** Verifier agent definitions. Falls back to the built-in registry when absent. */
  agentDefinitions?: AgentDefinition[];
  /** Max turns for each verifier sub-agent (default 10). */
  maxTurns?: number;
  /** Number of skeptic sub-agents in the panel (default 1, Phase 3: >1). */
  verifierCount?: number;
  /** After this many consecutive not-achieved rounds, fire the strategist (Phase 3). */
  strategistEvery?: number;
  /** Max consecutive not-achieved rounds before auto-pausing (stall guard). */
  maxNotAchievedRounds?: number;
}

const VERIFICATION_AGENT_TYPE = 'verification';

/** Marker the verification agent emits as its final line (see verificationAgent.ts). */
const VERDICT_MARKER = 'VERDICT:';

/** Default panel size when `verifierCount` is unspecified (config override). */
export const DEFAULT_VERIFIER_COUNT = 1;

/** Default strategist cadence (config override). */
export const DEFAULT_STRATEGIST_EVERY = 3;

/** Default stall guard: pause after this many not-achieved rounds (config override). */
export const DEFAULT_MAX_NOT_ACHIEVED_ROUNDS = 5;

/**
 * Run the verifier panel and map the aggregate verdict. Each skeptic gets
 * a slightly different stance so the panel covers more attack surface
 * (grok's adversarial panel). Verdicts aggregate conservatively.
 */
export async function verifyGoalCompletion(
  params: GoalVerificationParams,
): Promise<GoalVerificationResult> {
  const cfg = getGoalConfig();
  const {
    objective,
    finalSummary,
    baselineCommit,
    planFile,
    context,
    agentDefinitions,
    maxTurns,
    // Plan 411 Phase 4: caller-provided values win; otherwise fall back to
    // the `[goal]` config.toml section (env overrides applied in goal-config).
    verifierCount = cfg.verifierCount,
    strategistEvery = cfg.strategistEvery,
    maxNotAchievedRounds = cfg.maxNotAchievedRounds,
  } = params;

  const definition = findVerificationAgent(agentDefinitions);
  if (!definition) {
    // No verifier available — do not fabricate a verdict. Return a
    // conservative "blocked" so the goal pauses for user input instead of
    // silently completing or spinning.
    logger.warn('[GoalEvaluator] no verification agent found; goal marked blocked', undefined, 'GoalEvaluator');
    return { verdict: 'blocked', gapsSummary: 'Verifier unavailable — verification agent not found.' };
  }

  // Serialize the repo changes vs the goal baseline once for the whole
  // panel (grok repo_changes/): a skeptic judges what the model ACTUALLY
  // changed, not just the summary. Best-effort — undefined when no baseline
  // or git unavailable, and the prompt just omits the diff section.
  const repoChanges =
    baselineCommit && context.options.workingDirectory
      ? serializeRepoChanges(context.options.workingDirectory, baselineCommit)
      : undefined;

  // ── Panel (parallel, grok spawn_parallel) ──────────────────────────────
  const count = Math.max(1, Math.min(5, verifierCount));
  logger.info(`[GoalEvaluator] running ${count} verifier sub-agent(s) in parallel`, undefined, 'GoalEvaluator');

  // Each skeptic runs independently with a distinct adversarial stance. The
  // panel runs CONCURRENTLY via Promise.all — the verification stage is the
  // goal's slowest path, and skeptics are read-only so no shared-state
  // hazards (grok goal_classifier.rs).
  const skepticRuns = Array.from({ length: count }, (_, i) =>
    runOneSkeptic({
      skepticIndex: i,
      count,
      objective,
      finalSummary,
      baselineCommit,
      planFile,
      repoChanges,
      context,
      definition,
      maxTurns,
    }),
  );
  const results = await Promise.all(skepticRuns);

  const skepticVerdicts: Array<{ skeptic: number; verdict: GoalVerdict }> = [];
  const reports: string[] = [];
  for (const r of results) {
    skepticVerdicts.push({ skeptic: r.skeptic, verdict: r.verdict });
    reports.push(r.report);
    logger.info(`[GoalEvaluator] skeptic ${r.skeptic + 1} verdict: ${r.verdict}`, undefined, 'GoalEvaluator');
  }

  const aggregate = aggregateSkepticVerdicts(skepticVerdicts);
  const gapsSummary = mergeGaps(reports);
  const fingerprint = gapsSummary ? fingerprintOf(gapsSummary) : undefined;

  // ── Stall detection (Phase 3) ───────────────────────────────────────────
  const stallCount = goalModeTracker.setGaps(gapsSummary ?? '', fingerprint);
  const rounds = goalModeTracker.consecutiveNotAchieved();
  const stalled = stallCount >= 2 && rounds >= 2;
  if (stalled) {
    goalModeTracker.transition({ type: 'stall' });
    logger.warn(
      `[GoalEvaluator] stall detected (fingerprint unchanged ${stallCount}x); goal paused`,
      undefined,
      'GoalEvaluator',
    );
  }

  // ── Strategist (Phase 3) ────────────────────────────────────────────────
  let strategyProposal: string | undefined;
  const lastStrategist = goalModeTracker.lastStrategistFiredAt() ?? 0;
  const dueForStrategist =
    rounds >= strategistEvery &&
    Date.now() - lastStrategist > 60_000 && // throttle: once per minute
    !stalled;
  if (dueForStrategist) {
    strategyProposal = await runStrategist({
      objective,
      finalSummary,
      gapsSummary: gapsSummary ?? '',
      context,
      agentDefinitions,
      maxTurns,
    });
    if (strategyProposal) {
      goalModeTracker.recordStrategistFired();
    }
  }

  // ── Stall guard: pause instead of spinning forever ─────────────────────
  if (!stalled && rounds >= maxNotAchievedRounds) {
    goalModeTracker.transition({ type: 'stall' });
    logger.warn(
      `[GoalEvaluator] ${rounds} consecutive not-achieved rounds; goal paused`,
      undefined,
      'GoalEvaluator',
    );
  }

  return {
    verdict: aggregate,
    gapsSummary,
    gapFingerprint: fingerprint,
    details: reports[reports.length - 1]?.slice(-2000),
    skepticVerdicts,
    strategyProposal,
  };
}

/**
 * Aggregate panel verdicts conservatively (plan 411 §4.5):
 *  - any FAIL → not_achieved (even one skeptic found a real gap)
 *  - no FAIL, any PARTIAL → blocked
 *  - all PASS (or empty) → achieved
 * Pure — exhaustively unit-testable.
 */
export function aggregateSkepticVerdicts(
  verdicts: Array<{ skeptic: number; verdict: GoalVerdict }>,
): GoalVerdict {
  if (verdicts.length === 0) return 'achieved';
  if (verdicts.some((v) => v.verdict === 'not_achieved')) return 'not_achieved';
  if (verdicts.some((v) => v.verdict === 'blocked')) return 'blocked';
  return 'achieved';
}

/**
 * Merge per-skeptic reports into a gaps summary. When any skeptic found
 * gaps (refuted), the merged summary includes the evidence/findings;
 * otherwise returns undefined. Pure.
 */
export function mergeGaps(reports: string[]): string | undefined {
  const refuting = reports.filter(
    (r) => parseVerifierReport(r).verdict === 'not_achieved',
  );
  if (refuting.length === 0) return undefined;
  const parts: string[] = [];
  for (const r of refuting) {
    // Prefer structured findings, fall back to the report tail.
    const json = parseVerdictJson(r);
    if (json?.findings && json.findings.length > 0) {
      parts.push(
        json.findings
          .map((f) => `- [${f.kind ?? 'gap'}]${f.location ? ` ${f.location}` : ''}: ${f.detail ?? ''}`)
          .join('\n'),
      );
    } else {
      parts.push(r.slice(-1500));
    }
  }
  return parts.join('\n\n---\n\n').slice(0, 6000);
}

/**
 * Locate the built-in `verification` agent in the provided definitions.
 * Falls back to `undefined` when absent (caller decides how to degrade).
 */
export function findVerificationAgent(
  agentDefinitions?: AgentDefinition[],
): AgentDefinition | undefined {
  if (!agentDefinitions) return undefined;
  return agentDefinitions.find(
    (def) => def.agentType.toLowerCase() === VERIFICATION_AGENT_TYPE.toLowerCase(),
  );
}

/**
 * Run one skeptic sub-agent and map its output to a verdict.
 *
 * Parsing order (grok goal_classifier.rs):
 *  1. structured JSON verdict (authoritative) — `{"refuted", "evidence",
 *     "confidence", "blocking", "findings"}`;
 *  2. legacy `VERDICT: PASS|FAIL|PARTIAL` terminal line (fast-path
 *     fallback);
 *  3. no parseable verdict → conservative `blocked` (verifier malfunction).
 * A crashed skeptic also maps to `blocked` so a panel member that died
 * cannot silently flip the aggregate toward achieved.
 */
async function runOneSkeptic(params: {
  skepticIndex: number;
  count: number;
  objective: string;
  finalSummary: string;
  baselineCommit?: string;
  planFile?: string;
  repoChanges?: string;
  context: ToolUseContext;
  definition: AgentDefinition;
  maxTurns?: number;
}): Promise<{ skeptic: number; verdict: GoalVerdict; report: string }> {
  const {
    skepticIndex,
    count,
    objective,
    finalSummary,
    baselineCommit,
    planFile,
    repoChanges,
    context,
    definition,
    maxTurns,
  } = params;
  const stance = SKEPTIC_STANCES[skepticIndex % SKEPTIC_STANCES.length] ?? '';
  const prompt = buildVerifierPrompt({
    objective,
    finalSummary,
    baselineCommit,
    planFile,
    repoChanges,
    skepticStance: stance,
  });

  const promptMessages: Message[] = [
    { id: crypto.randomUUID(), role: 'user', content: prompt, timestamp: Date.now() },
  ];

  let report: string;
  try {
    const result = await runAgentSync({
      agentDefinition: definition,
      promptMessages,
      toolUseContext: context,
      isAsync: false,
      maxTurns: maxTurns ?? 10,
      availableTools: context.options.tools,
      description: `Goal verifier ${skepticIndex + 1}/${count}: ${objective.slice(0, 60)}`,
      agentId: crypto.randomUUID(),
    });
    report = extractText(result);
  } catch (err) {
    logger.warn(
      `[GoalEvaluator] verifier ${skepticIndex + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      'GoalEvaluator',
    );
    return {
      skeptic: skepticIndex,
      verdict: 'blocked',
      report: `[skeptic ${skepticIndex + 1}] crashed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { skeptic: skepticIndex, verdict: parseVerifierReport(report).verdict, report };
}

/** Build the verifier prompt (grok: objective + final answer + plan + baseline diff). */
export function buildVerifierPrompt(params: {
  objective: string;
  finalSummary: string;
  baselineCommit?: string;
  planFile?: string;
  skepticStance?: string;
  /** Serialized repo changes vs baseline (grok repo_changes/). */
  repoChanges?: string;
}): string {
  const { objective, finalSummary, baselineCommit, planFile, skepticStance, repoChanges } = params;
  const parts: string[] = [];
  parts.push(
    'Independently verify whether the following goal was ACHIEVED. Do not trust the summary — reproduce checks yourself.',
  );
  if (skepticStance) {
    parts.push('');
    parts.push(skepticStance);
  }
  parts.push('');
  parts.push(`## Objective`);
  parts.push(objective);
  parts.push('');
  parts.push(`## Claimed delivery (model summary)`);
  parts.push(finalSummary);
  if (planFile) {
    parts.push('');
    parts.push(`## Plan file`);
    parts.push(planFile);
  }
  if (baselineCommit) {
    parts.push('');
    parts.push(
      `## Baseline commit (git) — compare the working tree against ${baselineCommit} for changes.`,
    );
  }
  if (repoChanges && repoChanges.trim().length > 0) {
    parts.push('');
    parts.push(repoChanges.trim());
  }
  parts.push('');
  parts.push(
    'Run builds/tests/linters and exercise the changed paths. Respond with ONLY a JSON object matching this schema:',
  );
  parts.push('');
  parts.push(
    '{\n' +
      '  "refuted": false,            // true = completion REJECTED (gaps found); false = achieved\n' +
      '  "evidence": "<reproducible evidence or PASS summary>",\n' +
      '  "confidence": "high|medium|low",\n' +
      '  "blocking": "none|contradiction|unverifiable",  // contradiction/unverifiable ⇒ cannot fix by iterating\n' +
      '  "findings": [{"kind": "bug|gap|todo", "location": "path:line", "detail": "one line"}]\n' +
      '}\n' +
      'Set refuted=true when the delivery is NOT achieved; list concrete findings. ' +
      'No markdown fences, no prose after the JSON.',
  );
  return parts.join('\n');
}

/**
 * Parse a skeptic's output into a verdict.
 *
 * Order (grok goal_classifier.rs):
 *  1. structured JSON verdict (`{"refuted": bool, "evidence": str,
 *     "confidence": str, "blocking": str, "findings": [...]}`) —
 *     authoritative when well-formed;
 *  2. legacy terminal `VERDICT: PASS|FAIL|PARTIAL` line — fast-path
 *     fallback for older verifier prompts;
 *  3. nothing parseable → conservative `not_achieved` (fail-closed: an
 *     unverifiable claim is never silently accepted).
 * Pure — exhaustively unit-testable.
 */
export function parseVerifierReport(report: string): GoalVerificationResult {
  const text = report ?? '';
  // 1. Structured JSON verdict (authoritative).
  const json = parseVerdictJson(text);
  if (json) {
    // blocking=contradiction/unverifiable means the gaps cannot be fixed by
    // iterating — route to `blocked` (grok's `SkepticBlocking`).
    const verdict: GoalVerdict = json.refuted
      ? json.blocking === 'contradiction' || json.blocking === 'unverifiable'
        ? 'blocked'
        : 'not_achieved'
      : 'achieved';
    return {
      verdict,
      gapsSummary:
        verdict === 'not_achieved' || verdict === 'blocked'
          ? (json.evidence || text.slice(-2000))
          : undefined,
      gapFingerprint:
        verdict === 'not_achieved' || verdict === 'blocked'
          ? fingerprintOf(json.evidence || text)
          : undefined,
      details: text.slice(-2000),
    };
  }

  // 2. Legacy terminal marker fallback.
  const lines = text.split('\n');
  // Scan from the end: the contract says the verdict is the FINAL line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    const idx = line.indexOf(VERDICT_MARKER);
    if (idx === -1) continue;
    const raw = line.slice(idx + VERDICT_MARKER.length).trim().toUpperCase();
    const verdict = raw.includes('FAIL')
      ? 'not_achieved'
      : raw.includes('PARTIAL')
        ? 'blocked'
        : 'achieved';
    const detail = lines.slice(Math.max(0, i - 8), i).join('\n').trim();
    const gapsSummary = verdict === 'not_achieved' && detail ? detail : undefined;
    return {
      verdict,
      gapsSummary,
      gapFingerprint: gapsSummary ? fingerprintOf(gapsSummary) : undefined,
      details: text.slice(-2000),
    };
  }
  // 3. No marker — conservative: treat as not achieved with the raw tail as gaps.
  return {
    verdict: 'not_achieved',
    gapsSummary: text.slice(-2000),
    gapFingerprint: fingerprintOf(text),
    details: text.slice(-2000),
  };
}

/**
 * Structured JSON verdict shape (grok `SkepticVerdict`).
 * `refuted: true` = the skeptic rejects the completion (found gaps);
 * `false` = achieved. `blocking` distinguishes model-fixable gaps
 * (`none`) from objective/plan contradictions or environment-unverifiable
 * blockers (routes the goal to `blocked`).
 */
export interface SkepticJsonVerdict {
  refuted: boolean;
  evidence?: string;
  confidence?: string;
  blocking?: 'none' | 'contradiction' | 'unverifiable';
  findings?: Array<{ kind?: string; location?: string; detail?: string }>;
}

/**
 * Try to parse a structured JSON verdict out of the skeptic's output.
 *
 * The model may wrap JSON in a fenced block; we search for an object that
 * STARTS with the verdict's `"refuted"` key (grok's JSON contract) so prose
 * that merely contains braces (`{FAILED}`, `{brace}`) cannot corrupt the
 * parse. The candidate is bracket-balanced, so nested objects in `findings`
 * close correctly. Falls back to scanning for any JSON object only when no
 * `"refuted"`-led object is found. Returns undefined when no well-formed
 * object with a boolean `refuted` is found.
 */
export function parseVerdictJson(report: string): SkepticJsonVerdict | undefined {
  const text = report ?? '';
  // Preferred: an object that starts with the verdict's `"refuted"` key —
  // immune to prose braces before it. Works fenced or bare.
  const refutedIdx = text.search(/\{\s*"refuted"/);
  if (refutedIdx !== -1) {
    const body = extractBalancedObject(text, refutedIdx);
    if (body) {
      const parsed = tryParseJsonObject(body);
      if (parsed) return parsed;
    }
  }
  // Fallback: any JSON object (legacy verifier outputs without refuted-led
  // JSON). Still validated below for a boolean refuted.
  const anyIdx = text.indexOf('{');
  if (anyIdx !== -1) {
    const body = extractBalancedObject(text, anyIdx);
    if (body) {
      const parsed = tryParseJsonObject(body);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

/**
 * Extract the bracket-balanced JSON object starting at `start` (which must
 * point at `{`). Handles nested braces/strings so `{"findings": [{...}]}`
 * closes at the OUTER `}`. Returns undefined on unbalanced input.
 */
function extractBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse a candidate object body and validate it is a SkepticJsonVerdict. */
function tryParseJsonObject(body: string): SkepticJsonVerdict | undefined {
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    if (typeof raw.refuted !== 'boolean') return undefined;
    const blocking =
      raw.blocking === 'contradiction' || raw.blocking === 'unverifiable'
        ? raw.blocking
        : 'none';
    const findings = Array.isArray(raw.findings)
      ? (raw.findings as Array<Record<string, unknown>>)
          .map((f) => ({
            kind: typeof f.kind === 'string' ? f.kind : undefined,
            location: typeof f.location === 'string' ? f.location : undefined,
            detail: typeof f.detail === 'string' ? f.detail : undefined,
          }))
          .filter((f) => f.kind || f.location || f.detail)
      : undefined;
    return {
      refuted: raw.refuted,
      evidence: typeof raw.evidence === 'string' ? raw.evidence : undefined,
      confidence: typeof raw.confidence === 'string' ? raw.confidence : undefined,
      blocking,
      findings,
    };
  } catch {
    return undefined;
  }
}

/** Stable-ish fingerprint for stall detection. */
export function fingerprintOf(text: string): string {
  return text.trim().slice(0, 200).replace(/\s+/g, ' ');
}

/**
 * Skeptic stances — each panel member attacks from a different angle
 * (grok's adversarial panel, duya-ized). The first stance is the baseline
 * prompt; the rest add adversarial pressure.
 */
const SKEPTIC_STANCES: string[] = [
  '',
  'Adversarial focus: assume the delivery is INCOMPLETE until proven otherwise. Hunt the last 20%: half-working buttons, state that vanishes on refresh, backend crashes on bad input, tests that only cover the happy path. A missing edge case is a FAIL.',
  'Adversarial focus: verification avoidance is your enemy. Reject every PASS that lacks reproducible command output. If a check cannot be re-run and confirmed, it is not a PASS. Read-only code inspection is never sufficient evidence.',
  'Adversarial focus: break the invariants. Test invalid/empty/malformed inputs, concurrent access, restart behavior, and error paths. If the change looks right but nothing is actually exercised end-to-end, treat it as unverified.',
  'Adversarial focus: regression paranoia. Re-run the FULL existing test suite and diff the public API surface. Any broken pre-existing behavior, removed export, or changed contract is a FAIL regardless of the new feature working.',
];

/**
 * Run the strategist sub-agent (plan 411 Phase 3). When the goal keeps
 * coming back not-achieved, a strategist reviews the objective, the
 * model's delivery, and the verifier gaps, then proposes a fresh
 * approach. Returns the proposal text (or undefined on failure / no
 * agent).
 */
export async function runStrategist(params: {
  objective: string;
  finalSummary: string;
  gapsSummary: string;
  context: ToolUseContext;
  agentDefinitions?: AgentDefinition[];
  maxTurns?: number;
}): Promise<string | undefined> {
  const { objective, finalSummary, gapsSummary, context, agentDefinitions, maxTurns } = params;
  // Reuse the verification agent for strategy reconstruction — it already
  // has read-only, project-aware tooling. A dedicated strategist profile is
  // Phase 3 polish.
  const definition = findVerificationAgent(agentDefinitions);
  if (!definition) return undefined;

  const prompt = [
    'You are a strategy advisor for an agent working toward a goal that keeps failing verification.',
    '',
    '## Objective',
    objective,
    '',
    '## What the agent claims to have delivered',
    finalSummary,
    '',
    '## Verifier gaps (repeatedly not achieved)',
    gapsSummary,
    '',
    'Propose a concrete new approach: what is likely wrong, what to investigate first, and a step-by-step repair strategy. Do NOT modify any files — analysis only. End with a single line: STRATEGY: <one-sentence summary>.',
  ].join('\n');

  const promptMessages: Message[] = [
    { id: crypto.randomUUID(), role: 'user', content: prompt, timestamp: Date.now() },
  ];

  try {
    const result = await runAgentSync({
      agentDefinition: definition,
      promptMessages,
      toolUseContext: context,
      isAsync: false,
      maxTurns: maxTurns ?? 10,
      availableTools: context.options.tools,
      description: `Goal strategist: ${objective.slice(0, 60)}`,
      agentId: crypto.randomUUID(),
    });
    return extractText(result).slice(0, 4000) || undefined;
  } catch (err) {
    logger.warn(
      `[GoalEvaluator] strategist failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      'GoalEvaluator',
    );
    return undefined;
  }
}

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}
