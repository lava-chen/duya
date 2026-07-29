/**
 * packages/ai/src/api/transform-messages.ts
 *
 * Cross-provider message transformation with isSameModel guard.
 *
 * Spec §8.4: When the target model differs from the message's origin model,
 * thinking blocks are downgraded to plain text (signature discarded) to avoid
 * invalid replay and model mimicry of thinking tags.
 */

import type { Message, Model, MessageContent, ThinkingContent, TextContent } from '../types.js';

export function isSameModel(msg: Message, targetModel: Model): boolean {
  return msg.providerId === targetModel.providerId
    && msg.model === targetModel.id
    && msg.api === targetModel.api;
}

export function transformMessages(
  messages: Message[],
  targetModel: Model,
): Message[] {
  return messages.map(msg => {
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
