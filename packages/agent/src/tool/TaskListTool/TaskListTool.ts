/**
 * TaskListTool - List all tasks in the task list
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { TASK_LIST_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { getDatabaseTaskStore, type Task } from '../../session/task-store.js';

export class TaskListTool implements Tool, ToolExecutor {
  readonly name = TASK_LIST_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    _input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult> {
    // Get sessionId from context
    const sessionId = context?.options?.sessionId;
    if (!sessionId) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: 'No session context available',
      };
    }

    const store = getDatabaseTaskStore(sessionId);
    const allTasks = await store.listTasks();

    // Filter out internal tasks and build resolved task IDs
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

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const taskListTool = new TaskListTool();
