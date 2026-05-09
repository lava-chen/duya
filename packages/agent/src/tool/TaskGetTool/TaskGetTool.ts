/**
 * TaskGetTool - Get a task by ID from the task list
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { TASK_GET_TOOL_NAME } from './constants.js';
import { DESCRIPTION, PROMPT } from './prompt.js';
import { getDatabaseTaskStore, type Task, type TaskStatus, type TaskStore } from '../../session/task-store.js';

// Re-export types for backward compatibility
export type { Task, TaskStatus, TaskStore };

export interface TaskGetInput {
  taskId: string;
}

export class TaskGetTool implements Tool, ToolExecutor {
  readonly name = TASK_GET_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to retrieve',
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
    const { taskId } = input as unknown as TaskGetInput;

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
    const task = store.getTask(taskId);

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

  getPrompt(): string {
    return PROMPT;
  }
}

// Export for use by other modules
export const taskGetTool = new TaskGetTool();
