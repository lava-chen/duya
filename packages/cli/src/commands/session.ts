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

// ============================================================================
// Phase 4.2: search / export / import (Plan 200 P4)
// ============================================================================

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

async function searchSessions(q: string, format: OutputFormat, limit: number, offset: number): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ sessions: ListSessionItem[] }>(
      `/v1/sessions/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    );
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      for (const s of body.sessions) {
        process.stdout.write(`${s.id}\t${s.title}\t${s.messageCount}\n`);
      }
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function exportSession(id: string, formatArg: 'json' | 'md', outPath: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write('usage: duya session export <id> [--format json|md] [--output <path>]\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ format: 'json' | 'md'; id: string; body?: string; session?: unknown; messages?: unknown[] }>(
      '/v1/sessions/export',
      { id, format: formatArg },
    );
    if (body.format === 'md' && typeof body.body === 'string') {
      if (outPath) {
        const p = resolvePath(outPath);
        await fs.writeFile(p, body.body, 'utf-8');
        process.stdout.write(`Wrote ${p}\n`);
      } else {
        process.stdout.write(body.body);
      }
    } else {
      const json = JSON.stringify({ session: body.session, messages: body.messages }, null, 2);
      if (outPath) {
        const p = resolvePath(outPath);
        await fs.writeFile(p, json, 'utf-8');
        process.stdout.write(`Wrote ${p}\n`);
      } else {
        process.stdout.write(json + '\n');
      }
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function importSession(inputPath: string | undefined): Promise<number> {
  if (!inputPath) {
    process.stderr.write('usage: duya session import <file.json|file.md>\n');
    return 64;
  }
  const p = resolvePath(inputPath);
  const text = await fs.readFile(p, 'utf-8');
  let body: Record<string, unknown>;
  if (p.endsWith('.json')) {
    body = JSON.parse(text) as Record<string, unknown>;
  } else {
    // Markdown export: not currently parsed; Phase 4.2 only round-trips JSON.
    process.stderr.write('import: only JSON exports are supported in Phase 4.2\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<{ ok: boolean; id: string; title: string }>(
      '/v1/sessions/import',
      body,
    );
    process.stdout.write(`Imported session ${result.id} (${result.title})\n`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export const runSessionCommand = {
  list: listSessions,
  show: showSession,
  search: (ctx: { args: string[]; options: { q?: string; limit?: string; offset?: string }; format: OutputFormat }): Promise<number> => {
    const q = typeof ctx.options.q === 'string' ? ctx.options.q : ctx.args[0];
    if (!q) {
      process.stderr.write('usage: duya session search <q> [--limit 20] [--offset 0]\n');
      return Promise.resolve(64);
    }
    const limit = ctx.options.limit ? Math.max(1, Math.min(100, Number(ctx.options.limit) || 20)) : 20;
    const offset = ctx.options.offset ? Math.max(0, Number(ctx.options.offset) || 0) : 0;
    return searchSessions(q, ctx.format, limit, offset);
  },
  export: (ctx: { args: string[]; options: { format?: string; output?: string }; format: OutputFormat }): Promise<number> => {
    const id = ctx.args[0];
    const fmt = ctx.options.format === 'md' ? 'md' : 'json';
    const outPath = typeof ctx.options.output === 'string' ? ctx.options.output : undefined;
    return exportSession(id, fmt, outPath);
  },
  import: (ctx: { args: string[] }): Promise<number> => {
    return importSession(ctx.args[0]);
  },
};
