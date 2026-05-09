/**
 * Session Guidance Section - Session-Specific Guidance
 */

import type { PromptContext } from '../../types.js'
import { TOOL_NAMES, MODEL_CONSTANTS } from '../../types.js'

const EXPLORE_AGENT_MIN_QUERIES = 5
const VERIFICATION_AGENT_TYPE = 'verification'

function getAgentToolSection(ctx: PromptContext): string {
  const isForkSubagentEnabled = ctx.isForkSubagentEnabled ?? false

  return isForkSubagentEnabled
    ? `Calling ${TOOL_NAMES.AGENT} without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context — so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. **If you ARE the fork** — execute directly; do not re-delegate.`
    : `Use the ${TOOL_NAMES.AGENT} tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.`
}

function getDiscoverSkillsGuidance(ctx: PromptContext): string | null {
  const isSkillSearchEnabled = ctx.isSkillSearchEnabled ?? false
  const hasDiscoverSkillsTool = ctx.enabledTools.has(TOOL_NAMES.DISCOVER_SKILLS)

  if (isSkillSearchEnabled && hasDiscoverSkillsTool) {
    return `Relevant skills are automatically surfaced each turn as "Skills relevant to your task:" reminders. If you're about to do something those don't cover — a mid-task pivot, an unusual workflow, a multi-step plan — call ${TOOL_NAMES.DISCOVER_SKILLS} with a specific description of what you're doing. Skills already visible or loaded are filtered automatically. Skip this if the surfaced skills already cover your next action.`
  }
  return null
}

function getVerificationAgentSection(ctx: PromptContext): string | null {
  const isVerificationAgentEnabled = ctx.isVerificationAgentEnabled ?? false
  const hasAgentTool = ctx.enabledTools.has(TOOL_NAMES.AGENT)

  if (isVerificationAgentEnabled && hasAgentTool) {
    return `The contract: when non-trivial implementation happens on your turn, independent adversarial verification must happen before you report completion — regardless of who did the implementing (you directly, a fork you spawned, or a subagent). You are the one reporting to the user; you own the gate. Non-trivial means: 3+ file edits, backend/API changes, or infrastructure changes. Spawn the ${TOOL_NAMES.AGENT} tool with subagent_type="${VERIFICATION_AGENT_TYPE}". Your own checks, caveats, and a fork's self-checks do NOT substitute — only the verifier assigns a verdict; you cannot self-assign PARTIAL. Pass the original user request, all files changed (by anyone), the approach, and the plan file path if applicable. Flag concerns if you have them but do NOT share test results or claim things work. On FAIL: fix, resume the verifier with its findings plus your fix, repeat until PASS. On PASS: spot-check it — re-run 2-3 commands from its report, confirm every PASS has a Command run block with output that matches your re-run. If any PASS lacks a command block or diverges, resume the verifier with the specifics. On PARTIAL (from the verifier): report what passed and what could not be verified.`
  }
  return null
}

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
      ? `If you do not understand why the user has denied a tool call, use the ${TOOL_NAMES.ASK_USER_QUESTION} to ask them.`
      : null,
    isNonInteractiveSession
      ? null
      : `If you need the user to run a shell command themselves (e.g., an interactive login like \`gcloud auth login\`), suggest they type \`! <command>\` in the prompt — the \`!\` prefix runs the command in this session so its output lands directly in the conversation.`,
    hasAgentTool ? getAgentToolSection(ctx) : null,
    ...(hasAgentTool && !isForkSubagentEnabled
      ? [
          `For simple, directed codebase searches (e.g. for a specific file/class/function) use ${searchTools} directly.`,
      `For broader codebase exploration and deep research, use the ${TOOL_NAMES.AGENT} tool with subagent_type="Explore" (or "explore"). This is slower than using ${searchTools} directly, so use this only when a simple, directed search proves to be insufficient or when your task will clearly require more than ${EXPLORE_AGENT_MIN_QUERIES} queries.`,
        ]
      : []),
    hasSkills
      ? `/<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the ${TOOL_NAMES.SKILL} tool to execute them. IMPORTANT: Only use ${TOOL_NAMES.SKILL} for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.`
      : null,
    getDiscoverSkillsGuidance(ctx),
    getVerificationAgentSection(ctx),
  ].filter(item => item !== null)

  if (items.length === 0) return null

  return `# Session-specific guidance

${items.map(item => ` - ${item}`).join('\n')}`
}
