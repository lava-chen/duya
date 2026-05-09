import { z } from 'zod/v4';
import { DUYA_HEALTH_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { configDb } from '../../ipc/db-client.js';

const actionSchema = z.enum(['test_provider', 'gateway_status']);

const inputSchema = z.object({
  action: actionSchema,
  providerId: z.string().optional(),
});

function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_HEALTH_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_HEALTH_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class DuyaHealthTool implements Tool, ToolExecutor {
  readonly name = DUYA_HEALTH_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['test_provider', 'gateway_status'],
        description: 'Health check action',
      },
      providerId: {
        type: 'string',
        description: 'Provider ID to test (defaults to active provider)',
      },
    },
    required: ['action'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    } as Tool;
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(`Invalid input: ${parsed.error.message}`);
    }

    const data = parsed.data;

    try {
      switch (data.action) {
        case 'test_provider': {
          const result = await configDb.healthTestProvider({
            providerId: data.providerId,
          });
          return toolSuccess(result);
        }

        case 'gateway_status': {
          const result = await configDb.healthGatewayStatus();
          return toolSuccess(result);
        }

        default:
          return toolError(`Unknown action: ${(data as Record<string, unknown>).action}`);
      }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export const duyaHealthTool = new DuyaHealthTool();