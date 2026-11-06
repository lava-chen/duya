/**
 * Project tool — the Project Coordinator's view of durable project continuity.
 *
 * The Coordinator cannot inspect files or run commands. What it can do is read
 * the project's recorded state, tasks, decisions, memories and activity, keep
 * the state/next-step current, and record decisions and memory candidates with
 * their provenance. Acceptance is deliberately not a tool action: a Run ending
 * is not the user accepting work, and a model must not promote its own memory
 * candidate to active.
 */

import { randomUUID } from 'node:crypto';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../contracts/tool.js';
import type {
  ProjectToolAction,
  ProjectToolActivity,
  ProjectToolDecision,
  ProjectToolMemory,
  ProjectToolOperation,
  ProjectToolPayload,
  ProjectToolPort,
  ProjectToolSnapshot,
  ProjectToolState,
  ProjectToolTask,
} from './ports.js';

export const PROJECT_TOOL_NAME = 'project';

const MAX_TOOL_OUTPUT = 16_000;
const MAX_TASK_DESCRIPTION = 600;
const MAX_TEXT_ITEM = 800;
const MAX_ACTIVITY_PAYLOAD = 400;

const PROJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'context', 'update_state', 'record_decision', 'record_memory'],
      default: 'get',
      description:
        'get: read state, tasks, decisions, memories and activity. context: build bounded prompt-ready context, optionally for one task. update_state: replace current state and next step with a revision check. record_decision: propose or supersede a durable decision. record_memory: record a memory candidate, or supersede/retire an existing memory.',
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
    taskId: {
      type: 'string',
      description: 'For context: scope the context to one Project Task.',
    },
    maxCharacters: {
      type: 'integer',
      minimum: 200,
      maximum: 16_000,
      description: 'For context: output budget (default 8000).',
    },
    expectedRevision: {
      type: 'integer',
      minimum: 0,
      description:
        'For update_state/record_decision/record_memory: the revision you last read. Use 0 for a new key; read with get and retry on a revision conflict.',
    },
    currentState: {
      type: 'string',
      maxLength: 8000,
      description: 'For update_state: what is true now, in the user’s terms.',
    },
    nextStep: {
      type: 'string',
      maxLength: 2000,
      description: 'For update_state: the next concrete action, or an empty string when nothing is queued.',
    },
    key: {
      type: 'string',
      maxLength: 128,
      description: 'For record_decision/record_memory: stable key for the durable item.',
    },
    content: {
      type: 'string',
      maxLength: 8000,
      description: 'For record_decision/record_memory: the durable statement and the evidence it rests on.',
    },
    status: {
      type: 'string',
      enum: ['proposed', 'accepted', 'superseded', 'candidate', 'active', 'retired'],
      description:
        'For record_decision: proposed or superseded. For record_memory: candidate, superseded or retired. accepted/active require an explicit user action and are refused here.',
    },
  },
  required: [],
};

export class ProjectTool extends BaseTool {
  readonly name = PROJECT_TOOL_NAME;

  readonly description = `Read and maintain durable project continuity for the project this session coordinates.

## When to use
- Read the project before planning: state, tasks and their acceptance, accepted decisions, active memories, and recent activity. Use action "get"; page activity with afterCursor.
- Build bounded context for a task or for yourself with "context".
- Keep the durable "current state" and "next step" current after meaningful progress with "update_state". Read the current revision first; a stale revision is refused.
- Record a decision the user made, or a memory candidate you observed, with "record_decision"/"record_memory". Proposals and candidates carry this session as their source and keep their revision history.

## Rules
- Only the user can accept a decision, activate a memory candidate, or accept a Task. This tool refuses those statuses; record them as proposed/candidate and ask the user.
- A finished Run is evidence, not acceptance. Use "get" to reconcile Task status, then report the observed result.
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

        case 'context': {
          const taskId = readOptionalString(input.taskId);
          const maxCharacters = readBoundedInteger(input.maxCharacters, 'maxCharacters', 200, 16_000);
          if (maxCharacters === 'invalid') return err('maxCharacters must be an integer between 200 and 16000.');
          const result = await this.port.dispatch({
            action,
            payload: {
              ...(taskId === undefined ? {} : { taskId }),
              ...(maxCharacters === undefined ? {} : { maxCharacters }),
            },
          });
          if (!result.ok) return err(describeRefusal(result.reason));
          if (result.context === undefined) return err('The Host returned no project context.');
          return {
            id: randomUUID(),
            name: this.name,
            result: bound(formatContext(result.context)),
          };
        }

        case 'update_state': {
          const expectedRevision = readNonNegativeInteger(input.expectedRevision, 'expectedRevision');
          if (expectedRevision === 'invalid' || expectedRevision === undefined) {
            return err('expectedRevision is required and must be an integer >= 0.');
          }
          const currentState = readOptionalString(input.currentState);
          const nextStep = readOptionalString(input.nextStep);
          if (currentState === undefined || currentState.trim() === '') {
            return err('currentState is required.');
          }
          const result = await this.port.dispatch({
            action,
            payload: {
              expectedRevision,
              currentState,
              nextStep: nextStep ?? '',
            },
          });
          if (!result.ok) return err(describeRefusal(result.reason));
          if (result.state === undefined) return err('The Host returned no updated state.');
          return {
            id: randomUUID(),
            name: this.name,
            result: `Project state updated to revision ${result.state.revision}.\nCurrent state: ${result.state.currentState}\nNext step: ${result.state.nextStep || '(none)'}`,
          };
        }

        case 'record_decision': {
          const expectedRevision = readNonNegativeInteger(input.expectedRevision, 'expectedRevision');
          if (expectedRevision === 'invalid' || expectedRevision === undefined) {
            return err('expectedRevision is required and must be an integer >= 0.');
          }
          const key = readOptionalString(input.key);
          const content = readOptionalString(input.content);
          const status = readOptionalString(input.status) ?? 'proposed';
          if (key === undefined || key.trim() === '') return err('key is required.');
          if (content === undefined || content.trim() === '') return err('content is required.');
          const result = await this.port.dispatch({
            action,
            payload: { expectedRevision, key, content, status },
          });
          if (!result.ok) return err(describeRefusal(result.reason));
          if (result.decision === undefined) return err('The Host returned no recorded decision.');
          return {
            id: randomUUID(),
            name: this.name,
            result: `Decision "${result.decision.key}" recorded as ${result.decision.status} at revision ${result.decision.revision}.` +
              (result.decision.status === 'proposed'
                ? ' It is proposed, not accepted; only the user can accept it.'
                : ''),
          };
        }

        case 'record_memory': {
          const expectedRevision = readNonNegativeInteger(input.expectedRevision, 'expectedRevision');
          if (expectedRevision === 'invalid' || expectedRevision === undefined) {
            return err('expectedRevision is required and must be an integer >= 0.');
          }
          const key = readOptionalString(input.key);
          const content = readOptionalString(input.content);
          const status = readOptionalString(input.status) ?? 'candidate';
          if (key === undefined || key.trim() === '') return err('key is required.');
          if (content === undefined || content.trim() === '') return err('content is required.');
          const result = await this.port.dispatch({
            action,
            payload: { expectedRevision, key, content, status },
          });
          if (!result.ok) return err(describeRefusal(result.reason));
          if (result.memory === undefined) return err('The Host returned no recorded memory.');
          return {
            id: randomUUID(),
            name: this.name,
            result: `Memory "${result.memory.key}" recorded as ${result.memory.status} at revision ${result.memory.revision}.` +
              (result.memory.status === 'candidate'
                ? ' It is a candidate, not active; only the user can activate it.'
                : ''),
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
    case 'user_action_required':
      return 'That status requires an explicit user action. Record a proposal or candidate and ask the user.';
    case 'revision_conflict':
      return 'The durable revision changed. Read the project with action "get" and retry with the current revision.';
    default:
      return reason;
  }
}

function formatSnapshot(snapshot: ProjectToolSnapshot): string {
  const lines: string[] = [];
  const projectName = snapshot.project.name.trim() || snapshot.project.projectId;
  lines.push(`Project: ${projectName} (${snapshot.project.projectId})`);
  if (snapshot.state === null) {
    lines.push('State: (not recorded yet)');
  } else {
    lines.push(`State: revision ${snapshot.state.revision}, updated ${formatTime(snapshot.state.updatedAt)}`);
    lines.push(`Current state: ${snapshot.state.currentState || '(empty)'}`);
    lines.push(`Next step: ${snapshot.state.nextStep || '(none)'}`);
  }

  lines.push('');
  lines.push(`Tasks (${snapshot.tasks.length}):`);
  if (snapshot.tasks.length === 0) lines.push('- (none)');
  for (const task of snapshot.tasks) lines.push(formatTask(task));

  const accepted = snapshot.decisions.filter((item) => item.status === 'accepted');
  const proposed = snapshot.decisions.filter((item) => item.status === 'proposed');
  const superseded = snapshot.decisions.filter((item) => item.status === 'superseded');
  lines.push('');
  lines.push(`Decisions (${snapshot.decisions.length}):`);
  if (snapshot.decisions.length === 0) lines.push('- (none)');
  for (const item of [...accepted, ...proposed, ...superseded]) lines.push(formatDecision(item));

  const activeMemories = snapshot.memories.filter((item) => item.status === 'active');
  const candidates = snapshot.memories.filter((item) => item.status === 'candidate');
  const otherMemories = snapshot.memories.filter(
    (item) => item.status !== 'active' && item.status !== 'candidate',
  );
  lines.push('');
  lines.push(`Memories (${snapshot.memories.length}):`);
  if (snapshot.memories.length === 0) lines.push('- (none)');
  for (const item of [...activeMemories, ...candidates, ...otherMemories]) lines.push(formatMemory(item));

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

function formatDecision(item: ProjectToolDecision): string {
  return `- [${item.status} r${item.revision}] ${item.key} — ${truncate(item.content, MAX_TEXT_ITEM)} (${formatSource(item.source)})`;
}

function formatMemory(item: ProjectToolMemory): string {
  return `- [${item.status} r${item.revision}] ${item.key} — ${truncate(item.content, MAX_TEXT_ITEM)} (${formatSource(item.source)})`;
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

function formatContext(context: ProjectToolPayload['context']): string {
  if (context === undefined) return '';
  const sources = context.sourceRefs.map(formatSource).join(', ');
  return context.text + (sources === '' ? '' : `\n\nSources: ${sources}`);
}

function formatSource(source: { type: string; id: string }): string {
  return `${source.type}:${source.id}`;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  return new Date(value).toISOString();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function bound(value: string): string {
  return value.length <= MAX_TOOL_OUTPUT
    ? value
    : `${value.slice(0, MAX_TOOL_OUTPUT)}\n[Output truncated; use afterCursor or a task-scoped context for more.]`;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
