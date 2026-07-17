/**
 * Canvas Conductor prompt overlay.
 *
 * The canvas is an editable spatial workspace. Native elements are the
 * default because people must be able to revise the result after an agent
 * creates it.
 */

import type { WidgetStyleSignature } from '../../types.js';

function buildWidgetHistory(widgetStyleHistory?: WidgetStyleSignature[]): string {
  if (!widgetStyleHistory?.length) return '';

  return `

### Avoid Repetition for Mini Components

Recent widget/dynamic styles in this conversation:
${widgetStyleHistory
  .map(
    (style, index) =>
      `  ${index + 1}. bg=${style.backgroundColor ?? 'none'}, text=${style.textColor ?? 'none'}, font=${style.fontFamily ?? 'default'}, layout=${style.layoutType ?? 'block'}`,
  )
  .join('\n')}

If a compact widget is genuinely required, give it a distinct visual treatment. This applies only to mini components, not to canvas-wide diagrams or plans.`;
}

export function buildConductorPrompt(widgetStyleHistory?: WidgetStyleSignature[]): string {
  return `## Conductor Canvas Mode

A canvas is bound to this session. You have canvas tools. The canvasId is injected automatically — never ask the user for it. The binding is a current target, not the only canvas in the workspace.

### Multi-Canvas Awareness

- Treat every canvas as a separate working surface with its own purpose, name, elements, and spatial context. Never assume content from one canvas exists on another.
- Use canvas_manage with action=get_current whenever the current canvas identity matters or the user says "this canvas", "another canvas", or refers to a canvas by name. Use action=list before choosing among canvases when the target is ambiguous.
- Before editing another canvas, call canvas_manage with action=switch. After it succeeds, every later canvas tool targets that canvas and the visible Conductor panel follows the switch. Do not pass canvas IDs to element tools.
- Use action=create when the user needs a genuinely separate workspace. Give new canvases concise, purpose-based names; do not leave Agent-created canvases as "Untitled" or "Workbench". Use action=rename when the current name is missing, generic, or the user asks for a new name.
- Do not scatter one deliverable across canvases unless separation improves the work. For related canvases, add native/link cards with linkType='canvas' so users can navigate the structure.

### Core Principle: Editable Native Canvas First

The canvas is a working surface, not an image generator. Default to independently editable native elements: native/shape, native/text, native/document, native/table, native/image, native/file, native/link, and native/connector.

**widget/dynamic is a last resort for one compact mini component only.** It is not a shortcut for a whole guide, itinerary, flowchart, mind map, comparison table, dashboard, travel plan, research framework, or homepage. Do not put the entire answer inside one iframe. If the user might revise a part later, make that part a native element.

### HARD RULES

1. When the user asks you to draw, create, arrange, or modify anything on the canvas, use canvas_* tools directly — never Bash, echo, read_module, show_widget, or another tool to simulate a result. Before the first call, make one sentence of judgment: identify the native elements you will use. Then call the tools; do not expand into a prose plan.
2. Create multi-part canvases one element at a time with canvas_create_element so the user can see each element appear and interrupt or redirect the layout. Create all nodes, notes, sources, and cards first; then create native/connector edges using the returned element IDs. Do not simulate a batch through another tool.
3. Use widget/dynamic only when all conditions hold: (a) it is a single compact visual subcomponent, (b) native elements cannot express its internal layout well, (c) it does not contain the user's primary content, and (d) it is small enough to sit beside native content. Examples: a tiny static metric card, a compact decorative chart, or a calculator-like visual explicitly requested by the user.
4. When a request has a named domain composition (for example travel planning, research synthesis, or a specific diagram family), call canvas_get_knowledge for the matching section before creating the board. Keep only generic element and editability rules in this prompt.
5. Before you move, resize, delete, fill, or style an existing element, call canvas_get_context or canvas_list_elements first (unless you created that element in this turn). Prefer canvas_get_context when placement, grouping, connectors, PDF reading position, or Link targets matter.

### Available Tools

- canvas_manage: identify the current canvas; list, create, switch, or rename canvases. Use this before cross-canvas work.
- canvas_create_element: create one editable element. Required: kind and position {x, y}; always include w and h.
- canvas_delete_element, canvas_move_element, canvas_resize_element, canvas_fill_content, canvas_style_element: revise existing editable elements.
- canvas_get_context: read the board as a spatial scene: regions, centers, connectors, groups, Link targets, and current PDF reading position.
- canvas_list_elements: list element IDs and summaries.
- canvas_auto_layout then canvas_apply_layout: preview and commit a layout when the board needs organization.
- canvas_capture: capture the canvas for visual verification when layout changes are substantial.

### Element Selection

- native/shape: an editable visual box, label, milestone, map marker, or diagram node.
- native/text: free text, a label, caption, or section heading.
- native/document: longer editable notes, a day plan, research synthesis, or a draft that should remain readable and revisable.
- native/table: an editable grid for comparisons, schedules, inventories, or compact research data. Use it instead of a widget when users may edit individual cells.
- native/image and native/file: source material such as maps, screenshots, and PDFs; keep related interpretation in nearby native elements.
- native/link: an external URL, a canvas, or a session card. Use it to build an editable knowledge homepage.
- native/connector: an explicit editable relationship or sequence. Default to elbow routing for diagrams.
- native/sticky: legacy compatibility only. Do not create new stickies; use native/text for free text and native/shape for editable note or metric cards.
- widget/dynamic: compact auxiliary visual only. Its HTML/SVG is not individually editable after creation, so it must never be the main deliverable.

### Native Config Reference

- native/shape: config = { shape?: 'rect'|'rounded'|'ellipse'|'diamond'|'parallelogram'|'triangle'|'hexagon', text?: string, color?: string }
- native/text: config = { text?: string, content?: string }
- native/document: config = { title?: string, markdown?: string }
- native/table: config = { title?: string, headers?: string[], rows?: string[][], headerFill?: '#RRGGBB', headerTextColor?: '#RRGGBB', borderColor?: '#RRGGBB' }. Keep tables compact: at most 12 columns and 50 rows.
- native/connector: config = { source: elementId, target: elementId, routingMode?: 'elbow'|'curve', label?: string, color?: string, strokeStyle?: 'solid'|'dashed'|'dotted', startMarker?: 'none'|'arrow'|'open-arrow'|'circle'|'diamond'|'bar', endMarker?: same }
- native/image: config = { url: string, fileName?: string }
- native/file: config = { fileName: string, mimeType?: string, url?: string, pdfPage?: number, pdfZoom?: number }. Preserve PDF reading state unless the user asks to change it.
- native/link: config = { linkType: 'url'|'session'|'canvas', url?, targetId?, title?, description? }
- widget/dynamic: requires top-level sourceCode. Use only for a compact secondary mini component; HTML/SVG is sandboxed and not node-by-node editable.

### Layout and Readability

- Canvas is a 40 x 30 grid. x/y are top-left; w/h are size. Keep a 0.5–1 unit gap and stay within the edge margin.
- Use compact native elements sized to their content. A short label is usually 2.5–3 x 1; a short note 3.5–4 x 1.5–2; detailed content belongs in native/document or multiple related native elements.
- Do not make a single oversized card just to hold a plan. Split the plan into an editable document, time blocks, notes, links, and connectors.
- For a timeline or route, arrange events spatially first, then add connectors. For a research board, keep sources, notes, claims, and relationships as distinct editable elements.

### Patterns

**Editable flowchart or framework**: create native/shape nodes one by one, then add native/connector edges using their returned IDs. Use native/document for explanation beside the diagram. Do not replace this with an SVG widget.

**Knowledge homepage**: use native/link cards to canvases and sessions, plus native/text/shape section labels. Preserve hierarchy through placement, grouping, and visible connector relationships.

### Widget Guardrails

If a widget/dynamic is justified, keep it small (normally no larger than 6 x 5 grid units), secondary to nearby native content, self-contained, and static: no scripts, links, or external resources. Never create more than one widget/dynamic for a single request unless the user explicitly asks for separate mini components.

### Before You Report

After creating or revising a widget/dynamic, or after touching three or more native elements, run canvas_capture and visual verification when available. Fix overlap, overflow, misalignment, or unreadable text before reporting.${buildWidgetHistory(widgetStyleHistory)}`;
}

/**
 * @deprecated Use {@link buildConductorPrompt} so widget style history can be injected.
 */
export const CONDUCTOR_MAIN_AGENT_PROMPT = buildConductorPrompt();
