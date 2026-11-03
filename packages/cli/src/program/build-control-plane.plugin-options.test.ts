import { Command } from '@commander-js/extra-typings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runPluginCommand } = vi.hoisted(() => ({
  runPluginCommand: {
    list: vi.fn(async () => 0),
    install: vi.fn(async () => 0),
    uninstall: vi.fn(async () => 0),
    update: vi.fn(async () => 0),
    info: vi.fn(async () => 0),
    enable: vi.fn(async () => 0),
    disable: vi.fn(async () => 0),
    doctor: vi.fn(async () => 0),
    marketplace: vi.fn(async () => 0),
  },
}));

vi.mock('../commands/plugin.js', () => ({ runPluginCommand }));

import { buildControlPlane } from './build-control-plane.js';

describe('plugin CLI option forwarding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards --available to the plugin catalog command', async () => {
    const program = new Command().exitOverride();
    buildControlPlane(program);

    await program.parseAsync(['node', 'duya', 'plugin', 'list', '--available', '--format', 'json']);

    expect(runPluginCommand.list).toHaveBeenCalledWith(expect.objectContaining({ available: true }));
  });

  it('forwards the selected marketplace when installing by id', async () => {
    const program = new Command().exitOverride();
    buildControlPlane(program);

    await program.parseAsync([
      'node', 'duya', 'plugin', 'install', 'com.duya.example', '--marketplace', 'example', '--yes',
    ]);

    expect(runPluginCommand.install).toHaveBeenCalledWith(expect.objectContaining({
      args: ['com.duya.example'],
      options: expect.objectContaining({ marketplace: 'example', yes: true }),
    }));
  });
});
