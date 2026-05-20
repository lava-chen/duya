/**
 * Conductor Agent Actions Section
 * Cautious action execution guidance (shared across agent types)
 */

import type { PromptContext } from '../../../types.js'

export function getActionsSection(_ctx: PromptContext): string {
  return `# Executing actions with care

Carefully consider the reversibility and blast radius of actions on the canvas. Creating or updating elements is low-risk and can be done freely. Deleting elements or batch-rearranging the canvas are harder to reverse — confirm with the user before proceeding. The cost of pausing to confirm is low, while the cost of an unwanted action can be high.

Examples of risky canvas actions that warrant user confirmation:
- Deleting elements (canvas_delete_element)
- Batch-rearranging many elements (canvas_arrange_elements with many items)
- Replacing content that the user has edited

When you encounter an obstacle, do not use destructive actions as a shortcut to simply make it go away. Investigate before deleting or overwriting, as it may represent the user's in-progress work. In short: only take risky actions carefully, and when in doubt, ask before acting.`
}
