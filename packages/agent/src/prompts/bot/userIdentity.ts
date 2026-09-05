/**
 * User identity section for bot system prompt.
 *
 * Renders the user's display name and timezone. The timezone is read from
 * `process.env.TZ` (set by the main process from the OS locale). The display
 * name comes from the session's init payload (Plan 474 P2.0) and is passed in
 * via `BotPromptContext.userDisplayName`.
 *
 * Grok-bot equivalent: `renderTimeZoneSystemPrompt` + `renderUserIdentitySystemPrompt`.
 */

import type { BotPromptContext } from './framework.js'

/**
 * Render the user identity section. Returns null when neither userDisplayName
 * nor timezone is available — the section is omitted in that case.
 *
 * Budget: 400 chars (matches `BOT_USER_IDENTITY_SECTION.budgetChars`).
 */
export function renderUserIdentity(ctx: BotPromptContext): string | null {
  const name = ctx.userDisplayName
  const tz = ctx.timezone ?? process.env.TZ

  if (!name && !tz) return null

  const lines: string[] = ['## User']

  if (name) {
    lines.push(`- **Name**: ${name}`)
  }

  if (tz) {
    lines.push(`- **Timezone**: ${tz}`)
  }

  return lines.join('\n')
}
