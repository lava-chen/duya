import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOL_OUTPUT_BYTES,
  GetTaskOutputTool,
  KillTaskTool,
  MAX_MULTI_TASK_IDS,
  WaitTasksTool,
  type BackgroundTaskPort,
} from '../src/background-task-tool.js';

function makePort(overrides: Partial<BackgroundTaskPort> = {}): BackgroundTaskPort {
  return {
    getAgentTask: () => undefined,
    listAgentTasks: () => [],
    tryKillAgentTask: () => 'not_found',
    getShellTask: () => undefined,
    listShellTasks: () => [],
    readShellOutput: () => null,
    stopShellTask: async () => ({ success: false, message: 'not stopped' }),
    ...overrides,
  };
}

describe('background task capabilities', () => {
  it('keeps the snapshot schema non-blocking and rejects malformed or oversized batches', async () => {
    const tool = new GetTaskOutputTool(makePort());
    const schema = tool.input_schema as { properties: Record<string, unknown> };
    expect(schema.properties.timeout_ms).toBeUndefined();
    expect(tool.description).toMatch(/NEVER waits/i);
    expect((await tool.execute({ task_ids: [] })).error).toBe(true);
    const tooMany = await tool.execute({ task_ids: Array.from({ length: MAX_MULTI_TASK_IDS + 1 }, (_, i) => `t-${i}`) });
    expect(tooMany.error).toBe(true);
    expect(tooMany.result).toContain(`exceeds maximum of ${MAX_MULTI_TASK_IDS}`);
  });

  it('returns not-found snapshots and completed output with the existing truncation marker', async () => {
    const oversized = 'x'.repeat(DEFAULT_TOOL_OUTPUT_BYTES + 5);
    const tool = new GetTaskOutputTool(makePort({
      getAgentTask: (taskId) => taskId === 'done'
        ? { taskId, status: 'completed', result: { content: [{ type: 'text', text: oversized }] } }
        : undefined,
    }));

    const result = JSON.parse((await tool.execute({ task_ids: ['missing', 'done'] })).result) as {
      summary: string;
      results: Array<{ task_id: string; status: string; output: string }>;
    };
    expect(result.results[0]).toMatchObject({ task_id: 'missing', status: 'not_found', output: '' });
    expect(result.results[1].status).toBe('completed');
    expect(result.results[1].output).toBe(`${'x'.repeat(DEFAULT_TOOL_OUTPUT_BYTES)}\n...<truncated>`);
    expect(result.summary).toBe('1/2 tasks in terminal state');
  });

  it('returns immediately for a running task and reads live shell output through the port', async () => {
    const readShellOutput = vi.fn(() => ({ text: 'compiling module 1/9\n' }));
    const tool = new GetTaskOutputTool(makePort({
      getAgentTask: (taskId) => taskId === 'agent-live' ? { taskId, status: 'running' } : undefined,
      getShellTask: (id) => id === 'shell-live' ? { id, pid: 99, status: 'running' } : undefined,
      readShellOutput,
    }));

    const start = Date.now();
    const result = JSON.parse((await tool.execute({ task_ids: ['agent-live', 'shell-live'] })).result) as {
      results: Array<{ status: string; output: string }>;
    };
    expect(Date.now() - start).toBeLessThan(100);
    expect(result.results[0].output).toMatch(/will be notified automatically|do not poll/i);
    expect(result.results[1].status).toBe('running');
    expect(result.results[1].output).toContain('compiling module 1/9');
    expect(readShellOutput).toHaveBeenCalledWith('shell-live', DEFAULT_TOOL_OUTPUT_BYTES);
  });

  it('preserves kill outcomes for sub-agents and shell tasks; wait_tasks remains a nonblocking alias', async () => {
    const stopShellTask = vi.fn(async () => ({ success: true, message: 'Task shell-1 stopped' }));
    const agentPort = makePort({
      getAgentTask: (taskId) => taskId === 'agent-1' ? { taskId, status: 'running' } : undefined,
      tryKillAgentTask: () => 'killed',
      getShellTask: (taskId) => taskId === 'shell-1' ? { id: taskId, pid: 7, status: 'running' } : undefined,
      stopShellTask,
    });

    const agentResult = JSON.parse((await new KillTaskTool(agentPort).execute({ task_id: 'agent-1' })).result) as { outcome: string };
    const shellResult = JSON.parse((await new KillTaskTool(agentPort).execute({ task_id: 'shell-1' })).result) as { outcome: string };
    expect(agentResult.outcome).toBe('killed');
    expect(shellResult.outcome).toBe('killed');
    expect(stopShellTask).toHaveBeenCalledWith('shell-1');

    const wait = new WaitTasksTool(makePort({
      getAgentTask: (taskId) => taskId === 'running' ? { taskId, status: 'running' } : undefined,
    }));
    const waitResult = JSON.parse((await wait.execute({ task_ids: ['running'], timeout_ms: 1 })).result) as {
      results: Array<{ status: string; output: string }>;
    };
    expect(waitResult.results[0].status).toBe('running');
    expect(waitResult.results[0].output).toMatch(/do not poll/i);
  });
});
