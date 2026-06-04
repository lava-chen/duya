/**
 * packages/agent/src/cli/commands/session.ts
 *
 * `duya session list`   — list top-level user-visible sessions (4 fields)
 * `duya session show <id>` — show 6 fields for one session
 *
 * Both commands are thin HTTP adapters. The server's
 * `listSessionSummaries` / `getSessionSummary` enforce the visibility
 * filter and the safe DTO field set; the CLI just renders.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import { CliUserDataMissingError } from '../api/runtime-config.js';

interface ListSessionItem {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

interface ShowSessionItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messageCount: number;
}

function formatDate(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function renderListText(sessions: ListSessionItem[]): string {
  if (sessions.length === 0) return 'No sessions.';
  const idWidth = Math.max(2, ...sessions.map((s) => s.id.length));
  const titleWidth = Math.max(5, ...sessions.map((s) => s.title.length));
  const header = [
    'ID'.padEnd(idWidth),
    'TITLE'.padEnd(titleWidth),
    'UPDATED AT'.padEnd(20),
    'MESSAGES'.padStart(8),
  ].join('  ');
  const sep = '-'.repeat(header.length);
  const rows = sessions.map((s) =>
    [
      s.id.padEnd(idWidth),
      s.title.padEnd(titleWidth),
      formatDate(s.updatedAt).padEnd(20),
      String(s.messageCount).padStart(8),
    ].join('  '),
  );
  return [header, sep, ...rows].join('\n');
}

function renderShowText(s: ShowSessionItem): string {
  return [
    `${s.id}`,
    `  title:     ${s.title}`,
    `  createdAt: ${formatDate(s.createdAt)}`,
    `  updatedAt: ${formatDate(s.updatedAt)}`,
    `  model:     ${s.model || '-'}`,
    `  messages:  ${s.messageCount}`,
  ].join('\n');
}

function reportError(err: unknown): number {
  if (err instanceof CliUserDataMissingError) {
    process.stderr.write(err.message + '\n');
    return 2;
  }
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return err.isAppUnavailable() ? 2 : 1;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

async function listSessions(
  format: OutputFormat,
  pagination?: { limit?: string; offset?: string },
): Promise<number> {
  const params = new URLSearchParams();
  if (pagination?.limit !== undefined) params.set('limit', pagination.limit);
  if (pagination?.offset !== undefined) params.set('offset', pagination.offset);
  const query = params.toString();
  const path = '/v1/sessions' + (query ? '?' + query : '');
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ sessions: ListSessionItem[] }>(path);
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderListText(body.sessions) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function showSession(id: string, format: OutputFormat): Promise<number> {
  if (!id || id.trim().length === 0) {
    process.stderr.write('Usage: duya session show <id>\n');
    return 1;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<ShowSessionItem>(
      '/v1/sessions/' + encodeURIComponent(id),
    );
    process.stdout.write(format === 'json' ? renderJson(body) + '\n' : renderShowText(body) + '\n');
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export const runSessionCommand = {
  list: listSessions,
  show: showSession,
};
