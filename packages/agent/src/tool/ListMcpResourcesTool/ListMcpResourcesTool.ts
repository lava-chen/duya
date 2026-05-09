/**
 * ListMcpResourcesTool - List available MCP resources
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { LIST_MCP_RESOURCES_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

// MCP resource interface
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// Placeholder for MCP resources - would be populated by MCP server connections
let mcpResources: McpResource[] = [];

/**
 * Set MCP resources (called by MCP server connection)
 */
export function setMcpResources(resources: McpResource[]): void {
  mcpResources = resources;
}

/**
 * Get MCP resources
 */
export function getMcpResources(): McpResource[] {
  return mcpResources;
}

export class ListMcpResourcesTool implements Tool, ToolExecutor {
  readonly name = LIST_MCP_RESOURCES_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(): Promise<ToolResult> {
    const resources = getMcpResources();

    if (resources.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          resources: [],
          message: 'No MCP resources available. Connect to an MCP server to access resources.',
        }),
      };
    }

    const lines = resources.map(r => {
      const desc = r.description ? ` - ${r.description}` : '';
      return `${r.uri}: ${r.name}${desc}`;
    });

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        resources,
        count: resources.length,
      }) + '\n' + lines.join('\n'),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const listMcpResourcesTool = new ListMcpResourcesTool();
