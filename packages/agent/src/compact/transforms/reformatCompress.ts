import type { Message, MessageContent } from '../../types.js'
import { findLastUserIndex, buildToolNameByUseId, contentToStr } from './shared.js'

/** Tools whose JSON output is reformatted losslessly into a compact table. */
export const REFORMAT_TOOLS = new Set(['grep', 'glob'])

/** Reformat a grep result JSON string into a table; null when not applicable. */
export function reformatGrepResult(result: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.matches) || (obj.matches as unknown[]).length === 0) return null
  const matches = obj.matches as Array<Record<string, unknown>>
  const rows = matches.map((m) => {
    const file = String(m.file ?? '')
    const line = String(m.line ?? '')
    const column = String(m.column ?? '')
    const content = String(m.content ?? '')
    return `${file},${line},${column},${content}`
  })
  const table = [`[${rows.length}]{file,line:int,column:int,content}`, ...rows].join('\n')
  return JSON.stringify({ ...obj, matches: table })
}

/** Reformat a glob result JSON string; null when not applicable. */
export function reformatGlobResult(result: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.filenames) || (obj.filenames as unknown[]).length === 0) return null
  const filenames = obj.filenames as string[]
  const table = [`[${filenames.length}]{filename}`, ...filenames].join('\n')
  return JSON.stringify({ ...obj, filenames: table })
}

export const reformatTransform = {
  name: 'reformat',
  apply(messages: Message[]): Message[] {
    const lastUserIdx = findLastUserIndex(messages)
    if (lastUserIdx <= 0) return messages
    const toolNameByUseId = buildToolNameByUseId(messages)
    let modified = false
    const result = messages.map((msg, idx) => {
      if (idx >= lastUserIdx) return msg
      if (msg.role === 'tool' && msg.tool_call_id) {
        const toolName = toolNameByUseId.get(msg.tool_call_id)
        if (!toolName || !REFORMAT_TOOLS.has(toolName)) return msg
        const str = contentToStr(msg.content)
        const rebuilt = toolName === 'grep' ? reformatGrepResult(str) : reformatGlobResult(str)
        if (rebuilt === null || rebuilt === str) return msg
        modified = true
        return { ...msg, content: rebuilt }
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        let msgModified = false
        const newContent = msg.content.map((block): MessageContent => {
          if (block.type !== 'tool_result') return block
          const toolName = toolNameByUseId.get(block.tool_use_id)
          if (!toolName || !REFORMAT_TOOLS.has(toolName)) return block
          const str = contentToStr(block.content)
          const rebuilt = toolName === 'grep' ? reformatGrepResult(str) : reformatGlobResult(str)
          if (rebuilt === null || rebuilt === str) return block
          msgModified = true
          return { ...block, content: rebuilt }
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