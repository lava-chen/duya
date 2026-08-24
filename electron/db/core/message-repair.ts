/**
 * Read-side repair for crash-interrupted tool_use/tool_result pairs (plan 441).
 *
 * The journal writes each completed event boundary as it lands, so a hard
 * crash mid-turn only loses at most one in-flight tool call — the tool_use
 * was appended to the timeline but its tool_result never was. When the
 * session is reloaded, this helper scans the projected timeline and
 * synthesizes `[interrupted by crash]` tool_result entries for every
 * unmatched tool_use so the conversation makes sense to both the user
 * (they see the model was about to call a tool) and the agent loop (the
 * provider-acceptable shape has every tool_use paired).
 *
 * Symmetric cleanup also runs:
 *   - orphan tool_results (no matching tool_use anywhere) are dropped
 *     because the provider rejects them with 400 "tool call id is invalid".
 *
 * The function is pure: takes TimelineEntryRow[], returns the same shape
 * with optional synthesized rows appended. Callers can drop events
 * (compaction, rollout-process events) before passing to this helper.
 */

import type { MessageEntry } from '@duya/agent/message';
import type { TimelineEntryRow } from './message-log';

const INTERRUPTED_PLACEHOLDER = '[interrupted by crash]';

/**
 * Walk the message timeline once, collecting tool_use / tool_result ids.
 * Then append synthesized tool_result entries for any unmatched tool_use
 * AND drop orphan tool_result entries (no matching tool_use).
 *
 * Returned rows preserve input seq. Synthesized rows are appended at the
 * end with seq = max(existing seq) + 1, so callers that need a strictly
 * monotonic projection should renumber afterwards.
 */
export function repairInterruptedToolCalls(
  rows: TimelineEntryRow[],
): TimelineEntryRow[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  /** Per tool_use_id, the assistant message id containing the block. */
  const toolUseHostById = new Map<string, string>();

  // First pass: collect ids.
  for (const row of rows) {
    if (row.entry.type !== 'message') continue;
    const msg = row.entry.message;
    collectToolUseIds(msg, toolUseIds, toolUseHostById);
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    }
  }

  const unmatched = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) unmatched.add(id);
  }
  const orphans = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphans.add(id);
  }

  if (unmatched.size === 0 && orphans.size === 0) {
    return rows;
  }

  const result: TimelineEntryRow[] = [];
  let maxSeq = 0;
  for (const row of rows) {
    if (row.seq > maxSeq) maxSeq = row.seq;
    if (row.entry.type === 'message') {
      const msg = row.entry.message;
      // Drop orphan tool_result rows.
      if (msg.role === 'tool' && typeof msg.tool_call_id === 'string' && orphans.has(msg.tool_call_id)) {
        continue;
      }
    }
    result.push(row);
  }

  // Second pass: synthesize tool_result entries for unmatched tool_uses.
  for (const id of unmatched) {
    const synthetic: MessageEntry = {
      type: 'message',
      id: `repair:${id}`,
      parentId: toolUseHostById.get(id) ?? null,
      createdAt: Date.now(),
      message: {
        role: 'tool',
        id: `repair:${id}`,
        content: INTERRUPTED_PLACEHOLDER,
        timestamp: Date.now(),
        tool_call_id: id,
        status: 'done',
        visibility: 'visible',
      } as MessageEntry['message'],
    };
    maxSeq += 1;
    result.push({ entry: synthetic, seq: maxSeq });
  }

  return result;
}

/**
 * Collect every tool_use id found in `msg.content` blocks into the
 * provided sets. Both `msg_type === 'tool_use'` (single-block messages)
 * and mixed-content assistant messages are covered.
 */
function collectToolUseIds(
  msg: MessageEntry['message'],
  toolUseIds: Set<string>,
  toolUseHostById: Map<string, string>,
): void {
  if (msg.msg_type === 'tool_use' && typeof msg.tool_call_id === 'string' && msg.tool_call_id) {
    toolUseIds.add(msg.tool_call_id);
    toolUseHostById.set(msg.tool_call_id, msg.id ?? '');
    return;
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'tool_use' &&
        'id' in block &&
        typeof block.id === 'string'
      ) {
        toolUseIds.add(block.id);
        toolUseHostById.set(block.id, msg.id ?? '');
      }
    }
  }
}