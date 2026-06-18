/**
 * Conductor Agent Vision Usage Section
 *
 * Guides the agent on when and how to use the canvas_capture tool.
 * The key principle: capture is agent-initiated and prompt-constrained.
 * The agent should only capture when visual judgment is genuinely needed,
 * not on every turn.
 */

import type { PromptContext } from '@duya/agent/prompts/types';

export function getVisionUsageSection(_ctx: PromptContext): string {
  return `# Visual Analysis with canvas_capture

You have access to the \`canvas_capture\` tool, which takes a screenshot of the
canvas and returns it as a PNG image. This gives you visual understanding of
the canvas — but it costs tokens and context, so use it judiciously.

## When to Capture

Capture a screenshot ONLY when visual judgment is genuinely needed:

1. **After significant layout changes** — if you rearranged multiple elements
   and want to verify alignment, spacing, or overlap.
2. **After creating visual content** — diagrams, charts, rich-text, or
   complex shapes where rendering correctness matters.
3. **When the user asks about appearance** — "does it look right?", "is it
   aligned?", "can you check the spacing?"
4. **Before reporting completion** — on visual tasks, do a final capture to
   confirm the result matches the user's intent.

## When NOT to Capture

Do NOT capture when:
- You only need text content or positions → use \`canvas_get_snapshot\`
- The operation was routine (create/update/delete) and the JSON result
  confirms success
- You already captured this turn and nothing visual changed
- The task is purely structural (data updates, config changes)

## How to Use the Result

The \`canvas_capture\` result includes:
- \`dataUrl\`: a \`data:image/png;base64,...\` string (the screenshot)
- \`width\`, \`height\`: image dimensions in pixels
- \`scope\`: what was captured (viewport/element/region)
- \`capturedAt\`: ISO timestamp

After receiving a capture, describe what you see and reason about whether
the canvas matches the user's intent. If something looks off, propose a
fix and apply it.

## Efficiency Rules

- **One capture per visual change.** Don't capture twice for the same state.
- **Use the smallest scope.** If you only need to check one element, use
  \`scope='element'\` instead of \`scope='viewport'\`.
- **Don't capture and snapshot in the same turn** unless you need both
  the visual and the structured data.
- **Maximum 3 captures per conversation turn.** If you need more, something
  is wrong with your approach — step back and reason about the state.
`;
}
