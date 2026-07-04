/**
 * Conductor Agent Canvas Tools Section
 * Detailed schema descriptions for all Canvas Orchestrator tools
 */

import type { PromptContext } from '@duya/agent/prompts/types';

const CANVAS_TOOL_DEFINITIONS: Record<string, string> = {
  canvas_create_element: `### canvas_create_element
Create any element on the canvas. Supports these kinds:
- **native/sticky** — Sticky note with color (yellow, blue, green, pink, purple, gray)
- **native/connector** — Connection line between two elements with sourceId and targetId
- **native/image** — Image element (assetId or url)
- **native/file** — File attachment element (assetId, fileName, mimeType)
- **widget/task-list**, **widget/note-pad**, **widget/pomodoro**, **widget/news-board** — Structured widgets

Parameters: canvasId, kind, position {x, y, w, h, zIndex}, vizSpec (kind-specific), config`,

  canvas_update_element: `### canvas_update_element
Update an existing element's vizSpec, position, or config. Only specify the fields you want to change.

Parameters: canvasId, elementId, vizSpec?, position?, config?`,

  canvas_delete_element: `### canvas_delete_element
Remove an element from the canvas. High-risk: confirm with user before calling unless explicitly instructed.

Parameters: canvasId, elementId`,

  canvas_arrange_elements: `### canvas_arrange_elements
Batch reposition multiple elements at once. Use for layout reorganization.

Parameters: canvasId, layout: [{elementId, position {x, y, w, h}}]`,

  canvas_align: `### canvas_align
Align a single element to a canvas position (top-left, top-right, bottom-left, bottom-right, center).

Parameters: canvasId, elementId, alignment, margin?`,

  canvas_layout_grid: `### canvas_layout_grid
Arrange elements in a grid pattern (columns, gap, cellWidth, cellHeight).

Parameters: canvasId, elementIds, columns?, gap?, cellWidth?, cellHeight?`,

  canvas_get_snapshot: `### canvas_get_snapshot
Read-only: get current canvas state with all elements, positions, and vizSpecs.

Parameters: canvasId`,

  canvas_capture: `### canvas_capture
Capture a screenshot of the canvas for visual analysis. The result includes a PNG data URL and metadata (width, height, scope, timestamp).

**When to use (be selective):**
- After layout changes: verify visual alignment, spacing, overlap
- After creating complex elements (diagrams, charts, rich-text): check rendering
- When the user asks "how does it look?" or "is it aligned?"
- Before reporting done on a visual task: confirm the composition

**When NOT to use:**
- Reading text content → use canvas_get_snapshot
- Checking positions/sizes → use canvas_get_snapshot
- Routine create/update/delete → JSON state is sufficient
- Every turn → wastes tokens and context; use sparingly

**Scopes:**
- \`viewport\` (default): capture the user's current visible canvas area
- \`element\`: capture a single element by elementId (pass elementId)
- \`region\`: capture a rectangular area (pass region: {x, y, w, h} in screen pixels)

Parameters: canvasId, scope ('viewport'|'element'|'region'), elementId?, region?`,
};

export function getCanvasToolsSection(context?: PromptContext): string {
  const enabledTools = context?.enabledTools;

  const lines: string[] = ['## Available Canvas Tools'];

  for (const [toolName, toolDescription] of Object.entries(CANVAS_TOOL_DEFINITIONS)) {
    if (!enabledTools || enabledTools.has(toolName)) {
      lines.push('');
      lines.push(toolDescription);
    }
  }

  return lines.join('\n');
}
