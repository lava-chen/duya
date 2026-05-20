/**
 * General Agent Session Guidance Section
 */

import type { PromptContext } from '../../../types.js'
import { TOOL_NAMES } from '../../../types.js'

export function getSessionGuidanceSection(ctx: PromptContext): string | null {
  const hasAskUserQuestion = ctx.enabledTools.has(TOOL_NAMES.ASK_USER_QUESTION)
  const hasAgentTool = ctx.enabledTools.has(TOOL_NAMES.AGENT)
  const hasSkills = ctx.enabledTools.has(TOOL_NAMES.SKILL)
  const isNonInteractiveSession = ctx.isNonInteractiveSession ?? false
  const hasEmbeddedSearchTools = ctx.hasEmbeddedSearchTools ?? false
  const isForkSubagentEnabled = ctx.isForkSubagentEnabled ?? false

  const searchTools = hasEmbeddedSearchTools
    ? `\`find\` or \`grep\` via the ${TOOL_NAMES.BASH} tool`
    : `the ${TOOL_NAMES.GLOB} or ${TOOL_NAMES.GREP}`

  const items: (string | null)[] = [
    hasAskUserQuestion
      ? `Use ${TOOL_NAMES.ASK_USER_QUESTION} to ask the user questions when you need to:
      1. Gather user preferences or requirements
      2. Clarify ambiguous instructions
      3. Get decisions on implementation choices
      4. Offer choices about what direction to take
      Rules: 1-4 questions per call, 2-4 options per question, support multi-select.`
      : null,
    isNonInteractiveSession
      ? null
      : `If you need the user to run a shell command themselves, suggest they type \`! <command>\` in the prompt.`,
    hasAgentTool
      ? isForkSubagentEnabled
        ? `Calling ${TOOL_NAMES.AGENT} without a subagent_type creates a fork, which runs in the background.`
        : `Use the ${TOOL_NAMES.AGENT} tool with specialized agents when the task at hand matches the agent's description.`
      : null,
    ...(hasAgentTool && !isForkSubagentEnabled
      ? [
          `For simple searches use ${searchTools} directly.`,
          `For broader exploration, use ${TOOL_NAMES.AGENT} with subagent_type="Explore".`,
        ]
      : []),
    hasSkills
      ? `/<skill-name> is shorthand for users to invoke a user-invocable skill. Use ${TOOL_NAMES.SKILL} to execute them.`
      : null,
  ].filter(item => item !== null)

  if (items.length === 0) return null

  return `# Session-specific guidance

${items.map(item => ` - ${item}`).join('\n')}`
}