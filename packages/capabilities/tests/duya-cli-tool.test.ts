import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DuyaCliTool, DUYA_CLI_TOOL_NAME, DESCRIPTION, getPrompt } from '../src/DuyaCliTool/index.js';
import type { DuyaCliInvocation, DuyaCliToolPort } from '../src/DuyaCliTool/ports.js';

const commands = [
  { name: 'status', subcommands: ['default'] },
  { name: 'doctor', subcommands: ['default'] },
  { name: 'plugin', subcommands: ['list', 'info', 'install'] },
  { name: 'cron', subcommands: ['list', 'create'] },
  { name: 'message', subcommands: ['list', 'show'] },
  { name: 'config', subcommands: ['provider-add', 'settings-set'] },
] as const;

const dispatched: DuyaCliInvocation[] = [];
const run = vi.fn<DuyaCliToolPort['run']>(async (invocation) => {
  dispatched.push(invocation);
  return { exitCode: 0, stdout: JSON.stringify({ received: invocation }), stderr: '' };
});

const tool = new DuyaCliTool({ commands, run });

beforeEach(() => {
  vi.clearAllMocks();
  dispatched.length = 0;
  run.mockImplementation(async (invocation) => {
    dispatched.push(invocation);
    return { exitCode: 0, stdout: JSON.stringify({ received: invocation }), stderr: '' };
  });
});

function payload(result: { result: string }): Record<string, unknown> {
  return JSON.parse(result.result) as Record<string, unknown>;
}

describe('DuyaCliTool capability', () => {
  it('keeps the tool name, descriptor-derived schema, and prompt', () => {
    expect(DUYA_CLI_TOOL_NAME).toBe('duya_cli');
    expect(tool.name).toBe(DUYA_CLI_TOOL_NAME);
    expect(tool.toTool().input_schema).toEqual(tool.input_schema);
    const schema = tool.input_schema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties.command.enum).toEqual(commands.map((command) => command.name));
    expect(schema.properties.argv).toBeDefined();
    expect(schema.required).toEqual([]);
    expect(DESCRIPTION.length).toBeGreaterThan(50);
    expect(getPrompt()).toContain('duya_cli');
  });

  it('keeps all command paths under the single CLI entry point', () => {
    const commandEnum = (tool.input_schema as {
      properties: { command: { enum: string[] } };
    }).properties.command.enum;
    expect(commandEnum).not.toContain('provider set-key');
    expect(commandEnum).not.toContain('plugin install');
    expect(commandEnum).not.toContain('mcp add');
    expect(commandEnum).not.toContain('session delete');
  });

  it('rejects missing and unknown structured commands without dispatching', async () => {
    const missing = await tool.execute({});
    const unknown = await tool.execute({ command: 'not-a-command' });
    expect(missing.error).toBe(true);
    expect(unknown.error).toBe(true);
    expect(unknown.result).toContain('Invalid input');
    expect(run).not.toHaveBeenCalled();
  });

  it('validates structured subcommands while preserving the single-command hint', async () => {
    const missing = await tool.execute({ command: 'plugin' });
    expect(missing.error).toBe(true);
    expect(missing.result).toContain('requires a subcommand');
    expect(missing.result).toContain('allowedSubcommands');

    const unknown = await tool.execute({ command: 'plugin', subcommand: 'absent' });
    expect(unknown.error).toBe(true);
    expect(unknown.result).toContain("unknown subcommand 'absent' for 'plugin'");

    const singleCommand = await tool.execute({ command: 'status', subcommand: 'list' });
    expect(singleCommand.error).toBe(true);
    expect(singleCommand.result).toContain('does not accept a subcommand');
    expect(run).not.toHaveBeenCalled();
  });

  it('dispatches the frozen structured form and threads the session directory', async () => {
    const result = await tool.execute(
      { command: 'plugin', subcommand: 'info', id: 'plugin-1', yes: true },
      'E:/workspace/project',
    );
    expect(result.error).toBeUndefined();
    expect(dispatched).toEqual([{
      command: 'plugin',
      subcommand: 'info',
      id: 'plugin-1',
      format: 'json',
      yes: true,
      cwd: 'E:/workspace/project',
    }]);
    expect(payload(result)).toMatchObject({
      command: 'plugin',
      subcommand: 'info',
      exitCode: 0,
      ok: true,
      data: { received: { command: 'plugin', id: 'plugin-1' } },
    });
  });

  it('preserves a non-zero CLI result as a successful tool dispatch', async () => {
    run.mockResolvedValueOnce({
      exitCode: 64,
      stdout: '',
      stderr: 'plugin info requires an <id> argument',
    });
    const result = await tool.execute({ command: 'plugin', subcommand: 'info' });
    expect(result.error).toBeUndefined();
    expect(payload(result)).toMatchObject({
      exitCode: 64,
      ok: false,
      stderr: 'plugin info requires an <id> argument',
      data: '',
    });
  });

  it('parses argv flags, positional arguments, repeated fields, and help', async () => {
    await tool.execute({
      argv: [
        'config', 'settings-set', '--model', 'model-x', '--max-tokens=8192',
        '--allow', 'read_*', '--allow=write_*', '--agent', 'agent-a', '--agent=agent-b',
        '--yes', '--format', 'text', '--help',
      ],
    }, 'E:/session');

    expect(dispatched).toEqual([{
      command: 'config',
      subcommand: 'help',
      extraArgs: [],
      agentModel: 'model-x',
      configModel: 'model-x',
      configMaxTokens: '8192',
      agentAllow: ['read_*', 'write_*'],
      configAgents: ['agent-a', 'agent-b'],
      yes: true,
      format: 'text',
      cwd: 'E:/session',
    }]);
  });

  it('parses cron, channel, and message arguments and value-equals flags', async () => {
    await tool.execute({ argv: ['cron', 'create', '--cron={"schedule":"daily"}', '--from-file=./job.json'] });
    await tool.execute({ argv: ['channel', 'list', '--platform', 'telegram'] });
    await tool.execute({ argv: ['message', 'show', 'session-1', 'message-2', '--limit', '5', '--offset=10'] });

    expect(dispatched[0]).toMatchObject({
      command: 'cron', subcommand: 'create', cronBodyJson: '{"schedule":"daily"}', fromFile: './job.json',
    });
    expect(dispatched[1]).toMatchObject({ command: 'channel', subcommand: 'list', platform: 'telegram' });
    expect(dispatched[2]).toMatchObject({
      command: 'message', subcommand: 'show', id: 'session-1', extraArgs: ['message-2'], limit: '5', offset: '10',
    });
  });

  it('rejects empty argv and mixed invocation styles', async () => {
    const empty = await tool.execute({ argv: [] });
    const mixed = await tool.execute({ argv: ['cron', 'list'], command: 'cron' });
    expect(empty.error).toBe(true);
    expect(empty.result).toContain('non-empty');
    expect(mixed.error).toBe(true);
    expect(mixed.result).toContain('mutually exclusive');
    expect(run).not.toHaveBeenCalled();
  });

  it('parses JSON stdout only for JSON format and retains text output', async () => {
    run.mockResolvedValueOnce({ exitCode: 0, stdout: '{"items":[1]}', stderr: '' });
    const json = await tool.execute({ argv: ['cron', 'list'] });
    expect(payload(json).data).toEqual({ items: [1] });

    run.mockResolvedValueOnce({ exitCode: 0, stdout: '{"items":[1]}', stderr: '' });
    const text = await tool.execute({ argv: ['cron', 'list', '--format=text'] });
    expect(payload(text).data).toBe('{"items":[1]}');
  });
});
