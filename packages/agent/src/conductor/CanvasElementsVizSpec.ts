export const VIZ_SPEC_PROMPT = `
## Canvas Element Types & vizSpec Protocol

### diagram/svg — Flowcharts, Architecture Diagrams, Sequence Diagrams

Use for: system architecture, data flow, process diagrams, tech stack diagrams.

vizSpec format:
\`\`\`json
{
  "type": "mermaid",
  "content": "graph TD\\n  A[Client] --> B[Server]\\n  B --> C[Database]",
  "darkMode": true
}
\`\`\`

For Mermaid: use %%{init: {'theme':'dark'}}%% as first line.
Keep diagrams focused: 5-12 nodes. Use subgraphs for grouping.
Node labels: short (2-5 words), descriptive.

### chart/bar, chart/line, chart/pie — Data Visualizations

Use for: metrics, comparisons, trends, distributions.

vizSpec format:
\`\`\`json
{
  "chartType": "bar",
  "title": "Monthly Active Users",
  "labels": ["Jan", "Feb", "Mar", "Apr"],
  "datasets": [
    { "label": "Users", "data": [120, 145, 180, 210], "color": "#4f8cff" }
  ],
  "options": { "showLegend": true, "yAxisLabel": "Users" }
}
\`\`\`

### content/card — Information Cards

Use for: summaries, key metrics, status displays, quick references.

vizSpec format:
\`\`\`json
{
  "layout": "vertical",
  "header": { "title": "System Status", "subtitle": "Last 24 hours" },
  "sections": [
    { "type": "key-value", "content": { "Uptime": "99.9%", "Errors": "3", "Users": "1,204" } },
    { "type": "text", "content": { "text": "All systems operational." } }
  ],
  "footer": "Updated 5 min ago"
}
\`\`\`

### content/rich-text — Formatted Text Blocks

Use for: explanations, documentation blocks, announcements.

vizSpec format:
\`\`\`json
{
  "format": "markdown",
  "content": "## Summary\\n\\n- Point 1\\n- Point 2\\n\\n**Note:** Important info."
}
\`\`\`

### shape/rect, shape/circle — Decorative Shapes

Use for: visual separation, grouping, emphasis.

vizSpec format:
\`\`\`json
{
  "fill": "#1a365d",
  "stroke": "#4f8cff",
  "strokeWidth": 1,
  "label": "Region A"
}
\`\`\`

### shape/connector — Connection Lines

Use for: linking related elements, showing relationships.

vizSpec format:
\`\`\`json
{
  "sourceId": "element-uuid-1",
  "targetId": "element-uuid-2",
  "label": "depends on",
  "style": "solid",
  "arrow": true
}
\`\`\`
style can be "solid", "dashed", or "dotted".

### app/mini-app — Interactive Mini-Applications

Use for: calculators, converters, timers, forms, interactive demos.

vizSpec format:
\`\`\`json
{
  "html": "<div>...</div>",
  "js": "document.querySelector...",
  "css": ".my-class { ... }"
}
\`\`\`

Rules:
- Use DUYA design tokens via CSS variables: var(--color-text-primary), var(--color-background-primary), var(--color-border-tertiary)
- Keep within 200x200px default viewport (resizable by user)
- All script: use 'script-src unsafe-inline'; no external CDN needed
- Prefer self-contained implementations without external dependencies`;

export const VIZ_SPEC_WORKED_EXAMPLES = `
## Worked Examples

### Example 1: System Architecture Diagram
User: "Draw the architecture of my microservice system"
Response: I'll create a system architecture diagram showing your microservices and their relationships.

Tool call: canvas_create_element
{
  "canvasId": "canvas-1",
  "kind": "diagram/svg",
  "position": { "x": 0, "y": 0, "w": 8, "h": 6 },
  "vizSpec": {
    "type": "mermaid",
    "content": "graph LR\\n  A[API Gateway] --> B[Auth Service]\\n  A --> C[User Service]\\n  B --> D[(PostgreSQL)]\\n  C --> D\\n  C --> E[Redis Cache]",
    "darkMode": true
  }
}

### Example 2: Project Metrics Dashboard
User: "Show me the sprint metrics as charts and cards"
Response: Let me create a dashboard with charts and information cards.

Tool call: canvas_create_element (repeated for each element)
- chart/bar for velocity chart
- chart/line for bug trends
- content/card for sprint summary
- shape/connector to group related items

### Example 3: Reorganize Canvas Layout
User: "Organize this messy canvas into a clean layout"
Response: I'll reorganize the elements into a clean grid layout.

Tool call: canvas_get_snapshot (to see current state)
Tool call: canvas_arrange_elements (to reposition all elements)`;