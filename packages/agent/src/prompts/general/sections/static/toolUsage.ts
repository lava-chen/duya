/**
 * General Agent Tool Usage Section
 * Tool preference guidance
 */

import type { PromptContext, ToolPromptContribution } from '../../../types.js'
import { TOOL_NAMES } from '../../../types.js'

export function getToolUsageSection(
  ctx: PromptContext,
  toolContributions: ToolPromptContribution[],
): string {
  const hasTaskTool = ctx.enabledTools.has(TOOL_NAMES.TASK) || ctx.enabledTools.has(TOOL_NAMES.TODO_WRITE)
  const hasEmbeddedSearchTools = ctx.hasEmbeddedSearchTools ?? false
  const isReplModeEnabled = ctx.isReplModeEnabled ?? false
  const hasPowerShellTool = ctx.enabledTools.has('powershell')
  const shellToolsLabel = hasPowerShellTool
    ? `${TOOL_NAMES.BASH} or ${TOOL_NAMES.POWERSHELL}`
    : TOOL_NAMES.BASH

  if (isReplModeEnabled) {
    const items = [
      hasTaskTool
        ? `Break down and manage your work with the ${TOOL_NAMES.TASK} tool. These tools are helpful for planning your work and helping the user track your progress.`
        : null,
    ].filter(item => item !== null)
    if (items.length === 0) return ''
    return `# Using your tools

${items.map(item => ` - ${item}`).join('\n')}`
  }

  const providedToolSubitems = [
    `To read files use ${TOOL_NAMES.READ}`,
    `To edit files use ${TOOL_NAMES.EDIT}`,
    `To create files use ${TOOL_NAMES.WRITE}`,
    ...(hasEmbeddedSearchTools
      ? []
      : [
          `To search for files use ${TOOL_NAMES.GLOB}`,
          `To search content use ${TOOL_NAMES.GREP}`,
        ]),
    `Reserve using ${shellToolsLabel} for system commands that require shell execution. Use ${TOOL_NAMES.BASH} for Unix-style shell commands and ${TOOL_NAMES.POWERSHELL} for Windows-native PowerShell commands when available.`,
  ]

  const items = [
    `Do NOT use ${shellToolsLabel} when a relevant dedicated tool is provided. This helps the user understand and review your work:`,
    providedToolSubitems,
    hasTaskTool
      ? `Break down and manage your work with the ${TOOL_NAMES.TASK} tool.`
      : null,
    `You can call multiple tools in parallel when they are independent.`,
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
