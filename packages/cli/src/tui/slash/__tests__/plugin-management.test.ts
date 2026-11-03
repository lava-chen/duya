import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runPluginManagement } from '../plugin-management.js';
import type { TuiSlashContext } from '../types.js';

function context(confirm = 'confirm', busy = false) {
  const client = { installPluginLegacy: vi.fn(), setPluginEnabledLegacy: vi.fn(), addPluginMarketplace: vi.fn() };
  const tui = { choose: vi.fn(async () => confirm), showPanel: vi.fn(), printError: vi.fn() };
  return { client, tui, context: { client, tui, busy } as unknown as TuiSlashContext };
}

describe('TUI shared plugin management adapter', () => {
  it('confirms a source install and sends the whole directory to Host', async () => {
    const f = context();
    const source = path.join(os.tmpdir(), 'My Plugins', 'example');
    await runPluginManagement(f.context, 'install-path ' + source);
    expect(f.client.installPluginLegacy).toHaveBeenCalledWith({ fromPath: source });
    expect(f.tui.choose).toHaveBeenCalledOnce();
    expect(f.tui.showPanel).toHaveBeenCalled();
  });
  it('keeps cancelled and busy operations off the Host write API', async () => {
    const cancelled = context('cancel');
    await runPluginManagement(cancelled.context, 'disable com.duya.test');
    expect(cancelled.client.setPluginEnabledLegacy).not.toHaveBeenCalled();
    const busy = context('confirm', true);
    await runPluginManagement(busy.context, 'disable com.duya.test');
    expect(busy.client.setPluginEnabledLegacy).not.toHaveBeenCalled();
    expect(busy.tui.printError).toHaveBeenCalled();
  });
  it('preserves marketplace identity when installing a catalog item', async () => {
    const f = context();
    await runPluginManagement(f.context, 'install com.duya.test@my-market');
    expect(f.client.installPluginLegacy).toHaveBeenCalledWith({ pluginId: 'com.duya.test', marketplace: 'my-market' });
  });
});
