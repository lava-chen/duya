/**
 * WebSearchTool - Web search functionality (placeholder)
 * This tool is currently disabled and reserved for future redesign.
 * For web search, use browser_tool instead.
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { WEB_SEARCH_TOOL_NAME } from './constants.js';

export class WebSearchTool implements Tool, ToolExecutor {
  readonly name = WEB_SEARCH_TOOL_NAME;
  readonly description = 'Web search tool (currently disabled - use browser_tool instead)';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (tool disabled - use browser_tool instead)',
      },
    },
    required: ['query'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(): Promise<ToolResult> {
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        error: 'web_search_tool_disabled',
        message: 'Web search tool is currently disabled. Please use browser_tool for web search functionality.',
      }),
      error: true,
    };
  }
}

export const webSearchTool = new WebSearchTool();
