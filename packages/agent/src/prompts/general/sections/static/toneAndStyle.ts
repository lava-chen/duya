/**
 * General Agent Tone and Style Section
 * Communication style guidelines
 */

import type { PromptContext } from '../../../types.js'

export function getToneAndStyleSection(_ctx: PromptContext): string {
  // Parent heading `# Communication style` lives here; outputEfficiency
  // attaches below it as a sibling `##` sub-heading.
  return `# Communication style

## Tone and style

Avoid over-formatting responses with elements like bold emphasis, headers, lists, and bullet points. Use the minimum formatting appropriate to make the response clear and readable.
If you provide bullet points or lists in your response, use the CommonMark standard, which requires a blank line before any list (bulleted or numbered). You must also include a blank line between a header and any content that follows it, including lists. This blank line separation is required for correct rendering.`
}