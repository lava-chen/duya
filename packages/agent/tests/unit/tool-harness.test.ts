/**
 * Plan 481 P1.1 — regression test for the unified tool test harness.
 *
 * Drives an existing builtin tool (get_task_output) through the harness's
 * executor contract (lookup → validate → permissions → execute) to prove
 * the fixture reproduces production behavior without changing the tool.
 */

import { describe, expect, it } from 'vitest';
import {
  callTool,
  createTestRegistry,
  createToolContext,
  isToolError,
  recordingExecutor,
  resultPayload,
} from '../../src/tool/harness.js';
import { getTaskOutputTool, MAX_MULTI_TASK_IDS } from '../../src/tool/BackgroundTaskTool/GetTaskOutputTool.js';

describe('tool harness (plan 481 P1.1)', () => {
  it('registers a builtin tool and resolves it by name', async () => {
    const registry = createTestRegistry([getTaskOutputTool]);
    const outcome = await callTool(registry, 'get_task_output', { task_ids: ['t1'] }, createToolContext());

    expect(outcome.definition?.name).toBe('get_task_output');
  });

  it('returns null stages for an unknown tool', async () => {
    const registry = createTestRegistry([getTaskOutputTool]);
    const outcome = await callTool(registry, 'no_such_tool', {}, createToolContext());

    expect(outcome.definition).toBeUndefined();
    expect(outcome.result).toBeNull();
  });

  it('validation stage passes through for loose-shape tools (no validateInput)', async () => {
    const registry = createTestRegistry([getTaskOutputTool]);
    const outcome = await callTool(
      registry,
      'get_task_output',
      { task_ids: 'not-an-array' },
      createToolContext(),
    );

    // Only BaseTool subclasses carry validateInput; loose toTool()-shaped
    // tools skip the stage and rely on executor guards (asserted below).
    expect(outcome.validation?.success).toBe(true);
    expect(isToolError(outcome.result!)).toBe(true);
    expect(outcome.result!.result).toContain('task_ids must be a non-empty array of strings');
  });

  it('execute rejects a non-array task_ids with a structured error result', async () => {
    const registry = createTestRegistry([getTaskOutputTool]);
    const context = createToolContext();
    // Bypass the schema stage to exercise the executor's own guards.
    const result = await registry.getExecutor('get_task_output')!.execute(
      { task_ids: 42 } as unknown as Record<string, unknown>,
      '/tmp',
      context.toolUseContext,
    );

    expect(isToolError(result)).toBe(true);
    expect(result.result).toContain('task_ids must be a non-empty array of strings');
  });

  it('execute rejects more than the multi-task id cap', async () => {
    const registry = createTestRegistry([getTaskOutputTool]);
    const ids = Array.from({ length: MAX_MULTI_TASK_IDS + 1 }, (_, i) => `t${i}`);
    const context = createToolContext();
    const result = await registry.getExecutor('get_task_output')!.execute(
      { task_ids: ids },
      '/tmp',
      context.toolUseContext,
    );

    expect(isToolError(result)).toBe(true);
    expect(result.result).toContain(`exceeds maximum of ${MAX_MULTI_TASK_IDS}`);
  });

  it('snapshots an unknown task id as not_found without erroring', async () => {
    const registry = createTestRegistry([getTaskOutputTool]);
    const outcome = await callTool(
      registry,
      'get_task_output',
      { task_ids: ['no-such-task'] },
      createToolContext(),
    );

    expect(outcome.result).not.toBeNull();
    expect(isToolError(outcome.result!)).toBe(false);
    const payload = resultPayload(outcome.result!) as { mode: string; results: Array<{ task_id: string; status: string }> };
    expect(payload.mode).toBe('snapshot');
    expect(payload.results[0]).toMatchObject({ task_id: 'no-such-task', status: 'not_found' });
  });

  it('recording executor captures calls and returns the canned result', async () => {
    const executor = recordingExecutor({ result: JSON.stringify({ ok: true, echo: 'x' }) });
    const registry = createTestRegistry([{ tool: getTaskOutputTool.toTool(), executor }]);
    const outcome = await callTool(registry, 'get_task_output', { task_ids: ['a'] }, createToolContext());

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].input).toEqual({ task_ids: ['a'] });
    const payload = resultPayload(outcome.result!) as { ok: boolean; echo: string };
    expect(payload).toEqual({ ok: true, echo: 'x' });
  });

  it('createToolContext records permission requests', async () => {
    const { toolUseContext, permissionRequests } = createToolContext();
    const decision = await toolUseContext.requestPermission!({ toolName: 'demo' });

    expect(decision).toBe('deny'); // default recorder denies
    expect(permissionRequests).toEqual([{ toolName: 'demo' }]);
  });
});
