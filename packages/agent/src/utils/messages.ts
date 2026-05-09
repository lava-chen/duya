/**
 * Message utilities
 */

import type { Message, MessageContent, TextContent } from '../types.js'

/**
 * Create a user message with the given content
 */
export function createUserMessage({
  content,
  name,
  tool_call_id,
}: {
  content: MessageContent[] | string
  name?: string
  tool_call_id?: string
}): Message {
  return {
    role: 'user',
    content: typeof content === 'string' ? content : content,
    id: crypto.randomUUID(),
    name,
    tool_call_id,
    timestamp: Date.now(),
  }
}

/**
 * Extract text content from message content blocks
 */
export function extractTextContent(
  content: MessageContent[] | string,
  separator = '\n',
): string {
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text)
    .join(separator)
}

/**
 * Get the last assistant message from a list of messages
 */
export function getLastAssistantMessage(
  messages: Message[],
): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      return messages[i]
    }
  }
  return undefined
}
