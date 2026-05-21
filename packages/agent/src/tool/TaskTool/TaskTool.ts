/**
 * TaskTool - Unified task management tool
 * Consolidates: task_create, task_get, task_list, task_update, task_output, task_stop
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getDatabaseTaskStore, type Task, type TaskStatus } from '../../session/task-store.js';
import { getTaskOutputPath, writeTaskOutput, readTaskOutput } from '../../session/task-output.js';

export const TASK_TOOL_NAME = 'task';

export interface TaskInput {
  action: 'create' | 'get' | 'list' | 'update' | 'output' | 'stop';
  // create
  subject?: string;
  description?: string;
  activeForm?: string;
  // get / output / stop
  taskId?: string;
  // update
  status?: TaskStatus;
  owner?: string | null;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export class TaskTool implements Tool, ToolExecutor {
  readonly name = TASK_TOOL_NAME;
  readonly description = `Unified task management tool. Use this tool to manage tasks in the task list.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the task list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Actions

- create: Create a new task with subject and description. All tasks are created with status 'pending'.
- get: Get a specific task by ID to view full details including description and dependencies.
- list: List all tasks (no parameters needed). Prefer working on tasks in ID order when multiple are available.
- update: Update a task's properties. Use status 'completed' to mark done, status 'in_progress' to start work.
- output: Get the output of a completed task (checks metadata.output, then file output).
- stop: Stop an in-progress task and reset it to pending.

## Status Workflow

Status progresses: pending -> in_progress -> completed

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if: tests are failing, implementation is partial, you encountered unresolved errors, or you couldn't find necessary files or dependencies

## Task Dependencies

Use the update action with blocks/blockedBy to set up dependencies:
- blocks: Task IDs this task blocks (this task must complete before those can start)
- blockedBy: Task IDs that must complete before this task can start`;

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'get', 'list', 'update', 'output', 'stop'],
        description: 'The action to perform: create, get, list, update, output, stop',
      },
      // create params
      subject: {
        type: 'string',
        description: 'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")',
      },
      description: {
        type: 'string',
        description: 'What needs to be done',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown in spinner when in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.',
      },
      // common params
      taskId: {
        type: 'string',
        description: 'Task ID (required for get, update, output, stop)',
      },
      // update params
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'Updated task status. Use "in_progress" when starting, "completed" when done.',
      },
      owner: {
        type: 'string',
        description: 'Agent ID assigned to this task. Set to null to unassign.',
      },
      blocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs this task blocks (tasks that cannot start until this one completes)',
      },
      blockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task can start',
      },
      metadata: {
        type: 'object',
        description: 'JSON metadata. Include "output" with a summary when completing a task.',
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
    context?: ToolUseContext
  ): Promise<ToolResult> {
    const action = input.action as string;
    const params = input as unknown as Partial<TaskInput>;

    const sessionId = context?.options?.sessionId;
    if (!sessionId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'No session context available' }),
        error: true,
      };
    }

    const store = getDatabaseTaskStore(sessionId);

    switch (action) {
      case 'create':
        return this.createTask(store, params);
      case 'get':
        return this.getTask(store, params);
      case 'list':
        return this.listTasks(store);
      case 'update':
        return this.updateTask(store, params);
      case 'output':
        return this.getOutput(store, params);
      case 'stop':
        return this.stopTask(store, params);
      default:
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({ error: `Unknown action: ${action}` }),
          error: true,
        };
    }
  }

  private async createTask(store: ReturnType<typeof getDatabaseTaskStore>, params: Partial<TaskInput>): Promise<ToolResult> {
    const { subject, description, activeForm } = params;

    if (!subject || !description) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'subject and description are required for create' }),
        error: true,
      };
    }

    const task = await store.createTask({
      subject,
      description,
      activeForm,
      status: 'pending',
      blocks: [],
      blockedBy: [],
    });

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ task: { id: task.id, subject: task.subject } }),
    };
  }

  private async getTask(store: ReturnType<typeof getDatabaseTaskStore>, params: Partial<TaskInput>): Promise<ToolResult> {
    const { taskId } = params;

    if (!taskId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'taskId is required for get' }),
        error: true,
      };
    }

    const task = await store.getTask(taskId);
    if (!task) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Task ${taskId} not found` }),
        error: true,
      };
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ task }),
    };
  }

  private async listTasks(store: ReturnType<typeof getDatabaseTaskStore>): Promise<ToolResult> {
    const allTasks = await store.listTasks();

    const tasks = allTasks
      .filter(t => !t.id.startsWith('_'))
      .map(task => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        owner: task.owner,
        blockedBy: task.blockedBy,
      }));

    if (tasks.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: 'No tasks found',
      };
    }

    const lines = tasks.map(task => {
      const blocked = task.blockedBy.length > 0
        ? ` [blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}]`
        : '';
      const ownerInfo = task.owner ? ` (owner: ${task.owner})` : '';
      return `#${task.id} [${task.status}]${ownerInfo} ${task.subject}${blocked}`;
    });

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: lines.join('\n'),
    };
  }

  private async updateTask(store: ReturnType<typeof getDatabaseTaskStore>, params: Partial<TaskInput>): Promise<ToolResult> {
    const { taskId, status, owner, blocks, blockedBy, metadata, subject, description, activeForm } = params;

    if (!taskId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'taskId is required for update' }),
        error: true,
      };
    }

    const existingTask = await store.getTask(taskId);
    if (!existingTask) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Task ${taskId} not found` }),
        error: true,
      };
    }

    if (status && !['pending', 'in_progress', 'completed'].includes(status)) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Invalid status: ${status}` }),
        error: true,
      };
    }

    const updates: Partial<Task> = {};
    if (subject !== undefined) updates.subject = subject;
    if (description !== undefined) updates.description = description;
    if (activeForm !== undefined) updates.activeForm = activeForm;
    if (status !== undefined) updates.status = status;
    if (owner !== undefined) updates.owner = owner === null ? undefined : owner;
    if (blocks !== undefined) updates.blocks = blocks;
    if (blockedBy !== undefined) updates.blockedBy = blockedBy;
    if (metadata !== undefined) updates.metadata = metadata;

    const updatedTask = await store.updateTask(taskId, updates);

    const result: Record<string, unknown> = { task: updatedTask };

    if (status === 'completed' && updatedTask) {
      const output = (metadata?.output as string) || (updatedTask.metadata?.output as string);
      if (output) {
        result.notification = `Task #${taskId} "${updatedTask.subject}" completed.`;
      }
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(result),
    };
  }

  private async getOutput(store: ReturnType<typeof getDatabaseTaskStore>, params: Partial<TaskInput>): Promise<ToolResult> {
    const { taskId } = params;

    if (!taskId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'taskId is required for output' }),
        error: true,
      };
    }

    const task = await store.getTask(taskId);
    if (!task) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Task ${taskId} not found` }),
        error: true,
      };
    }

    if (task.status !== 'completed') {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          taskId,
          status: task.status,
          output: '',
          message: 'Task is not completed yet',
        }),
      };
    }

    const metadataOutput = task.metadata?.output as string | undefined;
    const fileOutput = readTaskOutput(taskId);
    const output = metadataOutput || fileOutput || `Task "${task.subject}" completed successfully.`;
    const source = metadataOutput ? 'metadata' : (fileOutput ? 'file' : 'fallback');

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ taskId, status: task.status, output, source }),
    };
  }

  private async stopTask(store: ReturnType<typeof getDatabaseTaskStore>, params: Partial<TaskInput>): Promise<ToolResult> {
    const { taskId } = params;

    if (!taskId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'taskId is required for stop' }),
        error: true,
      };
    }

    const task = await store.getTask(taskId);
    if (!task) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Task ${taskId} not found` }),
        error: true,
      };
    }

    if (task.status !== 'in_progress') {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Task ${taskId} is not in_progress (current status: ${task.status})`,
        }),
        error: true,
      };
    }

    await store.updateTask(taskId, { status: 'pending', owner: undefined });

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        taskId,
        status: 'stopped',
        message: `Task ${taskId} has been stopped`,
      }),
    };
  }

  getPrompt(): string {
    return `Use this tool to manage tasks in the task list. Use the "action" parameter to specify what you want to do.

## create - Create a new task
- subject (required): Brief, actionable title in imperative form
- description (required): What needs to be done
- activeForm (optional): Present continuous form for spinner
- All tasks are created with status 'pending'

## get - Get a task by ID
- taskId (required): The ID of the task to retrieve
- Returns full task details: subject, description, status, blocks, blockedBy

## list - List all tasks
- No parameters needed
- Returns a summary of each task: id, subject, status, owner, blockedBy
- Check Task tool with action "list" first to avoid creating duplicate tasks
- Prefer working on tasks in ID order (lowest ID first) when multiple are available, as earlier tasks often set up context for later ones

## update - Update a task
- taskId (required): The ID of the task to update
- status: 'pending' -> 'in_progress' -> 'completed'
- subject: Change the task title (imperative form, e.g., "Run tests")
- description: Change the task description
- activeForm: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- owner: Change the task owner (agent name). Set to null to unassign.
- blocks: Array of task IDs this task blocks
- blockedBy: Array of task IDs that must complete before this task
- metadata: JSON metadata. Include "output" with a summary when completing.
- After completing a task, call Task tool with action "list" to check for newly unblocked work or claim the next available task

## output - Get output of a completed task
- taskId (required): The ID of the completed task
- Checks metadata.output first, then file output, then falls back to a success message

## stop - Stop an in-progress task
- taskId (required): The ID of the task to stop
- Resets the task to 'pending' and clears the owner

## Examples

Create a task:
{"action": "create", "subject": "Fix auth bug", "description": "Fix login redirect loop in /api/login"}

Start work on a task:
{"action": "update", "taskId": "1", "status": "in_progress"}

Complete a task with output:
{"action": "update", "taskId": "1", "status": "completed", "metadata": {"output": "Fixed by updating JWT validation logic"}}

List all tasks:
{"action": "list"}

Set up task dependency:
{"action": "update", "taskId": "2", "blockedBy": ["1"]}`;
  }
}

// Export singleton instance
export const taskTool = new TaskTool();