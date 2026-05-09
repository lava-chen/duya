/**
 * TaskCreateTool - Create a new task in the task list
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { TASK_CREATE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { getDatabaseTaskStore } from '../../session/task-store.js';

export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
}

export class TaskCreateTool implements Tool, ToolExecutor {
  readonly name = TASK_CREATE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'A brief title for the task',
      },
      description: {
        type: 'string',
        description: 'What needs to be done',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      },
    },
    required: ['subject', 'description'],
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
    const { subject, description, activeForm } = input as unknown as TaskCreateInput;

    if (!subject || !description) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'subject and description are required' }),
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
      result: JSON.stringify({
        task: {
          id: task.id,
          subject: task.subject,
        },
      }),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const taskCreateTool = new TaskCreateTool();
