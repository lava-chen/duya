/**
 * KillTaskTool — terminate a background sub-agent task (aligned to Grok's
 * `kill_task`). Returns a typed outcome: `killed` / `already_exited` /
 * `not_found`. When an id is not tracked, the message enumerates known
 * task ids so the model can self-correct.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getBackgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';
import { isTerminalStatus } from './GetTaskOutputTool.js';

export const KILL_TASK_TOOL_NAME = 'kill_task';

function toResult(name: string, payload: unknown, error?: boolean): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

export class KillTaskTool implements Tool, ToolExecutor {
  readonly name = KILL_TASK_TOOL_NAME;
  readonly description = `Terminate a running background sub-agent task by id. Returns a typed outcome: "killed", "already_exited", or "not_found".`;

  readonly input_schema = {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The subagent task id to kill.' },
    },
    required: ['task_id'],
  };

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { task_id } = input as { task_id?: unknown };
    if (typeof task_id !== 'string' || task_id.length === 0) {
      return toResult(this.name, 'task_id must be a non-empty string.', true);
    }

    const lifecycle = getBackgroundAgentLifecycle();
    const rec = lifecycle.getSnapshot(task_id);
    if (!rec) {
      const known = lifecycle.getAll().map((r) => r.taskId);
      const hint = known.length
        ? `Known task ids: [${known.join(', ')}]`
        : 'No background subagents exist in this session.';
      return toResult(this.name, {
        task_id,
        outcome: 'not_found',
        message: `Task or subagent ${task_id} not found. ${hint}`,
      });
    }
    if (isTerminalStatus(rec.status)) {
      return toResult(this.name, {
        task_id,
        outcome: 'already_exited',
        message: `Task had already ${rec.status}`,
      });
    }

    lifecycle.kill(task_id, 'user_kill');
    return toResult(this.name, {
      task_id,
      outcome: 'killed',
      message: 'Task was terminated successfully',
    });
  }
}

export const killTaskTool = new KillTaskTool();