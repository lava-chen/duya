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
  | 'widget-design-system'
  | 'widget-todolist'
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

Sticky text now defaults to a larger size based on element height, so you usually do NOT need to set fontSize. Only set it when you want explicit control.

- 20  — default body text for a standard note.
- 22  — compact labels and first-level mind-map branches.
- 24  — root node, section title, single-word emphasis.
- 18  — smallest supported secondary text; legacy smaller values are clamped.

Do NOT go below 18 for Chinese body text. Prefer 20-24 for anything that must remain readable in an overview. Do NOT exceed 26.

### Text Content

- Keep each sticky under 80 characters for readability.
- Prefer 1-3 word labels for flowchart / mindmap nodes.
- For longer content, use \`widget/note-pad\` instead of a sticky.
- Multi-line: use \`\\n\` in the text field. Keep to 3 lines max.

### Default Sticky Size

- Compact label: 2.5x1 grid units (200x80px). Related labels use 0.5-0.75 unit gaps.
- Standard note: 4x2 grid units (320x160px).
- For titles, use 3.5x1.25 and 24px; do not create a wide empty banner.

### Size-to-Content Matching (Important)

Do not make a sticky larger than its content. Oversized stickies force the canvas to zoom out, making everything tiny.

| Content | Recommended grid size (w x h) | fontSize | Notes |
|---------|-------------------------------|----------|-------|
| 1-2 Chinese chars label | 2.5 x 1 | 22-24 | e.g. "开始"; auto-centered |
| 1 short Chinese line / 3-6 chars | 3 x 1 | 20-22 | e.g. "用户登录"; auto-centered |
| 2 short lines / 6-10 chars | 3.5 x 1.5 | 20 | Use slash or newline |
| Standard sticky (1-2 sentences) | 4 x 2 | 20 | Most common note |
| Detailed note (2-3 lines) | 5 x 2.5 | 20 | |
| Paragraph / long sentence | 5 x 3 | 20-22 | |
| Section title / mind-map root | 3.5 x 1.25 | 24 | Use the root as the title |

Rules:

- Width should match content width. A 4-char label does not need w=8.
- Height should barely clear the text. Single line → h=1. Two lines → h=1.5 or 2. Do not default to h=3+ "just in case".
- Prefer larger fontSize over a larger box. Compact labels default to 22px; do not request fontSize below 18.
- If text does not fit in w=5-7, h=3, use widget/dynamic instead of shrinking type.
- Leave 0.5-0.75 grid units between related nodes; use 1 unit only between semantic groups.
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

  'widget-design-system': `## Widget/dynamic Design System

Use these rules for every agent-generated widget/dynamic element. The goal is legibility at the default canvas zoom, not packing the maximum amount of information into one container.

### Canvas Scaling (read this first)

The canvas viewport defaults to framing the entire 40 x 30 grid on screen. This creates a counter-intuitive effect: **the larger a single widget is, the more the whole canvas zooms out to fit it, and the smaller its text appears.** A 36 x 20 widget looks "big" in grid units but renders as a tiny card because everything is scaled down. A smaller widget lets the canvas stay zoomed in, so the same text actually looks larger.

### Size Budget

- **Hard upper limit: w ≤ 14, h ≤ 10** (1120 x 800 px). Never exceed this.
- **Preferred range for explanatory diagrams: w=8-12, h=5-8.** Start here and only approach the hard limit when the content truly needs it.
- For dashboards with many metrics, prefer w=10-12, h=6-8.
- For single cards or small tools, prefer w=5-7, h=4-6.

### Information Density Budget

A widget is read as one composed image, not a scrollable document.

- **Aim for 4-6 visual sections total.** If the diagram needs more, it is too dense.
- **Each section = short title + at most one subtitle of ≤5 Chinese words.** Do not write full sentences or detailed file-line descriptions inside boxes.
- **Prefer hierarchy over enumeration.** "文件层" with subtitle "页面骨架 / 样式 / 脚本 / 资源" is better than four full-width file rows.
- **Details belong elsewhere.** If the user needs the full list (every file, every component, every metric), keep a concise overview widget in the reference zone and offer to create a separate detailed widget on demand. Do not turn the overview into a wall of text.

### Typography

- Base font-family: sans-serif.
- Section title: 16-18px, font-weight 600.
- Subtitle / secondary text: 12-14px, color #64748b or #475569.
- Body text inside boxes: 13-14px.
- Never go below 11px for primary content.

### Spacing

- Outer padding: 12-16px.
- Gap between sections: 10-12px.
- Internal gap inside a section: 6-8px.
- Border-radius: 6-8px for cards, 4px for small tags.

### Color Palette

Reuse the same semantic palette as native stickies so the canvas reads as one visual system:

| Semantic | Fill | Stroke / Text |
|----------|------|---------------|
| Neutral / default | #fef9c3 (yellow) | #854f0b |
| Info / process | #e6f1fb (blue) | #185fa5 |
| Success / done | #e1f5ee (green) | #0f6e56 |
| Error / warning | #fcebeb (pink/red) | #a32d2d |
| Message / cross-system | #eeedfe (purple) | #534ab7 |
| Sub / terminal | #f1efe8 (gray) | #5f5e5a |

### Splitting Strategy

When content exceeds the density budget:

1. Keep a high-level overview widget (4-6 sections) in the reference zone.
2. Offer to create one or more detail widgets for the parts the user wants to drill into.
3. Never try to make one widget serve both "global overview" and "deep detail" at the same time.
`,

  'widget-todolist': `## TodoList Widget Design Spec

Use this spec when the user asks for a todo list, task list, checklist, or backlog. It gives the todo-list widget a consistent visual structure across sessions so users can recognize "this is a task board" at a glance.

### When to Use This vs Other Tools

- User wants a **whole-list view** (see all tasks at once, status overview) → use this widget/dynamic spec.
- User wants **individually-editable items** (drag one task, reorder, per-item color) → use native/sticky or widget/task-list instead.
- User wants a **kanban with columns** (todo / doing / done as separate swimlanes) → use the KanbanBoard template in widget-usage, not this spec.

### Recommended Size

- Default: w=6, h=7 (480 x 560 px). Fits 6-8 items comfortably.
- Compact (3-5 items): w=5, h=5 (400 x 400 px).
- Long list (8-12 items): w=7, h=9 (560 x 720 px). Do NOT exceed w=14, h=10 hard limit.
- If the list has more than 12 items, split into a summary widget + a detail widget, or group by phase.

### Structure

Every todo-list widget has exactly four layers, top to bottom:

1. **Header** — list title + optional progress summary (e.g. "3/8 done").
2. **Progress bar** (optional, only if >3 items) — thin bar showing done/total ratio.
3. **Item list** — the tasks. Each item is one row.
4. **Footer** (optional) — last-updated timestamp or a one-line note.

Do not add extra sections (metrics, descriptions, unrelated content) inside a todo-list widget. If you need those, create a separate widget beside it.

### Item Row Anatomy

Each row contains, left to right:

- **Status marker** — a fixed-width glyph at the left edge.
- **Task text** — the main label, one short line.
- **Meta tag** (optional) — a small right-aligned tag for priority / owner / phase.

Row height: 32-36px. Row padding: 6px 8px. Gap between rows: 4px.

### Status Marker Styles

Use these exact markers — they are the visual language users recognize across the canvas:

| Status   | Marker | Color    | Text style               |
|----------|--------|----------|--------------------------|
| Todo     | ○      | #94a3b8  | normal                   |
| Doing    | ◐      | #3b82f6  | font-weight 500          |
| Done     | ●      | #10b981  | line-through, opacity 0.5|
| Blocked  | ✕      | #ef4444  | normal, color #ef4444    |

Marker width: 20px, fixed. Font-size: 14px. This keeps task text aligned even when statuses differ.

### Typography

- Header title: 15px, font-weight 600, color #1e293b.
- Progress summary: 12px, color #64748b, right-aligned in header.
- Task text: 13px, color #334155. Done items: color #94a3b8.
- Meta tag: 11px, color #64748b, background #f1f5f9, padding 2px 6px, border-radius 3px.
- Footer: 11px, color #94a3b8.

### Colors

- Widget background: #ffffff.
- Header divider: 1px solid #e2e8f0.
- Row hover (visual only, not interactive): no hover state needed.
- Progress bar track: #e2e8f0. Fill: #10b981.
- Blocked row background tint: #fef2f2 (very light red).

### Information Density

- Max 12 items in one widget. Beyond that, split.
- Task text ≤ 20 Chinese chars. If longer, truncate with ellipsis and put the full text in a separate detail widget.
- Meta tag ≤ 4 chars (e.g. "P0", "前端", "v2").
- Do NOT embed file paths, line numbers, or long descriptions in task text.

### Full Template

\`\`\`html
<div style="font-family:sans-serif;padding:14px;background:#fff;border-radius:8px;min-width:320px">
  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
    <h3 style="margin:0;font-size:15px;font-weight:600;color:#1e293b">项目任务</h3>
    <span style="font-size:12px;color:#64748b">3/8 done</span>
  </div>
  <div style="height:1px;background:#e2e8f0;margin-bottom:10px"></div>
  <!-- Progress bar -->
  <div style="height:4px;background:#e2e8f0;border-radius:2px;margin-bottom:12px;overflow:hidden">
    <div style="height:100%;width:37.5%;background:#10b981;border-radius:2px"></div>
  </div>
  <!-- Items -->
  <div style="display:flex;flex-direction:column;gap:4px">
    <!-- Done item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#10b981">●</span>
      <span style="flex:1;font-size:13px;color:#94a3b8;text-decoration:line-through">需求评审</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">P0</span>
    </div>
    <!-- Doing item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#3b82f6">◐</span>
      <span style="flex:1;font-size:13px;color:#334155;font-weight:500">接口联调</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">后端</span>
    </div>
    <!-- Todo item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#94a3b8">○</span>
      <span style="flex:1;font-size:13px;color:#334155">编写单元测试</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">测试</span>
    </div>
    <!-- Blocked item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;background:#fef2f2">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#ef4444">✕</span>
      <span style="flex:1;font-size:13px;color:#ef4444">部署到预发环境</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">运维</span>
    </div>
  </div>
  <!-- Footer -->
  <div style="margin-top:10px;font-size:11px;color:#94a3b8">Updated 2026-07-07</div>
</div>
\`\`\`

### Revision Workflow

When the user asks to update task status (e.g. "把接口联调标记为完成"):

1. Call canvas_list_elements to find the widget elementId.
2. Regenerate the FULL sourceCode with the updated status marker and text style. The marker for the changed item moves from ○/◐ to ●, and the text gets line-through + opacity 0.5.
3. Call canvas_fill_content with the new sourceCode. Do not try to patch individual rows — the whole sourceCode is replaced.
4. Update the progress bar width and the "X/Y done" counter in the header to stay in sync.

### Grouped Variant

If the list has distinct phases (e.g. "Phase 1 / Phase 2"), insert a phase sub-header row before the items of each phase:

\`\`\`html
<div style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin:10px 0 4px 0">Phase 1: 基础设施</div>
\`\`\`

Keep phase sub-headers sparse — max 3 groups per widget. More than 3 means the list is too complex for one widget.
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

### Readable Node Tiers

- Root: 3.5x1.25, fontSize 24.
- First-level branch: 3x1, fontSize 22.
- Leaf: 2.5x1, fontSize 20.
- Related-node gap: 0.5-0.75 units. Use 1 unit between branch groups.
- The root is the title. Do not add a separate oversized title banner.
- Keep the full map inside the smallest practical bounding box. A map may pan at the readable auto-fit floor; do not shrink type to force a full-canvas overview.

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

- Center root at (18.25, 14.5), size 3.5x1.25.
- First-level branches use a compact radius of about 4 units:
  - N  : (18.5, 10.5)
  - NE : (22.5, 11.5)
  - E  : (23.5, 14.5)
  - SE : (22.5, 17.5)
  - S  : (18.5, 18.5)
  - SW : (14, 17.5)
  - W  : (13, 14.5)
  - NW : (14, 11.5)
- Second-level branches extend another 3.5-4 units outward, not to the canvas edges.
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

- Root at (1, 4), size 3.5x1.25.
- Children at x=5.25, y spread vertically:
  - Child 1: (5.25, 2.5)
  - Child 2: (5.25, 4)
  - Child 3: (5.25, 5.5)
  (1.5 unit y stride for single-line children; widen only for wrapped labels.)
- Grandchildren at x=9:
  - Grandchild 1: (9, 2.5)
  - Grandchild 2: (9, 4)
  - Grandchild 3: (9, 5.5)
- Connectors bind node IDs; do not allocate extra blank rows for their paths.

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
