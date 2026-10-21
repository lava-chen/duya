import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/contracts/tool.js';
import { detectShellForFamily } from '../../src/utils/shellDetector.js';
import { PowerShellTool } from '../../src/ShellCommandTool/PowerShellTool.js';
import type { ShellCommandRuntimePorts } from '../../src/ShellCommandTool/ports.js';
import {
  checkPowerShellSecurity,
  isReadOnlyPowerShellCommand,
} from '../../src/ShellCommandTool/PowerShellSecurity.js';

function makeTool(runtime: ShellCommandRuntimePorts = {
  start: async () => {
    throw new Error('start should not be called');
  },
  outputDirectory: () => '.',
}): PowerShellTool {
  return new PowerShellTool(runtime);
}

const toolContext: ToolContext = {
  toolUseId: 'powershell-test',
  workingDirectory: process.cwd(),
  abortController: new AbortController(),
  sessionId: 'powershell-test-session',
  getAppState: () => ({}),
};

describe('PowerShellTool capability', () => {
  it('keeps the legacy name, input shape, and timeout validation', () => {
    const tool = makeTool();

    expect(tool.name).toBe('powershell');
    expect(tool.description).toBe('Execute a PowerShell command. Returns the stdout and stderr output.');
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The PowerShell command to execute' },
        timeout: { type: 'number' },
        run_in_background: { type: 'boolean' },
      },
    });
    expect(tool.validateInput({ command: 'Get-ChildItem', timeout: 0 })).toEqual({
      success: false,
      error: 'timeout must be a positive number',
    });
    expect(tool.validateInput({ command: 'Get-ChildItem' }).success).toBe(true);
    expect(tool.interruptBehavior).toBe('cancel');
  });

  it('uses PowerShell security rules for tool permission checks', () => {
    const tool = makeTool();

    expect(tool.checkPermissions({ command: 'Get-ChildItem' }, toolContext)).toEqual({ allowed: true });
    expect(tool.checkPermissions({ command: 'Remove-Item temp.txt' }, toolContext)).toMatchObject({
      allowed: true,
      requiresUserConfirmation: true,
    });
    expect(tool.checkPermissions({ command: 'Invoke-Expression $payload' }, toolContext)).toMatchObject({
      allowed: false,
    });
  });

  it('keeps PowerShell command classification conservative', () => {
    expect(checkPowerShellSecurity('Get-ChildItem').safe).toBe(true);
    expect(checkPowerShellSecurity('Remove-Item temp.txt').requiresApproval).toBe(true);
    expect(isReadOnlyPowerShellCommand('gci .')).toBe(true);
    expect(isReadOnlyPowerShellCommand('Get-ChildItem; Remove-Item temp.txt')).toBe(false);
    expect(isReadOnlyPowerShellCommand('Get-Content $(Get-Location)')).toBe(false);
  });

  it.skipIf(!detectShellForFamily('powershell'))('dispatches the unmodified command through the PowerShell runtime port', async () => {
    let received: Parameters<ShellCommandRuntimePorts['start']>[0] | undefined;
    const runtime: ShellCommandRuntimePorts = {
      start: vi.fn(async (params) => {
        received = params;
        return {
          taskId: params.taskId,
          pid: 123,
          outputFile: 'powershell-output.txt',
          settled: Promise.resolve({
            taskId: params.taskId,
            status: 'completed' as const,
            exitCode: 0,
            text: 'ok',
            durationMs: 1,
          }),
          promoteToBackground: () => undefined,
        };
      }),
      outputDirectory: () => '.',
    };

    const tool = makeTool(runtime);
    const result = await tool.execute({ command: 'Get-ChildItem' }, process.cwd(), {
      toolUseId: 'powershell-execute-test',
      abortController: new AbortController(),
      getAppState: () => ({}),
      options: {
        mainLoopModel: 'test-model',
        sessionId: 'powershell-test-session',
        workingDirectory: process.cwd(),
      },
    });

    // A completed foreground run reports an explicit `error: false` flag
    // (BashTool.buildForegroundResult derives it from the completion status),
    // which is the capability-wide convention for "no error" results.
    expect(result.error).toBe(false);
    expect(result.result).toBe('ok');
    expect(result.metadata).toMatchObject({
      exitCode: 0,
      taskId: 'powershell-execute-test',
      outputFile: 'powershell-output.txt',
    });
    expect(received?.command).toBe('Get-ChildItem');
    expect(received?.shellArgs).toContain('-EncodedCommand');
    const encodedCommand = received?.shellArgs.at(-1);
    expect(typeof encodedCommand).toBe('string');
    expect(Buffer.from(encodedCommand as string, 'base64').toString('utf16le')).toContain('; Get-ChildItem');
    expect(runtime.start).toHaveBeenCalledOnce();
  });
});
