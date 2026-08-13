/**
 * Research per-round continuation reminders (plan 423 Phase 2).
 *
 * Renders the minimal continuation instruction injected by the
 * ModeCoordinator before each LLM call while a research run is active
 * (mirrors goal's `renderGoalContinuation`). The continuation carries only
 * the fields the model needs to keep working:
 *
 *   - the `<research-state>` block (query / state / phase / rounds /
 *     sources / elapsed / sub-questions / coverage gaps)
 *   - the "Research NOT complete — continue working" sentinel
 *   - state-specific working guidance (what to do next in this state)
 *
 * Templates are unwrapped inner text — call {@link renderReminder} (from
 * `plan/reminders.ts`) to wrap them in `<system-reminder>` before
 * appending to the timeline (same convention as goal/plan reminders).
 */

import type { ResearchTracker, ResearchState } from './research-tracker.js';

/** Sentinel that flags an incomplete research run to the model. */
export const RESEARCH_CONTINUATION_SENTINEL =
  'Research NOT complete — continue working.';

/**
 * Render the `<research-state>` block. Pure — reads only the tracker's
 * public accessors.
 */
export function renderResearchState(tracker: ResearchTracker): string {
  const elapsedMs =
    tracker.createdAt() > 0 ? Math.max(0, Date.now() - tracker.createdAt()) : 0;
  const subQuestions = tracker.subQuestions();
  const gaps = tracker.coverageGaps();
  const lines = [
    '<research-state>',
    `Query: ${tracker.query()}`,
    `State: ${tracker.state()} | Phase: ${tracker.phase()} | Rounds: ${tracker.rounds()} | Sources: ${tracker.sourcesGathered().length} | Elapsed: ${Math.floor(elapsedMs / 1000)}s`,
  ];
  if (subQuestions.length > 0) {
    lines.push(`Sub-questions: ${subQuestions.join('; ')}`);
  }
  if (gaps.length > 0) {
    lines.push(`Coverage gaps: ${gaps.join('; ')}`);
  }
  lines.push('</research-state>');
  return lines.join('\n');
}

/**
 * Render the per-round continuation instruction.
 *
 * Order:
 *  1. `<research-state>` block;
 *  2. the "Research NOT complete" sentinel;
 *  3. state-specific working guidance (what to do next in this state).
 */
export function renderResearchContinuation(tracker: ResearchTracker): string {
  const parts: string[] = [];
  parts.push(renderResearchState(tracker));
  parts.push('');
  parts.push(RESEARCH_CONTINUATION_SENTINEL);
  parts.push('');
  parts.push(stateGuidance(tracker.state()));
  return parts.join('\n');
}

/** State-specific "what to do next" guidance for the model. */
function stateGuidance(state: ResearchState): string {
  switch (state) {
    case 'clarifying':
      return 'Clarify scope, depth, and success criteria with the user via ask_user_question if the query is ambiguous. When the plan is set, call research_advance to move to planning.';
    case 'planning':
      return 'Break the query into concrete sub-questions and a search strategy. Then call research_advance to move to gathering and start searching the web.';
    case 'gathering':
      return 'Continue searching and gathering sources (use research_fanout to parallelize independent sub-questions). Cross-corroborate claims across independent sources. When evidence is sufficient (or you have hit diminishing returns), call research_advance to move to evaluating.';
    case 'evaluating':
      return 'Evaluate gathered sources for authority, recency, and bias. If coverage gaps remain, you may advance back to gathering for more evidence. When satisfied, call research_advance to move to synthesizing, then write the report.';
    case 'synthesizing':
      return 'Write the research report now as a structured markdown document, then call research_report(completed: true) to finalize.';
    case 'awaiting_input':
      return 'A user answer is required before you can continue. Once the user has answered, call research_continue to resume the investigation.';
    case 'blocked':
      return 'The research is blocked waiting on a user decision. Once the user unblocks it, call research_continue to resume the investigation.';
    case 'complete':
    case 'idle':
      return '';
  }
}