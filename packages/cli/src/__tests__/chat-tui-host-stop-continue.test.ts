import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost } from '@duya/host/local-host';
import type { LegacyFrame } from '../tui/blocks.js';

interface View {
  options: {
    onSubmit(text: string): void;
    onInterrupt(): void;
    onExit(): void;
    isBusy(): boolean;
  };
  frames: LegacyFrame[];
  errors: string[];
}
const harness = vi.hoisted(() => ({ view: null as View | null }));
// Only the terminal painter is replaced. Admission, HTTP, SSE, persistence,
// cancellation, worker supervision and process replacement are production code.
vi.mock('../tui/index.js', () => ({
  shouldUseTui: () => true,
  TUIApp: class {
    frames: LegacyFrame[] = [];
    errors: string[] = [];
    constructor(readonly options: View['options']) { harness.view = this; }
    start() {}
    stop() {}
    setBusy() {}
    refresh() {}
    printUser() {}
    printNotice() {}
    printError(message: string) { this.errors.push(message); }
    push(frame: LegacyFrame) { this.frames.push(frame); }
    replaceTranscript() {}
    chooseFiltered() { return Promise.resolve(null); }
    choose() { return Promise.resolve(null); }
  },
}));
import { chatTui } from '../chat.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('TUI/Host transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('TUI stop and continue through the real Host', () => {
  afterEach(() => { harness.view = null; });
  it.each(['cooperative', 'escalated'])('continues the same session after a %s stop', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-tui-stop-'));
    const workerPath = path.join(root, 'worker.cjs');
    await fs.writeFile(workerPath, `
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (data) => {
        pending += data;
        let end;
        while ((end = pending.indexOf('\\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const command = JSON.parse(line);
          if (command.type === 'chat:interrupt' && ${JSON.stringify(mode)} === 'cooperative') {
            process.send({ type: 'chat:done', sessionId: command.sessionId });
          }
          if (command.type !== 'chat:start') continue;
          process.send({ type: 'chat:status', status: 'working' });
          if (command.prompt === 'continue') {
            process.send({ type: 'chat:text', content: 'continued' });
            process.send({ type: 'chat:done', sessionId: command.sessionId });
          }
        }
      });
      process.on('disconnect', () => process.exit(0));
    `);
    const host = await startLocalHost({ dataRoot: root, ephemeral: true, workerPath });
    const client = new HostSessionHttpClient(host.origin, host.token ?? '');
    let running: Promise<number> | undefined;
    try {
      await client.createImportedSession({ sessionId: 'tui-stop', title: 'stop test', workingDirectory: root, projectName: 'stop-test' });
      const start = vi.spyOn(client, 'startAgentRun');
      running = chatTui(client, 'tui-stop', {});
      await until(() => harness.view !== null);
      const view = harness.view!;
      view.options.onSubmit('wait');
      await until(() => view.frames.some((frame) => frame.type === 'status'));
      view.options.onInterrupt();
      view.options.onSubmit('continue');
      await until(() => view.frames.some((frame) => frame.type === 'text'));
      await until(() => !view.options.isBusy());
      expect(view.errors).toEqual([]);
      expect(start).toHaveBeenCalledTimes(2);
      const first = await start.mock.results[0]!.value;
      const second = await start.mock.results[1]!.value;
      expect(first.accepted && second.accepted).toBe(true);
      if (first.accepted && second.accepted) {
        expect((await client.getAgentRun(first.runId))?.status).toBe(mode === 'cooperative' ? 'cancelled' : 'failed');
        expect((await client.getAgentRun(second.runId))?.status).toBe('completed');
      }
      view.options.onExit();
      await expect(running).resolves.toBe(0);
    } finally {
      harness.view?.options.onExit();
      await running;
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
