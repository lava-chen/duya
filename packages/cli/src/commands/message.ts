/**
 * packages/agent/src/cli/commands/message.ts
 *
 * `duya message` — read-only message inspection within a session.
 *
 * Subcommands:
 *   list   — paginated message list
 *   show   — full message details (adds toolInput / thinking / attachments)
 *   count  — message count (replaces the `messageCount` field on session show)
 *
 * No write ops. Message create/update is the agent process's job
 * during streaming; exposing it would bypass the stream-chat pipeline.
 *
 * Data source: `electron/db/queries/messages.ts` (paginated read added
 * in plan 98) and `electron/cli/handlers/messages.ts`.
 *
 * DTOs frozen in `docs/design-docs/cli-control-plane/roadmap.md §3.4`.
 * Internal columns (`viz_spec`, `sub_agent_id`, `seq_index`, `status`)
 * are **never** exposed through the DTO.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTOs (frozen v1.0.0)
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageType = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'system';

export interface MessageListItemDTO {
  id: string;
  role: MessageRole;
  /** Plain text or short preview. Long content is truncated on the server. */
  content: string;
  name?: string;
  msgType: MessageType;
  createdAt: number;
  tokenUsage?: number;
  durationMs?: number;
  toolName?: string;
}

export interface MessageInfoItemDTO extends MessageListItemDTO {
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  thinking?: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
}

export interface MessageCountDTO {
  count: number;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function formatDate(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function preview(content: string, max = 60): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max - 3) + '...' : collapsed;
}

function renderListText(messages: MessageListItemDTO[]): string {
  if (messages.length === 0) return '(no messages)';
  const idWidth = Math.max(2, ...messages.map((m) => m.id.length));
  const roleWidth = Math.max(4, ...messages.map((m) => m.role.length));
  const header = [
    'ID'.padEnd(idWidth),
    'ROLE'.padEnd(roleWidth),
    'TYPE'.padEnd(11),
    'WHEN'.padEnd(20),
    'TOKENS',
    'CONTENT',
  ].join('  ');
  const sep = '-'.repeat(header.length);
  const rows = messages.map((m) =>
    [
      m.id.padEnd(idWidth),
      m.role.padEnd(roleWidth),
      m.msgType.padEnd(11),
      formatDate(m.createdAt).padEnd(20),
      String(m.tokenUsage ?? '-').padStart(6),
      preview(m.content, 80),
    ].join('  '),
  );
  return [header, sep, ...rows].join('\n');
}

function renderInfoText(m: MessageInfoItemDTO): string {
  const lines = [
    `${m.id}  (${m.role} / ${m.msgType})`,
    `  createdAt:    ${formatDate(m.createdAt)}`,
    `  content:`,
    ...m.content
      .split('\n')
      .slice(0, 20)
      .map((l) => `    ${l}`),
    m.content.split('\n').length > 20 ? `    ... (${m.content.split('\n').length - 20} more lines)` : '',
  ];
  if (m.name) lines.push(`  name:         ${m.name}`);
  if (m.tokenUsage !== undefined) lines.push(`  tokenUsage:   ${m.tokenUsage}`);
  if (m.durationMs !== undefined) lines.push(`  durationMs:   ${m.durationMs}`);
  if (m.toolName) lines.push(`  toolName:     ${m.toolName}`);
  if (m.toolCallId) lines.push(`  toolCallId:   ${m.toolCallId}`);
  if (m.toolInput && Object.keys(m.toolInput).length > 0) {
    lines.push(`  toolInput:`);
    lines.push(`    ${JSON.stringify(m.toolInput, null, 2).split('\n').join('\n    ')}`);
  }
  if (m.thinking) {
    lines.push(`  thinking:`);
    lines.push(`    ${m.thinking.split('\n').slice(0, 10).join('\n    ')}`);
    if (m.thinking.split('\n').length > 10) {
      lines.push(`    ... (${m.thinking.split('\n').length - 10} more lines)`);
    }
  }
  if (m.attachments && m.attachments.length > 0) {
    lines.push(`  attachments:`);
    for (const a of m.attachments) {
      lines.push(`    ${a.id}  ${a.name}  ${a.mimeType}  ${a.size}b`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function listMessages(ctx: CliSubcommandContext): Promise<ExitCode> {
  const sessionId = ctx.args[0];
  if (!sessionId) {
    process.stderr.write('Usage: duya message list <sessionId>\n');
    return 64;
  }
  const params = new URLSearchParams();
  if (typeof ctx.options.limit === 'string') params.set('limit', ctx.options.limit);
  if (typeof ctx.options.offset === 'string') params.set('offset', ctx.options.offset);
  const query = params.toString();
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/messages${
    query ? `?${query}` : ''
  }`;
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ messages: MessageListItemDTO[] }>(path);
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderListText(body.messages) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function showMessage(ctx: CliSubcommandContext): Promise<ExitCode> {
  const sessionId = ctx.args[0];
  const msgId = ctx.args[1];
  if (!sessionId || !msgId) {
    process.stderr.write('Usage: duya message show <sessionId> <msgId>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ message: MessageInfoItemDTO }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(msgId)}`,
    );
    process.stdout.write(
      ctx.format === 'json' ? renderJson(body) + '\n' : renderInfoText(body.message) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function countMessages(ctx: CliSubcommandContext): Promise<ExitCode> {
  const sessionId = ctx.args[0];
  if (!sessionId) {
    process.stderr.write('Usage: duya message count <sessionId>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<MessageCountDTO>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages/count`,
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`${body.count} message${body.count !== 1 ? 's' : ''}\n`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Public surface (consumed by descriptors.ts)
// ---------------------------------------------------------------------------

export const runMessageCommand = {
  list: listMessages,
  show: showMessage,
  count: countMessages,
};
