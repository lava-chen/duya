/**
 * Project tool — the Project Coordinator's read view of durable project continuity.
 *
 * The Coordinator cannot inspect files or run commands. What it can do is read
 * the project's Tasks, their acceptance, and recent activity. Durable records
 * are written by the Host and the user, not by a tool call: acceptance is
 * deliberately not a tool action, because a Run ending is not the user
 * accepting work.
 */

import { randomUUID } from 'node:crypto';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../contracts/tool.js';
import type {
  ProjectToolAction,
  ProjectToolActivity,
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolPort,
  ProjectToolSnapshot,
  ProjectToolTask,
} from './ports.js';

export const PROJECT_TOOL_NAME = 'project';

const MAX_TOOL_OUTPUT = 16_000;
const MAX_TASK_DESCRIPTION = 600;
const MAX_ACTIVITY_PAYLOAD = 400;

const PROJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['get'],
      default: 'get',
      description: 'get: read the project Tasks, their acceptance, and recent activity.',
    },
    afterCursor: {
      type: 'integer',
      minimum: 0,
      description: 'For get: return activity after this cursor. Omit for the most recent page.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'For get: activity page size (default 50).',
    },
  },
  required: [],
};

export class ProjectTool extends BaseTool {
  readonly name = PROJECT_TOOL_NAME;

  readonly description = `Read the durable project continuity for the project this session coordinates.

## When to use
- Read the project's Tasks, their acceptance, and recent activity before planning. Use action "get"; page activity with afterCursor.
- Reconcile Task status against what the Runs actually did.

## Rules
- This tool only reads. Durable project records are written by the Host and the user, so report what you observed instead of promising a write.
- Only the user can accept a Task. A finished Run is evidence, not acceptance.
- Follow the completionNotification returned by session spawn/reply. Query with session get when required; automatic wake is Host-dependent. Avoid repeated unchanged reads.

## Restriction
- The project is resolved from the calling Coordinator session. A session that is not the currently bound Coordinator is refused.`;

  readonly input_schema: Record<string, unknown> = PROJECT_SCHEMA;

  constructor(private readonly port: ProjectToolPort) {
    super();
  }

  toTool(): { name: string; description: string; input_schema: Record<string, unknown> } {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const action = (input.action as ProjectToolAction | undefined) ?? 'get';
    const err = (message: string): ToolResult => ({
      id: randomUUID(),
      name: this.name,
      result: `Error: ${message}`,
      error: true,
    });

    try {
      switch (action) {
        case 'get': {
          const afterCursor = readNonNegativeInteger(input.afterCursor, 'afterCursor');
          if (afterCursor === 'invalid') return err('afterCursor must be an integer >= 0.');
          const limit = readBoundedInteger(input.limit, 'limit', 1, 100);
          if (limit === 'invalid') return err('limit must be an integer between 1 and 100.');
          const result = await this.port.dispatch({
            action,
            payload: {
              ...(afterCursor === undefined ? {} : { afterCursor }),
              ...(limit === undefined ? {} : { limit }),
            },
          });
          if (!result.ok) return err(describeRefusal(result.reason));
          if (result.snapshot === undefined) return err('The Host returned no project snapshot.');
          return {
            id: randomUUID(),
            name: this.name,
            result: bound(formatSnapshot(result.snapshot)),
          };
        }

        default:
          return err(`action "${String(action)}" is not supported.`);
      }
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
}

function describeRefusal(reason: string): string {
  switch (reason) {
    case 'not_project_coordinator':
      return 'This session is not the currently bound Project Coordinator for a project.';
    default:
      return reason;
  }
}

function formatSnapshot(snapshot: ProjectToolSnapshot): string {
  const lines: string[] = [];
  lines.push(`Tasks (${snapshot.tasks.length}):`);
  if (snapshot.tasks.length === 0) lines.push('- (none)');
  for (const task of snapshot.tasks) lines.push(formatTask(task));

  lines.push('');
  lines.push(`Recent activity (${snapshot.activity.length}):`);
  if (snapshot.activity.length === 0) lines.push('- (none)');
  for (const item of snapshot.activity) lines.push(formatActivity(item));
  lines.push('');
  lines.push(`Activity cursor: ${snapshot.nextCursor}${snapshot.activity.length === 0 ? '' : ' (pass afterCursor to read the next page; newer rows have larger cursors)'}`);
  return lines.join('\n');
}

function formatTask(task: ProjectToolTask): string {
  const work = task.workSessionId === null ? '' : ` · work ${task.workSessionId}`;
  const availability = task.recordAvailable ? '' : ' · Task record unavailable';
  const description = truncate(task.description.trim(), MAX_TASK_DESCRIPTION);
  return `- ${task.taskId} [${task.status} · acceptance=${task.acceptanceStatus}${work}${availability}] ${task.subject}` +
    (description === '' ? '' : `\n  ${description}`);
}

function formatActivity(item: ProjectToolActivity): string {
  const refs = [
    item.taskId === null ? '' : `task=${item.taskId}`,
    item.sessionId === null ? '' : `session=${item.sessionId}`,
    item.runId === null ? '' : `run=${item.runId}`,
  ].filter(Boolean).join(' ');
  const payload = Object.keys(item.payload).length === 0
    ? ''
    : ` ${truncate(JSON.stringify(item.payload), MAX_ACTIVITY_PAYLOAD)}`;
  return `- #${item.cursor} ${item.type}${refs === '' ? '' : ` · ${refs}`}${payload} (${formatSource(item.source)})`;
}

function formatSource(source: { type: string; id: string }): string {
  return `${source.type}:${source.id}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function bound(value: string): string {
  return value.length <= MAX_TOOL_OUTPUT
    ? value
    : `${value.slice(0, MAX_TOOL_OUTPUT)}\n[Output truncated; page the activity with afterCursor for more.]`;
}

function readNonNegativeInteger(value: unknown, _name: string): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

function readBoundedInteger(
  value: unknown,
  _name: string,
  min: number,
  max: number,
): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : 'invalid';
}

export type { ProjectToolAction, ProjectToolOperation, ProjectToolPort, ProjectToolPayload };
