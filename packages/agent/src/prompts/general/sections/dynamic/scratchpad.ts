/**
 * General Agent Scratchpad Section
 */

import type { PromptContext } from '../../../types.js'

export function getScratchpadSection(ctx: PromptContext): string | null {
  if (!ctx.scratchpadDir) return null

  return `# Scratchpad Directory

Scratchpad directory: \`${ctx.scratchpadDir}\`
Use this directory for temporary files, notes, and intermediate outputs.`
}