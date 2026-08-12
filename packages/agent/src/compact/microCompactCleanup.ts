import type { Message, MessageContent, ToolResultContent } from '../types.js'

// WebSearch/WebFetch are retained only as historical wire names so old
// persisted conversations still receive the same micro-compaction behavior.
// The legacy capitalized names persist for old saved threads; the lowercase
// edit/write names match the current tool names washed through the pipeline.
//
// `Read` is deliberately EXCLUDED: stubbing early Read results to a fixed
// placeholder makes the model "forget" files it already read and forces it
// to re-read the same files every turn (the repeated-debugging symptom seen
// in long sessions). Read results are left intact so the model can reference
// earlier content; real compaction (session_memory/snip) is what reclaims
// that space when the context genuinely exceeds the budget.
export const COMPACTABLE_TOOLS = new Set([
  'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write',
  'edit', 'write',
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
