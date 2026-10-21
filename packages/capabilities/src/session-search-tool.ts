/**
 * SessionSearchTool - Search past conversation sessions
 *
 * Searches SQLite database via FTS5 for relevant session history
 * and returns summarized results using an auxiliary LLM.
 *
 * Enhanced features:
 * - Smart truncation around search matches (max 100k chars per session)
 * - Current session exclusion (with parent/child lineage resolution)
 * - Parallel summarization with concurrency control
 * - Role-based message filtering
 * - Retry mechanism with exponential backoff
 */

import { randomUUID } from 'node:crypto';
import { BaseTool } from './BaseTool.js';
import type { ToolResult, ToolUseContext } from './contracts/tool.js';

export const SESSION_SEARCH_TOOL_NAME = 'SessionSearch';
export type SessionDirectoryScope = 'same_project' | 'other_projects' | 'all';

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
4. Use scope="same_project" first for project work; expand to "other_projects" only when cross-project context is plausibly relevant
5. Review summarized results to find relevant context
6. Do NOT read full raw transcripts - use summaries for context

OUTPUT:
Returns summarized results from relevant sessions including:
- Session title and date
- Key decisions, solutions, or action items
- Relevant code snippets or file paths mentioned

OPTIONS:
- query: Search keywords (omit for recent sessions)
- limit: Max matching sessions to return; in recent all-project mode, applies per project group (default: 3, max: 5)
- scope: same_project, other_projects, or all (default)

LIMITATIONS:
- Only searches message content from non-deleted sessions
- Current session and its parent/child lineage are automatically excluded
- Results are summarized, not raw transcripts
- May not find very specific technical terms if they weren't explicitly discussed`;

export interface SummaryLLMConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  baseURL?: string;
}

export interface SessionMatchInfo {
  sessionId: string;
  title: string;
  projectName: string;
  source: string;
  sessionStarted: number;
  model?: string;
  /** Content-match snippet from the Host query service. */
  snippet?: string;
}

export interface SessionSearchMessage {
  role: string;
  content: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
}

export interface RecentSessionDirectoryEntry {
  sessionId: string;
  title: string;
  updatedAt: number;
  childCount: number;
}

export interface RecentSessionDirectory {
  sameProject: RecentSessionDirectoryEntry[];
  otherProjects: RecentSessionDirectoryEntry[];
}

export interface SessionSearchRequest {
  query: string;
  limit: number;
  scope: SessionDirectoryScope;
  workingDirectory: string;
  currentSessionId: string | null;
}

export interface SessionSearchPort {
  searchSessions(request: SessionSearchRequest): Promise<SessionMatchInfo[]>;
  loadRecentSessionDirectory(options: {
    currentSessionId: string | null;
    workingDirectory: string;
    sameProjectLimit: number;
    otherProjectLimit: number;
  }): Promise<RecentSessionDirectory>;
  getMessages(sessionId: string): Promise<readonly SessionSearchMessage[]>;
  streamSummary(
    config: SummaryLLMConfig,
    request: { systemPrompt: string; userPrompt: string; maxTokens: number },
  ): AsyncIterable<string>;
  warn?(message: string, context?: Record<string, unknown>): void;
}

/**
 * Configuration for the auxiliary LLM used to summarize search results.
 * If not configured, falls back to template-based summarization.
 */
interface SessionSummary {
  sessionId: string;
  title: string;
  projectName: string;
  when: string;
  source: string;
  model?: string;
  summary: string;
}

// Constants
const MAX_SESSION_CHARS = 100_000;
const MAX_SUMMARY_TOKENS = 10000;
const MAX_RESULT_LIMIT = 5;
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_CONCURRENCY_LIMIT = 5;
const SUMMARY_TIMEOUT_MS = 60000;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 1000;

/**
 * Format timestamp to human-readable date
 * Handles both seconds and milliseconds timestamps
 */
function formatTimestamp(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined) {
    return 'unknown';
  }
  try {
    let numTs = typeof ts === 'string' ? parseFloat(ts) : ts;
    if (isNaN(numTs)) {
      return String(ts);
    }
    // Detect if timestamp is in seconds (before 2000-01-01 in ms would be very small)
    // Unix timestamp in seconds for 2000-01-01 is 946684800
    // In milliseconds it would be 946684800000
    if (numTs < 10000000000) {
      // Likely seconds, convert to milliseconds
      numTs = numTs * 1000;
    }
    const date = new Date(numTs);
    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return String(ts);
  }
}

/**
 * Format conversation messages into readable transcript
 */
function formatConversation(messages: readonly SessionSearchMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    const content = msg.content || '';
    const toolName = msg.tool_name;

    if (role === 'TOOL' && toolName) {
      // Truncate long tool outputs
      if (content.length > 500) {
        const truncated = content.slice(0, 250) + '\n...[truncated]...\n' + content.slice(-250);
        parts.push(`[TOOL:${toolName}]: ${truncated}`);
      } else {
        parts.push(`[TOOL:${toolName}]: ${content}`);
      }
    } else if (role === 'ASSISTANT') {
      // Include tool call info if present
      const toolInput = msg.tool_input;
      if (toolInput && toolInput !== '{}') {
        try {
          const parsed = JSON.parse(toolInput);
          const toolCallName = parsed.name || msg.tool_name;
          if (toolCallName) {
            parts.push(`[ASSISTANT]: [Called: ${toolCallName}]`);
          }
        } catch {
          // Ignore parse error
        }
      }
      if (content) {
        parts.push(`[ASSISTANT]: ${content}`);
      }
    } else {
      parts.push(`[${role}]: ${content}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Truncate conversation text around search matches
 * Strategy:
 * 1. Try to find full query as phrase (case-insensitive)
 * 2. If no phrase hit, look for positions where all query terms appear within 200-char proximity
 * 3. Fall back to individual term positions
 * 4. Pick window that covers the most match positions
 */
function truncateAroundMatches(fullText: string, query: string, maxChars: number = MAX_SESSION_CHARS): string {
  if (fullText.length <= maxChars) {
    return fullText;
  }

  const textLower = fullText.toLowerCase();
  const queryLower = query.toLowerCase().trim();
  let matchPositions: number[] = [];

  // 1. Full-phrase search
  const phraseRegex = new RegExp(escapeRegex(queryLower), 'g');
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(textLower)) !== null) {
    matchPositions.push(match.index);
  }

  // 2. Proximity co-occurrence of all terms (within 200 chars)
  if (matchPositions.length === 0) {
    const terms = queryLower.split(/\s+/).filter(t => t.length > 0);
    if (terms.length > 1) {
      const termPositions: Map<string, number[]> = new Map();
      for (const term of terms) {
        const positions: number[] = [];
        const termRegex = new RegExp(escapeRegex(term), 'g');
        let tm: RegExpExecArray | null;
        while ((tm = termRegex.exec(textLower)) !== null) {
          positions.push(tm.index);
        }
        termPositions.set(term, positions);
      }

      // Find rarest term
      let rarestTerm = terms[0];
      let rarestCount = termPositions.get(rarestTerm)?.length ?? Infinity;
      for (const term of terms) {
        const count = termPositions.get(term)?.length ?? Infinity;
        if (count < rarestCount) {
          rarestCount = count;
          rarestTerm = term;
        }
      }

      // Check proximity for rarest term positions
      for (const pos of termPositions.get(rarestTerm) ?? []) {
        const allOthersNearby = terms.every(t => {
          if (t === rarestTerm) return true;
          const positions = termPositions.get(t) ?? [];
          return positions.some(p => Math.abs(p - pos) < 200);
        });
        if (allOthersNearby) {
          matchPositions.push(pos);
        }
      }
    }
  }

  // 3. Individual term positions (last resort)
  if (matchPositions.length === 0) {
    const terms = queryLower.split(/\s+/).filter(t => t.length > 0);
    for (const term of terms) {
      const termRegex = new RegExp(escapeRegex(term), 'g');
      let tm: RegExpExecArray | null;
      while ((tm = termRegex.exec(textLower)) !== null) {
        matchPositions.push(tm.index);
      }
    }
  }

  if (matchPositions.length === 0) {
    // Nothing at all - take from start
    const truncated = fullText.slice(0, maxChars);
    const suffix = maxChars < fullText.length ? '\n\n...[later conversation truncated]...' : '';
    return truncated + suffix;
  }

  // 4. Pick window that covers the most match positions
  matchPositions.sort((a, b) => a - b);

  let bestStart = 0;
  let bestCount = 0;
  for (const candidate of matchPositions) {
    const windowStart = Math.max(0, candidate - Math.floor(maxChars / 4)); // bias: 25% before, 75% after
    const windowEnd = windowStart + maxChars;
    const actualStart = windowEnd > fullText.length ? Math.max(0, fullText.length - maxChars) : windowStart;
    const count = matchPositions.filter(p => actualStart <= p && p < actualStart + maxChars).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = actualStart;
    }
  }

  const start = bestStart;
  const end = Math.min(fullText.length, start + maxChars);

  const truncated = fullText.slice(start, end);
  const prefix = start > 0 ? '...[earlier conversation truncated]...\n\n' : '';
  const suffix = end < fullText.length ? '\n\n...[later conversation truncated]...' : '';
  return prefix + truncated + suffix;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SessionSearchTool extends BaseTool {
  readonly name = SESSION_SEARCH_TOOL_NAME;
  readonly description = DESCRIPTION;
  private summaryLLMConfig: SummaryLLMConfig | null = null;
  private currentSessionId: string | null = null;
  private maxConcurrency: number = DEFAULT_MAX_CONCURRENCY;

  constructor(private readonly port: SessionSearchPort) {
    super();
  }

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for past session content. Omit for recent sessions.',
      },
      limit: {
        type: 'number',
        description: 'Maximum matching sessions to return (per project group in recent mode; default: 3, max: 5)',
        default: 3,
      },
      scope: {
        type: 'string',
        enum: ['same_project', 'other_projects', 'all'],
        default: 'all',
        description: 'Limit results to the current project, other projects, or all sessions.',
      },
    },
  };

  /**
   * Configure the auxiliary LLM for summarization.
   * If not called, falls back to template-based summarization.
   */
  configureSummaryLLM(config: SummaryLLMConfig): void {
    this.summaryLLMConfig = config;
  }

  /**
   * Set the current session ID to exclude from search results
   */
  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Set maximum concurrency for parallel summarization
   */
  setMaxConcurrency(concurrency: number): void {
    this.maxConcurrency = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY_LIMIT));
  }

  /**
   * Get the current LLM configuration (for testing)
   */
  getSummaryLLMConfig(): SummaryLLMConfig | null {
    return this.summaryLLMConfig;
  }

  private parseScope(value: unknown): SessionDirectoryScope {
    return value === 'same_project' || value === 'other_projects' || value === 'all'
      ? value
      : 'all';
  }

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    // Defensive: coerce limit to safe integer
    let limitRaw = input.limit ?? 3;
    let limit: number;
    if (typeof limitRaw !== 'number') {
      const parsed = Number(limitRaw);
      limit = isNaN(parsed) ? 3 : parsed;
    } else {
      limit = limitRaw;
    }
    limit = Math.max(1, Math.min(limit, MAX_RESULT_LIMIT));

    const query = (input.query as string | undefined)?.trim();
    const scope = this.parseScope(input.scope);
    const currentSessionId = context?.options?.sessionId || this.currentSessionId;
    const currentWorkingDirectory = workingDirectory || context?.options?.workingDirectory || '';

    try {
      if (!query) {
        // No query - return recent sessions
        const recent = await this.port.loadRecentSessionDirectory({
          currentSessionId,
          workingDirectory: currentWorkingDirectory,
          sameProjectLimit: scope === 'other_projects' ? 0 : limit,
          otherProjectLimit: scope === 'same_project' ? 0 : limit,
        });
        // Flatten the grouped directory into a single list of search
        // results for the formatter. The formatter no longer takes a
        // directory + scope; it takes a flat array so it can be tested
        // in isolation without constructing directory fixtures.
        const flatSessions = [
          ...(scope !== 'other_projects' ? recent.sameProject : []),
          ...(scope !== 'same_project' ? recent.otherProjects : []),
        ].map(entry => ({
          sessionId: entry.sessionId,
          title: entry.title,
          date: formatTimestamp(entry.updatedAt),
          snippet: `${entry.childCount} child session(s)`,
        }));
        return {
          id: randomUUID(),
          name: this.name,
          result: this.formatRecentSessions(flatSessions),
        };
      }

      // Search with query via FTS5
      const results = await this.port.searchSessions({
        query,
        limit,
        scope,
        workingDirectory: currentWorkingDirectory,
        currentSessionId: currentSessionId || null,
      });

      if (results.length === 0) {
        return {
          id: randomUUID(),
          name: this.name,
          result: 'No relevant past sessions found for your query.',
        };
      }

      // Summarize results with parallel processing
      const summary = await this.summarizeResultsParallel(results, query);

      return {
        id: randomUUID(),
        name: this.name,
        result: summary,
      };
    } catch (error) {
      return {
        id: randomUUID(),
        name: this.name,
        result: `Session search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: true,
      };
    }
  }

  /**
   * Format recent sessions as readable output.
   *
   * Accepts a flat list of search-style results (sessionId / title / date /
   * snippet) rather than the grouped RecentSessionDirectory shape. The
   * grouping by "Same Project" / "Other Projects" is now done by the
   * caller (execute) before projection, so the formatter is a pure
   * presentation function that can be unit-tested in isolation.
   *
   * Each session is rendered as:
   *   Session ID: <sessionId>
   *   - Title: ...
   *   - Date: ...
   *   ```json
   *   { "sessionId": "...", "title": "...", "date": "..." }
   *   ```
   *
   * Defensive: if sessionId is empty/undefined upstream (the classic
   * `row.id` vs `row.sessionId` SQL alias bug), we emit an empty string
   * rather than the literal text "undefined" so the error is visible
   * without polluting downstream JSON parsing.
   */
  private formatRecentSessions(
    sessions: Array<{
      sessionId: string;
      title: string;
      date: string;
      snippet?: string;
    }>,
  ): string {
    if (sessions.length === 0) {
      return 'No recent sessions found.';
    }

    const lines = ['<session-directory>', '## Recent Sessions', ''];
    for (const session of sessions) {
      // Coerce undefined/null to empty string so we never emit the
      // literal text "undefined" — that would silently look like a
      // valid session id and hide the upstream projection bug.
      const sid = session.sessionId ?? '';
      const title = session.title ?? 'Untitled';
      const date = session.date ?? '';
      const snippet = session.snippet ?? '';

      lines.push(`Session ID: ${sid}`);
      lines.push(`- Title: ${title}`);
      lines.push(`- Date: ${date}`);
      if (snippet) {
        lines.push(`- Snippet: ${snippet}`);
      }
      lines.push('```json');
      lines.push(JSON.stringify({
        sessionId: sid,
        title,
        date,
      }, null, 2));
      lines.push('```', '');
    }

    lines.push('</session-directory>');
    return lines.join('\n');
  }

  /**
   * Summarize search results in parallel with concurrency control
   */
  private async summarizeResultsParallel(
    results: SessionMatchInfo[],
    query: string,
  ): Promise<string> {
    if (results.length === 0) {
      return 'No relevant past sessions found for your query.';
    }

    // Load all session conversations
    const sessionData: Array<{
      sessionId: string;
      matchInfo: SessionMatchInfo;
      conversationText: string;
    }> = [];

    for (const matchInfo of results) {
      try {
        // Prefer the content-match snippet returned by the main process
        // (rollout scan). It pinpoints the exact matching text, so we avoid
        // loading/re-truncating the whole conversation — and it stays correct
        // even when the session was compacted. Fall back to the full
        // conversation only when the search produced a metadata-only hit
        // (empty snippet).
        const snippet = matchInfo.snippet?.trim();
        let conversationText: string;
        if (snippet) {
          conversationText = snippet;
        } else {
          const messages = await this.port.getMessages(matchInfo.sessionId);
          if (!messages || messages.length === 0) continue;
          conversationText = truncateAroundMatches(formatConversation(messages), query);
        }

        sessionData.push({
          sessionId: matchInfo.sessionId,
          matchInfo,
          conversationText,
        });
      } catch (error) {
        this.port.warn?.(`Failed to load session ${matchInfo.sessionId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (sessionData.length === 0) {
      return 'Found matching sessions but could not load conversation data.';
    }

    // Summarize all sessions with bounded concurrency
    const semaphore = new Semaphore(this.maxConcurrency);
    const summaryPromises = sessionData.map(async ({ sessionId, matchInfo, conversationText }) => {
      await semaphore.acquire();
      try {
        const summary = await this.summarizeSessionWithRetry(conversationText, query, matchInfo);
        return {
          sessionId,
          title: matchInfo.title,
          projectName: matchInfo.projectName,
          when: formatTimestamp(matchInfo.sessionStarted),
          source: matchInfo.source,
          model: matchInfo.model,
          summary: summary || this.createFallbackPreview(conversationText),
        };
      } finally {
        semaphore.release();
      }
    });

    const summaries = await Promise.all(summaryPromises);

    // Format output
    return this.formatSummaries(summaries, query);
  }

  /**
   * Summarize a single session with retry logic
   */
  private async summarizeSessionWithRetry(
    conversationText: string,
    query: string,
    sessionMeta: SessionMatchInfo,
  ): Promise<string | null> {
    if (!this.summaryLLMConfig) {
      return null; // Will use fallback
    }

    const systemPrompt =
      `You are reviewing a past conversation transcript to help recall what happened. ` +
      `Summarize the conversation with a focus on the search topic. Include:\n` +
      `1. What the user asked about or wanted to accomplish\n` +
      `2. What actions were taken and what the outcomes were\n` +
      `3. Key decisions, solutions found, or conclusions reached\n` +
      `4. Any specific commands, files, URLs, or technical details that were important\n` +
      `5. Anything left unresolved or notable\n\n` +
      `Be thorough but concise. Preserve specific details (commands, paths, error messages) ` +
      `that would be useful to recall. Write in past tense as a factual recap.`;

    const userPrompt =
      `Search topic: ${query}\n` +
      `Session source: ${sessionMeta.source}\n` +
      `Session date: ${formatTimestamp(sessionMeta.sessionStarted)}\n\n` +
      `CONVERSATION TRANSCRIPT:\n${conversationText}\n\n` +
      `Summarize this conversation with focus on: ${query}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let summary = '';

        const streamPromise = (async () => {
          for await (const chunk of this.port.streamSummary(this.summaryLLMConfig!, {
            systemPrompt,
            userPrompt,
            maxTokens: MAX_SUMMARY_TOKENS,
          })) {
            summary += chunk;
          }
        })();

        const timeoutPromise = sleep(SUMMARY_TIMEOUT_MS).then(() => {
          throw new Error('Summary generation timed out');
        });

        await Promise.race([streamPromise, timeoutPromise]);

        if (summary.trim()) {
          return summary;
        }
      } catch (error) {
        this.port.warn?.(`Summarization attempt ${attempt + 1}/${MAX_RETRIES} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_BASE_MS * (attempt + 1));
        }
      }
    }

    return null; // All retries failed
  }

  /**
   * Create fallback preview when summarization fails
   */
  private createFallbackPreview(conversationText: string): string {
    const preview = conversationText.slice(0, 500);
    return `[Raw preview — summarization unavailable]\n${preview}${conversationText.length > 500 ? '\n...[truncated]' : ''}`;
  }

  /**
   * Format summaries into final output
   */
  private formatSummaries(summaries: SessionSummary[], query: string): string {
    const lines = ['<session-context>\n## Relevant Past Sessions\n'];
    lines.push(`Search query: "${query}"\n`);

    for (const s of summaries) {
      // Heading uses sessionId (not title) so downstream agents can
      // anchor the JSON envelope to the markdown section even if the
      // aux summarizer rewrote the natural-language title.
      lines.push(`### Session: ${s.sessionId}`);
      lines.push(`- **Session ID**: ${s.sessionId}`);
      lines.push(`- **Project**: ${s.projectName}`);
      lines.push(`- **When**: ${s.when}`);
      lines.push(`- **Source**: ${s.source}`);
      if (s.model) {
        lines.push(`- **Model**: ${s.model}`);
      }
      lines.push('');
      // Machine-readable JSON envelope: do NOT change summary text,
      // but emit a structured payload alongside the markdown so an
      // LLM-driven downstream agent can still recover `sessionId`
      // even if the aux summarizer rewrote the natural-language part.
      lines.push('```json');
      lines.push(JSON.stringify({
        sessionId: s.sessionId,
        title: s.title,
        project: s.projectName,
        when: s.when,
        source: s.source,
        model: s.model ?? null,
      }, null, 2));
      lines.push('```');
      lines.push('');
      lines.push(s.summary);
      lines.push('');
    }

    lines.push('</session-context>');
    return lines.join('\n');
  }

}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.permits++;
    }
  }
}
