export const DESCRIPTION = `Search your long-term memory of past conversations, or browse recent sessions.

TWO MODES:
1. Recent sessions (no query): Call with no query to browse recent root sessions grouped by current project and other projects.
2. Keyword search (with query): Search for specific topics across all past sessions.

USE THIS TOOL PROACTIVELY when:
- The user says "we did this before", "remember when", "last time", "as I mentioned"
- The user asks about a topic you worked on before but don't have in current context
- The user references a past decision, configuration, or approach
- The user says "in a previous session", "earlier we talked about"
- You suspect relevant cross-session context exists

HOW TO USE:
1. Formulate a search query based on the user's question
2. Use descriptive terms - search message content, not just session titles
3. Use OR between keywords for broader recall (e.g., "docker OR kubernetes")
4. Use roleFilter to exclude tool outputs if needed (e.g., "user,assistant")
5. Use scope="same_project" first for project work; expand to "other_projects" only when cross-project context is plausibly relevant
6. Review summarized results to find relevant context
7. Do NOT read full raw transcripts - use summaries for context

OUTPUT:
Returns summarized results from relevant sessions including:
- Session title and date
- Key decisions, solutions, or action items
- Relevant code snippets or file paths mentioned

OPTIONS:
- query: Search keywords (omit for recent sessions)
- limit: Max matching sessions to return; in recent all-project mode, applies per project group (default: 3, max: 5)
- roleFilter: Comma-separated roles to include (e.g., "user,assistant")
- scope: same_project, other_projects, or all (default)

LIMITATIONS:
- Only searches message content from non-deleted sessions
- Current session and its parent/child lineage are automatically excluded
- Results are summarized, not raw transcripts
- May not find very specific technical terms if they weren't explicitly discussed`;

export function getPrompt(): string {
  return DESCRIPTION;
}
