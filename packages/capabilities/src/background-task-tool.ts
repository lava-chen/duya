import { BaseTool } from './BaseTool.js';
import type { ToolResult } from './contracts/tool.js';
import { GET_TASK_OUTPUT_TOOL_NAME } from '@duya/agent-protocol/task-tool-names';

export { GET_TASK_OUTPUT_TOOL_NAME };

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'not_found';

export interface BackgroundAgentTaskSnapshot {
  taskId: string;
  status: Exclude<BackgroundTaskStatus, 'not_found'>;
  error?: string;
  result?: {
    content: readonly { type: string; text?: string }[];
  };
}

export type BackgroundShellTaskStatus =
  | 'running'
  | 'completed'
  | 'killed'
  | 'disk_limit'
  | 'error'
  | 'lost';

export interface BackgroundShellTaskSnapshot {
  id: string;
  pid: number;
  status: BackgroundShellTaskStatus;
  exitCode?: number;
  error?: string;
}

export type BackgroundAgentKillOutcome = 'killed' | 'not_found' | 'already_terminal';

/** Host-owned lifecycle and filesystem effects required by these tools. */
export interface BackgroundTaskPort {
  getAgentTask(taskId: string): BackgroundAgentTaskSnapshot | undefined;
  listAgentTasks(): readonly { taskId: string }[];
  tryKillAgentTask(taskId: string): BackgroundAgentKillOutcome;
  getShellTask(taskId: string): BackgroundShellTaskSnapshot | undefined;
  listShellTasks(): readonly { id: string }[];
  readShellOutput(taskId: string, maxBytes: number): { text: string } | null;
  stopShellTask(taskId: string): Promise<{ success: boolean; message: string }>;
}

export const KILL_TASK_TOOL_NAME = 'kill_task';
export const WAIT_TASKS_TOOL_NAME = 'wait_tasks';
export const MAX_MULTI_TASK_IDS = 10;
export const DEFAULT_TOOL_OUTPUT_BYTES = 40_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

export function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

export function mapShellTaskStatus(status: BackgroundShellTaskStatus): BackgroundTaskStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'killed':
      return 'killed';
    default:
      return 'failed';
  }
}

export function formatShellTaskOutput(
  task: BackgroundShellTaskSnapshot,
  readOutput: BackgroundTaskPort['readShellOutput'],
  maxBytes: number = DEFAULT_TOOL_OUTPUT_BYTES,
): string {
  const tail = readOutput(task.id, maxBytes)?.text.trim() ?? '';
  if (mapShellTaskStatus(task.status) === 'running') {
    const lead = `running (pid ${task.pid}). You will be notified automatically when this task completes — do not poll for it.`;
    return tail ? `${lead}\n\n${tail}` : lead;
  }

  const header = task.exitCode !== undefined ? `[exit ${task.exitCode}]` : '';
  return [task.error, header, tail].filter(Boolean).join('\n') || '(no output)';
}

function toResult(name: string, payload: unknown, error = false): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

export function formatAgentTaskOutput(task: BackgroundAgentTaskSnapshot): string {
  if (task.status === 'completed' && task.result) {
    let output = task.result.content
      .map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
      .join('\n');
    if (output.length > DEFAULT_TOOL_OUTPUT_BYTES) {
      output = `${output.slice(0, DEFAULT_TOOL_OUTPUT_BYTES)}\n...<truncated>`;
    }
    return output;
  }
  return task.error ?? '';
}

interface TaskOutputResult {
  task_id: string;
  status: BackgroundTaskStatus;
  output: string;
}

export class GetTaskOutputTool extends BaseTool {
  readonly name = GET_TASK_OUTPUT_TOOL_NAME;
  readonly description = `Fetch the current output or status snapshot of one or more background tasks (sub-agents and background shell commands).

- Completed tasks return their output; still-running tasks report their status (and, for shell commands, the live output tail).
- Non-blocking: this tool NEVER waits for a task to finish. When a background task completes you will be notified automatically with a <task-notification> containing its result — do not poll or wait for it, do not call this tool repeatedly. Use this only to take a quick look, or to fetch the full output of a task that has already completed.
- For a running task that looks stuck or looping, use kill_task to terminate it.`;

  readonly input_schema = {
    type: 'object',
    properties: {
      task_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more subagent or background shell task ids.',
      },
    },
    required: ['task_ids'],
  };

  constructor(private readonly port: BackgroundTaskPort) {
    super();
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { task_ids: taskIds } = input as { task_ids?: unknown };
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id) => typeof id === 'string')) {
      return toResult(this.name, 'task_ids must be a non-empty array of strings.', true);
    }
    if (taskIds.length > MAX_MULTI_TASK_IDS) {
      return toResult(this.name, `task_ids exceeds maximum of ${MAX_MULTI_TASK_IDS} entries.`, true);
    }

    const results: TaskOutputResult[] = taskIds.map((id) => {
      const agentTask = this.port.getAgentTask(id);
      if (agentTask) {
        if (!isTerminalStatus(agentTask.status)) {
          return {
            task_id: id,
            status: agentTask.status,
            output: `${agentTask.status}. You will be notified automatically when this task completes — do not poll for it.`,
          };
        }
        return { task_id: id, status: agentTask.status, output: formatAgentTaskOutput(agentTask) };
      }

      const shellTask = this.port.getShellTask(id);
      if (!shellTask) return { task_id: id, status: 'not_found', output: '' };
      return {
        task_id: id,
        status: mapShellTaskStatus(shellTask.status),
        output: formatShellTaskOutput(shellTask, this.port.readShellOutput),
      };
    });

    const terminal = results.filter((result) => isTerminalStatus(result.status)).length;
    return toResult(this.name, {
      mode: 'snapshot',
      results,
      summary: `${terminal}/${results.length} tasks in terminal state`,
    });
  }
}

export class KillTaskTool extends BaseTool {
  readonly name = KILL_TASK_TOOL_NAME;
  readonly description = `Terminate a running background task by id — either a background shell command (bash/powershell, including one that was auto-promoted from a foreground call) or a background sub-agent. Returns a typed outcome: "killed", "already_exited", or "not_found".`;

  readonly input_schema = {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The background task id to kill.' },
    },
    required: ['task_id'],
  };

  constructor(private readonly port: BackgroundTaskPort) {
    super();
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { task_id: taskId } = input as { task_id?: unknown };
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return toResult(this.name, 'task_id must be a non-empty string.', true);
    }

    const agentTask = this.port.getAgentTask(taskId);
    if (agentTask) {
      if (isTerminalStatus(agentTask.status)) {
        return toResult(this.name, {
          task_id: taskId,
          outcome: 'already_exited',
          message: `Task had already ${agentTask.status}`,
        });
      }

      const outcome = this.port.tryKillAgentTask(taskId);
      if (outcome === 'killed') {
        return toResult(this.name, {
          task_id: taskId,
          outcome: 'killed',
          message: 'Task was terminated successfully',
        });
      }
      if (outcome === 'already_terminal') {
        const status = this.port.getAgentTask(taskId)?.status ?? agentTask.status;
        return toResult(this.name, {
          task_id: taskId,
          outcome: 'already_exited',
          message: `Task had already ${status}`,
        });
      }
    }

    const shellTask = this.port.getShellTask(taskId);
    if (!shellTask) {
      const known = [
        ...this.port.listAgentTasks().map((task) => task.taskId),
        ...this.port.listShellTasks().map((task) => task.id),
      ];
      const hint = known.length
        ? `Known task ids: [${known.join(', ')}]`
        : 'No background tasks exist in this session.';
      return toResult(this.name, {
        task_id: taskId,
        outcome: 'not_found',
        message: `Task ${taskId} not found. ${hint}`,
      });
    }

    if (shellTask.status !== 'running') {
      return toResult(this.name, {
        task_id: taskId,
        outcome: 'already_exited',
        message: `Background command had already ${shellTask.status}`,
      });
    }

    const result = await this.port.stopShellTask(taskId);
    return toResult(this.name, {
      task_id: taskId,
      outcome: result.success ? 'killed' : 'already_exited',
      message: result.message,
    });
  }
}

/** Legacy prompt alias. Despite its historic description this is non-blocking. */
export class WaitTasksTool extends BaseTool {
  readonly name = WAIT_TASKS_TOOL_NAME;
  readonly description = `Block until one or more background sub-agent tasks finish, then return their output. Delegates to get_task_output with a default timeout.`;

  readonly input_schema = {
    type: 'object',
    properties: {
      task_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more subagent task ids.',
      },
      timeout_ms: {
        type: 'integer',
        description: `Max ms to wait. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`,
      },
    },
    required: ['task_ids'],
  };

  constructor(private readonly port: BackgroundTaskPort) {
    super();
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { task_ids: taskIds, timeout_ms: timeoutMs } = input as { task_ids?: unknown; timeout_ms?: unknown };
    const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_WAIT_TIMEOUT_MS;
    return new GetTaskOutputTool(this.port).execute({ task_ids: taskIds, timeout_ms: effectiveTimeout });
  }
}
