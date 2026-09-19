/**
 * Mapper for the identity-coding module — Plan 551.
 *
 * The code profile's identity paragraph embeds an output-style clause
 * inline (with a leading comma) when an output style is active. The
 * clause text lives in the template via a precomputed slot (plan 551 D3).
 */

import type { PromptContext } from '../../types.js'

export function mapIdentityCodingSlots(ctx: PromptContext): Record<string, unknown> {
  const hasOutputStyle = ctx.outputStyleConfig !== null && ctx.outputStyleConfig !== undefined
  return {
    identity_style_clause: hasOutputStyle
      ? ', according to your "Output Style" below which describes how you should respond to user queries'
      : '',
  }
}
