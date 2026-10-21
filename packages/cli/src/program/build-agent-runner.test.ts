/**
 * packages/cli/src/program/build-agent-runner.test.ts
 *
 * Regression test for the in-process runner's process.exit guard.
 *
 * The CLI command modules (commands/mcp.ts, commands/agent.ts,
 * commands/config.ts) were written for the standalone `duya` binary and
 * call `process.exit(code)` on API failures (writeErrorAndExit). When the
 * same code is dispatched in-process via buildAgentRunner (the `duya_cli`
 * agent tool), a bare process.exit() killed the whole agent worker
 * mid-chat with exit code 1 — no crash log, no stderr (the hint was
 * swallowed by captureStreams). The guard must convert the exit into the
 * regular result envelope instead.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAgentRunner } from './build-agent-runner.js';
import { CLI_DESCRIPTORS } from './descriptors.js';
import type { CliSubcommandContext } from './registry.js';

// The descriptors array is frozen but the descriptor objects are not
// (see defineDescriptors in registry.ts), so we can swap a run callback
// for the duration of a test. Restore it afterwards.
const mcp = CLI_DESCRIPTORS.find((d) => d.name === 'mcp')!;
const originalRun = mcp.subcommands!['add']!.run;

afterEach(() => {
  mcp.subcommands!['add']!.run = originalRun;
});

describe('buildAgentRunner process.exit guard', () => {
  it('converts process.exit(1) inside a command into a result envelope instead of killing the process', async () => {
    mcp.subcommands!['add']!.run = async (_ctx: CliSubcommandContext) => {
      process.exit(1);
    };

    const resolve = buildAgentRunner();
    const result = await resolve({
      command: 'mcp',
      subcommand: 'add',
      configId: 'srv',
      configType: 'codegraph',
      format: 'json',
    });

    // The process must still be alive (the test reaching this line proves it).
    expect(result.exitCode).toBe(1);
    expect(typeof result.stderr).toBe('string');
  });

  it('preserves the hint written to stderr before process.exit and keeps the exit code', async () => {
    mcp.subcommands!['add']!.run = async (_ctx: CliSubcommandContext) => {
      process.stderr.write('boom: control plane unavailable\n');
      process.exit(2);
    };

    const resolve = buildAgentRunner();
    const result = await resolve({
      command: 'mcp',
      subcommand: 'add',
      configId: 'srv',
      configType: 'codegraph',
      format: 'json',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('boom: control plane unavailable');
  });

  it('preserves stdout written before process.exit', async () => {
    mcp.subcommands!['add']!.run = async (_ctx: CliSubcommandContext) => {
      process.stdout.write('partial output\n');
      process.exit(1);
    };

    const resolve = buildAgentRunner();
    const result = await resolve({
      command: 'mcp',
      subcommand: 'add',
      configId: 'srv',
      configType: 'codegraph',
      format: 'json',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('partial output\n');
  });

  it('restores process.exit after dispatch', async () => {
    mcp.subcommands!['add']!.run = async (_ctx: CliSubcommandContext) => {
      process.exit(1);
    };

    const originalExit = process.exit;
    const resolve = buildAgentRunner();
    await resolve({
      command: 'mcp',
      subcommand: 'add',
      configId: 'srv',
      configType: 'codegraph',
      format: 'json',
    });

    expect(process.exit).toBe(originalExit);
  });

  it('still surfaces real errors thrown by the command', async () => {
    mcp.subcommands!['add']!.run = async (_ctx: CliSubcommandContext) => {
      throw new Error('real failure');
    };

    const resolve = buildAgentRunner();
    await expect(
      resolve({
        command: 'mcp',
        subcommand: 'add',
        configId: 'srv',
        configType: 'codegraph',
        format: 'json',
      }),
    ).rejects.toThrow('real failure');
  });
});
