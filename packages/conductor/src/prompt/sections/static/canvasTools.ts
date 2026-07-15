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
- **native/link** — Link card referencing a URL, DUYA session, or DUYA canvas (linkType, url/targetId, title, description, expanded?)

Parameters: canvasId, kind, position {x, y, w, h, zIndex} (all in **grid units**, 1 unit = 80 px on screen), vizSpec (kind-specific), config`,

  canvas_update_element: `### canvas_update_element
Update an existing element's vizSpec, position, or config. Only specify the fields you want to change.

Parameters: canvasId, elementId, vizSpec?, position? (in **grid units**, 1 unit = 80 px), config?`,

  canvas_delete_element: `### canvas_delete_element
Remove an element from the canvas. High-risk: confirm with user before calling unless explicitly instructed.

Parameters: canvasId, elementId`,

  canvas_arrange_elements: `### canvas_arrange_elements
Batch reposition multiple elements at once. Use for layout reorganization.

Parameters: canvasId, layout: [{elementId, position {x, y, w, h}}] (positions in **grid units**, 1 unit = 80 px)`,

  canvas_align: `### canvas_align
Align a single element to a canvas position (top-left, top-right, bottom-left, bottom-right, center).

Parameters: canvasId, elementId, alignment, margin? (in **screen pixels**, default 20 px)`,

  canvas_layout_grid: `### canvas_layout_grid
Arrange elements in a grid pattern (columns, gap, cellWidth, cellHeight).

Parameters: canvasId, elementIds, columns?, gap? (screen pixels), cellWidth? (screen pixels), cellHeight? (screen pixels)`,

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

  group_create: `### group_create
Create a group element that loosely binds existing elements by their IDs.
Used to organize related elements by theme / process stage / responsibility.

A group renders as a dashed frame around its members with an optional
title at the top-left. Members keep their absolute canvas positions and
remain independently draggable; the frame's bbox is recalculated in real time.

**Grouping is a semantic judgment, NOT a type judgment** — do NOT auto-group
by element type. Look at the element list (id + type + text summary) and
decide which elements belong together.

Use cases:
- By theme: group stickers discussing the same topic
- By process stage: Requirements / Design / Implementation / Test
- By responsibility: Frontend / Backend / Design

Parameters: canvasId, memberIds (string[], minItems 1), title?, bgColor?`,

  group_ungroup: `### group_ungroup
Remove a group element (the dashed frame). Member elements are NOT deleted —
only the group frame is removed. Use when the grouping is no longer relevant.

Parameters: canvasId, groupId`,

  group_add_members: `### group_add_members
Append members to an existing group. New memberIds are deduped against the
existing list. All memberIds must exist on the same canvas as the group,
and a group cannot be a member of itself.

Parameters: canvasId, groupId, memberIds (string[], minItems 1)`,

  group_remove_members: `### group_remove_members
Remove members from an existing group. Only the membership relation is
removed — the elements themselves stay on the canvas.

Parameters: canvasId, groupId, memberIds (string[], minItems 1)`,
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
