/**
 * Design knowledge sections for canvas_get_knowledge tool.
 *
 * Each section is a focused markdown blob the LLM can fetch on-demand
 * to get specific design guidance without bloating the system prompt.
 *
 * Content here is intentionally concrete: exact hex colors, exact
 * coordinates, exact field names. No generic advice — the model can
 * only act on specifics.
 */

export type KnowledgeSection =
  | 'sticky-style'
  | 'connector-style'
  | 'widget-usage'
  | 'flowchart-layout'
  | 'mindmap-layout';

export const KNOWLEDGE_SECTIONS: Record<KnowledgeSection, string> = {
  'sticky-style': `## Sticky Note Style Guide

### Available Colors (config.color)

Color keys map to the **Diagram module** semantic palette (same hex values
as the \`.s-*\` classes used in SVG diagrams). See
\`packages/conductor/src/renderer/components/native/sticky-colors.ts\`
for the canonical source.

| Color   | Fill / Stroke (CSS rgb)        | Diagram class | When to use                                                    |
|---------|--------------------------------|---------------|----------------------------------------------------------------|
| yellow  | rgb(250,238,218) / rgb(133,79,11) | \`.s-chk\`     | Default notes, neutral process steps, generic content (Amber).|
| blue    | rgb(230,241,251) / rgb(24,95,165) | \`.s-proc\`    | Info / process / reference / "this is data".                  |
| green   | rgb(225,245,238) / rgb(15,110,86) | \`.s-agent\`   | Success, done state, "yes" branch endpoint, completion.       |
| pink    | rgb(252,235,235) / rgb(163,45,45) | \`.s-err\`     | Errors, warnings, "no" branch endpoint, failure. **Name kept for back-compat; renders light red.** |
| purple  | rgb(238,237,254) / rgb(83,74,183) | \`.s-msg\`     | Messages / IPC / cross-system links.                          |
| gray    | rgb(241,239,232) / rgb(95,94,90)  | \`.s-sub\`     | Start / end / terminal / neutral boundary nodes.              |

Notes:
- There is no literal pink anymore — use **pink** for error / warning semantics.
- Default border is 1px solid in the theme's stroke color. Set \`borderStyle\` only when you need a custom border.
- Use \`bgColor\` (CSS color string) to override the theme fill for one-off palettes.

### Font Size (config.fontSize)

- 14  — default body text. Use unless you have a reason not to.
- 18  — section titles, short labels (1-3 words).
- 20  — main page title, single-word emphasis.
- 12  — detailed notes, sub-bullets, secondary info.

Do NOT exceed 20 — larger sizes overflow the default 160x100 sticky.

### Text Content

- Keep each sticky under 80 characters for readability.
- Prefer 1-3 word labels for flowchart / mindmap nodes.
- For longer content, use \`widget/note-pad\` instead of a sticky.
- Multi-line: use \`\\n\` in the text field. Keep to 3 lines max.

### Default Sticky Size

- 160w x 100h. Leave 40px gap between stickies.
- For titles, keep 160x100 — increase fontSize instead of width.
- For detailed notes, increase height to 140-160 instead of width.
`,

  'connector-style': `## Connector Style Guide

Connectors are \`native/connector\` elements. The visual style lives in
\`config\`: stroke, strokeWidth, endMarker. The geometry lives in
\`position\`: { x, y } (the line's anchor point — typically the
midpoint of the source's right edge for left-to-right flow).

### Stroke Colors (config.stroke, hex)

| Hex       | Meaning                                | When to use                          |
|-----------|----------------------------------------|--------------------------------------|
| #333333   | Default / neutral                      | General flow, default process arrow.|
| #3B82F6   | Blue / highlight                       | Emphasized path, primary flow.      |
| #EF4444   | Red / error                            | Error branch, failure path.         |
| #10B981   | Green / success                        | Success branch, happy path.         |

For mind-map association links, default #333333 is fine; do not
color-code unless the user asks.

### Stroke Width (config.strokeWidth)

- 1 — default. Use for all standard connectors.
- 2 — emphasized. Use for the main path of a flowchart, or to
      highlight a critical transition.
- 3 — thick / highlight. Reserve for the single most important
      arrow on the canvas. More than one stroke-3 connector
      dilutes the effect.

### End Marker (config.endMarker)

- 'arrow' — default for flowcharts and any directed relationship.
- 'none'  — use for mind-map associations, undirected links, or
            visual grouping where direction does not matter.

### Curvature

The canvas auto-routes connectors between source and target
elements; you do not set a curvature field directly. To influence
the visual path:

- Place source and target on the same horizontal or vertical line
  for a clean straight segment.
- For L-shaped routes, place target diagonally offset — the canvas
  draws an orthogonal elbow.
- Avoid placing intermediates between source and target; the
  connector should not pass over other stickies.

### Layout Rules

- Connectors should NOT cross unnecessarily. If two connectors
  must cross, reroute one by repositioning its endpoint.
- A connector's source and target must both exist before creation.
- Create all stickies first in one batch, then create connectors
  using the returned elementIds.
- Default connector position: midpoint between source and target,
  e.g. for source at (40,40,160,100) and target at (260,40,160,100),
  connector position is (200, 90).
`,

  'widget-usage': `## Widget Modules (for widget/dynamic sourceCode)

widget/dynamic renders agent-written HTML/SVG in a sandboxed iframe (no JS execution, CSS allowed).

### Module: TodoList
HTML template (replace {{items}} with actual data):
<div style="font-family:sans-serif;padding:12px;min-width:200px">
  <h3 style="margin:0 0 8px;font-size:14px">{{title}}</h3>
  {{#items}}
  <label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px">
    <input type="checkbox" {{#done}}checked{{/done}} disabled>
    <span style="{{#done}}text-decoration:line-through;opacity:0.5{{/done}}">{{text}}</span>
  </label>
  {{/items}}
</div>
Note: checkbox disabled because JS is blocked; for static display only.

### Module: MetricCard
<div style="font-family:sans-serif;padding:16px;border-radius:8px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.1);min-width:160px">
  <div style="font-size:11px;color:#666;text-transform:uppercase">{{label}}</div>
  <div style="font-size:24px;font-weight:700;margin:4px 0">{{value}}</div>
  <div style="font-size:11px;color:{{deltaColor}}">{{delta}}</div>
</div>

### Module: FlowChart (SVG)
<svg width="320" height="120" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="40" width="80" height="40" rx="6" fill="#3b82f6"/>
  <text x="50" y="64" text-anchor="middle" fill="#fff" font-size="12">Start</text>
  <rect x="120" y="40" width="80" height="40" rx="6" fill="#10b981"/>
  <text x="160" y="64" text-anchor="middle" fill="#fff" font-size="12">Process</text>
  <line x1="90" y1="60" x2="120" y2="60" stroke="#333" stroke-width="2" marker-end="url(#arrow)"/>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
    <polygon points="0 0, 8 4, 0 8" fill="#333"/></marker></defs>
</svg>

### Module: KanbanBoard
3-column board using CSS grid:
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-family:sans-serif;min-width:400px">
  <div style="background:#f3f4f6;border-radius:6px;padding:8px">
    <h4 style="margin:0 0 6px;font-size:12px">Todo</h4>
    <div style="background:#fff;padding:6px;border-radius:4px;font-size:11px;margin-bottom:4px">Task A</div>
  </div>
  <div style="background:#f3f4f6;border-radius:6px;padding:8px">
    <h4 style="margin:0 0 6px;font-size:12px">Doing</h4>
    <div style="background:#fff;padding:6px;border-radius:4px;font-size:11px;margin-bottom:4px">Task B</div>
  </div>
  <div style="background:#f3f4f6;border-radius:6px;padding:8px">
    <h4 style="margin:0 0 6px;font-size:12px">Done</h4>
    <div style="background:#fff;padding:6px;border-radius:4px;font-size:11px;margin-bottom:4px">Task C</div>
  </div>
</div>

### Module: NoteCard
<div style="font-family:sans-serif;padding:12px;background:#fef9c3;border-left:3px solid #eab308;border-radius:4px;min-width:180px">
  <div style="font-size:11px;color:#666;margin-bottom:4px">{{timestamp}}</div>
  <div style="font-size:13px;line-height:1.4">{{content}}</div>
</div>

### Rules
- sourceCode must be self-contained (no external resources, no <script>).
- Inline CSS only (style attributes or <style> tags).
- SVG must have explicit width/height.
- Default widget size: 4 x 3 grid units (320 x 240 px). Override via position.w/h.
- For text-heavy content, use position.w=6 h=4 or larger.
`,

  'flowchart-layout': `## Flowchart Layout Templates

All coordinates are in grid units (1 unit = 80px). Default canvas: 40 x 30. Default sticky size: 3w x 3h.

### Template 1: Linear Horizontal Flow

Best for: short sequential processes (3-5 steps).

\`\`\`
y=1   [Start]──→[Step 1]──→[Step 2]──→[End]
      x=1       x=5        x=9        x=13
\`\`\`

- All nodes at y=1, height 3.
- x positions: 1, 5, 9, 13 (4 unit stride, 1 unit gap).
- Connectors go left-to-right, endMarker='arrow'.
- Connector y = 2.5 (vertical midpoint of node).
- Connector x = right edge of source = source.x + 3.
  e.g. connector 1 at (4, 2.5), connector 2 at (8, 2.5).

### Template 2: Branching Flow (Decision)

Best for: if/else logic, yes/no decisions.

\`\`\`
                       [Yes branch]   x=9, y=2
                      /
[Prev step]──→[Decision?]
              x=1,y=5   x=5,y=5
                      \\\\
                       [No branch]    x=9, y=8
\`\`\`

- Decision node at (5, 5), typically purple.
- Yes branch at (9, 2) — top-right.
- No branch at (9, 8) — bottom-right.
- Yes-branch connector: green (#10B981).
- No-branch connector: red (#EF4444).
- Label the branch by putting "Yes" / "No" in the next sticky's
  text, or as a separate small sticky near the connector.

### Template 3: Vertical Sequential Flow

Best for: long sequential processes (5+ steps), top-down pipelines.

\`\`\`
x=1   [Step 1]   y=1
        │
     [Step 2]   y=5
        │
     [Step 3]   y=9
        │
     [Step 4]   y=13
\`\`\`

- All nodes at x=1, width 3.
- y positions: 1, 5, 9, 13 (4 unit stride, 1 unit gap).
- Connector x = 2.5 (horizontal midpoint of node).
- Connector y = top edge of target = target.y.
  e.g. connector 1 at (2.5, 5).
- Good when horizontal space is tight but vertical is plentiful.

### Color Coding for Flowcharts

| Node role          | Color  |
|--------------------|--------|
| Start              | gray   |
| End (success)      | green  |
| End (error)        | pink   |
| Process step       | yellow |
| Decision           | purple |
| Reference / input  | blue   |

### Workflow

1. Plan node positions on paper / in your head before calling tools.
2. Create ALL stickies in ONE turn (parallel canvas_create_element
   calls). Capture returned elementIds.
3. In the NEXT turn, create connectors using the captured IDs.
   Do NOT attempt to create a connector in the same turn as its
   endpoints — you won't have the IDs yet.
4. Optional: call canvas_capture to verify layout.
5. If a node is misaligned, use canvas_move_element (not delete +
   recreate).
`,

  'mindmap-layout': `## Mind Map Layout Templates

Mind maps use stickies for nodes and connectors with
\`endMarker: 'none'\` (association, not flow). Default canvas:
40 x 30 grid units. Center is (20, 15).

### Template 1: Radial Layout

Best for: brainstorming, topic exploration, non-hierarchical ideas.

\`\`\`
                [N]
              /     \\
        [NW]──[CENTER]──[NE]
              |     |
        [SW]──[  ●  ]──[SE]
              |     |
                [S]
\`\`\`

- Center node at (20, 15) — canvas center.
- First-level branches at radius 5, 8 positions:
  - N  : (20, 10)
  - NE : (24, 12)
  - E  : (25, 15)
  - SE : (24, 18)
  - S  : (20, 20)
  - SW : (16, 18)
  - W  : (15, 15)
  - NW : (16, 12)
- Second-level branches extend outward at radius 10 from center:
  - N-1 : (20, 5)
  - NE-1: (28, 9)
  - E-1 : (30, 15)
  - SE-1: (28, 21)
  - S-1 : (20, 25)
  - SW-1: (12, 21)
  - W-1 : (10, 15)
  - NW-1: (12, 9)
- Each second-level node connects to its first-level parent, not
  directly to center.

### Template 2: Tree Layout (Left-to-Right)

Best for: hierarchical structure, org charts, file trees,
outline-style notes.

\`\`\`
                 [Child 1]──[Grandchild 1]
                /
[Root]──[Child 2]──[Grandchild 2]
                \\
                 [Child 3]──[Grandchild 3]
\`\`\`

- Root at (1, 5), width 3.
- Children at x=5, y spread vertically:
  - Child 1: (5, 3)
  - Child 2: (5, 5)
  - Child 3: (5, 7)
  (2 unit y stride for 3 children; adjust for more.)
- Grandchildren at x=9:
  - Grandchild 1: (9, 3)
  - Grandchild 2: (9, 5)
  - Grandchild 3: (9, 7)
- Connectors: root→child uses (4, midpoint-y), child→grandchild
  uses (8, midpoint-y).

### Color Coding for Mind Maps

Use a different color PER first-level branch — this creates
visual grouping. The center / root is gray or yellow.

| Branch role        | Suggested color |
|--------------------|-----------------|
| Root / center      | gray or yellow  |
| Branch A           | blue            |
| Branch B           | green           |
| Branch C           | pink            |
| Branch D           | purple          |
| Branch E+          | cycle back to yellow, then blue...

All descendants of a branch inherit the branch's color.

### Style Rules

- Connector endMarker: 'none' (mind maps show association, not
  direction).
- Connector stroke: default #333333 for all (do not color-code
  connectors — color comes from the nodes).
- Connector strokeWidth: 1 (keep mind-map links visually quieter
  than flowchart arrows).
- Keep labels SHORT: 2-4 words per node. Long labels clutter the
  radial pattern — split into a parent + child instead.

### Workflow

1. Create the center / root sticky first.
2. Create all first-level branches in ONE turn.
3. In the next turn, create connectors from center to each
   first-level branch.
4. Add second-level branches as needed, then their connectors.
5. Apply branch colors via canvas_style_element after creation
   (or set color in the initial canvas_create_element config).
6. Optional: canvas_capture to verify the radial symmetry.
`,
};

export const KNOWLEDGE_SECTION_NAMES = Object.keys(KNOWLEDGE_SECTIONS) as KnowledgeSection[];
