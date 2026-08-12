/**
 * Goal summarizer (grok goal_summarizer.rs, duya-ized).
 *
 * Runs ONCE after a goal is verified-ACHIEVED to produce the closing
 * user-facing summary — the last thing the user reads. Read-only, using
 * the same verification agent (its prompt forbids project writes).
 *
 * Fail-OPEN (grok): the goal is already complete before this runs, so any
 * failure (transport / runtime / empty output) is logged and ignored —
 * completion is never blocked. The surfaced summary is capped at
 * `SUMMARY_MAX_CHARS` so a model that ignores the word cap cannot flood
 * the reply.
 */

import type { AgentDefinition } from '../../tool/SubagentTool/loadAgentsDir.js';
import { runAgentSync } from '../../tool/SubagentTool/runAgent.js';
import type { Message, ToolUseContext } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { findVerificationAgent } from './goal-evaluator.js';

/** Hard backstop on the surfaced summary length (grok: 1200 chars). */
export const SUMMARY_MAX_CHARS = 1200;

export interface GoalSummaryParams {
  objective: string;
  /** The model's final completion message (what it claimed). */
  finalSummary: string;
  /** Verifier gaps summary from the final (achieved) round, if any. */
  gapsSummary?: string;
  context: ToolUseContext;
  agentDefinitions?: AgentDefinition[];
  maxTurns?: number;
}

/**
 * Produce the closing summary. Fail-open: always resolves, returning a
 * non-empty summary on success or undefined on any failure (caller treats
 * undefined as "skip the closing summary, goal stays complete").
 */
export async function summarizeGoalCompletion(
  params: GoalSummaryParams,
): Promise<string | undefined> {
  const { objective, finalSummary, gapsSummary, context, agentDefinitions, maxTurns } = params;

  const definition = findVerificationAgent(agentDefinitions);
  if (!definition) {
    logger.warn('[GoalSummarizer] no agent available; skipping closing summary', undefined, 'GoalSummarizer');
    return undefined;
  }

  const prompt = [
    'You are summarizing a completed goal for the user. The goal has been independently verified as ACHIEVED.',
    '',
    '## Objective',
    objective,
    '',
    '## What the agent claimed to deliver',
    finalSummary,
    '',
    gapsSummary && gapsSummary.trim().length > 0
      ? `## Final verifier notes\n${gapsSummary.trim()}`
      : '',
    '',
    'Write a concise closing summary (≤120 words) the user reads as the final word on this goal: what was delivered, how it was verified, and any follow-up worth noting. Read-only — do not modify files. Output ONLY the summary text.',
  ]
    .filter((s) => s !== '')
    .join('\n');

  const promptMessages: Message[] = [
    { id: crypto.randomUUID(), role: 'user', content: prompt, timestamp: Date.now() },
  ];

  try {
    const result = await runAgentSync({
      agentDefinition: definition,
      promptMessages,
      toolUseContext: context,
      isAsync: false,
      maxTurns: maxTurns ?? 6,
      availableTools: context.options.tools,
      description: `Goal summarizer: ${objective.slice(0, 60)}`,
      agentId: crypto.randomUUID(),
    });
    const text = extractText(result).trim();
    if (!text) {
      logger.warn('[GoalSummarizer] empty summary; skipping', undefined, 'GoalSummarizer');
      return undefined;
    }
    return text.slice(0, SUMMARY_MAX_CHARS);
  } catch (err) {
    logger.warn(
      `[GoalSummarizer] failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      'GoalSummarizer',
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
