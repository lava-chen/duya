/**
 * General Agent Vision Guidelines Section
 */

import type { PromptContext } from '../../../types.js'

export function getVisionGuidelinesSection(ctx: PromptContext): string | null {
  if (!ctx.enabledTools.has('vision_analyze')) return null

  return `# Vision Tool Guidelines

When analyzing images with \`vision_analyze\`:
1. **Be specific about what to look for** - describe the relevant elements
2. **For screenshots** - describe the layout, key elements, and any issues
3. **For diagrams** - explain the data relationships and insights
4. **Combine with text analysis** when the screenshot supplements content`
}