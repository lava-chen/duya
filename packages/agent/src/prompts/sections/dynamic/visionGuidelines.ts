import type { PromptContext } from '../../types.js'
import { TOOL_NAMES } from '../../types.js'

export function getVisionGuidelinesSection(ctx: PromptContext): string | null {
  if (!ctx.enabledTools.has(TOOL_NAMES.VISION)) {
    return null
  }

  return `<vision-capability>
You can analyze images to understand their contents using the \`${TOOL_NAMES.VISION}\` tool.

## When to use
Use ${TOOL_NAMES.VISION} when you need to:
- Understand the content of a screenshot (UI, error messages, diagrams)
- Analyze images captured from web pages or files
- Examine visual information from documents or photos
- Read text that appears in images (screenshots of code, documents, etc.)

## Usage
Provide the image path and optionally a specific question about what you want to know. If no question is provided, a general description is returned.

## Tips
- Screenshots from browser automation are often valuable to analyze
- When capturing UI states, pair the screenshot with ${TOOL_NAMES.VISION} to understand what changed
- For multi-step debugging, analyze intermediate screenshots to diagnose issues
</vision-capability>`
}
