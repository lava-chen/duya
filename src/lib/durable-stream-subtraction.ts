// durable-stream-subtraction.ts — plan 447.
//
// Reconciles the StreamSessionManager's accumulated `streamingEvents`
// against the durable transcript (DB rows loaded into the conversation
// store). Plan 441 made persistence event-level mid-turn, so when a user
// switches back to an in-flight session the DB already contains the
// finished rounds while the snapshot still replays them — rendering the
// turn twice.
//
// Ordering invariant: journal persistence follows event arrival order, so
// durable-covered events form a PREFIX of the streaming timeline ending at
// the last durable `tool_result` (the only event kind with a stable id on
// both sides). Text/thinking have no ids but always sit inside that prefix,
// so cutting there removes exactly the finalized rounds and keeps the live
// tail (unfinalized text/thinking, running tools).
//
// Trailing-text fallback: a finalized text-only assistant block (no tool
// round in the same turn) cannot be cut by id. We additionally compare the
// concatenated text after the cut against the last durable assistant
// message's text — if they match exactly, drop the trailing text events
// too so the same reply doesn't render twice for a frame.

import type { StreamingEvent } from './stream-session-manager';
import type { Message } from '@/types';

export interface DurableToolIds {
  /** tool_use block ids present in durable assistant messages. */
  toolUseIds: Set<string>;
  /** tool_call ids present in durable tool-result rows. */
  toolResultIds: Set<string>;
  /**
   * Concatenated text from the LAST durable assistant message (string
   * content, or text blocks joined by '\n\n'). Empty when the transcript
   * has no assistant message yet or its text cannot be reconstructed.
   * Optional for backwards compatibility — callers that don't need the
   * trailing-text fallback may omit it.
   */
  finalAssistantText?: string;
}

/**
 * Extract the tool ids and the trailing assistant text already persisted
 * in the store's message rows for a session. Mirrors the extraction in
 * stream-session-manager's `registerLoadedMessages`, but operates on
 * mapped store Messages.
 */
export function extractDurableToolIds(messages: readonly Message[]): DurableToolIds {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  let finalAssistantText = '';
  let sawAssistant = false;

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const block of msg.content) {
        if (
          block
          && typeof block === 'object'
          && block.type === 'tool_use'
          && typeof (block as Record<string, unknown>).id === 'string'
        ) {
          toolUseIds.add((block as Record<string, unknown>).id as string);
        } else if (
          block
          && typeof block === 'object'
          && block.type === 'text'
          && typeof (block as Record<string, unknown>).text === 'string'
        ) {
          textParts.push(String((block as Record<string, unknown>).text));
        }
      }
      if (textParts.length > 0) {
        finalAssistantText = textParts.join('\n\n');
        sawAssistant = true;
      }
    } else if (msg.role === 'tool') {
      const toolCallId = msg.parentToolCallId ?? msg.tool_call_id;
      if (typeof toolCallId === 'string' && toolCallId) {
        toolResultIds.add(toolCallId);
      }
    }
    // String content: rare on assistant rows (the IPC parser usually maps
    // them through arrays); fall through with the previous value.
  }

  // Drop the text marker if no assistant message carried any reconstructable
  // text — keeps `finalAssistantText === ''` honest for the comparison.
  if (!sawAssistant) finalAssistantText = '';

  return { toolUseIds, toolResultIds, finalAssistantText };
}

/**
 * Drop the durable-covered prefix from the streaming timeline and any stray
 * durable tool events after it. Returns the input array unchanged (identity)
 * when nothing is covered — the common live-streaming case.
 */
export function subtractDurableStreamingEvents(
  events: readonly StreamingEvent[],
  durable: DurableToolIds,
): StreamingEvent[] {
  if (
    durable.toolUseIds.size === 0
    && durable.toolResultIds.size === 0
    && !durable.finalAssistantText
  ) {
    return events as StreamingEvent[];
  }

  // Last durable tool_result marks the end of the covered prefix.
  let cut = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'tool_result' && durable.toolResultIds.has(e.toolResult.tool_use_id)) {
      cut = i;
      break;
    }
  }

  const hasStrayDurableToolEvent = events.some((e, i) => {
    if (i <= cut) return false;
    if (e.type === 'tool_use') return durable.toolUseIds.has(e.toolUse.id);
    if (e.type === 'tool_result') return durable.toolResultIds.has(e.toolResult.tool_use_id);
    return false;
  });

  if (cut < 0 && !hasStrayDurableToolEvent) {
    return events as StreamingEvent[];
  }

  const out: StreamingEvent[] = [];
  for (let i = cut + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'tool_use' && durable.toolUseIds.has(e.toolUse.id)) continue;
    if (e.type === 'tool_result' && durable.toolResultIds.has(e.toolResult.tool_use_id)) continue;
    out.push(e);
  }

  // Trailing-text fallback: when the durable last-assistant text is fully
  // captured by the remaining text events after the cut, drop those text
  // events too so the same reply doesn't render as both a durable row and
  // a live-stream row for a frame before `isStreaming` flips off.
  if (durable.finalAssistantText) {
    const trailingText = concatTrailingText(out);
    if (trailingText.length > 0 && trailingText === durable.finalAssistantText) {
      return out.filter((e) => e.type !== 'text');
    }
  }

  return out;
}

function concatTrailingText(events: readonly StreamingEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type === 'text' && e.content) parts.push(e.content);
  }
  return parts.join('');
}
