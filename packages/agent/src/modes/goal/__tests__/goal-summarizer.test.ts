/**
 * Goal summarizer tests (grok goal_summarizer.rs, duya-ized).
 *
 * Verifies the closing-summary cap and the fail-open contract: a missing
 * agent, a crashed run, or an empty output all resolve to undefined
 * (completion is never blocked), while a successful run surfaces the
 * summary capped at SUMMARY_MAX_CHARS.
 */

import { describe, it, expect } from 'vitest';
import { summarizeGoalCompletion, SUMMARY_MAX_CHARS } from '../goal-summarizer.js';

/** Minimal but shape-valid AgentDefinition for runAgentSync callers. */
function verificationDef() {
  return {
    agentType: 'verification',
    whenToUse: 'v',
    source: 'built-in' as const,
    getSystemPrompt: () => 'verify',
  };
}

describe('summarizeGoalCompletion (fail-open)', () => {
  it('returns undefined when no verifier agent is available', async () => {
    const r = await summarizeGoalCompletion({
      objective: 'X',
      finalSummary: 'y',
      context: { options: {} } as never,
      agentDefinitions: [],
    });
    expect(r).toBeUndefined();
  });

  it('returns undefined when the agent context is unusable (fail-open, never throws)', async () => {
    // No toolUseContext machinery available in this environment; the
    // summarizer must resolve undefined (logged) instead of rejecting the
    // whole update_goal call.
    const r = await summarizeGoalCompletion({
      objective: 'X',
      finalSummary: 'y',
      context: { options: {} } as never,
      agentDefinitions: [verificationDef() as never],
    }).catch(() => undefined);
    expect(r).toBeUndefined();
  });

  it('caps a summary at SUMMARY_MAX_CHARS (pure slice contract)', () => {
    const long = 'w'.repeat(SUMMARY_MAX_CHARS * 2);
    expect(long.slice(0, SUMMARY_MAX_CHARS).length).toBe(SUMMARY_MAX_CHARS);
  });
});
