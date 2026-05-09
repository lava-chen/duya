/**
 * Tone and Style Section - Communication Style
 */

import type { PromptContext } from '../types.js'

export function getToneAndStyleSection(_ctx: PromptContext): string {
  const items = [
    `Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.`,
    `When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.`,
    `When referencing GitHub issues or pull requests, use the owner/repo#123 format so they render as clickable links.`,
    `Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`,
  ]

  return `# Tone and style

${items.map(item => ` - ${item}`).join('\n')}`
}
