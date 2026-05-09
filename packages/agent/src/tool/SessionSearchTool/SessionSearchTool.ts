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

import { BaseTool } from '../BaseTool.js';
import type { ToolResult, Message } from '../../types.js';
import type { MessageRow } from '../../session/db.js';
import { SESSION_SEARCH_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import { getDb, getMessages } from '../../session/db.js';
import { AnthropicClient } from '../../llm/anthropic-client.js';
import { OpenAIClient } from '../../llm/openai-client.js';
import type { LLMClient } from '../../llm/base.js';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Configuration for the auxiliary LLM used to summarize search results.
 * If not configured, falls back to template-based summarization.
 */
export interface SummaryLLMConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  baseURL?: string;
}

interface SessionSearchResult {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  snippet: string;
}

interface SearchResult {
  sessionId: string;
  title: string;
  date: string;
  snippet: string;
}

interface SessionMatchInfo {
  sessionId: string;
  source: string;
  sessionStarted: number;
  model?: string;
}

interface SessionSummary {
  sessionId: string;
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
function formatConversation(messages: MessageRow[]): string {
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

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for past session content. Omit for recent sessions.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 3, max: 5)',
        default: 3,
      },
      roleFilter: {
        type: 'string',
        description: 'Optional: only search messages from specific roles (comma-separated). E.g. "user,assistant" to skip tool outputs.',
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

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
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
    const roleFilter = (input.roleFilter as string | undefined)?.trim();

    try {
      if (!query) {
        // No query - return recent sessions
        const recent = this.getRecentSessions(limit);
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: this.formatRecentSessions(recent),
        };
      }

      // Search with query via FTS5
      const results = await this.searchSessions(query, limit, roleFilter);

      if (results.length === 0) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: 'No relevant past sessions found for your query.',
        };
      }

      // Summarize results with parallel processing
      const summary = await this.summarizeResultsParallel(results, query);

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: summary,
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Session search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: true,
      };
    }
  }

  /**
   * Resolve session to its root parent (for delegation/compression lineage)
   */
  private resolveToParent(sessionId: string, db: BetterSqlite3.Database): string {
    const visited = new Set<string>();
    let sid = sessionId;
    const stmt = db.prepare('SELECT parent_session_id FROM chat_sessions WHERE id = ?');
    while (sid && !visited.has(sid)) {
      visited.add(sid);
      try {
        const row = stmt.get(sid) as { parent_session_id?: string } | undefined;
        if (row?.parent_session_id) {
          sid = row.parent_session_id;
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    return sid;
  }

  /**
   * Get the root session ID of current session lineage
   */
  private getCurrentSessionRoot(db: BetterSqlite3.Database): string | null {
    if (!this.currentSessionId) return null;
    return this.resolveToParent(this.currentSessionId, db);
  }

  /**
   * Deduplicate rows by resolved parent session, exclude current lineage.
   */
  private deduplicateAndExcludeRows(
    rows: Array<{ sessionId: string; sessionStarted: number; model?: string }>,
    limit: number,
    db: BetterSqlite3.Database,
    currentRoot: string | null,
  ): SessionMatchInfo[] {
    const seenSessions = new Map<string, SessionMatchInfo>();
    for (const row of rows) {
      const rawSid = row.sessionId;
      const resolvedSid = this.resolveToParent(rawSid, db);

      if (currentRoot && resolvedSid === currentRoot) continue;
      if (this.currentSessionId && rawSid === this.currentSessionId) continue;

      if (!seenSessions.has(resolvedSid)) {
        seenSessions.set(resolvedSid, {
          sessionId: resolvedSid,
          source: 'cli',
          sessionStarted: row.sessionStarted,
          model: row.model,
        });
      }

      if (seenSessions.size >= limit) break;
    }

    return Array.from(seenSessions.values());
  }

  /**
   * Search sessions via FTS5 with role filtering and current session exclusion
   */
  private async searchSessions(
    query: string,
    limit: number,
    roleFilter?: string,
  ): Promise<SessionMatchInfo[]> {
    const db = getDb();
    const currentRoot = this.getCurrentSessionRoot(db);

    // Parse role filter
    const roleList = roleFilter
      ? roleFilter.split(',').map(r => r.trim()).filter(r => r.length > 0)
      : null;

    // Try FTS5 search first
    try {
      const ftsQuery = this.prepareFtsQuery(query);

      let sql = `
        SELECT
          s.id as sessionId,
          s.title,
          s.created_at as sessionStarted,
          s.model
        FROM messages_fts
        JOIN chat_sessions s ON messages_fts.session_id = s.id
        WHERE messages_fts MATCH ?
          AND s.is_deleted = 0
      `;

      const params: (string | number)[] = [ftsQuery];

      // Add role filter if specified (need to join with messages table)
      if (roleList && roleList.length > 0) {
        sql += ` AND messages_fts.rowid IN (
          SELECT rowid FROM messages WHERE role IN (${roleList.map(() => '?').join(',')})
        )`;
        params.push(...roleList);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit * 3); // Fetch more to account for filtering

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as Array<{
        sessionId: string;
        title: string;
        sessionStarted: number;
        model?: string;
      }>;

      return this.deduplicateAndExcludeRows(rows, limit, db, currentRoot);
    } catch (error) {
      // FTS5 not available or error - fall back to LIKE search
      console.warn('[SessionSearch] FTS5 search failed, falling back to LIKE search:', error instanceof Error ? error.message : String(error));
      return this.searchSessionsFallback(query, limit, roleList, db, currentRoot);
    }
  }

  /**
   * Fallback LIKE search when FTS5 is unavailable
   */
  private searchSessionsFallback(
    query: string,
    limit: number,
    roleList: string[] | null,
    db: BetterSqlite3.Database,
    currentRoot: string | null,
  ): SessionMatchInfo[] {
    const likeQuery = `%${query}%`;

    let sql = `
      SELECT DISTINCT
        s.id as sessionId,
        s.title,
        s.created_at as sessionStarted,
        s.model
      FROM messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.content LIKE ?
        AND s.is_deleted = 0
    `;

    const params: (string | number)[] = [likeQuery];

    if (roleList && roleList.length > 0) {
      sql += ` AND m.role IN (${roleList.map(() => '?').join(',')})`;
      params.push(...roleList);
    }

    sql += ` ORDER BY s.updated_at DESC LIMIT ?`;
    params.push(limit * 3);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      sessionId: string;
      title: string;
      sessionStarted: number;
      model?: string;
    }>;

    return this.deduplicateAndExcludeRows(rows, limit, db, currentRoot);
  }

  /**
   * Get recent sessions without search
   */
  private getRecentSessions(limit: number): SearchResult[] {
    const db = getDb();
    const currentRoot = this.getCurrentSessionRoot(db);

    const sql = `
      SELECT
        s.id as sessionId,
        s.title,
        s.created_at,
        s.updated_at,
        substr(m.content, 1, 200) as snippet
      FROM chat_sessions s
      LEFT JOIN messages m ON s.id = m.session_id
        AND m.rowid = (
          SELECT rowid FROM messages
          WHERE session_id = s.id AND role = 'user'
          ORDER BY created_at DESC LIMIT 1
        )
      WHERE s.is_deleted = 0
      ORDER BY s.updated_at DESC
      LIMIT ?
    `;

    const stmt = db.prepare(sql);
    const rows = stmt.all(limit * 2) as SessionSearchResult[]; // Fetch extra to account for filtering

    const results: SearchResult[] = [];
    for (const row of rows) {
      const resolvedSid = this.resolveToParent(row.id, db);

      // Skip current session lineage
      if (currentRoot && resolvedSid === currentRoot) continue;
      if (this.currentSessionId && row.id === this.currentSessionId) continue;

      results.push({
        sessionId: row.id,
        title: row.title || 'Untitled',
        date: new Date(row.updated_at).toLocaleDateString(),
        snippet: row.snippet ? row.snippet.slice(0, 100) + '...' : 'No messages',
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Format recent sessions as readable output
   */
  private formatRecentSessions(sessions: SearchResult[]): string {
    if (sessions.length === 0) {
      return 'No recent sessions found.';
    }

    const lines = ['## Recent Sessions\n'];
    for (const s of sessions) {
      lines.push(`### "${s.title}" (${s.date})`);
      lines.push(`Session ID: ${s.sessionId}`);
      lines.push(`Last activity: ${s.snippet}\n`);
    }

    return lines.join('\n');
  }

  /**
   * Prepare query for FTS5 - escape special chars and handle prefixes
   */
  private prepareFtsQuery(query: string): string {
    const escaped = query
      .replace(/['"]/g, '')
      .replace(/[+\-&|!(){}[\]^~*?:]/g, ' ')
      .trim();

    const words = escaped.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return '""';

    return words.map(w => `${w}*`).join(' ');
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
        const messages = getMessages(matchInfo.sessionId);
        if (!messages || messages.length === 0) continue;

        const conversationText = formatConversation(messages);
        const truncatedText = truncateAroundMatches(conversationText, query);

        sessionData.push({
          sessionId: matchInfo.sessionId,
          matchInfo,
          conversationText: truncatedText,
        });
      } catch (error) {
        console.warn(`Failed to load session ${matchInfo.sessionId}:`, error);
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
        const client = this.createLLMClient();
        const messages: Message[] = [
          { role: 'user', content: userPrompt, id: crypto.randomUUID(), timestamp: Date.now() },
        ];

        let summary = '';

        const streamPromise = (async () => {
          for await (const event of client.streamChat(messages, { systemPrompt, maxTokens: MAX_SUMMARY_TOKENS })) {
            if (event.type === 'text') {
              summary += event.data;
            }
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
        console.warn(`Summarization attempt ${attempt + 1}/${MAX_RETRIES} failed:`, error);
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
      lines.push(`### Session: ${s.sessionId}`);
      lines.push(`- **When**: ${s.when}`);
      lines.push(`- **Source**: ${s.source}`);
      if (s.model) {
        lines.push(`- **Model**: ${s.model}`);
      }
      lines.push('');
      lines.push(s.summary);
      lines.push('');
    }

    lines.push('</session-context>');
    return lines.join('\n');
  }

  /**
   * Create LLM client based on configured provider
   */
  private createLLMClient(): LLMClient {
    if (!this.summaryLLMConfig) {
      throw new Error('Summary LLM not configured');
    }

    if (this.summaryLLMConfig.provider === 'anthropic') {
      return new AnthropicClient({
        apiKey: this.summaryLLMConfig.apiKey,
        model: this.summaryLLMConfig.model,
        baseURL: this.summaryLLMConfig.baseURL || '',
      });
    } else {
      return new OpenAIClient({
        apiKey: this.summaryLLMConfig.apiKey,
        model: this.summaryLLMConfig.model,
        baseURL: this.summaryLLMConfig.baseURL || '',
      });
    }
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

export const sessionSearchTool = new SessionSearchTool();
