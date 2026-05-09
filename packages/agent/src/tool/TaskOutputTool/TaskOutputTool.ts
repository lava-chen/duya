/**
 * TaskOutputTool - Get the output of a completed task
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { TASK_OUTPUT_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { getDatabaseTaskStore } from '../../session/task-store.js';
import { getTaskOutputPath, writeTaskOutput, readTaskOutput } from '../../session/task-output.js';

export interface TaskOutputInput {
  taskId: string;
}

export class TaskOutputTool implements Tool, ToolExecutor {
  readonly name = TASK_OUTPUT_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to get output for',
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
    const { taskId } = input as unknown as TaskOutputInput;

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
      result: JSON.stringify({
        taskId,
        status: task.status,
        output,
        source,
      }),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const taskOutputTool = new TaskOutputTool();
