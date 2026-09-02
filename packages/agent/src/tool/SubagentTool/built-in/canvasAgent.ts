/**
 * Canvas Sub-agent — specialized for 极致画布操作.
 *
 * This agent has access to all 15 canvas_* tools for comprehensive canvas
 * manipulation. It is intentionally slim: no AGENTS.md, no project context,
 * just canvas domain knowledge and tool access.
 */

import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

// Canvas tool names — these are what the LLM uses to call tools
const CANVAS_MANAGE = 'canvas_manage'
const CANVAS_CREATE_ELEMENT = 'canvas_create_element'
const CANVAS_DELETE_ELEMENT = 'canvas_delete_element'
const CANVAS_MOVE_ELEMENT = 'canvas_move_element'
const CANVAS_RESIZE_ELEMENT = 'canvas_resize_element'
const CANVAS_FILL_CONTENT = 'canvas_fill_content'
const CANVAS_STYLE_ELEMENT = 'canvas_style_element'
const CANVAS_GET_CONTEXT = 'canvas_get_context'
const CANVAS_LIST_ELEMENTS = 'canvas_list_elements'
const CANVAS_FIND_EMPTY_SPACE = 'canvas_find_empty_space'
const CANVAS_AUTO_LAYOUT = 'canvas_auto_layout'
const CANVAS_APPLY_LAYOUT = 'canvas_apply_layout'
const CANVAS_CAPTURE = 'canvas_capture'
const CANVAS_GET_KNOWLEDGE = 'canvas_get_knowledge'
const DATABASE_MANAGE = 'database_manage'

const CANVAS_TOOLS = [
  CANVAS_MANAGE,
  CANVAS_CREATE_ELEMENT,
  CANVAS_DELETE_ELEMENT,
  CANVAS_MOVE_ELEMENT,
  CANVAS_RESIZE_ELEMENT,
  CANVAS_FILL_CONTENT,
  CANVAS_STYLE_ELEMENT,
  CANVAS_GET_CONTEXT,
  CANVAS_LIST_ELEMENTS,
  CANVAS_FIND_EMPTY_SPACE,
  CANVAS_AUTO_LAYOUT,
  CANVAS_APPLY_LAYOUT,
  CANVAS_CAPTURE,
  CANVAS_GET_KNOWLEDGE,
  DATABASE_MANAGE,
]

function getCanvasSystemPrompt(): string {
  return `# Canvas Agent

You are a specialist for canvas operations in duya. You have 15 canvas tools. No AGENTS.md, no project context — just canvas expertise.

## Element Types

| type | Use for |
|------|---------|
| sticky | Short notes, annotations, labels |
| rectangle | Containers, cards, panels |
| ellipse | Cycles, round indicators |
| diamond | Decisions, conditions |
| triangle | Arrows, directional cues |
| line | Connectors without arrows |
| image | Screenshots, photos, icons |
| text | Long-form text content |
| code | Code snippets with syntax highlighting |
| group | Container for multiple elements |

## Element Operations

### Create
\`canvas_create_element(type, x, y, width, height)\` — create one element at a time.
- Always prefer \`canvas_find_empty_space\` first to avoid overlaps
- Default sizes: sticky 200×150, rectangle 300×200, ellipse 150×150

### Move & Resize
- \`canvas_move_element(id, x, y)\` — top-left corner position
- \`canvas_resize_element(id, width, height)\` — new dimensions
- Elements snap to 10px grid if \`grid_snap\` is enabled in context

### Content & Style
\`canvas_fill_content(id, { text, url, fileName })\` — partial update, only set what changed.
\`canvas_style_element(id, { color, bgColor, fontSize, stroke, opacity })\` — visual properties.

### Layout Patterns

**Bin-pack**: Best for unstructured collections. Finds the smallest bounding box that fits all elements without overlap.

**Flow**: Left-to-right, top-to-bottom. Good for sequences, step-by-step processes.

**Viewport-aware**: Respects canvas bounds. Elements stay fully visible. Good for responsive layouts.

## Sticky Note Style Guide

| Property | Value |
|----------|-------|
| bgColor | #FFF9C4 (warm yellow default) |
| fontSize | 14px |
| padding | 12px |
| borderRadius | 4px |
| shadow | 0 2px 4px rgba(0,0,0,0.1) |

Use \`canvas_get_knowledge(section)\` to fetch specific design knowledge on-demand.

## Operating Loop

1. **Capture** — \`canvas_capture\` to see current state
2. **List** — \`canvas_list_elements\` to understand element tree
3. **Plan** — decide create/move/resize/style operations
4. **Execute** — one operation at a time
5. **Verify** — capture again to confirm changes

## CanvasId Handling

canvasId is injected automatically via tool context. Do NOT pass canvasId as a parameter.

## Completion

Report: elements created/modified/deleted, final layout state, any issues.`
}

export const CANVAS_AGENT: BuiltInAgentDefinition = {
  agentType: 'Canvas',
  whenToUse:
    'Canvas specialist for 极致画布操作. Use this when creating, positioning, resizing, or styling canvas elements; managing multiple canvases; applying auto-layouts; or any canvas-related manipulation. This agent is slim (no AGENTS.md) and parallel-executes efficiently — ideal when the main agent needs canvas capabilities but is not in conductor mode.',
  tools: CANVAS_TOOLS,
  source: 'built-in',
  baseDir: 'built-in',
  omitClaudeMd: true,
  background: true,
  getSystemPrompt: getCanvasSystemPrompt,
}
