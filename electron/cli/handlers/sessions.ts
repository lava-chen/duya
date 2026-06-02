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
