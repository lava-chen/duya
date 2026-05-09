/**
 * Tool Usage Section - Tool Preference Guidance
 */

import type { PromptContext, ToolPromptContribution } from '../types.js'
import { TOOL_NAMES } from '../types.js'

export function getToolUsageSection(
  ctx: PromptContext,
  toolContributions: ToolPromptContribution[],
): string {
  const hasAgentTool = ctx.enabledTools.has(TOOL_NAMES.AGENT)
  const hasTaskTool = ctx.enabledTools.has(TOOL_NAMES.TASK_CREATE) || ctx.enabledTools.has(TOOL_NAMES.TODO_WRITE)
  const hasEmbeddedSearchTools = ctx.hasEmbeddedSearchTools ?? false
  const isReplModeEnabled = ctx.isReplModeEnabled ?? false

  if (isReplModeEnabled) {
    const items = [
      hasTaskTool
        ? `Break down and manage your work with the ${ctx.enabledTools.has(TOOL_NAMES.TASK_CREATE) ? TOOL_NAMES.TASK_CREATE : TOOL_NAMES.TODO_WRITE} tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.`
        : null,
    ].filter(item => item !== null)
    if (items.length === 0) return ''
    return `# Using your tools

${items.map(item => ` - ${item}`).join('\n')}`
  }

  const providedToolSubitems = [
    `To read files use ${TOOL_NAMES.READ} instead of cat, head, tail, or sed`,
    `To edit files use ${TOOL_NAMES.EDIT} instead of sed or awk`,
    `To create files use ${TOOL_NAMES.WRITE} instead of cat with heredoc or echo redirection`,
    ...(hasEmbeddedSearchTools
      ? []
      : [
          `To search for files use ${TOOL_NAMES.GLOB} instead of find or ls`,
          `To search the content of files, use ${TOOL_NAMES.GREP} instead of grep or rg`,
        ]),
    `Reserve using the ${TOOL_NAMES.BASH} exclusively for system commands and terminal operations that require shell execution. If you are unsure and there is a relevant dedicated tool, default to using the dedicated tool and only fallback on using the ${TOOL_NAMES.BASH} tool for these if it is absolutely necessary.`,
  ]

  const items = [
    `Do NOT use the ${TOOL_NAMES.BASH} to run commands when a relevant dedicated tool is provided. Using dedicated tools allows the user to better understand and review your work. This is CRITICAL to assisting the user:`,
    providedToolSubitems,
    hasTaskTool
      ? `Break down and manage your work with the ${ctx.enabledTools.has(TOOL_NAMES.TASK_CREATE) ? TOOL_NAMES.TASK_CREATE : TOOL_NAMES.TODO_WRITE} tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.`
      : null,
    `You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially instead. For instance, if one operation must complete before another starts, run these operations sequentially instead.`,
  ].filter(item => item !== null)

  let toolSpecificGuidance = ''
  if (toolContributions.length > 0) {
    const guidanceItems = toolContributions
      .filter(tc => tc.usageGuidance)
      .map(tc => `${tc.toolName}: ${tc.usageGuidance}`)
    if (guidanceItems.length > 0) {
      toolSpecificGuidance = '\n\n' + guidanceItems.join('\n')
    }
  }

  const flatItems: string[] = []
  for (const item of items) {
    if (Array.isArray(item)) {
      flatItems.push(...item.map(subitem => `  - ${subitem}`))
    } else if (item !== null) {
      flatItems.push(` - ${item}`)
    }
  }

  return `# Using your tools
${flatItems.join('\n')}${toolSpecificGuidance}`
}
