/**
 * KillTaskTool — terminate a background task (sub-agent or shell command) by id.
 * Returns a typed outcome: `killed` / `already_exited` / `not_found`. When an id
 * is not tracked, the message enumerates known task ids so the model can
 * self-correct.
 *
 * Background shell commands live in BashTaskRegistry rather than
 * BackgroundAgentLifecycle, so the id is resolved against both — a promoted or
 * `run_in_background` bash task must be stoppable through the same tool the
 * BashTool result text points at.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getBackgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';
import { getBashTaskRegistry } from '../../session/bash-task-registry.js';
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
  readonly description = `Terminate a running background task by id — either a background shell command (bash/powershell, including one that was auto-promoted from a foreground call) or a background sub-agent. Returns a typed outcome: "killed", "already_exited", or "not_found".`;

  readonly input_schema = {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The background task id to kill.' },
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
      return this.killBashTask(task_id);
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

  /**
   * Stop a background shell command via BashTaskRegistry. `stopTask` refuses
   * anything that is not `running`, so a terminal entry reports
   * `already_exited` rather than a failure.
   */
  private async killBashTask(taskId: string): Promise<ToolResult> {
    const registry = getBashTaskRegistry();
    const task = registry.getTask(taskId);

    if (!task) {
      const known = [
        ...getBackgroundAgentLifecycle().getAll().map((r) => r.taskId),
        ...registry.listTasks().map((t) => t.id),
      ];
      const hint = known.length
        ? `Known task ids: [${known.join(', ')}]`
        : 'No background tasks exist in this session.';
      return toResult(this.name, {
        task_id: taskId,
        outcome: 'not_found',
        message: `Task ${taskId} not found. ${hint}`,
      });
    }

    if (task.status !== 'running') {
      return toResult(this.name, {
        task_id: taskId,
        outcome: 'already_exited',
        message: `Background command had already ${task.status}`,
      });
    }

    const result = await registry.stopTask(taskId);
    return toResult(this.name, {
      task_id: taskId,
      outcome: result.success ? 'killed' : 'already_exited',
      message: result.message,
    });
  }
}

export const killTaskTool = new KillTaskTool();