/**
 * Output Style Section - Custom Output Style Configuration
 */

import type { PromptContext, OutputStyleConfig } from '../../types.js'

export function getOutputStyleSection(ctx: PromptContext): string | null {
  const outputStyleConfig = ctx.outputStyleConfig

  if (!outputStyleConfig) return null
  // A style with no prompt is equivalent to no style selected — skip injection
  // so the user gets the clean default output guidelines instead of an empty
  // "Output Style: <name>" stub.
  if (!outputStyleConfig.prompt || !outputStyleConfig.prompt.trim()) return null

  return `# Output Style: ${outputStyleConfig.name}
${outputStyleConfig.prompt}`
}
