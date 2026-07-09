import type { Message, MessageContent, ToolResultContent } from '../types.js'

const COMPACTABLE_TOOLS = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write',
])

const MAX_RECENT_TO_KEEP = 15

export function microCleanupMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_RECENT_TO_KEEP) return messages

  // Build a tool_use_id -> tool_name map from all assistant messages
  // so we can look up the tool name for each tool_result block.
  // tool_result blocks do not carry the tool name directly; they only
  // reference the tool_use_id of the originating tool_use block.
  const toolNameByUseId = new Map<string, string>()
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      const b = block as unknown as Record<string, unknown>
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        toolNameByUseId.set(b.id, b.name)
      }
    }
  }

  const cleaned = messages.map((msg, index) => {
    const isRecent = index >= messages.length - MAX_RECENT_TO_KEEP
    if (isRecent || !Array.isArray(msg.content)) return msg

    const hasCompactableToolResult = msg.content.some(
      (block) => {
        const b = block as unknown as Record<string, unknown>
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') return false
        const toolName = toolNameByUseId.get(b.tool_use_id)
        return toolName !== undefined && COMPACTABLE_TOOLS.has(toolName)
      }
    )

    if (!hasCompactableToolResult) return msg

    const newContent: MessageContent[] = msg.content.map((block) => {
      const b = block as unknown as Record<string, unknown>
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const toolName = toolNameByUseId.get(b.tool_use_id)
        if (toolName !== undefined && COMPACTABLE_TOOLS.has(toolName)) {
          const truncated: ToolResultContent = {
            type: 'tool_result',
            tool_use_id: b.tool_use_id as string,
            content: '[tool_result truncated by micro-compact]',
            is_error: false,
          }
          return truncated
        }
      }
      return block
    })

    return { ...msg, content: newContent }
  })

  return cleaned
}
