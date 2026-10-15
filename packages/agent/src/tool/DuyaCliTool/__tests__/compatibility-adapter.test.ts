import { describe, expect, it } from 'vitest';
import { duyaCliTool } from '../DuyaCliTool.js';

describe('legacy duya_cli adapter', () => {
  it('binds the current CLI descriptor registry and in-process help runner', async () => {
    const result = await duyaCliTool.execute({ argv: ['help', '--format=json'] });
    const payload = JSON.parse(result.result) as {
      command: string;
      exitCode: number;
      ok: boolean;
      data: { commands: Array<{ name: string }> };
    };

    expect(result.error).toBeUndefined();
    expect(payload).toMatchObject({ command: 'help', exitCode: 0, ok: true });
    expect(payload.data.commands.map((command) => command.name)).toContain('status');
    expect(payload.data.commands.map((command) => command.name)).toContain('cron');
    expect(payload.data.commands.map((command) => command.name)).toContain('config');
  });
});
