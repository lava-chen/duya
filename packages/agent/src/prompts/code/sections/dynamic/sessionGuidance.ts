/**
 * Code Agent Session Guidance Section
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
  const isVerificationAgentEnabled = ctx.isVerificationAgentEnabled ?? false

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
      Rules: 1-4 questions per call, 2-4 options per question, support multi-select. Always add "(Recommended)" to your preferred option label. Mark the recommended option as the first in the list.`
      : null,
    isNonInteractiveSession
      ? null
      : `If you need the user to run a shell command themselves (e.g., an interactive login like \`gcloud auth login\`), suggest they type \`! <command>\` in the prompt — the \`!\` prefix runs the command in this session so its output lands directly in the conversation.`,
    hasAgentTool
      ? isForkSubagentEnabled
        ? `Calling ${TOOL_NAMES.AGENT} without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context — so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. **If you ARE the fork** — execute directly; do not re-delegate.`
        : `Use the ${TOOL_NAMES.AGENT} tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.`
      : null,
    ...(hasAgentTool && !isForkSubagentEnabled
      ? [
          `For simple, directed codebase searches (e.g. for a specific file/class/function) use ${searchTools} directly.`,
          `For broader codebase exploration and deep research, use the ${TOOL_NAMES.AGENT} tool with subagent_type="Explore" (or "explore"). This is slower than using ${searchTools} directly, so use this only when a simple, directed search proves to be insufficient.`,
        ]
      : []),
    hasSkills
      ? `/<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the ${TOOL_NAMES.SKILL} tool to execute them. IMPORTANT: Only use ${TOOL_NAMES.SKILL} for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.`
      : null,
    isVerificationAgentEnabled && hasAgentTool
      ? `The contract: when non-trivial implementation happens on your turn, independent adversarial verification must happen before you report completion — regardless of who did the implementing (you directly, a fork you spawned, or a subagent). You are the one reporting to the user; you own the gate. Non-trivial means: 3+ file edits, backend/API changes, or infrastructure changes. Spawn the ${TOOL_NAMES.AGENT} tool with subagent_type="verification". Your own checks, caveats, and a fork's self-checks do NOT substitute — only the verifier assigns a verdict.`
      : null,
  ].filter(item => item !== null)

  if (items.length === 0) return null

  return `# Session-specific guidance

${items.map(item => ` - ${item}`).join('\n')}`
}