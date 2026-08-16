/**
 * Notice injected into every sub-agent system prompt so the sub-agent never
 * tries to spawn or delegate to another agent. The spawning/messaging tools
 * are physically withheld (see SUBAGENT_FORBIDDEN_TOOLS); this is the
 * defense-in-depth prompt that tells the model it is a sub-agent and must do
 * the work itself rather than attempting to re-delegate.
 */
export const SUBAGENT_SCOPE_NOTICE = `You are a sub-agent spawned by a parent agent to complete one delegated task.
You CANNOT spawn sub-agents and CANNOT delegate or message other agents — those tools are intentionally withheld from you and are not available in your tool list.
Complete your assigned task directly using only the tools listed below. If the work is large, break it down yourself and work through it step by step instead of trying to hand it to another agent.`

/** Compose a role-specific subagent prompt with the shared Duya harness. */
export function composeSubagentSystemPrompt(
  rolePrompt: string,
  harnessPrompt: string,
): string {
  return [rolePrompt.trim(), harnessPrompt.trim(), SUBAGENT_SCOPE_NOTICE.trim()]
    .filter(part => part.length > 0)
    .join('\n\n')
}
