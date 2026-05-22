import type { Message } from '../types.js'

const COMPACTABLE_TOOLS = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write',
])

const MAX_RECENT_TO_KEEP = 15

export function microCleanupMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_RECENT_TO_KEEP) return messages

  const cleaned = messages.map((msg, index) => {
    const isRecent = index >= messages.length - MAX_RECENT_TO_KEEP
    if (isRecent || !Array.isArray(msg.content)) return msg

    const hasCompactableToolResult = msg.content.some(
      (block: any) =>
        block.type === 'tool_result' &&
        block.tool_use?.name &&
        COMPACTABLE_TOOLS.has(block.tool_use.name)
    )

    if (!hasCompactableToolResult) return msg

    const newContent = msg.content.map((block: any) => {
      if (
        block.type === 'tool_result' &&
        block.tool_use?.name &&
        COMPACTABLE_TOOLS.has(block.tool_use.name)
      ) {
        return {
          ...block,
          content: `[tool_result truncated by micro-compact]`,
          is_error: false,
        }
      }
      return block
    })

    return { ...msg, content: newContent }
  })

  return cleaned
}