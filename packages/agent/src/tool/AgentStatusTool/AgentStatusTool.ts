import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { backgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';
import type { TaskRecord, TaskStatus } from '../../lifecycle/TaskState.js';

export const AGENT_STATUS_TOOL_NAME = 'AgentStatus';

type AgentStatusAction = 'list' | 'get' | 'wait';

interface AgentStatusInput {
  action: AgentStatusAction;
  agent_id?: string;
  agent_ids?: string[];
  timeout_ms?: number;
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'killed']);

function isTerminal(task: TaskRecord): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

function resultText(task: TaskRecord): string | undefined {
  if (!task.result) return undefined;
  const text = task.result.content
    .map((block) => block.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function serializeTask(task: TaskRecord, includeOutput: boolean): Record<string, unknown> {
  return {
    agentId: task.taskId,
    sessionId: task.subAgentSessionId,
    parentSessionId: task.parentSessionId,
    agentType: task.agentType,
    agentName: task.agentName,
    description: task.description,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    durationMs: task.completedAt ? task.completedAt - task.startedAt : Date.now() - task.startedAt,
    progress: {
      toolUseCount: task.progress.toolUseCount,
      lastActivity: task.progress.lastActivity,
      recentActivities: task.progress.recentActivities,
    },
    ...(task.error ? { error: task.error } : {}),
    ...(includeOutput ? { output: resultText(task) } : {}),
  };
}

async function waitForTasks(
  tasks: TaskRecord[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (tasks.every(isTerminal)) return true;

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const unsubscribers: Array<() => void> = [];

    const cleanup = () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(completed);
    };
    const check = () => {
      if (tasks.every((task) => {
        const current = backgroundAgentLifecycle.getSnapshot(task.taskId);
        return current ? isTerminal(current) : true;
      })) {
        finish(true);
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('AgentStatus wait interrupted'));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    for (const task of tasks) {
      if (!isTerminal(task)) {
        unsubscribers.push(backgroundAgentLifecycle.subscribe(task.taskId, check));
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

export class AgentStatusTool implements Tool, ToolExecutor {
  readonly name = AGENT_STATUS_TOOL_NAME;
  readonly description = `Inspect or wait for background sub-agents launched by the Agent tool.

Use this tool only for runtime agent progress. It is separate from the task-list tool.

- list: List background agents for the current session.
- get: Get one agent's current status using agent_id.
- wait: Wait for agent_ids, or all current-session agents when omitted, to reach a terminal state.

Normally, wait for automatic task-notifications instead of polling. Never inspect transcript directories or use shell sleep loops.`;

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'wait'],
      },
      agent_id: {
        type: 'string',
        description: 'Agent ID returned by the Agent tool. Required for get.',
      },
      agent_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to wait for. Omit to wait for all agents in the current session.',
      },
      timeout_ms: {
        type: 'number',
        minimum: 0,
        maximum: 600000,
        default: 300000,
      },
    },
    required: ['action'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const params = input as unknown as AgentStatusInput;
    const sessionId = context?.options.sessionId;
    const sessionTasks = backgroundAgentLifecycle.getAll()
      .filter((task) => !sessionId || task.parentSessionId === sessionId);

    if (params.action === 'list') {
      return this.success({
        agents: sessionTasks.map((task) => serializeTask(task, false)),
        running: sessionTasks.filter((task) => !isTerminal(task)).length,
      });
    }

    if (params.action === 'get') {
      if (!params.agent_id) return this.failure('agent_id is required for get');
      const task = backgroundAgentLifecycle.getSnapshot(params.agent_id);
      if (!task || (sessionId && task.parentSessionId !== sessionId)) {
        return this.failure(`Background agent ${params.agent_id} not found`);
      }
      return this.success({ agent: serializeTask(task, isTerminal(task)) });
    }

    if (params.action === 'wait') {
      const requestedIds = params.agent_ids?.filter(Boolean);
      const tasks = requestedIds?.length
        ? requestedIds
            .map((id) => backgroundAgentLifecycle.getSnapshot(id))
            .filter((task): task is TaskRecord => Boolean(task && (!sessionId || task.parentSessionId === sessionId)))
        : sessionTasks;

      if (requestedIds?.length && tasks.length !== new Set(requestedIds).size) {
        return this.failure('One or more background agent IDs were not found in the current session');
      }

      const timeoutMs = Math.min(600000, Math.max(0, params.timeout_ms ?? 300000));
      const completed = await waitForTasks(tasks, timeoutMs, context?.abortController.signal);
      const current = tasks.map((task) => backgroundAgentLifecycle.getSnapshot(task.taskId) ?? task);
      return this.success({
        completed,
        timedOut: !completed,
        agents: current.map((task) => serializeTask(task, isTerminal(task))),
      });
    }

    return this.failure(`Unknown action: ${String(params.action)}`);
  }

  private success(result: Record<string, unknown>): ToolResult {
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(result),
    };
  }

  private failure(message: string): ToolResult {
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ error: message }),
      error: true,
    };
  }
}

export const agentStatusTool = new AgentStatusTool();
