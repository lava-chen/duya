/**
 * GetTaskOutputTool — non-blocking status/output snapshot for background
 * sub-agent tasks.
 *
 * Explicitly NOT a wait/poll tool: background tasks deliver their terminal
 * <task-notification> automatically (async completion notification wakes the
 * parent session), so blocking on a task would double-receive the result and
 * occupy the turn with dead polling. The only valid use is an immediate
 * snapshot:
 *   - completed / failed / killed → inline the final output;
 *   - still running              → report status and remind the model not to
 *                                  poll (completion arrives by notification).
 *
 * Grok's equivalent is `CheckSubagent`: read-only "how is it doing", never
 * "wait for it to finish". (Grok 0.18 removed the legacy blocking
 * `wait_tasks` / `get_task_output(timeout_ms>0)` semantics duya originally
 * mirrored from grok_build.)
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import type { TaskRecord, TaskStatus } from '../../lifecycle/TaskState.js';
import { getBackgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';

export const GET_TASK_OUTPUT_TOOL_NAME = 'get_task_output';
/** Max task ids accepted in a single snapshot call. */
export const MAX_MULTI_TASK_IDS = 10;
/** Inline budget for a completed task's output (keeps context bounded). */
export const DEFAULT_TOOL_OUTPUT_BYTES = 40_000;

export function isTerminalStatus(s: TaskStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'killed';
}

function toResult(
  name: string,
  payload: unknown,
  error?: boolean,
): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

/**
 * Format a task's output for prompt consumption. Completed tasks inline
 * their final text content, truncated to `DEFAULT_TOOL_OUTPUT_BYTES` so a
 * snapshot of a verbose task can't bloat model context.
 */
export function formatTaskOutput(rec: TaskRecord): string {
  if (rec.status === 'completed' && rec.result) {
    let out = rec.result.content
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
    if (out.length > DEFAULT_TOOL_OUTPUT_BYTES) {
      out = out.slice(0, DEFAULT_TOOL_OUTPUT_BYTES) + '\n...<truncated>';
    }
    return out;
  }
  if (rec.error) return rec.error;
  return '';
}

interface TaskOutputResult {
  task_id: string;
  status: TaskStatus;
  output: string;
}

export class GetTaskOutputTool implements Tool, ToolExecutor {
  readonly name = GET_TASK_OUTPUT_TOOL_NAME;
  readonly description = `Fetch the current output or status snapshot of one or more background sub-agent tasks.

- Completed tasks return their output; still-running tasks report their status.
- Non-blocking: this tool NEVER waits for a task to finish. When a background task completes you will be notified automatically with a <task-notification> containing its result — do not poll or wait for it, do not call this tool repeatedly. Use this only to take a quick look, or to fetch the full output of a task that has already completed.
- For a running task that looks stuck or looping, use kill_task to terminate it.`;

  readonly input_schema = {
    type: 'object',
    properties: {
      task_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more subagent task ids.',
      },
    },
    required: ['task_ids'],
  };

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { task_ids } = input as { task_ids?: unknown };
    if (!Array.isArray(task_ids) || task_ids.length === 0 || !task_ids.every((t) => typeof t === 'string')) {
      return toResult(this.name, 'task_ids must be a non-empty array of strings.', true);
    }
    if (task_ids.length > MAX_MULTI_TASK_IDS) {
      return toResult(this.name, `task_ids exceeds maximum of ${MAX_MULTI_TASK_IDS} entries.`, true);
    }
    const ids = task_ids as string[];

    const lifecycle = getBackgroundAgentLifecycle();
    const results: TaskOutputResult[] = ids.map((id) => {
      const rec = lifecycle.getSnapshot(id);
      if (!rec) return { task_id: id, status: 'not_found' as TaskStatus, output: '' };
      if (!isTerminalStatus(rec.status)) {
        return {
          task_id: id,
          status: rec.status,
          output: `${rec.status}. You will be notified automatically when this task completes — do not poll for it.`,
        };
      }
      return { task_id: id, status: rec.status, output: formatTaskOutput(rec) };
    });

    const completed = results.filter((r) => isTerminalStatus(r.status)).length;
    return toResult(this.name, {
      mode: 'snapshot',
      results,
      summary: `${completed}/${results.length} tasks in terminal state`,
    });
  }
}

export const getTaskOutputTool = new GetTaskOutputTool();
