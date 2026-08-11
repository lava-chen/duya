import type { Message, MessageContent } from '../../types.js'
import { findLastUserIndex, buildToolNameByUseId, contentToStr } from './shared.js'

/** Tools whose plain-text long bodies are replaced with a placeholder. */
export const OFFLOAD_TOOLS = new Set(['read', 'bash'])

/** Bodies longer than this (chars) get replaced. */
export const OFFLOAD_THRESHOLD = 2000

export function offloadPlaceholder(toolName: string): string {
  const hint =
    toolName === 'read'
      ? 'use read to re-read the file'
      : 'use bash to re-run the command'
  return `[tool_result truncated by projection-compress — ${hint} if needed]`
}

export const offloadTransform = {
  name: 'offload',
  apply(messages: Message[]): Message[] {
    const lastUserIdx = findLastUserIndex(messages)
    if (lastUserIdx <= 0) return messages
    const toolNameByUseId = buildToolNameByUseId(messages)
    let modified = false
    const result = messages.map((msg, idx) => {
      if (idx >= lastUserIdx) return msg
      if (msg.role === 'tool' && msg.tool_call_id) {
        const toolName = toolNameByUseId.get(msg.tool_call_id)
        if (!toolName || !OFFLOAD_TOOLS.has(toolName)) return msg
        const str = contentToStr(msg.content)
        if (str.length <= OFFLOAD_THRESHOLD) return msg
        modified = true
        return { ...msg, content: offloadPlaceholder(toolName) }
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        let msgModified = false
        const newContent = msg.content.map((block): MessageContent => {
          if (block.type !== 'tool_result') return block
          const toolName = toolNameByUseId.get(block.tool_use_id)
          if (!toolName || !OFFLOAD_TOOLS.has(toolName)) return block
          const str = contentToStr(block.content)
          if (str.length <= OFFLOAD_THRESHOLD) return block
          msgModified = true
          return { ...block, content: offloadPlaceholder(toolName) }
        })
        if (msgModified) {
          modified = true
          return { ...msg, content: newContent }
        }
      }
      return msg
    })
    return modified ? result : messages
  },
}