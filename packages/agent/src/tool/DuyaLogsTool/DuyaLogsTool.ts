import { z } from 'zod/v4';
import { DUYA_LOGS_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { configDb } from '../../ipc/db-client.js';

const actionSchema = z.enum(['tail', 'errors']);

const inputSchema = z.object({
  action: actionSchema,
  lines: z.number().int().positive().max(100).optional(),
});

function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_LOGS_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_LOGS_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class DuyaLogsTool implements Tool, ToolExecutor {
  readonly name = DUYA_LOGS_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['tail', 'errors'],
        description: 'Action: tail for recent logs, errors for error entries only',
      },
      lines: {
        type: 'number',
        description: 'Number of lines/entries (default: 50, max: 100)',
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
        case 'tail': {
          const result = await configDb.logsTail(data.lines ?? 50);
          return toolSuccess(result);
        }

        case 'errors': {
          const result = await configDb.logsErrors(data.lines ?? 50);
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

export const duyaLogsTool = new DuyaLogsTool();