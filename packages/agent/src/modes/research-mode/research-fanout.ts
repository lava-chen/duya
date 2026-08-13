/**
 * Research fan-out tool (plan 423 Phase 3).
 *
 * `research_fanout` lets the model parallelize the `gathering` phase: given a
 * list of sub-questions, it spawns one Research sub-agent per question
 * (via the existing `SubagentTool`) concurrently, aggregates each agent's
 * structured findings, and returns the combined result to the caller.
 *
 * Design notes:
 *  - Reuses `SubagentTool.execute` (blocking, `run_in_background: false`) so
 *    fan-out inherits the full sub-agent pipeline (agent resolution, session
 *    creation, progress reporting) without re-implementing it — mirroring the
 *    "reuse duyaAgent execution path" principle from plan 60.
 *  - Legal only while `gathering` (the plan's research loop). Called from any
 *    other state it is rejected so the lifecycle stays enforced by the pure
 *    state machine.
 *  - Aggregation is returned to the model as plain text (the model then
 *    evaluates authority/recency/bias); the tracker only records the
 *    sub-questions so the continuation reminder reflects fan-out progress.
 *  - Sub-questions are recorded via `addSubQuestion` so a later `evaluating`
 *    pass can see what was fanned out.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';
import { subagentTool } from '../../tool/SubagentTool/SubagentTool.js';
import { researchModeTracker } from './research-tracker.js';
import { persistSnapshot } from '../engine/persistence.js';
import { sendEvent, buildResearchUpdatedEvent } from '../../process/worker-protocol.js';
import type { ModeTracker } from '../engine/tracker.js';

export const RESEARCH_FANOUT_TOOL_NAME = 'research_fanout';

/** Stable error codes for research fan-out rejections. */
export const RESEARCH_FANOUT_ERROR_CODES = {
  INVALID_INPUT: 'research_fanout_invalid_input',
  NOT_GATHERING: 'research_fanout_not_gathering',
  NO_QUESTIONS: 'research_fanout_no_questions',
} as const;

export type ResearchFanoutErrorCode =
  (typeof RESEARCH_FANOUT_ERROR_CODES)[keyof typeof RESEARCH_FANOUT_ERROR_CODES];

/** Cap on simultaneously spawned research agents (anti-resource-exhaustion). */
export const RESEARCH_FANOUT_MAX_AGENTS = 5;

const researchFanoutInputSchema = z.object({
  questions: z
    .array(z.string().min(1))
    .min(1)
    .describe('Sub-questions to fan out to parallel research agents.'),
  max_agents: z
    .number()
    .int()
    .min(1)
    .max(RESEARCH_FANOUT_MAX_AGENTS)
    .optional()
    .describe('Optional cap on how many agents to spawn concurrently.'),
});

const researchFanoutDefinition: Tool = {
  name: RESEARCH_FANOUT_TOOL_NAME,
  description:
    'Parallelize the gathering phase: spawn one Research sub-agent per sub-question, run them concurrently, and return their aggregated findings. Call this while gathering when you have multiple independent sub-questions worth investigating in parallel.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sub-questions to fan out to parallel research agents.',
      },
      max_agents: {
        type: 'integer',
        minimum: 1,
        maximum: RESEARCH_FANOUT_MAX_AGENTS,
        description: `Optional cap on concurrent agents (default: all questions, capped at ${RESEARCH_FANOUT_MAX_AGENTS}).`,
      },
    },
    required: ['questions'],
  },
};

/** One fanned-out sub-agent's outcome. */
interface FanoutResult {
  question: string;
  ok: boolean;
  content?: string;
  error?: string;
  sessionId?: string;
}

const researchFanoutExecutor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parse = researchFanoutInputSchema.safeParse(input);
    if (!parse.success) {
      return errorFn(
        RESEARCH_FANOUT_TOOL_NAME,
        RESEARCH_FANOUT_ERROR_CODES.INVALID_INPUT,
        parse.error.message,
      );
    }

    if (researchModeTracker.state() !== 'gathering') {
      return errorFn(
        RESEARCH_FANOUT_TOOL_NAME,
        RESEARCH_FANOUT_ERROR_CODES.NOT_GATHERING,
        `research_fanout is only valid while gathering (current state: ${researchModeTracker.state()}).`,
      );
    }

    const questions = parse.data.questions;
    const maxAgents = Math.min(
      parse.data.max_agents ?? RESEARCH_FANOUT_MAX_AGENTS,
      RESEARCH_FANOUT_MAX_AGENTS,
    );
    const toRun = questions.slice(0, maxAgents);

    // Record the sub-questions so the continuation reminder reflects fan-out.
    for (const q of toRun) {
      researchModeTracker.addSubQuestion(q);
    }

    const results = await Promise.all(
      toRun.map((q) => runOne(q, workingDirectory, context)),
    );

    const sessionId = context?.options.sessionId;
    if (sessionId) {
      await persistSnapshot(
        researchModeTracker as unknown as ModeTracker<string, string, unknown>,
        sessionId,
      );
      // Surface the fan-out progress (sub-questions recorded) to the renderer.
      emitResearchUpdatedLocal(sessionId);
    }

    const aggregated = aggregate(results);
    return {
      id: crypto.randomUUID(),
      name: RESEARCH_FANOUT_TOOL_NAME,
      result: JSON.stringify(aggregated),
      error: false,
    };
  },
};

/** Spawn a single Research sub-agent for one sub-question and collect its text. */
async function runOne(
  question: string,
  workingDirectory: string | undefined,
  context: ToolUseContext | undefined,
): Promise<FanoutResult> {
  const prompt = RESEARCH_SUBAGENT_PROMPT(question);
  try {
    const res = await subagentTool.execute(
      {
        prompt,
        subagent_type: 'Research',
        run_in_background: false,
        name: `research: ${question.slice(0, 40)}`,
      },
      workingDirectory,
      context,
    );
    if (res.error) {
      return { question, ok: false, error: extractErrorText(res.result) };
    }
    const parsed = safeParse(res.result) as {
      content?: string;
      sessionId?: string;
    } | null;
    return {
      question,
      ok: true,
      content: parsed?.content ?? res.result,
      sessionId: parsed?.sessionId,
    };
  } catch (err) {
    return {
      question,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Combine per-question outcomes into a single model-facing summary. */
function aggregate(results: FanoutResult[]): {
  launched: number;
  succeeded: number;
  failed: number;
  findings: Array<{ question: string; content: string; sessionId?: string }>;
  errors: Array<{ question: string; error: string }>;
} {
  const findings = results
    .filter((r): r is FanoutResult & { content: string } => r.ok && r.content !== undefined)
    .map((r) => ({ question: r.question, content: r.content, sessionId: r.sessionId }));
  const errors = results
    .filter((r): r is FanoutResult & { error: string } => !r.ok && r.error !== undefined)
    .map((r) => ({ question: r.question, error: r.error }));
  return {
    launched: results.length,
    succeeded: findings.length,
    failed: errors.length,
    findings,
    errors,
  };
}

/** Build the Research sub-agent task prompt for a single sub-question. */
function RESEARCH_SUBAGENT_PROMPT(question: string): string {
  return `You are investigating one sub-question of a larger deep-research task. Provide a focused, evidence-based summary.

## Research Question
${question}

## Deliverable — return a structured markdown summary:
### Overview
### Key Findings
- Each finding with the source(s) that support it (title + URL where available).
### Sources Consulted
- List each source with a one-line note on authority / recency / bias.
### Uncertainties
- Anything you could not fully answer and why.

Be thorough but stay focused on this single question. Only report claims you can trace to a source you actually consulted.`;
}

function errorFn(
  name: string,
  code: ResearchFanoutErrorCode,
  message: string,
): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify({ error: message, error_code: code }),
    error: true,
  };
}

function extractErrorText(result: string): string {
  const parsed = safeParse(result) as { error?: string } | null;
  return parsed?.error ?? result;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** ToolRegistration pair injected by research mode (plan 423 §4). */
export function getResearchFanoutTool(): {
  definition: Tool;
  executor: ToolExecutor;
} {
  return { definition: researchFanoutDefinition, executor: researchFanoutExecutor };
}

/**
 * Emit a `chat:research_updated` worker event so the renderer's research
 * status card reflects fan-out progress. Mirrors research-tools' emit but
 * lives here to avoid a research-tools ⇄ research-fanout import cycle.
 */
function emitResearchUpdatedLocal(sessionId: string): void {
  sendEvent(
    buildResearchUpdatedEvent(sessionId, {
      state: researchModeTracker.state(),
      phase: researchModeTracker.phase(),
      query: researchModeTracker.query(),
      subQuestions: researchModeTracker.subQuestions(),
      sourcesGathered: researchModeTracker.sourcesGathered(),
      coverageGaps: researchModeTracker.coverageGaps(),
      rounds: researchModeTracker.rounds(),
      stallRounds: researchModeTracker.stallRounds(),
      history: researchModeTracker.history().map((h) => ({ at: h.at, event: h.event, detail: h.detail })),
    }) as unknown as Record<string, unknown>,
  );
}