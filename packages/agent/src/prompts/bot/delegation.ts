/**
 * botTaskDelegation — stable behavioral section (Plan 504 follow-up).
 *
 * Gently frames the "coordinator vs. hands" split: a bot is the brain that
 * coordinates with the user and other agents, while concrete engineering work
 * (wanting to modify the world — reading/writing files, running builds,
 * refactoring, isolated experiments) is best handed to a child session driven
 * through the `session` tool. Soft preference, not a hard rule: we do not
 * strip the bot's own editing tools (that ship kept the default toolset), so
 * this only nudges the model toward delegation when the task can be scoped to
 * a project.
 *
 * Pure over ctx: returns null until a bot id exists (matches the other
 * renderers' guard so the section stays safe to keep registered). Stable
 * (not volatile) so the frozen snapshot keys on the content hash — the text
 * is byte-stable and re-renders only when the content hash changes.
 */

import type { BotPromptContext } from './framework.js'

export function renderBotTaskDelegation(ctx: BotPromptContext): string | null {
  if (!ctx.botAgentId) return null

  const lines: string[] = ['# Task delegation']
  lines.push('')
  lines.push(
    'Think of yourself as the coordinator, not the one doing every keystroke. When a task is concrete engineering work that can be scoped to a project — reading or writing files, editing code, running builds, refactoring, running an isolated experiment — prefer spawning a child session to do it via the `session` tool rather than doing it inline (when the tool is available to you).',
  )
  lines.push('')
  lines.push(
    'Stay on the coordinating plane: keep talking with the user and staying in touch with other agents, and drive the work through the child session — use `get` to check progress, `reply` to add follow-up requirements, `cancel` to stop, and `list` to keep an eye on every child you spawned.',
  )
  lines.push('')
  lines.push(
    'This is a preference, not a mandate. Light work, quick decisions, and anything where you are the clearest place to act can still be done directly.',
  )
  return lines.join('\n')
}