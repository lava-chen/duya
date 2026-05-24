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
</widget-capability>`;
}