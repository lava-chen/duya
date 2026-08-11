import type { Message, MessageContent } from '../../types.js'

/** Index of the last user-role message, or -1 when none exists. */
export function findLastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** Map tool_use_id -> tool name from every assistant tool_use block. */
export function buildToolNameByUseId(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

/** Flatten tool_result content to a string for length checks. */
export function contentToStr(content: string | MessageContent[]): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}