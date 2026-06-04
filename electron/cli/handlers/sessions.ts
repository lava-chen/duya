/**
 * electron/cli/handlers/sessions.ts
 *
 * Read-only session handler for the CLI control plane.
 *
 * IMPORTANT: this module is a thin HTTP adapter. The CLI-visible filter
 * (top-level / not-deleted / not-automation / not-gateway) and the safe
 * field projection are applied inside the SQL of
 * `listSessionSummaries` / `getSessionSummary`. The handler must NOT
 * re-filter or re-strip fields on the returned rows.
 *
 * Stable JSON contract (Phase 1, see phase-1-audit.md §8):
 *   GET /v1/sessions?limit=20&offset=0
 *     { sessions: [{ id, title, updatedAt, messageCount }] }
 *   GET /v1/sessions/:id
 *     { id, title, createdAt, updatedAt, model, messageCount }
 *
 * Pagination / not-found errors are normalized to the Phase 0 error
 * envelope: { error: { code, message } }.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  listSessionSummaries,
  getSessionSummary,
  InvalidPaginationParam,
  SESSION_LIST_DEFAULT_LIMIT,
  type SessionSummary,
} from '../../db/queries/sessions';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

/** List response includes 4 fields per row. */
interface ListSessionItem {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** Show response includes 6 fields. */
interface ShowSessionItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messageCount: number;
}

function toListItem(row: SessionSummary): ListSessionItem {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  };
}

function toShowItem(row: SessionSummary): ShowSessionItem {
  return {
    id: row.id,
    title: row.created_at === row.updated_at && row.model === '' ? row.title : row.title, // identity
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model,
    messageCount: row.message_count,
  };
}

/** Parsed query bag for `GET /v1/sessions`. */
export interface ListSessionsQuery {
  limit?: number;
  offset?: number;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new InvalidPaginationParam('limit', 'must be a number');
  }
  return n;
}

function parseOffset(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new InvalidPaginationParam('offset', 'must be a number');
  }
  return n;
}

/** Extract `limit` and `offset` from a request URL. */
export function parseQuery(url: string | undefined): ListSessionsQuery {
  if (!url) return {};
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return {};
  const out: ListSessionsQuery = {};
  for (const part of url.slice(qIdx + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const val = eq >= 0 ? part.slice(eq + 1) : '';
    if (key === 'limit') out.limit = parseLimit(val);
    else if (key === 'offset') out.offset = parseOffset(val);
  }
  return out;
}

/**
 * Dispatch list. The router in cli-api-server.ts parses the URL into a
 * `ListSessionsQuery` and calls this with the parsed bag. The handler
 * never inspects `req.url` directly.
 */
export function handleListSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  query: ListSessionsQuery = {},
): void {
  void _req;
  try {
    const rows = listSessionSummaries({
      limit: query.limit ?? SESSION_LIST_DEFAULT_LIMIT,
      offset: query.offset ?? 0,
    });
    const sessions: ListSessionItem[] = rows.map(toListItem);
    sendJson(res, 200, { sessions });
  } catch (err) {
    if (err instanceof InvalidPaginationParam) {
      sendError(res, 400, `invalid_${err.param}`, err.reason);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to list sessions: ${msg}`);
  }
}

/**
 * Dispatch show. Unified 404: do NOT distinguish between "id does not
 * exist" and "id is hidden by the visibility filter" (deleted /
 * automation / gateway / sub-agent). This prevents leaking the existence
 * of internal sessions.
 */
export function handleGetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
): void {
  void _req;
  if (!id || id.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Session id must be a non-empty string');
    return;
  }
  try {
    const row = getSessionSummary(id);
    if (!row) {
      sendError(res, 404, 'session_not_found', `Session not found: ${id}`);
      return;
    }
    sendJson(res, 200, toShowItem(row));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to get session: ${msg}`);
  }
}

// ============================================================================
// Phase 4.2: search / export / import (Plan 200 P4)
// ============================================================================

import { listMessages } from '../../db/queries/messages';
import { getDatabase } from '../../db/connection';

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 16 * 1024 * 1024;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          resolve(obj as Record<string, unknown>);
        } else {
          reject(new Error('request body must be a JSON object'));
        }
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * GET /v1/sessions/search?q=...&limit=20&offset=0
 */
export function handleSearchSessions(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = req.url ?? '/';
  const qIdx = url.indexOf('?');
  let q: string | undefined;
  let limit = SESSION_LIST_DEFAULT_LIMIT;
  let offset = 0;
  if (qIdx >= 0) {
    for (const part of url.slice(qIdx + 1).split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (k === 'q') q = decodeURIComponent(v);
      else if (k === 'limit') limit = Math.max(1, Math.min(100, Number(v) || limit));
      else if (k === 'offset') offset = Math.max(0, Number(v) || 0);
    }
  }
  if (!q) {
    sendError(res, 400, 'missing_q', 'q query parameter required');
    return;
  }
  try {
    const rows = listSessionSummaries({ limit: 100, offset: 0 });
    const needle = q.toLowerCase();
    const filtered = rows
      .filter((r) => r.title.toLowerCase().includes(needle))
      .slice(offset, offset + limit);
    sendJson(res, 200, {
      sessions: filtered.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updated_at,
        messageCount: r.messageCount,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to search sessions: ${msg}`);
  }
}

/**
 * POST /v1/sessions/export  body: { id, format?: 'json' | 'md' }
 */
export async function handleExportSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const id = asString(body.id);
  if (!id) {
    sendError(res, 400, 'missing_id', 'id required');
    return;
  }
  const format = asString(body.format) === 'md' ? 'md' : 'json';
  try {
    const summary = getSessionSummary(id);
    if (!summary) {
      sendError(res, 404, 'session_not_found', `Session not found: ${id}`);
      return;
    }
    const messages = listMessages(id);
    if (format === 'md') {
      const md = renderSessionMarkdown(summary, messages);
      sendJson(res, 200, { format: 'md', id, body: md });
    } else {
      sendJson(res, 200, { format: 'json', session: summary, messages });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to export session: ${id}: ${msg}`);
  }
}

function renderSessionMarkdown(
  s: SessionSummary,
  messages: Array<{ id: string; role: string; content: string; created_at: number; msg_type?: string }>,
): string {
  const out: string[] = [];
  out.push(`# ${s.title}`);
  out.push('');
  out.push(`- id: ${s.id}`);
  out.push(`- model: ${s.model}`);
  out.push(`- createdAt: ${new Date(s.created_at).toISOString()}`);
  out.push(`- updatedAt: ${new Date(s.updated_at).toISOString()}`);
  out.push(`- messageCount: ${s.messageCount}`);
  out.push('');
  for (const m of messages) {
    out.push(`## ${m.role} (${new Date(m.created_at).toISOString()})`);
    if (m.msg_type && m.msg_type !== 'text') out.push(`*(${m.msg_type})*`);
    out.push('');
    out.push(m.content);
    out.push('');
  }
  return out.join('\n');
}

/**
 * POST /v1/sessions/import  body: { session, messages[] }
 */
export async function handleImportSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const session = body.session as Record<string, unknown> | undefined;
  const messages = body.messages;
  if (!session || typeof session !== 'object') {
    sendError(res, 400, 'missing_session', 'session object required');
    return;
  }
  if (!Array.isArray(messages)) {
    sendError(res, 400, 'missing_messages', 'messages array required');
    return;
  }
  try {
    const db = getDatabase();
    if (!db) {
      sendError(res, 503, 'db_unavailable', 'database is not ready');
      return;
    }
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
    const newId = randomUUID();
    const now = Date.now();
    const title = typeof session.title === 'string' ? session.title : 'Imported chat';
    const model = typeof session.model === 'string' ? session.model : '';
    const createdAt = asNumber(session.created_at, now);
    db.prepare(
      `INSERT INTO chat_sessions (id, title, created_at, updated_at, model, working_directory, project_name, status, mode, permission_profile, provider_id, context_summary, context_summary_updated_at, is_deleted, generation, agent_type, agent_name)
       VALUES (?, ?, ?, ?, ?, '', '', 'active', 'code', 'default', 'env', '', 0, 0, 0, 'main', '')`
    ).run(newId, title, createdAt, now, model);

    const insertMsg = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, msg_type, status, created_at) VALUES (?, ?, ?, ?, ?, 'done', ?)`
    );
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const mm = m as Record<string, unknown>;
      const role = typeof mm.role === 'string' ? mm.role : 'user';
      const content = typeof mm.content === 'string' ? mm.content : '';
      const msgType = typeof mm.msg_type === 'string' ? mm.msg_type : 'text';
      const msgId = typeof mm.id === 'string' ? mm.id : randomUUID();
      const createdAtMsg = asNumber(mm.created_at, now);
      insertMsg.run(msgId, newId, role, content, msgType, createdAtMsg);
    }
    sendJson(res, 200, { ok: true, id: newId, title });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to import session: ${msg}`);
  }
}
