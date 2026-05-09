import type { PromptContext } from '../../types.js';

interface ConductorSnapshot {
  canvasId: string;
  canvasName: string;
  widgets: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }>;
  elements?: Array<{
    id: string;
    elementKind: string;
    vizSpec: Record<string, unknown> | null;
    position: { x: number; y: number; w: number; h: number };
  }>;
}

let currentSnapshot: ConductorSnapshot | null = null;

export function setConductorCanvasState(snapshot: ConductorSnapshot | null): void {
  currentSnapshot = snapshot;
}

export function getConductorCanvasSection(_context: PromptContext): string | null {
  if (!currentSnapshot) return null;

  const { canvasId, canvasName, widgets, elements } = currentSnapshot;

  const widgetDetails = widgets.map((w) => {
    const dataStr = JSON.stringify(w.data);
    return `- ${w.id} (type: ${w.type}) — Data: ${dataStr.length > 500 ? dataStr.slice(0, 500) + '...(truncated)' : dataStr}`;
  }).join('\n');

  const elementDetails = elements
    ? elements.map((el) => {
        const pos = `(${el.position.x}, ${el.position.y}) ${el.position.w}x${el.position.h}`;
        const viz = el.vizSpec ? ` | vizSpec: ${JSON.stringify(el.vizSpec).slice(0, 200)}` : '';
        return `- ${el.id} (${el.elementKind}) at ${pos}${viz}`;
      }).join('\n')
    : '';

  return `## Canvas Workspace: "${canvasName}" (canvasId: ${canvasId})
- ${widgets.length} widgets currently on canvas

### Widget State
${widgetDetails || '(empty canvas — no widgets yet)'}

${elementDetails ? `### Element State\n${elementDetails}\n` : ''}### Canvas Operations

**V2 Canvas Orchestrator (preferred):**
- **canvas_create_element**: Create any element — diagrams, charts, cards, shapes, mini-apps, widgets. Supports vizSpec for structured rendering.
- **canvas_update_element**: Update an element's vizSpec, position, or config.
- **canvas_delete_element**: Remove an element from the canvas.
- **canvas_arrange_elements**: Batch reposition multiple elements at once.
- **canvas_get_snapshot**: Re-read current canvas state.

**V1 Widget Operations (legacy):**
- **conductor_update_widget_data**: Update widget data. Task-list: { tasks: [{ id, title, completed, priority? }] }. News-board: { articles: [...], lastUpdated }. Note-pad: { content }. Pomodoro: { duration, breakDuration, currentTask? }.
- **conductor_create_widget**: Create legacy widgets (task-list, note-pad, pomodoro, news-board).
- **conductor_get_snapshot**: Re-read canvas state.

### Guidelines
- When the user asks to visualize data, use canvas_create_element with appropriate kind and vizSpec.
- When the user asks "今天我的计划" or "帮我规划任务", extract tasks and use canvas_create_element with kind "widget/task-list" or update existing task-list widgets.
- When the user asks "今天有什么新闻", use web_search to find news, then call canvas_create_element for news-board.
- For task-list: MERGE with existing tasks. Include ALL tasks (old + new).
- For news-board: REPLACE all articles (news is a time-sensitive snapshot).
- Always respond naturally in Chinese first, then make tool calls.
- Keep responses concise and action-oriented.`;
}