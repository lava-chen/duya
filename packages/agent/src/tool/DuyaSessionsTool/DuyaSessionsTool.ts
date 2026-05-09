import { z } from 'zod/v4';
import { DUYA_SESSIONS_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { sessionDb, searchDb } from '../../ipc/db-client.js';

const actionSchema = z.enum(['list', 'search', 'info']);

const inputSchema = z.object({
  action: actionSchema,
  query: z.string().optional(),
  sessionId: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

type SessionsInput = z.infer<typeof inputSchema>;

function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_SESSIONS_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_SESSIONS_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class DuyaSessionsTool implements Tool, ToolExecutor {
  readonly name = DUYA_SESSIONS_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'info'],
        description: 'Action: list all sessions, search by keyword, or get session info',
      },
      query: {
        type: 'string',
        description: 'Search query string (for action: search)',
      },
      sessionId: {
        type: 'string',
        description: 'Session ID (for action: info)',
      },
      limit: {
        type: 'number',
        description: 'Max results (default: 10, max: 50)',
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
        case 'list': {
          const limit = Math.min(data.limit ?? 10, 50);
          const sessions = await sessionDb.list();
          const list = (sessions as Array<Record<string, unknown>> ?? []).slice(0, limit);
          return toolSuccess({
            count: list.length,
            sessions: list.map((s) => ({
              id: s.id,
              title: s.title,
              model: s.model,
              mode: s.mode,
              updatedAt: s.updated_at,
              workingDirectory: s.working_directory,
            })),
          });
        }

        case 'search': {
          if (!data.query || data.query.trim().length === 0) {
            return toolError('query is required for search action');
          }
          const limit = Math.min(data.limit ?? 10, 50);
          const results = await searchDb.sessions(data.query, limit);
          const sessions = results as Array<Record<string, unknown>> ?? [];
          return toolSuccess({
            count: sessions.length,
            query: data.query,
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title,
              model: s.model,
              updatedAt: s.updated_at,
            })),
          });
        }

        case 'info': {
          if (!data.sessionId) {
            return toolError('sessionId is required for info action');
          }
          const session = await sessionDb.get(data.sessionId);
          if (!session) {
            return toolError(`Session not found: ${data.sessionId}`);
          }
          const s = session as Record<string, unknown>;
          return toolSuccess({
            id: s.id,
            title: s.title,
            model: s.model,
            mode: s.mode,
            providerId: s.provider_id,
            workingDirectory: s.working_directory,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
            status: s.status,
          });
        }

        default:
          return toolError(`Unknown action: ${(data as Record<string, unknown>).action}`);
      }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export const duyaSessionsTool = new DuyaSessionsTool();