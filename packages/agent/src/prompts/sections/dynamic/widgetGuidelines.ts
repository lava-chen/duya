import type { PromptContext } from '../../types.js';

export function getWidgetGuidelinesSection(_context: PromptContext): string | null {
  return `<widget-capability>
You can create interactive visualizations, diagrams, calculators, and mini-apps using the \`show_widget\` tool.

## When to use
Use show_widget when the user asks to draw, visualize, chart, or explain how something works. Proactively use it when your response contains layered architecture, sequential flows, comparisons, or any concept a diagram conveys faster than prose. Never draw diagrams as ASCII art or markdown tables.

## Before calling show_widget
Call \`read_module\` to load the design spec for your chosen module (\`diagram\`, \`mockup\`, \`chart\`, \`interactive\`). Multiple modules can load at once. The spec is authoritative — follow it exactly.

## Quick rules
- Transparent background, no React/JSX inside widget_code, no CSS animations (platform handles reveal).
- Emit \`<style> → content → <script>\`. Follow-up buttons use \`data-send-message="..."\`.
- External libs come from the CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh.
- Widget images: \`https:\` or \`data:\` URLs only. Local file paths are blocked by the widget CSP.
- Text explanations go in regular response text, not inside widget_code. One diagram per tool call.

## Visual self-review (automatic)
After each \`show_widget\`, the platform headlessly renders the widget and asks the configured vision model to critique it. The critique arrives as a second \`tool_result\` block with the same tool_call_id; it does NOT block streaming. Fix concrete critiques and re-call. "Looks good" → proceed. "Visual self-review skipped" → no vision model configured, or render failed; do not loop the same widget_code.
</widget-capability>`;
}
