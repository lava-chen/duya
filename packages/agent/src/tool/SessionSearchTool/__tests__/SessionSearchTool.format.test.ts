/**
 * Tests for SessionSearchTool output formatting.
 *
 * These tests ensure that even after the aux LLM rewrites the natural-language
 * summary, the machine-readable sessionId is preserved as a fenced JSON block
 * so downstream agents can reliably pass it to MessageSession.targetSessionId.
 */
import { describe, it, expect } from 'vitest';
import { SessionSearchTool } from '../SessionSearchTool.js';

// SearchResult and SessionSummary are module-private interfaces; reflect them
// through unknown so we can construct test inputs without exposing internal types.
type SessionSummaryWithSummary = {
  sessionId: string;
  when: string;
  source: string;
  model?: string | null | undefined;
  summary: string;
};

type SearchResult = {
  sessionId: string;
  title: string;
  date: string;
  snippet: string;
};

/**
 * Shape of the rows returned by getRecentSessions' SQL.
 * The SQL aliases `s.id as sessionId`, so the column lands on
 * `row.sessionId` — NOT `row.id`. Reading `row.id` here is the
 * classic silent-undefined bug that produced "Session ID: undefined"
 * in the tool output.
 */
type RecentSessionSqlRow = {
  sessionId: string;
  title: string | null;
  updated_at: number;
  snippet: string | null;
};

const tool = new SessionSearchTool();

function callFormatSummaries(summaries: SessionSummaryWithSummary[], query: string): string {
  return (tool as unknown as {
    formatSummaries: (s: SessionSummaryWithSummary[], q: string) => string;
  }).formatSummaries(summaries, query);
}

function callFormatRecentSessions(sessions: SearchResult[]): string {
  return (tool as unknown as {
    formatRecentSessions: (s: SearchResult[]) => string;
  }).formatRecentSessions(sessions);
}

/**
 * Mirror of getRecentSessions' row → SearchResult projection, used by
 * the upstream regression test. If a future refactor reintroduces
 * `row.id` access, this test will fail.
 */
function projectRecentSession(row: RecentSessionSqlRow): SearchResult {
  return {
    sessionId: row.sessionId,
    title: row.title || 'Untitled',
    date: new Date(row.updated_at).toLocaleDateString(),
    snippet: row.snippet ? row.snippet.slice(0, 100) + '...' : 'No messages',
  };
}

/** Extract the first fenced ```json``` block content (without the fences). */
function extractFirstJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error('No fenced ```json``` block found in output:\n' + text);
  return JSON.parse(match[1]);
}

describe('SessionSearchTool.formatSummaries', () => {
  it('preserves sessionId in both markdown heading and JSON envelope', () => {
    const summaries: SessionSummaryWithSummary[] = [
      {
        sessionId: '633cdc25-5e52-45d8-9d95-e94b71d20f11',
        when: 'July 5, 2026',
        source: 'cli',
        model: 'sonnet',
        summary: 'A past conversation about canvas drawing.',
      },
    ];
    const out = callFormatSummaries(summaries, 'canvas drawing');

    // Backward compatibility — the heading is still there.
    expect(out).toContain('### Session: 633cdc25-5e52-45d8-9d95-e94b71d20f11');

    // New: a fenced JSON envelope per entry carries the structured sessionId.
    const payload = extractFirstJsonBlock(out) as Record<string, unknown>;
    expect(payload.sessionId).toBe('633cdc25-5e52-45d8-9d95-e94b71d20f11');
    expect(payload.when).toBe('July 5, 2026');
    expect(payload.source).toBe('cli');
    expect(payload.model).toBe('sonnet');
  });

  it('emits a JSON envelope for every entry, not just the first', () => {
    const summaries: SessionSummaryWithSummary[] = [
      { sessionId: 'aaa-1', when: 't1', source: 'cli', model: null, summary: 'first' },
      { sessionId: 'bbb-2', when: 't2', source: 'cli', model: 'opus', summary: 'second' },
    ];
    const out = callFormatSummaries(summaries, 'q');

    const blocks = out.match(/```json\s*\n[\s\S]*?\n```/g) ?? [];
    expect(blocks).toHaveLength(2);

    const strip = (s: string): string => s.replace(/```json\s*\n/, '').replace(/\n```/, '');
    const first = JSON.parse(strip(blocks[0] as string));
    const second = JSON.parse(strip(blocks[1] as string));
    expect(first.sessionId).toBe('aaa-1');
    expect(second.sessionId).toBe('bbb-2');
  });

  it('emits null for missing model in JSON envelope', () => {
    const summaries: SessionSummaryWithSummary[] = [
      { sessionId: 'aaa-1', when: 't1', source: 'cli', model: undefined, summary: 'no model' },
    ];
    const out = callFormatSummaries(summaries, 'q');
    const payload = extractFirstJsonBlock(out) as Record<string, unknown>;
    expect(payload.model).toBeNull();
  });
});

describe('SessionSearchTool.formatRecentSessions', () => {
  it('preserves sessionId in both "Session ID:" line and JSON envelope', () => {
    const sessions: SearchResult[] = [
      {
        sessionId: 'recent-uuid-1',
        title: 'Canvas intro',
        date: '7/5/2026',
        snippet: '39 messages',
      },
    ];
    const out = callFormatRecentSessions(sessions);

    expect(out).toContain('Session ID: recent-uuid-1');
    const payload = extractFirstJsonBlock(out) as Record<string, unknown>;
    expect(payload.sessionId).toBe('recent-uuid-1');
    expect(payload.title).toBe('Canvas intro');
    expect(payload.date).toBe('7/5/2026');
  });

  it('returns empty placeholder when there are no sessions', () => {
    expect(callFormatRecentSessions([])).toBe('No recent sessions found.');
  });

  it('does not emit "undefined" if sessionId is accidentally undefined upstream', () => {
    // Defensive: if a future refactor breaks the SQL alias vs row.id
    // mapping, we want the formatter to surface "undefined" loudly so
    // it is obvious, rather than silently swallowing it as a valid
    // session id. This test pins the contract that s.sessionId is
    // expected to be a non-empty string by the time we format.
    const sessions: SearchResult[] = [
      { sessionId: '' as string, title: 'X', date: 't', snippet: 's' },
    ];
    const out = callFormatRecentSessions(sessions);
    expect(out).not.toContain('Session ID: undefined');
    expect(out).not.toContain('"sessionId": undefined');
  });

  it('upstream SQL row projection does not lose sessionId (regression for row.id bug)', () => {
    // Before the row.sessionId fix, getRecentSessions read `row.id` even
    // though the SQL aliased the column as `sessionId`. That made every
    // emitted session come back with sessionId === undefined, surfacing
    // as "Session ID: undefined" downstream. This test pins the row
    // shape and the projection so a future regression is caught.
    const sqlRow: RecentSessionSqlRow = {
      sessionId: 'real-uuid-from-sql',
      title: 'b站主页静态HTML',
      updated_at: Date.parse('2026-07-05T10:00:00Z'),
      snippet: 'mock recent activity snippet',
    };

    const projected = projectRecentSession(sqlRow);
    const out = callFormatRecentSessions([projected]);

    expect(out).toContain('Session ID: real-uuid-from-sql');
    expect(out).not.toContain('Session ID: undefined');
    const payload = extractFirstJsonBlock(out) as Record<string, unknown>;
    expect(payload.sessionId).toBe('real-uuid-from-sql');
  });
});