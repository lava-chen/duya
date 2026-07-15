/**
 * Canvas element vizSpec reference strings.
 * Minimal set: sticky, connector, image, file, and 4 widget kinds.
 */

export const VIZ_SPEC_PROMPT = `
## Canvas Element Types & vizSpec Protocol

The conductor canvas supports a minimal element set:

- **native/sticky** — Sticky note
- **native/connector** — Connection line between elements
- **native/image** — Image element (assetId or url)
- **native/file** — File attachment element (assetId, fileName, mimeType)
- **native/link** — Link card referencing a URL, DUYA session, or DUYA canvas
- **native/group** — Loose-binding group frame around member elements
- **widget/task-list** — Structured task list widget
- **widget/note-pad** — Plain-text note pad widget
- **widget/pomodoro** — Pomodoro timer widget
- **widget/news-board** — News feed widget

### native/sticky — Sticky Notes

Use for: free-form annotations, reminders, brainstorm fragments.

vizSpec format:
\`\`\`json
{
  "text": "Discuss pricing model",
  "color": "yellow",
  "shape": "rect"
}
\`\`\`
Color options: yellow, blue, green, pink, purple, gray. Hex values mirror the
diagram module's .s-* palette (yellow maps to .s-chk Amber, blue maps to .s-proc,
green maps to .s-agent, pink maps to .s-err Red, purple maps to .s-msg, gray maps to .s-sub). Note that the pink
key renders as light red (.s-err) and is kept for back-compat. Default border is
1px solid in the theme stroke color; set borderStyle only when you need
a non-default border.

Style fields (all optional):
- **shape**: "rect" | "diamond" | "ellipse" — default "rect".
  - Use "rect" for paragraph content and long notes.
  - Use "diamond" for decision nodes (e.g. "Approved?").
  - Use "ellipse" for start/end nodes (e.g. "Begin", "Done").
  - Short labels (≤20 chars) use diamond/ellipse; paragraphs use rect.
- **bgColor**: CSS color string — overrides the theme color when set.
- **borderStyle**: { color?, width?, style? } — "style" is "solid" | "dashed" | "dotted".
  When width is omitted, a 1px solid theme stroke is rendered.

### native/connector — Connection Lines

Use for: linking related elements, showing relationships.

vizSpec format:
\`\`\`json
{
  "sourceId": "element-uuid-1",
  "targetId": "element-uuid-2",
  "routingMode": "elbow",
  "label": "depends on",
  "strokeStyle": "solid",
  "color": "#7C5CFF",
  "arrowStart": false,
  "arrowEnd": true
}
\`\`\`

Style fields (all optional, top-level):
- **routingMode**: "elbow" | "curve" — default "elbow". Use elbow for every editable architecture map, dependency graph, flowchart, and mind map. Curve is opt-in only when explicitly requested for an organic relation.
- **strokeStyle**: "solid" | "dashed" | "dotted" — default "solid".
  - Use "dashed" for conditional/optional branches.
  - Use "dotted" for weak/implicit relations.
- **color**: CSS color string — default var(--text-secondary).
- **arrowStart**: boolean — default false. Set true for bidirectional relations.
- **arrowEnd**: boolean — default true. Set false for conditional branches with no outcome.

Examples:
- Conditional branch: strokeStyle="dashed", arrowEnd=false
- Bidirectional relation: arrowStart=true, arrowEnd=true

For fan-out/fan-in, align siblings in one row or column and create
direct elbow connectors for every semantic relation. Matching anchor
sides make their orthogonal segments overlap into a shared trunk/bus
with short branches. Never chain siblings together to fake the bus.

### native/image — Image Elements

Use for: embedding pictures, screenshots, diagrams on the canvas.

vizSpec format:
\`\`\`json
{
  "assetId": "asset-uuid",
  "url": "duya-file:///path/to/image.png",
  "fileName": "screenshot.png",
  "objectFit": "contain"
}
\`\`\`

### native/file — File Attachments

Use for: attaching PDFs, documents, or other binary files to the canvas.

vizSpec format:
\`\`\`json
{
  "assetId": "asset-uuid",
  "fileName": "spec.pdf",
  "mimeType": "application/pdf",
  "size": 102400
}
\`\`\`

### native/link — Link Cards

Use for: referencing external URLs, DUYA sessions, or DUYA canvases on the canvas.

vizSpec format:
\`\`\`json
{
  "linkType": "url",
  "url": "https://react.dev",
  "title": "React Documentation",
  "description": "The library for web and native user interfaces."
}
\`\`\`

Config fields:
- **linkType** (required): \`"url"\` | \`"session"\` | \`"canvas"\`.
- **url** (url only): absolute external URL.
- **targetId** (session/canvas only): UUID of the referenced session or canvas.
- **title** (optional): display title; falls back to domain or target id.
- **description** (optional): short description shown in the expanded card.
- **expanded** (optional): \`true\` renders the rich card, \`false\` renders the compact chip. Default \`false\`.
- **expandedSize** (optional): \`{ w, h }\` in grid units, remembered when the user resizes the expanded card.

Examples:
- External URL: \`{ "linkType": "url", "url": "https://example.com" }\`
- Session link: \`{ "linkType": "session", "targetId": "session-uuid" }\`
- Canvas link: \`{ "linkType": "canvas", "targetId": "canvas-uuid" }\`

### native/group — Group Frames

Use for: visually organizing related elements by theme / process stage /
responsibility. A group is a dashed frame drawn around its member
elements. Members keep their absolute canvas positions and remain
independently draggable; the frame's bbox is recalculated in real time.

Group is a **semantic judgment, NOT a type judgment** — do NOT auto-group
by element type. Look at the element list (id + type + text summary) and
decide which elements belong together.

Config fields (stored on the group element's config):
- **title** (optional): label shown at the top-left of the frame.
- **bgColor** (optional): CSS color for a semi-transparent frame overlay.
- **memberIds** (required): non-empty array of existing element IDs on
  the same canvas.

Use the dedicated group tools (group_create, group_ungroup,
group_add_members, group_remove_members) — do NOT use element.create
or element.update_content for group manipulation.

Examples:
- **By theme**: group stickers discussing "pricing model" together
  \`\`\`json
  { "title": "Pricing discussion", "memberIds": ["s1", "s3", "s5"] }
  \`\`\`
- **By process stage**: split a flow into Requirements / Design /
  Implementation / Test groups
  \`\`\`json
  { "title": "Requirements", "memberIds": ["r1", "r2"] }
  \`\`\`
- **By responsibility**: cluster work items by Frontend / Backend /
  Design owners
  \`\`\`json
  { "title": "Frontend", "bgColor": "#B8DFFF", "memberIds": ["f1", "f2", "f3"] }
  \`\`\`

### widget/* — Structured Widgets

Pass an empty vizSpec.payload — widgets render their own UI based on type.

vizSpec format:
\`\`\`json
{ "kind": "widget/note-pad", "payload": {} }
\`\`\``;

export const VIZ_SPEC_WORKED_EXAMPLES = `
## Worked Examples

### Example 1: Task List with Connections
User: "Add a task list and connect it to a sticky note"
Response: I'll add a task list widget and a sticky note, then connect them.

Tool call: canvas_create_element (widget/task-list)
Tool call: canvas_create_element (native/sticky)
Tool call: canvas_create_element (native/connector, sourceId=task-list-id, targetId=sticky-id)

### Example 2: Reorganize Canvas Layout
User: "Organize this messy canvas into a clean layout"
Response: I'll reorganize the elements into a clean grid layout.

Tool call: canvas_get_snapshot (to see current state)
Tool call: canvas_arrange_elements (to reposition all elements)`;
