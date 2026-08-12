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

import type { Message, Model, MessageContent, ThinkingContent, TextContent, ToolResultContent } from '../types.js';

// =============================================================================
// Tool-result textification (Plan 418 Phase 2)
// =============================================================================

/**
 * Marker lines that wrap a textified tool result so the model can reliably
 * delimit tool output even when the endpoint rejects structured `tool_result`
 * content blocks.
 */
export const TEXTIFY_OPEN_MARK = '[Tool result:';
export const TEXTIFY_CLOSE_MARK = '[Tool result ended]';

export function textifyToolResultContent(
  toolCallId: string | undefined,
  content: string | MessageContent[],
  isError?: boolean,
  toolName?: string,
): string {
  let body: string;
  if (typeof content === 'string') {
    body = content;
  } else if (Array.isArray(content)) {
    body = content
      .map((block) => {
        switch (block.type) {
          case 'text':
            return block.text;
          case 'image':
            return NON_VISION_TOOL_IMAGE_PLACEHOLDER;
          case 'tool_result':
            return textifyToolResultContent(
              block.tool_use_id,
              block.content,
              block.is_error,
            );
          default:
            return '';
        }
      })
      .filter((part) => part.length > 0)
      .join('\n');
  } else {
    body = JSON.stringify(content);
  }

  const idPart = toolCallId ? ` tool_use_id=${toolCallId}` : '';
  const namePart = toolName ? ` ${toolName}` : '';
  return [
    `${TEXTIFY_OPEN_MARK}${isError ? ' error' : ''}${namePart}${idPart}]`,
    body,
    TEXTIFY_CLOSE_MARK,
  ].join('\n');
}

/**
 * Replace every tool-result carrier with a plain-text user message so the
 * payload contains no `tool_result` content blocks (Plan 418).
 *
 * Handles both carriers used in duya history:
 *   - `role: 'tool'` messages (new format: tool_call_id + string/array content)
 *   - `tool_result` blocks embedded in a message content array (legacy format)
 *
 * `tool_use` blocks on assistant messages are preserved — the endpoint either
 * accepts them (tool_use + text result) or rejects them, in which case the
 * caller degrades further (Plan 418 L2: drop tools entirely).
 */
export function textifyToolResults(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      // duya marks failed tool execution with a `<tool_error>` wrapper inside
      // the result content (StreamingToolExecutor.createErrorMessage). Detect
      // it so the textified form carries an explicit error marker.
      const isError =
        typeof msg.content === 'string' && msg.content.includes('<tool_error>');
      result.push({
        role: 'user',
        content: textifyToolResultContent(
          msg.tool_call_id,
          msg.content,
          isError,
          msg.name,
        ),
      });
      continue;
    }

    if (Array.isArray(msg.content)) {
      const toolResultBlocks = msg.content.filter(
        (b): b is ToolResultContent => b.type === 'tool_result',
      );
      if (toolResultBlocks.length > 0) {
        const remaining = msg.content.filter((b) => b.type !== 'tool_result');
        result.push({ ...msg, content: remaining });
        for (const block of toolResultBlocks) {
          result.push({
            role: 'user',
            content: textifyToolResultContent(
              block.tool_use_id,
              block.content,
              block.is_error,
            ),
          });
        }
        continue;
      }
    }

    result.push(msg);
  }
  return result;
}

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
