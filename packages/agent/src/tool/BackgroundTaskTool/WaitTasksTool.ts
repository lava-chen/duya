/**
 * WaitTasksTool — thin alias over GetTaskOutputTool's wait-all path
 * (aligned to Grok's `wait_tasks`). Retained for prompts that still
 * issue `wait_tasks` / `wait_commands_or_subagents`; it delegates to
 * GetTaskOutputTool rather than re-implementing the wait loop.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import {
  GetTaskOutputTool,
  DEFAULT_WAIT_TIMEOUT_MS,
} from './GetTaskOutputTool.js';

export const WAIT_TASKS_TOOL_NAME = 'wait_tasks';

export class WaitTasksTool implements Tool, ToolExecutor {
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

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, wd?: string, context?: ToolUseContext): Promise<ToolResult> {
    const { task_ids, timeout_ms } = input as { task_ids?: unknown; timeout_ms?: unknown };
    const effectiveTimeout = typeof timeout_ms === 'number' && timeout_ms > 0
      ? timeout_ms
      : DEFAULT_WAIT_TIMEOUT_MS;
    return new GetTaskOutputTool().execute({ task_ids, timeout_ms: effectiveTimeout }, wd, context);
  }
}

export const waitTasksTool = new WaitTasksTool();