import { z } from 'zod/v4';
import { DUYA_RESTART_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { configDb } from '../../ipc/db-client.js';

const inputSchema = z.object({
  reason: z.string().optional(),
  resume: z.boolean().optional(),
});

type RestartInput = z.infer<typeof inputSchema>;

function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_RESTART_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_RESTART_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class DuyaRestartTool implements Tool, ToolExecutor {
  readonly name = DUYA_RESTART_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason for restarting (e.g., "Switching to OpenAI provider")',
      },
      resume: {
        type: 'boolean',
        description: 'Whether to send a completion message after restart (default: true)',
      },
    },
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
      const sessionId = process.env.SESSION_ID || process.env.DUYA_SESSION_ID || 'unknown';

      const result = await configDb.restart({
        sessionId,
        reason: data.reason || 'Agent requested restart',
        resume: data.resume ?? true,
      });

      return toolSuccess({
        ok: true,
        message: 'Agent restart has been requested. The session will resume with a new agent process.',
        reason: data.reason,
        raw: result,
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export const duyaRestartTool = new DuyaRestartTool();