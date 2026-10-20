/**
 * Display projection for one session's conversation.
 *
 * ## Two sources, one screen, no duplicates
 *
 * A session's text exists twice by design. The Host owns a DURABLE message
 * history — the transcript that survives the process — and the live run owns
 * the STREAMING version of the same text, which only exists as events. Showing
 * both naively prints every answer twice: once as it streams, and again when the
 * history catches up.
 *
 * The join key is the producing run id, not a turn label or message text. The
 * selected run's identity is Host-owned, and durable rows written by that run
 * carry the same id. So an assistant row is drawn from durable history unless
 * the SELECTED run owns it, in which case the live snapshot supplies it.
 *
 * Matching on message text would be shorter and would also be wrong: two
 * identical answers in one session would cross over, and a truncated or
 * reformatted durable row would silently produce a second copy of an answer that
 * already streamed. Turn identity cannot drift like that.
 *
 * ## Why the ordering pass below is not a second reducer
 *
 * Tool cards and assistant text have to interleave the way the run actually
 * produced them, but the surface exposes them as two collections with no shared
 * key. Rather than keep a second copy of the events and re-derive state, this
 * walks the snapshot's own ordered timeline and records the order each surface
 * id was FIRST seen in. It reads the projection the shared model already built;
 * it does not build one.
 */

import type { RunSessionSnapshot, ToolCallSurface } from '@duya/client-core';
import type { DurableCompactionRow, DurableMessageRow } from './api.js';

export type ConversationRow =
  | { readonly kind: 'user'; readonly key: string; readonly text: string; readonly at: number }
  | {
      readonly kind: 'assistant';
      readonly key: string;
      readonly text: string;
      readonly thinking: string;
      /** True once the run published its authoritative final message. */
      readonly finalized: boolean;
      readonly at: number;
    }
  | { readonly kind: 'tool'; readonly key: string; readonly tool: ToolCallSurface }
  | {
      readonly kind: 'compaction';
      readonly key: string;
      readonly tokensBefore: number;
      readonly tokensAfter: number | null;
      readonly at: number;
    };

export interface ConversationInput {
  readonly messages: readonly DurableMessageRow[];
  readonly compactions: readonly DurableCompactionRow[];
  /** The selected run's surface, or `null` when no run is selected. */
  readonly snapshot: RunSessionSnapshot | null;
}

export function projectConversation(input: ConversationInput): readonly ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const row of durableRows(input.messages, input.snapshot?.runId ?? null)) rows.push(row);
  for (const row of input.compactions) {
    rows.push({
      kind: 'compaction',
      key: `compaction:${row.id}`,
      tokensBefore: row.tokensBefore,
      tokensAfter: row.tokensAfter,
      at: row.createdAt,
    });
  }
  // The page is read oldest-first, but compaction entries arrive in their own
  // list; a stable sort on time interleaves them without disturbing order
  // between rows that share a timestamp.
  rows.sort((left, right) => rowTime(left) - rowTime(right));

  for (const row of liveRows(input.snapshot)) rows.push(row);
  return rows;
}

function durableRows(
  messages: readonly DurableMessageRow[],
  selectedRunId: string | null,
): readonly ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const row of messages) {
    if (row.role === 'user') {
      rows.push({ kind: 'user', key: `user:${row.id}`, text: row.text, at: row.createdAt });
      continue;
    }
    // The selected run already carries this message in its own order. Skipping
    // only its exact durable copy keeps one answer from being drawn twice.
    if (selectedRunId !== null && row.runId === selectedRunId) continue;
    rows.push({
      kind: 'assistant',
      key: `assistant:${row.id}`,
      text: row.text,
      thinking: row.thinking,
      finalized: true,
      at: row.createdAt,
    });
  }
  return rows;
}

/**
 * The selected run's own rows, in the order the run produced them.
 *
 * Assistant text comes from the snapshot's message surfaces, never from
 * re-applying deltas: `assistant.message_finalized` REPLACES the accumulated
 * text, so a renderer that appends both prints the answer twice.
 */
function liveRows(snapshot: RunSessionSnapshot | null): readonly ConversationRow[] {
  if (snapshot === null) return [];
  const messages = new Map(snapshot.messages.map((message) => [message.messageId, message] as const));
  const tools = new Map(snapshot.toolCalls.map((tool) => [tool.toolCallId, tool] as const));

  const rows: ConversationRow[] = [];
  for (const item of timelineOrder(snapshot)) {
    if (item.kind === 'message') {
      const message = messages.get(item.id);
      if (message === undefined) continue;
      if (message.text.trim() === '' && message.thinking.trim() === '') continue;
      rows.push({
        kind: 'assistant',
        key: `live-assistant:${message.messageId}`,
        text: message.text,
        thinking: message.thinking,
        finalized: message.finalized,
        at: 0,
      });
      continue;
    }
    const tool = tools.get(item.id);
    if (tool === undefined) continue;
    rows.push({ kind: 'tool', key: `live-tool:${tool.toolCallId}`, tool });
  }
  return rows;
}

type LiveItem =
  | { readonly kind: 'message'; readonly id: string }
  | { readonly kind: 'tool'; readonly id: string };

/**
 * First-seen order of every assistant message and tool call in the run.
 *
 * The snapshot's timeline is the run's own sequence, so this is where the
 * interleaving already exists; all this does is record which surface each
 * ordering event belongs to, once.
 */
function timelineOrder(snapshot: RunSessionSnapshot): readonly LiveItem[] {
  const order: LiveItem[] = [];
  const seenMessages = new Set<string>();
  const seenTools = new Set<string>();

  for (const item of snapshot.timeline) {
    const event = item.payload;
    switch (event.type) {
      case 'assistant.text_delta':
      case 'assistant.text_block':
      case 'assistant.thinking_delta':
      case 'assistant.thinking_block':
      case 'assistant.message_finalized': {
        if (!seenMessages.has(event.messageId)) {
          seenMessages.add(event.messageId);
          order.push({ kind: 'message', id: event.messageId });
        }
        break;
      }
      case 'tool.call_preview':
      case 'tool.call_started':
      case 'tool.arguments_delta':
      case 'tool.progress':
      case 'tool.call_completed':
      case 'tool.timed_out': {
        if (!seenTools.has(event.toolCallId)) {
          seenTools.add(event.toolCallId);
          order.push({ kind: 'tool', id: event.toolCallId });
        }
        break;
      }
      default:
        break;
    }
  }

  // A surface with no ordering event still has to be drawn; append it rather than
  // dropping content the shared model built.
  for (const message of snapshot.messages) {
    if (!seenMessages.has(message.messageId)) order.push({ kind: 'message', id: message.messageId });
  }
  for (const tool of snapshot.toolCalls) {
    if (!seenTools.has(tool.toolCallId)) order.push({ kind: 'tool', id: tool.toolCallId });
  }
  return order;
}

function rowTime(row: ConversationRow): number {
  switch (row.kind) {
    case 'user':
    case 'assistant':
    case 'compaction':
      return row.at;
    case 'tool':
      return Number.MAX_SAFE_INTEGER;
  }
}
