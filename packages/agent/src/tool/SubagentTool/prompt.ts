/**
 * SubagentTool Prompt
 */

import type { AgentDefinition } from './loadAgentsDir.js'
import { SUBAGENT_TOOL_NAME } from './constants.js'
import { formatAgentLineForPrompt } from './SubagentTool.js'

// Tool name imports from duya
const FILE_READ_TOOL_NAME = 'Read'
const FILE_WRITE_TOOL_NAME = 'Write'
const GLOB_TOOL_NAME = 'Glob'
const GREP_TOOL_NAME = 'Grep'
const SEND_MESSAGE_TOOL_NAME = 'SendMessage'

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  const writingThePromptSection = `

## Writing the prompt

When spawning an agent (with a subagent_type), it starts with zero context.
Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

  const currentExamples = `Example usage:

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the ${FILE_WRITE_TOOL_NAME} tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the ${SUBAGENT_TOOL_NAME} tool to launch a test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the ${SUBAGENT_TOOL_NAME} tool to launch the greeting-responder agent"
</example>
`

  const agentListSection = `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLineForPrompt(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${SUBAGENT_TOOL_NAME} tool runs a specialized agent on your behalf. Each agent type has specific capabilities and tools available to it. The sub-agent runs in this same session's process with its own context and its own conversation — it starts with zero knowledge of our discussion, and anything you want it to know must be in its prompt.

${agentListSection}

When using the ${SUBAGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  const whenNotToUseSection = `
When NOT to use the ${SUBAGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${GLOB_TOOL_NAME} instead of the ${SUBAGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${GREP_TOOL_NAME} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${SUBAGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple ${SUBAGENT_TOOL_NAME} tool use content blocks
- Agents run in the background by default. The tool returns immediately and you continue working — you will be automatically notified when it completes. Do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- Foreground vs background: pass \`run_in_background: false\` only when you truly need the agent's result before the next step. Use the default background mode for independent or parallel work.
- To continue a previously spawned agent, pass \`resume_from\` with the \`subagent_id\` from its result. The sub-agent resumes with its full prior context in the same conversation — the new prompt is a follow-up turn, not a fresh briefing. Re-send the agent's type so it keeps the same role. Do not use ${SEND_MESSAGE_TOOL_NAME}: a plain ${SUBAGENT_TOOL_NAME} call with no \`resume_from\` always starts a new sub-agent.
- Tuning: \`max_turns\` caps how many turns the agent may take, \`effort\` sets its thinking budget (\`off\` disables extended thinking), \`permission_mode\` controls whether its tool calls can prompt the user, and \`tools: { allow, deny }\` narrows its toolset. Reach for these only when the defaults are visibly wrong for the job.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${SUBAGENT_TOOL_NAME} tool use content blocks.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository so its edits cannot touch the user's working copy. This requires a clean working tree; the worktree path and branch are returned in the result. It cannot be combined with \`resume_from\`.
- Set \`auto_wake: false\` only when you explicitly do not want to be interrupted when a background agent finishes — you then have to fetch the result yourself with get_task_output.${writingThePromptSection}

${currentExamples}`
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  return formatAgentLineForPrompt(agent)
}
