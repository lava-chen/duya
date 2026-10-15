import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/shellDetector.js', () => ({
  detectShellForFamily: vi.fn(() => ({
    name: 'bash',
    path: '/bin/bash',
    family: 'unix',
    supportsUnixCommands: true,
    execArg: '-c',
  })),
}));

import { BashTool } from '../../src/ShellCommandTool/BashTool.js';
import type {
  ShellCommandCompletion,
  ShellCommandHandle,
  ShellCommandRuntimePorts,
  StartShellCommand,
} from '../../src/ShellCommandTool/ports.js';

describe('capability BashTool runtime ports', () => {
  let start: ReturnType<typeof vi.fn>;
  let promoteToBackground: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    promoteToBackground = vi.fn();
    start = vi.fn(async (params: StartShellCommand): Promise<ShellCommandHandle> => {
      const completion: ShellCommandCompletion = {
        taskId: params.taskId,
        status: 'completed',
        exitCode: 0,
        text: 'shell capability ran',
        durationMs: 3,
      };
      return {
        taskId: params.taskId,
        pid: 42,
        outputFile: '/tmp/bash-output.log',
        settled: Promise.resolve(completion),
        promoteToBackground,
      };
    });
  });

  it('executes through the injected host process owner and returns its result', async () => {
    const runtime: ShellCommandRuntimePorts = {
      start,
      outputDirectory: () => '/tmp',
    };
    const tool = new BashTool(runtime, {
      softYieldMs: 0,
      normalizeCommandForExecution: (command) => command,
    });
    const abortController = new AbortController();

    const result = await tool.execute(
      { command: 'echo capability' },
      '/workspace',
      {
        toolUseId: 'tool-call-1',
        options: { sessionId: 'session-1' },
        abortController,
      },
    );

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'tool-call-1',
      command: 'echo capability',
      cwd: '/workspace',
      sessionId: 'session-1',
      abortSignal: abortController.signal,
    }));
    expect(result.result).toBe('shell capability ran');
    expect(result.metadata).toMatchObject({ taskId: 'tool-call-1', outputFile: '/tmp/bash-output.log' });
  });

  it('promotes a timed-out foreground wait without restarting the process', async () => {
    let settle!: (value: ShellCommandCompletion) => void;
    start.mockImplementation(async (params: StartShellCommand): Promise<ShellCommandHandle> => ({
      taskId: params.taskId,
      pid: 43,
      outputFile: '/tmp/bash-output.log',
      settled: new Promise((resolve) => { settle = resolve; }),
      promoteToBackground,
    }));
    const tool = new BashTool({ start, outputDirectory: () => '/tmp' }, {
      softYieldMs: 1,
      normalizeCommandForExecution: (command) => command,
    });

    const result = await tool.execute({ command: 'sleep 5' }, '/workspace');

    expect(promoteToBackground).toHaveBeenCalledOnce();
    expect(result.metadata).toMatchObject({ autoPromoted: true, taskId: expect.any(String) });
    settle({ taskId: 'late', status: 'completed', exitCode: 0, text: '', durationMs: 5 });
  });
});
