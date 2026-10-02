// durable-stream-subtraction.ts — plan 447.
//
// Reconciles the StreamSessionManager's accumulated `streamingEvents`
// against the durable transcript (DB rows loaded into the conversation
// store). Plan 441 made persistence event-level mid-turn, so when a user
// switches back to an in-flight session the DB already contains the
// finished rounds while the snapshot still replays them — rendering the
// turn twice.
//
// Ordering invariant: SSE yields `tool_use` before its matching `tool_result`
// (generator protocol), and plan 441's Journal persists the assistant message
// (which carries the `tool_use` block) before the standalone tool_result row
// (assistant boundary at `done`, tool result at `for await ... getRemainingResults`).
// So durable-covered events form a PREFIX of the streaming timeline ending at
// the last durable `tool_use` — the earliest event with a stable id on both
// sides. Text/thinking have no ids but always sit inside that prefix, so
// cutting there removes exactly the finalized rounds and keeps the live tail
// (unfinalized text/thinking, running tools).
//
// Why not cut on `tool_result`? Tool result persistence is fire-and-forget IPC
// with a 3-5ms roundtrip; SSE's `yield` is synchronous. A renderer that
// reloads during the 3-5ms window between `assistant_message_finalized` and
// `tool_result_added` will see the tool_use in DB but the tool_result not yet
// in DB — yet both are already in `streamingEvents` (SSE pushed them earlier).
// Cutting on tool_result would fail in that window and re-render the entire
// SSE prefix, breaking the group summary. Cutting on tool_use closes that
// window because tool_use persistence always lands before tool_result.
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
  /**
   * Number of `isCompactSummary` messages already persisted. Each finished
   * compaction is durably recorded as such a message, so once a compaction's
   * 'done'/'error' streaming event is represented by a durable row, the live
   * `compact` action should not render a second copy. Optional for backward
   * compatibility — omitted (or 0) means "no compact cleanup".
   */
  compactedCount?: number;
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
  let compactedCount = 0;

  for (const msg of messages) {
    if (msg.isCompactSummary) compactedCount += 1;
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

  return { toolUseIds, toolResultIds, finalAssistantText, compactedCount };
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
    && (durable.compactedCount ?? 0) === 0
  ) {
    return events as StreamingEvent[];
  }

  // Union of durable tool ids: a tool_result whose id is in toolUseIds is
  // *also* durably covered (the matching tool_use row is durable, the
  // tool_result row is just a 3-5ms IPC lag behind it). Without this union
  // the dedup pass below would keep the SSE tool_result on screen and
  // re-render the same tool that MessageItem already drew from the
  // durable row. Plan 441's mid-turn persistence is what makes this
  // window reachable.
  const allDurableToolIds = new Set<string>([
    ...durable.toolUseIds,
    ...durable.toolResultIds,
  ]);

  // Last durable tool_use marks the end of the covered prefix. See the
  // module-level Ordering invariant for why we anchor on tool_use instead
  // of tool_result (Journal persists the assistant message — which carries
  // the tool_use block — strictly before the matching tool_result row).
  let cut = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'tool_use' && durable.toolUseIds.has(e.toolUse.id)) {
      cut = i;
      break;
    }
  }

  const hasToolWork = allDurableToolIds.size > 0;
  const hasStrayDurableToolEvent = hasToolWork && events.some((e, i) => {
    if (i <= cut) return false;
    if (e.type === 'tool_use') return allDurableToolIds.has(e.toolUse.id);
    if (e.type === 'tool_result') return allDurableToolIds.has(e.toolResult.tool_use_id);
    return false;
  });

  const compactedCount = durable.compactedCount ?? 0;
  // Only the compacted-count cleanup applies (no durable tool rows / text):
  // skip straight to compact subtraction without the tool-prefix cut.
  if (cut < 0 && !hasStrayDurableToolEvent && !durable.finalAssistantText) {
    return removeCoveredCompactEvents(events, compactedCount);
  }

  const out: StreamingEvent[] = [];
  for (let i = cut + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'tool_use' && allDurableToolIds.has(e.toolUse.id)) continue;
    if (e.type === 'tool_result' && allDurableToolIds.has(e.toolResult.tool_use_id)) continue;
    out.push(e);
  }

  // Trailing-text fallback: when the durable last-assistant text is fully
  // captured by the remaining text events after the cut, drop those text
  // events too so the same reply doesn't render as both a durable row and
  // a live-stream row for a frame before `isStreaming` flips off.
  if (durable.finalAssistantText) {
    const trailingText = concatTrailingText(out);
    if (trailingText.length > 0 && trailingText === durable.finalAssistantText) {
      return removeCoveredCompactEvents(out.filter((e) => e.type !== 'text'), compactedCount);
    }
  }

  return removeCoveredCompactEvents(out, compactedCount);
}

/**
 * Drop `compact` events already represented by durable `isCompactSummary`
 * rows. Each finished compaction persists exactly one summary message, so up
 * to `compactedCount` of the 'done'/'error' compact events can be removed.
 * A still-running 'compacting' event is never a finished durable record, so
 * it is always kept — the durable row appears only once 'done' lands.
 */
function removeCoveredCompactEvents(
  events: readonly StreamingEvent[],
  compactedCount: number,
): StreamingEvent[] {
  if (compactedCount <= 0) return events as StreamingEvent[];
  const out: StreamingEvent[] = [];
  let removed = 0;
  for (const e of events) {
    if (
      removed < compactedCount
      && e.type === 'compact'
      && (e.phase === 'done' || e.phase === 'error')
    ) {
      removed += 1;
      continue;
    }
    out.push(e);
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
