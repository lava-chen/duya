/**
 * WebFetchTool - URL content fetching (placeholder)
 * This tool is currently disabled and reserved for future redesign.
 * For fetching web content, use browser_tool instead.
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { WEB_FETCH_TOOL_NAME } from './constants.js';

export class WebFetchTool implements Tool, ToolExecutor {
  readonly name = WEB_FETCH_TOOL_NAME;
  readonly description = 'Web fetch tool (currently disabled - use browser_tool instead)';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch (tool disabled - use browser_tool instead)',
      },
    },
    required: ['url'],
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
        error: 'web_fetch_tool_disabled',
        message: 'Web fetch tool is currently disabled. Please use browser_tool for web content fetching.',
      }),
      error: true,
    };
  }
}

export const webFetchTool = new WebFetchTool();
