/**
 * Conductor Agent Canvas Tools Section
 * Detailed schema descriptions for all Canvas Orchestrator tools
 */

export function getCanvasToolsSection(): string {
  return `## Available Canvas Tools

### canvas_create_element
Create any element on the canvas. Supports these kinds:
- **diagram/svg** — Flowchart, architecture diagram, sequence diagram (Mermaid format)
- **chart/bar**, **chart/line**, **chart/pie** — Data visualizations with chartType, labels, datasets
- **content/card** — Information card with header, sections (key-value, text), footer
- **content/rich-text** — Formatted text block (Markdown)
- **content/image** — Image placeholder
- **shape/rect**, **shape/circle** — Geometric shapes with fill, stroke, label
- **shape/connector** — Connection lines between elements with sourceId and targetId
- **app/mini-app** — Interactive mini-application with html, js, css
- **widget/task-list**, **widget/note-pad**, **widget/pomodoro**, **widget/news-board** — Structured widgets

Parameters: canvasId, kind, position {x, y, w, h, zIndex}, vizSpec (kind-specific), config

### canvas_update_element
Update an existing element's vizSpec, position, or config. Only specify the fields you want to change.

Parameters: canvasId, elementId, vizSpec?, position?, config?

### canvas_delete_element
Remove an element from the canvas. High-risk: confirm with user before calling unless explicitly instructed.

Parameters: canvasId, elementId

### canvas_arrange_elements
Batch reposition multiple elements at once. Use for layout reorganization.

Parameters: canvasId, layout: [{elementId, position {x, y, w, h}}]

### canvas_align
Align a single element to a canvas position (top-left, top-right, bottom-left, bottom-right, center).

Parameters: canvasId, elementId, alignment, margin?

### canvas_layout_grid
Arrange elements in a grid pattern (columns, gap, cellWidth, cellHeight).

Parameters: canvasId, elementIds, columns?, gap?, cellWidth?, cellHeight?

### canvas_get_snapshot
Read-only: get current canvas state with all elements, positions, and vizSpecs.

Parameters: canvasId`
}
