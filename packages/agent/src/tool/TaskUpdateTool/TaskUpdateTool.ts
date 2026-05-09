/**
 * TaskUpdateTool - Update a task in the task list
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { TASK_UPDATE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import type { TaskStatus } from '../TaskGetTool/TaskGetTool.js';
import { getDatabaseTaskStore } from '../../session/task-store.js';
import type { TaskStore, Task } from '../../session/task-store.js';
import { formatTaskNotification } from '../../session/task-output.js';

export interface TaskUpdateInput {
  taskId: string;
  subject?: string;
  description?: string;
  status?: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export class TaskUpdateTool implements Tool, ToolExecutor {
  readonly name = TASK_UPDATE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to update',
      },
      subject: {
        type: 'string',
        description: 'Updated task subject/title',
      },
      description: {
        type: 'string',
        description: 'Updated task description',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'Updated task status',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form for spinner',
      },
      owner: {
        type: 'string',
        description: 'The agent ID assigned to this task. Set to null to unassign.',
      },
      blocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs this task blocks',
      },
      blockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task',
      },
      metadata: {
        type: 'object',
        description: 'JSON metadata. Include "output" with a summary when completing a task.',
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
    const { taskId, ...updates } = input as unknown as TaskUpdateInput;

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
    const existingTask = store.getTask(taskId);

    if (!existingTask) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Task ${taskId} not found` }),
        error: true,
      };
    }

    // Validate status if provided
    if (updates.status && !['pending', 'in_progress', 'completed'].includes(updates.status)) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Invalid status: ${updates.status}. Must be one of: pending, in_progress, completed`,
        }),
        error: true,
      };
    }

    const updatedTask = store.updateTask(taskId, updates);

    const result: Record<string, unknown> = { task: updatedTask };

    if (updates.status === 'completed') {
      const task = await updatedTask;
      if (task) {
        const notification = formatTaskNotification({
          taskId: task.id,
          subject: task.subject,
          status: task.status,
          owner: task.owner,
          output: (updates.metadata?.output as string) || (task.metadata?.output as string),
        });
        result.notification = notification;
      }
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(result),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const taskUpdateTool = new TaskUpdateTool();
