/**
 * packages/ai/src/api/transform-messages.ts
 *
 * Cross-provider message transformation with isSameModel guard.
 *
 * Spec §8.4: When the target model differs from the message's origin model,
 * thinking blocks are downgraded to plain text (signature discarded) to avoid
 * invalid replay and model mimicry of thinking tags.
 *
 * Tool-result images: when a tool_result carries inline ImageContent blocks
 * (e.g. ReadTool on a pure image file) and the target model lacks vision
 * support, the image blocks are downgraded to placeholder text so we never
 * send an image to a non-vision endpoint. Vision-capable models keep the
 * image blocks and the provider adapter forwards them natively.
 */

import type { Message, Model, MessageContent, ThinkingContent, TextContent } from '../types.js';

export function isSameModel(msg: Message, targetModel: Model): boolean {
  return msg.providerId === targetModel.providerId
    && msg.model === targetModel.id
    && msg.api === targetModel.api;
}

const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  '(image omitted: model does not support images. Use the vision tool to analyze the image.)';

/**
 * Replace every ImageContent block in a tool-result content array with a
 * text placeholder. Used when the target model's `input` lacks 'image'.
 */
function downgradeToolImageBlocks(content: MessageContent[]): MessageContent[] {
  return content.map((block: MessageContent): MessageContent => {
    if (block.type === 'image') {
      return { type: 'text', text: NON_VISION_TOOL_IMAGE_PLACEHOLDER };
    }
    return block;
  });
}

export function transformMessages(
  messages: Message[],
  targetModel: Model,
): Message[] {
  return messages.map(msg => {
    // Tool messages with array content carry inline images (e.g. ReadTool on
    // a pure image file). Downgrade image blocks to placeholder text when the
    // main model lacks vision support so non-vision endpoints never receive an
    // image block. Vision-capable models keep the image blocks untouched and
    // the provider adapter forwards them natively.
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      if (targetModel.input.includes('image')) {
        return msg;
      }
      return {
        ...msg,
        content: downgradeToolImageBlocks(msg.content),
      };
    }

    if (msg.role !== 'assistant' || typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;

    const same = isSameModel(msg, targetModel);

    return {
      ...msg,
      content: msg.content.map((block: MessageContent): MessageContent => {
        if (block.type === 'thinking') {
          if (same) {
            // Keep thinking + signature for replay
            return block;
          }
          // Cross-model: downgrade to plain text, discard signature
          const downgraded: TextContent = { type: 'text', text: block.thinking };
          return downgraded;
        }
        return block;
      }),
    };
  });
}
