import type { PromptContext } from '../../types.js';

export function getWidgetGuidelinesSection(_context: PromptContext): string | null {
  return `<widget-capability>
You can create interactive visualizations, diagrams, calculators, and mini-apps using the \`show_widget\` tool.

## When to use
Use show_widget when the user asks to draw, visualize, chart, or explain how something works. Proactively use it when your response contains layered architecture, sequential flows, comparisons, or any concept a diagram conveys faster than prose. Never draw diagrams as ASCII art or markdown tables.

## Before calling show_widget for the first time
Call \`read_module\` to load the design specification for your task. Choose modules based on what you are rendering, not what the data represents:

- **diagram** — SVG flowcharts, architecture diagrams, structure charts, sequence diagrams
- **mockup** — HTML cards, dashboards, comparison tables, data displays
- **chart** — Data visualizations (Chart.js, D3, ApexCharts)
- **interactive** — Interactive widgets with controls, calculators, converters, mini-apps

You can load multiple modules at once by passing an array: \`["mockup", "chart"]\` for a dashboard with charts.

This is YOUR decision — no hook or middleware triggers it automatically. Module content is authoritative — follow it exactly. After the first load, the content is in your context for the rest of the conversation.

## Quick rules (even without read_module)
- Transparent background (host provides bg)
- No React/JSX inside widget_code
- CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh
- Streaming order: \`<style>\` → content → \`<script>\`
- For follow-up buttons: \`<button data-send-message="your question">Ask</button>\`
- Do NOT add CSS animations — the platform adds a reveal animation automatically
- Text explanations go in regular response text, not inside widget_code
- Each diagram is one tool call; interleave multiple calls with explanatory text

## Widget images

Widget images must use \`https:\` or \`data:\` URLs only. The widget
iframe's Content-Security-Policy blocks \`duya-file://\`, \`file://\`,
and bare relative paths. To embed a generated image, encode it as a
data URL or host it on a CDN the widget allowlist permits.

Clicking an image inside a widget opens DUYA's lightbox.

## Visual self-review (automatic)
After every \`show_widget\` call, the platform automatically renders your widget headlessly and asks the configured vision model to critique it. The critique arrives as a second \`tool_result\` block with the same tool_call_id — it does NOT block streaming, so the widget still appears instantly for the user.

You will see one of three messages in the second tool_result:
- A concrete critique ("text overlaps node X", "legend is missing", "the title is cut off") → fix the issue and call \`show_widget\` again with the corrected widget_code
- "Looks good — no obvious issues" → the widget passed review, proceed with your next sentence
- "Visual self-review skipped: …" → the user has not configured a vision model in Settings > Vision Model, or the headless render failed; proceed without self-review (do NOT keep retrying the same widget_code)

The self-review is best-effort and never replaces user judgment — treat its findings as a second pair of eyes, not ground truth.
</widget-capability>`;
}
