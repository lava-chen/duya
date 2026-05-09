/**
 * TaskStopTool - Stop an in-progress task
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { TASK_STOP_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { getDatabaseTaskStore } from '../../session/task-store.js';

export interface TaskStopInput {
  taskId: string;
}

export class TaskStopTool implements Tool, ToolExecutor {
  readonly name = TASK_STOP_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to stop',
      },
    },
    required: ['taskId'],
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
    const { taskId } = input as unknown as TaskStopInput;

    if (!taskId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'taskId is required' }),
        error: true,
      };
    }

    // Get sessionId from context
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

    // Update task status back to pending and clear owner
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
    return getPrompt();
  }
}

// Export for use by other modules
export const taskStopTool = new TaskStopTool();
