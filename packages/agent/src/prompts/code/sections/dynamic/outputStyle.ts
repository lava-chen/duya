/**
 * Code Agent Output Style Section
 */

import type { PromptContext } from '../../../types.js'

export function getOutputStyleSection(ctx: PromptContext): string | null {
  const config = ctx.outputStyleConfig
  if (!config) return null

  return `# Output Style: ${config.name}

${config.prompt}

${config.keepCodingInstructions ? '' : 'Note: Coding-specific instructions may be disabled for this output style.'}`
}