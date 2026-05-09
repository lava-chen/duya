/**
 * ReadMcpResourceTool - Read an MCP resource by URI
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { READ_MCP_RESOURCE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { getMcpResources } from '../ListMcpResourcesTool/ListMcpResourcesTool.js';

export interface ReadMcpResourceInput {
  uri: string;
}

export class ReadMcpResourceTool implements Tool, ToolExecutor {
  readonly name = READ_MCP_RESOURCE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      uri: {
        type: 'string',
        description: 'The URI of the resource to read',
      },
    },
    required: ['uri'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { uri } = input as unknown as ReadMcpResourceInput;

    if (!uri) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'uri is required' }),
        error: true,
      };
    }

    const resources = getMcpResources();
    const resource = resources.find(r => r.uri === uri);

    if (!resource) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Resource not found: ${uri}`,
          availableResources: resources.map(r => r.uri),
        }),
        error: true,
      };
    }

    // In a full implementation, this would fetch the resource content
    // For now, return placeholder content
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        uri,
        name: resource.name,
        content: `[Resource content would be fetched here: ${uri}]`,
        mimeType: resource.mimeType || 'text/plain',
      }),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const readMcpResourceTool = new ReadMcpResourceTool();
