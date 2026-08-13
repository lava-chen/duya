/**
 * GetTaskOutputTool — unified polling / waiting entry point (aligned to
 * Grok's `get_task_output`).
 *
 * A single call covers both "fetch a snapshot" and "block until done":
 *   - `timeout_ms` omitted or 0 → return an immediate snapshot.
 *   - `timeout_ms` > 0 → block up to N ms waiting for all tasks to finish.
 *
 * When a wait-all times out with tasks still running, the result appends a
 * hint that the caller will be notified automatically on completion (Phase 4
 * async completion notification) — so the model should NOT keep polling.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import type { TaskRecord, TaskStatus } from '../../lifecycle/TaskState.js';
import { getBackgroundAgentLifecycle } from '../../lifecycle/BackgroundAgentLifecycle.js';

export const GET_TASK_OUTPUT_TOOL_NAME = 'get_task_output';
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const MAX_MULTI_WAIT_IDS = 10;
export const DEFAULT_TOOL_OUTPUT_BYTES = 40_000;
/**
 * Hard ceiling on a single blocking wait, aligned to Grok `max_wait_block`.
 * Capping is safe because a completed task pings the model (async completion
 * notification), so a truncated wait costs one more poll, not the result.
 */
export const MAX_WAIT_BLOCK_MS = 10 * 60 * 1000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a task's output for prompt consumption. Completed tasks inline
 * their final text content; a wait-all path truncates to
 * `DEFAULT_TOOL_OUTPUT_BYTES` because it occupies model context.
 */
export function formatTaskOutput(rec: TaskRecord, truncate: boolean): string {
  if (rec.status === 'completed' && rec.result) {
    let out = rec.result.content
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
    if (truncate && out.length > DEFAULT_TOOL_OUTPUT_BYTES) {
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
  readonly description = `Fetch the output of one or more background sub-agent tasks, or block until they finish.

- Pass task_ids plus timeout_ms>0 to wait up to that many ms for all tasks to complete.
- Pass timeout_ms omitted or 0 to take an immediate snapshot of current status.
- If a wait times out while tasks are still running, you will be notified automatically when they complete — do not keep polling.`;

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
        description: '0 or omitted = snapshot now; >0 = block up to N ms waiting for all to finish.',
      },
    },
    required: ['task_ids'],
  };

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { task_ids, timeout_ms } = input as { task_ids?: unknown; timeout_ms?: unknown };
    if (!Array.isArray(task_ids) || task_ids.length === 0 || !task_ids.every((t) => typeof t === 'string')) {
      return toResult(this.name, 'task_ids must be a non-empty array of strings.', true);
    }
    if (task_ids.length > MAX_MULTI_WAIT_IDS) {
      return toResult(this.name, `task_ids exceeds maximum of ${MAX_MULTI_WAIT_IDS} entries.`, true);
    }
    const ids = task_ids as string[];
    const requestedWaitMs = typeof timeout_ms === 'number' && timeout_ms > 0 ? timeout_ms : 0;
    const waitMs = Math.min(requestedWaitMs, MAX_WAIT_BLOCK_MS);

    const lifecycle = getBackgroundAgentLifecycle();
    const results: TaskOutputResult[] = await Promise.all(
      ids.map(async (id) => {
        const started = Date.now();
        let rec = lifecycle.getSnapshot(id);
        while (waitMs > 0 && rec && !isTerminalStatus(rec.status) && Date.now() - started < waitMs) {
          await sleep(250);
          rec = lifecycle.getSnapshot(id);
        }
        if (!rec) return { task_id: id, status: 'not_found' as TaskStatus, output: '' };
        if (waitMs > 0 && !isTerminalStatus(rec.status)) {
          return {
            task_id: id,
            status: rec.status,
            output: `${rec.status}. You will be notified automatically when the task completes.`,
          };
        }
        return { task_id: id, status: rec.status, output: formatTaskOutput(rec, waitMs > 0) };
      }),
    );

    const completed = results.filter((r) => isTerminalStatus(r.status)).length;
    return toResult(this.name, {
      mode: waitMs > 0 ? 'wait_all' : 'snapshot',
      results,
      summary: `${completed}/${results.length} tasks completed`,
    });
  }
}

export const getTaskOutputTool = new GetTaskOutputTool();