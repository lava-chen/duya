/**
 * electron/cli/handlers/messages.ts
 *
 * CLI API handlers for the message read-only control plane.
 *
 * Routes (Plan 99 P3):
 *   GET /v1/sessions/:id/messages?limit=&offset=
 *     → { messages: MessageListItemDTO[] }
 *   GET /v1/sessions/:id/messages/:msgId
 *     → MessageInfoItemDTO
 *   GET /v1/sessions/:id/messages/count
 *     → { count: number }
 *
 * Internal columns are NEVER exposed through the DTO:
 *   - viz_spec     (UI viz rendering — internal)
 *   - sub_agent_id (sub-agent tracing)
 *   - seq_index    (internal ordering)
 *   - status       (internal lifecycle)
 *
 * Read visibility: messages are scoped to the session id. We do
 * NOT apply the chat_sessions.is_deleted / mode / status filter
 * here — that is the caller's responsibility (the GUI already
 * hides deleted/automation/gateway sessions from the sidebar, so
 * the CLI surface assumes the same visibility).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  listMessagesBySession,
  getMessageById,
  getMessageCount,
  type MessageRow,
} from '../../db/queries/messages';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

interface MessageListItem {
  id: string;
  role: string;
  content: string;
  name?: string;
  msgType: string;
  createdAt: number;
  tokenUsage?: number;
  durationMs?: number;
  toolName?: string;
}

interface MessageInfoItem extends MessageListItem {
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  thinking?: string;
  attachments?: Array<{ id: string; name: string; mimeType: string; size: number }>;
}

function parseTokenUsage(tokenUsage: string | null): number | undefined {
  if (!tokenUsage) return undefined;
  try {
    const parsed = JSON.parse(tokenUsage) as { total?: unknown };
    if (typeof parsed?.total === 'number') return parsed.total;
  } catch {
    // ignore
  }
  return undefined;
}

function parseToolInput(toolInput: string | null): Record<string, unknown> | undefined {
  if (!toolInput) return undefined;
  try {
    const parsed = JSON.parse(toolInput) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function parseAttachments(attachments: string | null): MessageInfoItem['attachments'] {
  if (!attachments) return undefined;
  try {
    const parsed = JSON.parse(attachments) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (a): a is { id: string; name: string; mimeType: string; size: number } =>
          typeof a === 'object' &&
          a !== null &&
          typeof (a as { id?: unknown }).id === 'string' &&
          typeof (a as { name?: unknown }).name === 'string' &&
          typeof (a as { mimeType?: unknown }).mimeType === 'string' &&
          typeof (a as { size?: unknown }).size === 'number',
      );
    }
  } catch {
    // ignore
  }
  return undefined;
}

function toListItem(row: MessageRow): MessageListItem {
  const out: MessageListItem = {
    id: row.id,
    role: row.role,
    content: row.content,
    msgType: row.msg_type,
    createdAt: row.created_at,
  };
  if (row.name) out.name = row.name;
  const tokenUsage = parseTokenUsage(row.token_usage);
  if (tokenUsage !== undefined) out.tokenUsage = tokenUsage;
  if (row.duration_ms !== null) out.durationMs = row.duration_ms;
  if (row.tool_name) out.toolName = row.tool_name;
  return out;
}

function toInfoItem(row: MessageRow): MessageInfoItem {
  const out: MessageInfoItem = { ...toListItem(row) };
  if (row.tool_call_id) out.toolCallId = row.tool_call_id;
  const toolInput = parseToolInput(row.tool_input);
  if (toolInput) out.toolInput = toolInput;
  if (row.thinking) out.thinking = row.thinking;
  const attachments = parseAttachments(row.attachments);
  if (attachments && attachments.length > 0) out.attachments = attachments;
  return out;
}

function parseIntParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * Parse a `GET` URL's query string into `{ limit, offset }`. Returns
 * `undefined` for missing / empty values.
 */
export interface ListMessagesQuery {
  limit?: number;
  offset?: number;
}

export function parseListMessagesQuery(url: string | undefined): ListMessagesQuery {
  if (!url) return {};
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return {};
  const out: ListMessagesQuery = {};
  for (const part of url.slice(qIdx + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const val = eq >= 0 ? part.slice(eq + 1) : '';
    if (key === 'limit') {
      const n = parseIntParam(val);
      if (n !== undefined) out.limit = n;
    } else if (key === 'offset') {
      const n = parseIntParam(val);
      if (n !== undefined) out.offset = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleListMessages(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  query: ListMessagesQuery = {},
): void {
  void _req;
  if (!sessionId || sessionId.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Session id must be a non-empty string');
    return;
  }
  try {
    const messages = listMessagesBySession(sessionId, {
      limit: query.limit,
      offset: query.offset,
    });
    sendJson(res, 200, { messages: messages.map(toListItem) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to list messages: ${msg}`);
  }
}

export function handleGetMessage(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  messageId: string,
): void {
  void req;
  if (!sessionId || sessionId.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Session id must be a non-empty string');
    return;
  }
  if (!messageId || messageId.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Message id must be a non-empty string');
    return;
  }
  try {
    const row = getMessageById(sessionId, messageId);
    if (!row) {
      sendError(res, 404, 'message_not_found', `Message not found: ${messageId}`);
      return;
    }
    // Wrap in `{ message }` to match the shape consumed by
    // `duya message show` (it reads `body.message`). Previously the
    // bare DTO made `body.message` undefined and threw
    // "Cannot read properties of undefined (reading 'id')".
    sendJson(res, 200, { message: toInfoItem(row) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to get message: ${msg}`);
  }
}

export function handleMessageCount(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): void {
  void _req;
  if (!sessionId || sessionId.trim().length === 0) {
    sendError(res, 400, 'invalid_id', 'Session id must be a non-empty string');
    return;
  }
  try {
    const count = getMessageCount(sessionId);
    sendJson(res, 200, { count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'internal_error', `Failed to count messages: ${msg}`);
  }
}
