/**
 * Session Search Section - Guidance for proactive session search
 *
 * Injected into system prompt to guide the model to use SessionSearch
 * when the user references past conversations.
 */

import type { PromptContext } from '../../types.js';
import { TOOL_NAMES } from '../../types.js';

/**
 * Get session search guidance section.
 * This helps the model understand when and how to use SessionSearch proactively.
 */
export function getSessionSearchSection(ctx: PromptContext): string | null {
  if (!ctx.enabledTools.has(TOOL_NAMES.SESSION_SEARCH)) {
    return null;
  }

  return `## Session Search

Use the \`SessionSearch\` tool proactively when:
- User says "we did this before", "remember when", "last time", "as I mentioned"
- User asks about a topic you worked on before but don't have in current context
- User references a past decision, configuration, or approach
- User says "in a previous session", "earlier we talked about"
- A long-running task or handoff appears to depend on a decision or failed approach that is not recorded in the current plan/spec

Search with concrete identifiers from the request: feature name, subsystem, file, error, plan title, or decision term. Prefer the repository's current plan/spec and code when they already answer the question. Search past sessions to recover missing context, not as a ritual on every task.

Results are summarized evidence, not current truth. Verify any drift-prone claim against the workspace before acting. If a recovered decision materially changes the task, record it in the canonical project artifact instead of leaving it only in chat history.`;
}
