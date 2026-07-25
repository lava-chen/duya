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
import type { ToolResult, Message, ToolUseContext } from '../../types.js';
import type { MessageRow } from '../../session/db.js';
import { SESSION_SEARCH_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import { getDb, getMessages } from '../../session/db.js';
import { AnthropicClient } from '../../llm/anthropic-client.js';
import { OpenAIClient } from '../../llm/openai-client.js';
import type { LLMClient } from '../../llm/base.js';
import type BetterSqlite3 from 'better-sqlite3';
import {
  loadRecentSessionDirectory,
  matchesSessionDirectoryScope,
  sanitizeSessionMetadata,
  type RecentSessionDirectory,
  type RecentSessionDirectoryEntry,
  type SessionDirectoryScope,
} from '../../session/recent-session-directory.js';

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

interface SessionMatchInfo {
  sessionId: string;
  title: string;
  projectName: string;
  source: string;
  sessionStarted: number;
  model?: string;
}

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
        description: 'Maximum matching sessions to return (per project group in recent mode; default: 3, max: 5)',
        default: 3,
      },
      roleFilter: {
        type: 'string',
        description: 'Optional: only search messages from specific roles (comma-separated). E.g. "user,assistant" to skip tool outputs.',
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
    const roleFilter = (input.roleFilter as string | undefined)?.trim();
    const scope = this.parseScope(input.scope);
    const currentSessionId = context?.options?.sessionId || this.currentSessionId;
    const currentWorkingDirectory = workingDirectory || context?.options?.workingDirectory || '';

    try {
      if (!query) {
        // No query - return recent sessions
        const recent = await loadRecentSessionDirectory({
          currentSessionId,
          workingDirectory: currentWorkingDirectory,
          sameProjectLimit: scope === 'other_projects' ? 0 : limit,
          otherProjectLimit: scope === 'same_project' ? 0 : limit,
          sameProjectLookbackMs: Number.POSITIVE_INFINITY,
          otherProjectLookbackMs: Number.POSITIVE_INFINITY,
        });
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: this.formatRecentSessions(recent, scope),
        };
      }

      // Search with query via FTS5
      const results = await this.searchSessions(
        query,
        limit,
        roleFilter,
        scope,
        currentWorkingDirectory,
        currentSessionId,
      );

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
    const stmt = db.prepare('SELECT parent_id, parent_session_id FROM chat_sessions WHERE id = ?');
    while (sid && !visited.has(sid)) {
      visited.add(sid);
      try {
        const row = stmt.get(sid) as {
          parent_id?: string | null;
          parent_session_id?: string | null;
        } | undefined;
        const parentId = row?.parent_id ?? row?.parent_session_id;
        if (parentId) {
          sid = parentId;
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
  private getCurrentSessionRoot(
    db: BetterSqlite3.Database,
    currentSessionId: string | null,
  ): string | null {
    if (!currentSessionId) return null;
    return this.resolveToParent(currentSessionId, db);
  }

  /**
   * Deduplicate rows by resolved parent session, exclude current lineage.
   */
  private deduplicateAndExcludeRows(
    rows: Array<{
      sessionId: string;
      title: string;
      projectName?: string;
      workingDirectory?: string;
      sessionStarted: number;
      model?: string;
    }>,
    limit: number,
    db: BetterSqlite3.Database,
    currentRoot: string | null,
    currentSessionId: string | null,
    scope: SessionDirectoryScope,
    workingDirectory: string,
  ): SessionMatchInfo[] {
    const seenSessions = new Map<string, SessionMatchInfo>();
    for (const row of rows) {
      const rawSid = row.sessionId;
      const resolvedSid = this.resolveToParent(rawSid, db);

      if (currentRoot && resolvedSid === currentRoot) continue;
      if (currentSessionId && rawSid === currentSessionId) continue;
      if (!matchesSessionDirectoryScope(row.workingDirectory, workingDirectory, scope)) continue;

      if (!seenSessions.has(resolvedSid)) {
        seenSessions.set(resolvedSid, {
          sessionId: resolvedSid,
          title: sanitizeSessionMetadata(row.title, 'Untitled'),
          projectName: sanitizeSessionMetadata(row.projectName, 'Unknown project'),
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
    scope: SessionDirectoryScope = 'all',
    workingDirectory: string = '',
    currentSessionId: string | null = null,
  ): Promise<SessionMatchInfo[]> {
    const db = getDb();
    const currentRoot = this.getCurrentSessionRoot(db, currentSessionId);

    // Parse role filter
    const roleList = roleFilter
      ? roleFilter.split(',').map(r => r.trim()).filter(r => r.length > 0)
      : null;

    // Parse the user query into a FTS5 MATCH expression. Returns null when no
    // usable tokens are left (so we can short-circuit instead of issuing a query
    // that would match everything or fail with a syntax error).
    const ftsQuery = this.parseSearchQuery(query);
    if (ftsQuery === null) {
      return [];
    }

    // Try FTS5 search first
    try {
      // Body hits: search inside message content.
      const bodyRows = this.searchBodyMessages(db, ftsQuery, roleList, limit * 4);

      // Metadata hits: search session title / model / project_name / agent_name.
      // Boosts recall when users remember the conversation title or model.
      const metaRows = this.searchSessionMetadata(db, ftsQuery, limit * 4);

      // Merge body + metadata hits, deduplicate, and sort by combined score.
      const merged = this.mergeSearchHits(bodyRows, metaRows);

      return this.deduplicateAndExcludeRows(
        merged,
        limit,
        db,
        currentRoot,
        currentSessionId,
        scope,
        workingDirectory,
      );
    } catch (error) {
      // FTS5 not available or error - fall back to LIKE search
      console.warn('[SessionSearch] FTS5 search failed, falling back to LIKE search:', error instanceof Error ? error.message : String(error));
      return this.searchSessionsFallback(
        query,
        limit,
        roleList,
        db,
        currentRoot,
        currentSessionId,
        scope,
        workingDirectory,
      );
    }
  }

  /**
   * Query messages_fts for hits inside message content. Returns rows in BM25
   * rank order, already joined with chat_sessions for downstream fields.
   */
  private searchBodyMessages(
    db: BetterSqlite3.Database,
    ftsQuery: string,
    roleList: string[] | null,
    fetchLimit: number,
  ): Array<{
    sessionId: string;
    title: string;
    projectName: string;
    workingDirectory: string;
    sessionStarted: number;
    model: string;
    ftsScore: number;
  }> {
    let sql = `
      SELECT
        s.id as sessionId,
        s.title,
        s.project_name as projectName,
        s.working_directory as workingDirectory,
        s.created_at as sessionStarted,
        s.model,
        bm25(messages_fts, 1.0, 1.0, 0.5) as ftsScore
      FROM messages_fts
      JOIN chat_sessions s ON messages_fts.session_id = s.id
      WHERE messages_fts MATCH ?
        AND s.is_deleted = 0
    `;

    const params: (string | number)[] = [ftsQuery];

    if (roleList && roleList.length > 0) {
      sql += ` AND messages_fts.rowid IN (
        SELECT rowid FROM messages WHERE role IN (${roleList.map(() => '?').join(',')})
      )`;
      params.push(...roleList);
    }

    sql += ` ORDER BY ftsScore LIMIT ?`;
    params.push(fetchLimit);

    return db.prepare(sql).all(...params) as Array<{
      sessionId: string;
      title: string;
      projectName: string;
      workingDirectory: string;
      sessionStarted: number;
      model: string;
      ftsScore: number;
    }>;
  }

  /**
   * Query sessions_fts for hits on session metadata (title / model / project /
   * agent name). Column weights bias the score toward title matches.
   */
  private searchSessionMetadata(
    db: BetterSqlite3.Database,
    ftsQuery: string,
    fetchLimit: number,
  ): Array<{
    sessionId: string;
    title: string;
    projectName: string;
    workingDirectory: string;
    sessionStarted: number;
    model: string;
    ftsScore: number;
  }> {
    const sql = `
      SELECT
        s.id as sessionId,
        s.title,
        s.project_name as projectName,
        s.working_directory as workingDirectory,
        s.created_at as sessionStarted,
        s.model,
        bm25(sessions_fts, 4.0, 2.0, 2.0, 1.0, 1.0, 0.5) as ftsScore
      FROM sessions_fts
      JOIN chat_sessions s ON sessions_fts.session_id = s.id
      WHERE sessions_fts MATCH ?
        AND s.is_deleted = 0
      ORDER BY ftsScore
      LIMIT ?
    `;
    return db.prepare(sql).all(ftsQuery, fetchLimit) as Array<{
      sessionId: string;
      title: string;
      projectName: string;
      workingDirectory: string;
      sessionStarted: number;
      model: string;
      ftsScore: number;
    }>;
  }

  /**
   * Merge body + metadata hits per session. Sessions that appear in both lists
   * are boosted (the lower / better BM25 score wins, then halved as a soft
   * "double hit" bonus). Sessions present in only one list keep that list's
   * score.
   */
  private mergeSearchHits(
    bodyRows: Array<{ sessionId: string; title: string; projectName: string; workingDirectory: string; sessionStarted: number; model: string; ftsScore: number }>,
    metaRows: Array<{ sessionId: string; title: string; projectName: string; workingDirectory: string; sessionStarted: number; model: string; ftsScore: number }>,
  ): Array<{
    sessionId: string;
    title: string;
    projectName: string;
    workingDirectory: string;
    sessionStarted: number;
    model: string;
    ftsScore: number;
  }> {
    type Row = (typeof bodyRows)[number];
    const bySession = new Map<string, { body?: Row; meta?: Row; score: number }>();

    const DOUBLE_HIT_BOOST = 0.5;

    for (const row of bodyRows) {
      bySession.set(row.sessionId, { body: row, score: row.ftsScore });
    }
    for (const row of metaRows) {
      const existing = bySession.get(row.sessionId);
      if (existing?.body) {
        // Both body and metadata matched. Keep the better rank and apply boost.
        const best = Math.min(existing.body.ftsScore, row.ftsScore);
        existing.meta = row;
        existing.score = best * DOUBLE_HIT_BOOST;
      } else if (existing) {
        existing.meta = row;
        existing.score = row.ftsScore;
      } else {
        bySession.set(row.sessionId, { meta: row, score: row.ftsScore });
      }
    }

    // Pick the most informative row for fields (prefer the body row when both exist
    // so message-derived projectName / workingDirectory stays authoritative).
    const merged: Row[] = [];
    for (const entry of bySession.values()) {
      const source = entry.body ?? entry.meta!;
      merged.push({ ...source, ftsScore: entry.score });
    }
    merged.sort((a, b) => a.ftsScore - b.ftsScore);
    return merged;
  }

  /**
   * Fallback LIKE search when FTS5 is unavailable.
   * Splits the query into individual tokens and ORs them as substrings so that
   * a multi-word query (which the previous `%query%` implementation treated as
   * a single literal substring) still produces useful recall.
   */
  private searchSessionsFallback(
    query: string,
    limit: number,
    roleList: string[] | null,
    db: BetterSqlite3.Database,
    currentRoot: string | null,
    currentSessionId: string | null,
    scope: SessionDirectoryScope,
    workingDirectory: string,
  ): SessionMatchInfo[] {
    // Tokenize the query the same way parseSearchQuery does, but instead of
    // building an FTS5 expression we build a list of LIKE patterns.
    const tokens = this.tokenizeForFallback(query);
    if (tokens.length === 0) {
      return [];
    }

    let sql = `
      SELECT DISTINCT
        s.id as sessionId,
        s.title,
        s.project_name as projectName,
        s.working_directory as workingDirectory,
        s.created_at as sessionStarted,
        s.model
      FROM messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE s.is_deleted = 0
        AND (${tokens.map(() => 'm.content LIKE ?').join(' OR ')})
    `;

    const params: (string | number)[] = tokens.map(t => `%${t}%`);

    if (roleList && roleList.length > 0) {
      sql += ` AND m.role IN (${roleList.map(() => '?').join(',')})`;
      params.push(...roleList);
    }

    sql += ` ORDER BY s.updated_at DESC LIMIT ?`;
    params.push(limit * 8);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      sessionId: string;
      title: string;
      projectName?: string;
      workingDirectory?: string;
      sessionStarted: number;
      model?: string;
    }>;

    return this.deduplicateAndExcludeRows(
      rows,
      limit,
      db,
      currentRoot,
      currentSessionId,
      scope,
      workingDirectory,
    );
  }

  /**
   * Tokenize a user query into plain lowercase words for the LIKE fallback.
   * Phrase queries collapse to their constituent words (we lose phrase
   * semantics but still match the content).
   */
  private tokenizeForFallback(query: string): string[] {
    const result: string[] = [];
    const phraseRe = /"([^"]+)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = phraseRe.exec(query)) !== null) {
      const raw = (m[1] ?? m[2] ?? '').toLowerCase();
      // Split on whitespace, drop single chars, drop operator-only tokens.
      for (const w of raw.split(/\s+/)) {
        const cleaned = w.replace(/[+\-&|!(){}[\]^~*?:]/g, '');
        if (cleaned.length >= 2) result.push(cleaned);
      }
    }
    return Array.from(new Set(result));
  }

  /**
   * Format recent sessions as readable output
   */
  private formatRecentSessions(
    directory: RecentSessionDirectory,
    scope: SessionDirectoryScope,
  ): string {
    const groups: Array<{ title: string; sessions: RecentSessionDirectoryEntry[] }> = [];
    if (scope !== 'other_projects') {
      groups.push({ title: 'Same Project', sessions: directory.sameProject });
    }
    if (scope !== 'same_project') {
      groups.push({ title: 'Other Projects', sessions: directory.otherProjects });
    }

    if (groups.every(group => group.sessions.length === 0)) {
      return 'No recent sessions found.';
    }

    const lines = ['<session-directory>', '## Recent Sessions', ''];
    for (const group of groups) {
      lines.push(`### ${group.title}`);
      if (group.sessions.length === 0) {
        lines.push('No recent sessions in this scope.', '');
        continue;
      }

      for (const session of group.sessions) {
        lines.push(`- "${session.title}" — ${session.projectName}`);
        lines.push('```json');
        lines.push(JSON.stringify({
          sessionId: session.sessionId,
          title: session.title,
          project: session.projectName,
          updatedAt: formatTimestamp(session.updatedAt),
          childSessions: session.childCount,
        }, null, 2));
        lines.push('```', '');
      }
    }

    lines.push('</session-directory>');
    return lines.join('\n');
  }

  /**
   * Parse a user search query into an FTS5 MATCH expression.
   *
   * Supported syntax:
   *   "exact phrase"   preserved as an FTS5 phrase query
   *   +required        FTS5 required term (`+term`)
   *   -excluded        FTS5 NOT term (`-term`)
   *   foo OR bar       FTS5 OR (case-sensitive keyword)
   *   auth*            explicit prefix (preserved)
   *   auth             bare term; lowercased and emitted as-is.
   *                    Trigram tokenizer handles substring matching natively,
   *                    so no auto-`*` is needed for prefix recall.
   *   a / ab           1- and 2-character Latin/digit tokens are dropped
   *                    (FTS5 trigram needs at least 3 characters to produce a trigram).
   *   \u4e2d\u6587       CJK / non-Latin scripts pass through unchanged; trigram handles substrings.
   *
   * Returns null when the query has no usable tokens, so callers can short-circuit
   * instead of issuing a query that would match nothing or trip a syntax error.
   */
  private parseSearchQuery(query: string): string | null {
    const tokens: Array<{ kind: 'word' | 'phrase' | 'or' | 'plus' | 'minus'; text: string }> = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      if (m[1] !== undefined) {
        tokens.push({ kind: 'phrase', text: m[1] });
        continue;
      }
      const raw = m[2];
      if (raw === 'OR') {
        tokens.push({ kind: 'or', text: 'OR' });
      } else if (raw.startsWith('+') && raw.length > 1) {
        tokens.push({ kind: 'plus', text: raw.slice(1) });
      } else if (raw.startsWith('-') && raw.length > 1) {
        tokens.push({ kind: 'minus', text: raw.slice(1) });
      } else {
        tokens.push({ kind: 'word', text: raw });
      }
    }

    const parts: string[] = [];
    // Strip FTS5 operator characters that the user might have typed inside a term
    // (e.g. `foo+bar` => `foo bar`). Preserve `*` and `?` since they are FTS5
    // wildcards users may legitimately include (e.g. `auth*`).
    const stripOps = (s: string) => s.replace(/[+\-&|!(){}[\]^~:]/g, ' ').trim();

    const isLatinOrDigit = (s: string) => /^[a-z0-9]+$/.test(s);
    const hasWildcard = (s: string) => s.endsWith('*') || s.endsWith('?');

    for (const tok of tokens) {
      if (tok.kind === 'or') {
        parts.push('OR');
        continue;
      }
      if (tok.kind === 'phrase') {
        const inner = stripOps(tok.text).replace(/\s+/g, ' ').toLowerCase();
        if (inner.length >= 2) parts.push(`"${inner.replace(/"/g, '""')}"`);
        continue;
      }

      const cleaned = stripOps(tok.text).toLowerCase();
      if (cleaned.length === 0) continue;
      // FTS5 trigram produces 0 trigrams for 1- and 2-character inputs; drop them
      // so we don't issue a guaranteed-empty query.
      if (cleaned.length < 3 && isLatinOrDigit(cleaned)) continue;

      const term = hasWildcard(cleaned) ? cleaned : cleaned;

      if (tok.kind === 'plus') parts.push(`+${term}`);
      else if (tok.kind === 'minus') parts.push(`-${term}`);
      else parts.push(term);
    }

    if (parts.length === 0) return null;
    return parts.join(' ');
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
      lines.push(`### ${s.title}`);
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
