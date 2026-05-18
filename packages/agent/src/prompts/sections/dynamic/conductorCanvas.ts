import type { PromptContext } from '../../types.js';

export interface ConductorCanvasSnapshot {
  canvasId: string;
  canvasName: string;
  elements: Array<{
    id: string;
    kind: string;
    vizSpec: Record<string, unknown> | null;
    position: { x: number; y: number; w: number; h: number };
    config: Record<string, unknown>;
  }>;
}

let currentSnapshot: ConductorCanvasSnapshot | null = null;

export function setConductorCanvasState(snapshot: ConductorCanvasSnapshot | null): void {
  currentSnapshot = snapshot;
}

export function buildConductorCanvasSection(context: PromptContext): string | null {
  if (!currentSnapshot) return null;

  const { canvasId, canvasName, elements } = currentSnapshot;

  const elementDetails = elements.map((el) => {
    const pos = `(${el.position.x}, ${el.position.y}) ${el.position.w}x${el.position.h}`;
    const viz = el.vizSpec ? ` | vizSpec: ${JSON.stringify(el.vizSpec).slice(0, 200)}` : '';
    return `- ${el.id} (kind: ${el.kind}) at ${pos}${viz}`;
  }).join('\n');

  return `## Canvas Workspace: "${canvasName}" (canvasId: ${canvasId})
- ${elements.length} elements currently on canvas

### Element State
${elementDetails || '(empty canvas — no elements yet)'}

### Available Tools
- **canvas_create_element**: Create any element — diagrams, charts, cards, shapes, mini-apps, widgets. Supports vizSpec for structured rendering.
- **canvas_update_element**: Update an element's vizSpec, position, or config.
- **canvas_delete_element**: Remove an element from the canvas.
- **canvas_arrange_elements**: Batch reposition multiple elements at once.
- **canvas_get_snapshot**: Re-read current canvas state.

### Guidelines for Canvas Management

**Content Creation:**
- When the user asks to visualize data, use canvas_create_element with appropriate kind and vizSpec.
- When the user asks about their plans or tasks, use canvas_create_element with kind "widget/task-list".
- When the user asks for news, use web_search to find news, then call canvas_create_element for news-board.
- Always respond naturally in the user's language first, then make tool calls.

**Data Updates:**
- For task-list: MERGE with existing tasks. Include ALL tasks (old + new).
- For news-board: REPLACE all articles (news is a time-sensitive snapshot).
- For note-pad: REPLACE content entirely.
- Keep responses concise and action-oriented.

**Layout & Design:**
- Use diagrams for relationships, flows, and comparisons.
- Use cards for structured information and key facts.
- Use charts for numerical data and trends.
- Group related elements together, space evenly.
- Keep the canvas clean — delete obsolete elements when asked.

**Collaboration:**
- Always respond naturally in the user's language.
- If the user's request is unclear, ask clarifying questions before acting.
- Proactively suggest useful widgets or visualizations when relevant.`;
}