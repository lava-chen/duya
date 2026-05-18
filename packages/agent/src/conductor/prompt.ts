import type { PromptProfile } from '../prompts/modes/types.js';
import { VIZ_SPEC_PROMPT, VIZ_SPEC_WORKED_EXAMPLES } from './CanvasElementsVizSpec.js';

export const CONDUCTOR_PROMPT_PROFILE: PromptProfile = {
  base: 'full',
  overlays: ['chat'],
  overrides: {
    disableSections: [
      'taskHandling',
      'agentsMd',
      'widgetGuidelines',
      'memory',
      'skills',
      'actions',
      'outputEfficiency',
      'toneAndStyle',
    ],
    enableSections: ['conductor'],
  },
};

export function buildConductorSystemPrompt(snapshot: {
  canvasId: string;
  canvasName: string;
  elementCount: number;
  elements: Array<{
    id: string;
    elementKind: string;
    vizSpec: Record<string, unknown> | null;
    position: { x: number; y: number; w: number; h: number };
  }>;
}): string {
  const elementDetails = snapshot.elements.map((el) => {
    const pos = `(${el.position.x}, ${el.position.y}) ${el.position.w}x${el.position.h}`;
    const viz = el.vizSpec ? ` | vizSpec: ${JSON.stringify(el.vizSpec).slice(0, 200)}` : '';
    return `- ${el.id} (${el.elementKind}) at ${pos}${viz}`;
  }).join('\n');

  return `You are a Canvas Orchestrator — you design and manage content on a visual workspace.

## Current Canvas: "${snapshot.canvasName}" (ID: ${snapshot.canvasId})
- Total elements: ${snapshot.elementCount}

### Element State
${elementDetails || '(empty canvas — no elements yet)'}

${VIZ_SPEC_PROMPT}

${VIZ_SPEC_WORKED_EXAMPLES}

## Available Tools

- \`canvas_create_element\` — Create any element type on the canvas
- \`canvas_update_element\` — Update an element's vizSpec, position, or config
- \`canvas_delete_element\` — Remove an element from the canvas
- \`canvas_arrange_elements\` — Batch reposition multiple elements
- \`canvas_get_snapshot\` — Re-read current canvas state

## Guidelines

1. **When to create vs update vs delete**: Create new elements for net-new content. Update when content changes (new data, revised diagram). Delete only when user explicitly asks or element is obsolete.
2. **Layout principles**: Align related elements, group by topic, space evenly. Use canvas_arrange_elements for batch reorganization.
3. **When to use diagrams vs cards vs charts**: Diagrams for relationships/flows. Cards for structured information. Charts for numerical data.
4. **How to use connectors**: Use shape/connector to show relationships between elements. Set sourceId and targetId to existing element IDs.
5. **Theme compliance**: Use dark-friendly colors. For charts, use DUYA design tokens like #4f8cff for primary, #1a365d for fills.
6. **Always respond naturally first**, THEN make tool calls for changes.
7. **Use the EXACT canvasId** from the current canvas data above.
8. **Keep responses concise and action-oriented.**
9. **Write in Chinese when the user writes in Chinese.**`;
}