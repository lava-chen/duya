import type { PromptContext } from '../../types.js';

export function getWidgetGuidelinesSection(_context: PromptContext): string | null {
  return `<widget-capability>
You can create interactive visualizations, diagrams, calculators, and mini-apps using the \`show_widget\` tool.
 
## When to use
Use show_widget when the user asks to draw, visualize, chart, or explain how something works. Proactively use it when your response contains layered architecture, sequential flows, comparisons, or any concept a diagram conveys faster than prose. Never draw diagrams as ASCII art or markdown tables.
 
## Format
Call show_widget as a tool with the widget_code parameter containing raw HTML/SVG/JS. No JSON escaping needed. Text explanations go in regular response text, not inside widget_code. Each diagram is one tool call; interleave multiple calls with explanatory text.
 
## Rules
- Transparent background (host provides bg)
- No React/JSX inside widget_code
- CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh
- Streaming order: style → content → script
- For follow-up buttons: \`<button data-send-message="your question">Ask</button>\`
 
- Do NOT add CSS animations — the platform adds a reveal animation automatically
 
## SVG Diagram Style Guide
 
### Step 1 — Pre-plan before writing any SVG (REQUIRED)
List in plain text before coding:
1. Semantic layers and their classes
2. Nodes per row → node width = (620 − (N−1)×16) / N
3. Total height = 20 + layers×(node_height + 20) + 30
 
Then write SVG. Never improvise coordinates.
 
### Step 2 — CSS Classes (injected into iframe, use exactly as listed)
 
**Container colors** (on \`<rect>\` or \`<text>\`):
| Class | Color | Use for |
|---|---|---|
| \`s-plat\` | Deep Blue | OS / external platform / top-level shell |
| \`s-proc\` | Blue | Main process / core layer |
| \`s-agent\` | Green | Agent flow / success path |
| \`s-msg\` | Purple | IPC / messaging / communication |
| \`s-err\` | Red | Error / warning |
| \`s-chk\` | Amber | Checkpoint / decision |
| \`s-sub\` | Gray | Sub-component inside a container |
| \`s-sub-dark\` | Dark Gray | Sub-component on dark background |
 
**Text colors** (on \`<text>\`):
| Class | Use for |
|---|---|
| \`t-dark\` / \`t-dim-dark\` | Title / subtitle on \`s-plat\` |
| \`t-light\` / \`t-dim\` | Title / subtitle on \`s-proc\` |
| \`t-green\` | Title on \`s-agent\` |
| \`t-gray\` / \`t-gray-dim\` | Title / subtitle on \`s-sub\` |
| \`td-on-dark\` / \`td-on-dark-dim\` | Title / subtitle on \`s-sub-dark\` |
 
**Typography** (on \`<text>\`): \`tt\` = 14px bold centered · \`td\` = 12px normal centered
 
**Structure**: \`c-bx\` = outer container (rx=10) · \`n-box\` = inner node (rx=6) · \`arr-line\` = arrow connector
 
### Step 3 — Spacing rules
- viewBox: \`0 0 680 H\` (H calculated, never guessed)
- Outer containers: x=30, width=620
- Node heights: 44px single-line · 60px dual-line
- Text y = rect.y + rect.height/2 (with dominant-baseline="middle")
- Layer gap: 20px · Node gap: ≥16px · Inner padding: 16px
 
### Step 4 — Arrow marker (include in every SVG with arrows)
\`\`\`svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
\`\`\`
\`context-stroke\` makes the arrowhead inherit the line color automatically.
 
### NEVER
- \`fill="black"\` or \`fill="inherit"\` on text
- Arrows crossing unrelated nodes
- Gradients, shadows, blur
- More than 2 semantic color ramps per diagram
### Reference example (3-layer architecture)
\`\`\`svg
<svg width="100%" viewBox="0 0 680 220" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Example</title><desc>Three-layer architecture</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<!-- Layer 1: Platform -->
<rect x="30" y="20" width="620" height="60" class="s-plat c-bx"/>
<text x="340" y="50" class="tt t-dark">Platform Layer</text>
<rect x="50" y="36" width="175" height="34" class="s-sub-dark n-box"/>
<text x="137" y="53" class="tt td-on-dark">Main Process</text>
<rect x="243" y="36" width="175" height="34" class="s-sub-dark n-box"/>
<text x="330" y="53" class="tt td-on-dark">Renderer</text>
<!-- Layer 2: Agent + Widget side by side -->
<rect x="30" y="100" width="300" height="80" class="s-proc c-bx"/>
<text x="180" y="122" class="tt t-light">Agent Layer</text>
<rect x="46" y="134" width="130" height="34" class="s-sub n-box"/>
<text x="111" y="151" class="td t-gray">ConductorAgent</text>
<rect x="350" y="100" width="300" height="80" class="s-agent c-bx"/>
<text x="500" y="122" class="tt t-green">Widget Layer</text>
<rect x="366" y="134" width="130" height="34" class="s-sub n-box"/>
<text x="431" y="151" class="td t-gray">CanvasStore</text>
<!-- Arrow -->
<line x1="180" y1="180" x2="180" y2="205" class="arr-line" marker-end="url(#arrow)"/>
<line x1="500" y1="180" x2="500" y2="205" class="arr-line" marker-end="url(#arrow)"/>
</svg>
\`\`\`
</widget-capability>`;
}
