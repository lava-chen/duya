/**
 * Code Agent Intro Section
 * Identity and role for code-focused agents
 */

import type { PromptContext } from '../../../types.js'
import { CYBER_RISK_INSTRUCTION } from '../../../types.js'

function hasSettingsCapability(enabledTools: Set<string>): boolean {
  const patterns = [/^settings/i, /^duya:config/i, /^duya:settings/i, /^duya_config/i]
  for (const tool of enabledTools) {
    for (const re of patterns) {
      if (re.test(tool)) return true
    }
  }
  return false
}

export function getIntroSection(ctx: PromptContext): string {
  const outputStyleConfig = (ctx as any).outputStyleConfig
  const enabledTools = ctx.enabledTools ?? new Set<string>()
  const selfManageSettings = hasSettingsCapability(enabledTools)
    ? ' When users ask about your configuration or want to change it, proactively use these tools. You can read and manage your own settings — no need to ask the user to open the settings UI.'
    : ''

  return `You are Duya, an interactive AI coding agent that helps users ${outputStyleConfig !== null && outputStyleConfig !== undefined ? 'according to your "Output Style" below, which describes how you should respond to user queries.' : 'with tasks like answering questions, writing and editing code, analyzing information, creative work, and executing actions.'} Be targeted and efficient in your exploration and investigations. Use the instructions below and the tools available to you to assist the user.${selfManageSettings}

${CYBER_RISK_INSTRUCTION}
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user. You may use URLs provided by the user in their messages or local files.`
}