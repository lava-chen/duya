/**
 * canvas_get_knowledge tool.
 *
 * Fetches a focused design-knowledge section on-demand. The LLM
 * should call this when it needs specific guidance on sticky colors,
 * connector styles, widget usage, or layout templates for
 * flowcharts / mind maps — instead of having all of that bloat the
 * system prompt.
 *
 * This tool does NOT go through IPC and does NOT need a bound
 * canvasId. The knowledge is static markdown kept in
 * \`knowledge-sections.ts\`. It works in any mode but is most
 * useful in conductor mode.
 *
 * The model is expected to call this sparingly — only when it
 * actually needs the guidance. Repeated calls for the same section
 * are wasteful; the content is deterministic.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import {
  KNOWLEDGE_SECTIONS,
  KNOWLEDGE_SECTION_NAMES,
  type KnowledgeSection,
} from './knowledge-sections.js';

export const TOOL_NAME = 'canvas_get_knowledge';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Fetch design knowledge for the canvas conductor. ' +
    'Returns focused guidance on sticky colors, connector styles, ' +
    'widget usage, widget design system (size/density/typography/colors), ' +
    'layout templates for flowcharts and mind maps, or a travel-guide composition module. ' +
    'Call this when you need specific design guidance — do NOT call ' +
    'it for every request, only when you need help with styling, ' +
    'sizing, density, or layout decisions.',
  input_schema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['sticky-style', 'connector-style', 'widget-usage', 'widget-design-system', 'widget-todolist', 'flowchart-layout', 'mindmap-layout', 'travel-guide'],
        description: 'Which knowledge section to retrieve.',
      },
    },
    required: ['section'],
  },
};

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const section = input.section as string;
    const content = KNOWLEDGE_SECTIONS[section as KnowledgeSection];
    if (!content) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({
          success: false,
          error: {
            code: 'UNKNOWN_SECTION',
            message: `Unknown section: ${section}. Available: ${KNOWLEDGE_SECTION_NAMES.join(', ')}`,
          },
        }),
        error: true,
      };
    }

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify({ success: true, data: { section, content } }),
      error: false,
    };
  },
};
