/**
 * Mapper for the rules module — Plan 551.
 *
 * The code profile's rules section interpolates tool names and the
 * todo-tool line conditionally. The blank line where the todo line
 * collapses is preserved by rendering an empty `rules_task_line` slot
 * (the template emits the line's newline either way, matching the legacy
 * template-literal shape).
 */

import type { PromptContext } from '../../types.js'
import { TOOL_NAMES } from '../../types.js'

function hasTodoTool(ctx: PromptContext): boolean {
  return (
    ctx.enabledTools.has(TOOL_NAMES.TODO)
    || ctx.enabledTools.has(TOOL_NAMES.TASK)
    || ctx.enabledTools.has(TOOL_NAMES.TODO_WRITE)
  )
}

export function mapRulesSlots(ctx: PromptContext): Record<string, unknown> {
  const taskTool = hasTodoTool(ctx) ? TOOL_NAMES.TODO : null
  const searchTools = ctx.hasEmbeddedSearchTools
    ? 'the provided search tools'
    : `${TOOL_NAMES.GREP} and ${TOOL_NAMES.GLOB}`
  return {
    rules_search_tools: searchTools,
    rules_file_tools: `${TOOL_NAMES.READ}/${TOOL_NAMES.EDIT}/${TOOL_NAMES.WRITE}`,
    rules_task_line: taskTool
      ? `- When using ${taskTool}, inspect existing tasks before creating work, respect owners and dependencies, and update status at meaningful checkpoints.`
      : '',
  }
}
