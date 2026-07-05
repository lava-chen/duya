/**
 * Historical canvas tool-call compression.
 *
 * Long conversations accumulate large `canvas_*` tool_use inputs (e.g.
 * `canvas_batch_create` with 10 elements) and large tool_results (e.g.
 * `canvas_list_elements` returning a long markdown tree, or
 * `canvas_capture` returning a base64 PNG data URL). After several
 * rounds these historical details are no longer needed — the LLM can
 * re-read the current canvas state via `canvas_list_elements`.
 *
 * This module rewrites the message array sent to the LLM (NOT the
 * persisted `this.messages`) so that historical canvas tool_use inputs
 * and oversized tool_results are replaced with compact placeholders.
 * The most recent round (last user message and everything after) is
 * always left intact so the current reasoning chain is preserved.
 *
 * Env switch: `DUYA_COMPRESS_CANVAS_HISTORY`
 *   - unset / any value other than 'false' → compression enabled (default)
 *   - 'false' → compression disabled
 *
 * Mirrors the pattern in `microCompactCleanup.ts` but targets canvas
 * tools specifically and rewrites both tool_use inputs and tool_result
 * bodies.
 */

import type { Message, MessageContent } from '../types.js';

/**
 * Canvas tools whose historical inputs/results should be compressed.
 *
 * `canvas_get_knowledge` is intentionally excluded — it returns static
 * design-knowledge content that is not canvas state and may be cited
 * later. `canvas_list_elements` is included because its result (a long
 * markdown tree of every element) is the single largest historical
 * payload in a canvas-heavy session.
 */
const CANVAS_TOOL_NAMES = new Set<string>([
  'canvas_create_element',
  'canvas_batch_create',
  'canvas_delete_element',
  'canvas_move_element',
  'canvas_resize_element',
  'canvas_fill_content',
  'canvas_style_element',
  'canvas_list_elements',
  'canvas_capture',
]);

/** Don't compress very short histories — not worth the churn. */
const MIN_MESSAGES_FOR_COMPRESSION = 4;

/** Tool results longer than this (in chars) get replaced. */
const TOOL_RESULT_COMPRESS_THRESHOLD = 500;

const COMPRESSED_TOOL_USE_INPUT: Record<string, unknown> = {
  _compressed:
    '[canvas tool input replaced — use canvas_list_elements to get current state]',
};

const COMPRESSED_TOOL_RESULT =
  '[canvas tool result replaced — use canvas_list_elements for current state]';

/**
 * Compress historical canvas tool calls in the message array sent to
 * the LLM. Returns a new array when compression is applied; returns
 * the input reference unchanged when there is nothing to compress or
 * when the env switch is off. Never mutates the input array or its
 * message objects.
 */
export function compressHistoricalCanvasToolCalls(messages: Message[]): Message[] {
  // Env switch: default enabled, disabled only when explicitly 'false'.
  if (process.env.DUYA_COMPRESS_CANVAS_HISTORY === 'false') {
    return messages;
  }

  if (messages.length <= MIN_MESSAGES_FOR_COMPRESSION) {
    return messages;
  }

  // Find the index of the last user-mode message. Everything from
  // that index onward is the current round and is left intact so the
  // model retains its reasoning chain for the active turn.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx <= 0) {
    return messages;
  }

  // First pass: collect tool_use IDs of canvas tool calls in the
  // history portion (before lastUserIdx). We need the IDs so we can
  // match tool_result messages back to the canvas tool that produced
  // them, regardless of whether the result is stored in the new
  // (role: 'tool') or legacy (role: 'user' with tool_result block)
  // format.
  const canvasToolUseIds = new Set<string>();
  for (let i = 0; i < lastUserIdx; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && CANVAS_TOOL_NAMES.has(block.name)) {
        canvasToolUseIds.add(block.id);
      }
    }
  }
  if (canvasToolUseIds.size === 0) {
    return messages;
  }

  // Second pass: rewrite historical messages.
  let modified = false;
  const result = messages.map((msg, idx) => {
    if (idx >= lastUserIdx) return msg;

    // Assistant messages: replace canvas tool_use input with a placeholder.
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      let msgModified = false;
      const newContent = msg.content.map((block): MessageContent => {
        if (block.type === 'tool_use' && CANVAS_TOOL_NAMES.has(block.name)) {
          msgModified = true;
          return {
            ...block,
            input: { ...COMPRESSED_TOOL_USE_INPUT },
          };
        }
        return block;
      });
      if (msgModified) {
        modified = true;
        return { ...msg, content: newContent };
      }
      return msg;
    }

    // New-format tool results: role 'tool' with tool_call_id + string content.
    if (msg.role === 'tool' && msg.tool_call_id && canvasToolUseIds.has(msg.tool_call_id)) {
      const contentStr = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      if (contentStr.length > TOOL_RESULT_COMPRESS_THRESHOLD) {
        modified = true;
        return { ...msg, content: COMPRESSED_TOOL_RESULT };
      }
    }

    // Legacy-format tool results: role 'user' with content array
    // containing tool_result blocks.
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      let msgModified = false;
      const newContent = msg.content.map((block): MessageContent => {
        if (block.type !== 'tool_result') return block;
        if (!canvasToolUseIds.has(block.tool_use_id)) return block;
        const contentStr = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        if (contentStr.length <= TOOL_RESULT_COMPRESS_THRESHOLD) return block;
        msgModified = true;
        return {
          ...block,
          content: COMPRESSED_TOOL_RESULT,
        };
      });
      if (msgModified) {
        modified = true;
        return { ...msg, content: newContent };
      }
    }

    return msg;
  });

  return modified ? result : messages;
}
