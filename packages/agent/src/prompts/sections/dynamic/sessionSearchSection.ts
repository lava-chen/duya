/**
 * Session Search Section - Guidance for proactive session search
 *
 * Injected into system prompt to guide the model to use SessionSearch
 * when the user references past conversations.
 */

import type { PromptContext } from '../../types.js';

/**
 * Get session search guidance section.
 * This helps the model understand when and how to use SessionSearch proactively.
 */
export function getSessionSearchSection(_ctx: PromptContext): string {
  return `## Session Search

Use the \`SessionSearch\` tool proactively when:
- User says "we did this before", "remember when", "last time", "as I mentioned"
- User asks about a topic you worked on before but don't have in current context
- User references a past decision, configuration, or approach
- User says "in a previous session", "earlier we talked about"
- You suspect relevant cross-session context exists

When searching, use descriptive terms from the user's question as the query.
Results are summarized, not raw transcripts - focus on key decisions and outcomes.`;
}
