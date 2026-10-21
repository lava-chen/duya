/**
 * imageTruncationTransform.ts — plan 454 follow-up (image token budget).
 *
 * Drops old screenshot content from the projected message array to keep
 * the LLM request bounded. Mirrors claude-quickstarts
 * `_maybe_filter_to_n_most_recent_images`:
 *
 *   - Walks every `tool_result` content block in user messages
 *   - Counts embedded `image` content blocks (base64 PNG / JPEG / WEBP)
 *     attributed to a `computer_use` tool call (the screenshot the
 *     dispatcher returns from `capture` / `zoom` / `type` follow-up)
 *   - When the total exceeds the configured budget, drops the
 *     oldest image blocks in chunks (per-message granularity so we
 *     don't break prompt cache any more than necessary)
 *
 * Default budget: 5 screenshots per session. Configurable via
 * `DUYA_COMPUTER_USE_IMAGE_BUDGET` env var.
 *
 * This is a projection-layer transform — the persisted message
 * history is left intact so the user can scroll back to see every
 * screenshot in the chat; only the projected copy sent to the LLM
 * is trimmed.
 *
 * The transform never modifies `tool_result.text` blocks; the model
 * can still read the structured error / result text and knows the
 * image was truncated (we leave a short notice in the tool result
 * text so the model isn't confused by the missing screenshot).
 */

import type { Message, MessageContent, ToolResultContent } from '../../types.js';
import type { ProjectionTransform } from '../projectionCompress.js';

const ENV_BUDGET = 'DUYA_COMPUTER_USE_IMAGE_BUDGET';
const DEFAULT_BUDGET = 5;

/** Tools whose tool_result payloads may include image content. */
const IMAGE_TOOLS = new Set(['computer_use', 'Read', 'VisionAnalyze']);

const BUDGET = (() => {
  const raw = process.env[ENV_BUDGET];
  if (raw === undefined) return DEFAULT_BUDGET;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_BUDGET;
})();

/**
 * Check whether a tool name is one that may emit image content.
 * Exposed for callers that want to know whether to expect images.
 */
export function isImageTool(toolName: string | undefined): boolean {
  return toolName !== undefined && IMAGE_TOOLS.has(toolName);
}

/**
 * Count image content blocks across the message list. Walks
 * `tool_result` content blocks recursively (some tools nest the
 * image inside a JSON-serialized envelope).
 */
function countImages(blocks: readonly unknown[]): number {
  let count = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'image') {
      count += 1;
      continue;
    }
    // The computer_use dispatcher returns images as
    // `{ type: 'image', source: { type: 'base64', ... } }`. Older
    // tools may use a different shape; we trust the `type` field
    // alone here.
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      count += countImages(b.content as readonly unknown[]);
    }
  }
  return count;
}

/**
 * Image truncation transform (plan 454 follow-up). Drops the
 * oldest `image` content blocks from the message array when the
 * total exceeds the configured budget.
 *
 * The transform is pure: it returns a new array only when at
 * least one image was actually dropped. If the budget is 0 (or
 * the env explicitly sets it to 0), every image is dropped.
 */
export const imageTruncationTransform: ProjectionTransform = {
  name: 'computer-use-image-truncation',
  apply(messages: Message[]): Message[] {
    // First pass: count + collect the messages that contain
    // droppable image content. We only touch the messages that
    // contain a `computer_use` (or other image-emitter) tool_result.
    const toolNameByUseId = new Map<string, string>();
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          toolNameByUseId.set(b.id, b.name);
        }
      }
    }

    // Count total images in tool_results that come from image tools.
    let totalImages = 0;
    type ImageRef = { msgIndex: number; blockIndex: number };
    const imageRefs: ImageRef[] = [];
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (!msg || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi];
        if (!block || typeof block !== 'object') continue;
        const b = block as unknown as Record<string, unknown>;
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const toolName = toolNameByUseId.get(b.tool_use_id);
        if (!isImageTool(toolName)) continue;
        if (!Array.isArray(b.content)) continue;
        const inner = b.content as readonly unknown[];
        const innerCount = countImages(inner);
        totalImages += innerCount;
        for (let ci = 0; ci < inner.length; ci++) {
          const cb = inner[ci];
          if (cb && typeof cb === 'object' && (cb as Record<string, unknown>).type === 'image') {
            imageRefs.push({ msgIndex: mi, blockIndex: bi });
            // We only need one ref per tool_result (the image we
            // drop is the first image inside that tool_result's
            // content). The first ref per (msg, block) is enough.
            break;
          }
        }
      }
    }

    if (totalImages <= BUDGET || imageRefs.length === 0) return messages;

    const dropCount = totalImages - BUDGET;
    // Drop the oldest first, in FIFO order. imageRefs is already in
    // message order so this is the natural order.
    const toDrop = new Set(imageRefs.slice(0, dropCount).map((r) => `${r.msgIndex}:${r.blockIndex}`));

    const rewritten: Message[] = messages.map((msg, mi) => {
      if (!Array.isArray(msg.content)) return msg;
      let changed = false;
      const newContent: MessageContent[] = msg.content.map((block, bi) => {
        const key = `${mi}:${bi}`;
        if (!toDrop.has(key)) return block;
        if (!block || typeof block !== 'object') return block;
        const b = block as unknown as Record<string, unknown>;
        if (b.type !== 'tool_result' || !Array.isArray(b.content)) return block;
        const inner = b.content as Array<Record<string, unknown>>;
        const newInner = inner.filter((cb) => cb.type !== 'image');
        if (newInner.length === inner.length) return block;
        changed = true;
        const toolResult = block as ToolResultContent;
        // Leave a short notice so the model knows the screenshot
        // was dropped by the truncation policy. This avoids
        // re-asking the user for content the model never sees.
        const notice =
          '[computer-use image truncated by projection pipeline; ' +
          'call capture again to re-fetch]';
        const noticeBlock: ToolResultContent = {
          type: 'tool_result',
          tool_use_id: toolResult.tool_use_id,
          content: [
            ...newInner,
            { type: 'text', text: notice } as unknown as ToolResultContent['content'][number],
          ],
        } as unknown as ToolResultContent;
        return noticeBlock as unknown as MessageContent;
      });
      return changed ? { ...msg, content: newContent } : msg;
    });

    return rewritten;
  },
};
