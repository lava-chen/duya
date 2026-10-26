/**
 * A turn must survive the last client lease disappearing.
 *
 * The 2026-10-26 incident: a healthy turn showed `terminated`, then the next
 * prompt got `fetch failed`, while the worker kept running and persisted the
 * answer. The Host's idle shutdown closed the HTTP server (destroying the run
 * event stream) before it drained the worker, and a client that came back
 * during that window had no way to cancel the verdict.
 *
 * This test drives the production path end to end: a real ephemeral Host, a
 * real worker process fixture, the real SSE stream and the real TUI loop. Only
 * the terminal painter is replaced.
 */
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
    setBackgroundTasks() {}
    hasRunningBackgroundTasks() { return false; }
    isTaskViewOpen() { return false; }
    showPanel() {}
  },
}));
import { chatTui } from '../chat.js';

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) {
      const seen = harness.view?.frames.map((frame) => frame.type) ?? [];
      const errors = harness.view?.errors ?? [];
      throw new Error(`timed out waiting for ${what}; frames: [${seen.join(', ')}]; errors: ${JSON.stringify(errors)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function untilHostGone(client: HostSessionHttpClient): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await client.getHealth();
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error('Host never stopped after its last client left');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('a turn whose client lease drops mid-flight', () => {
  afterEach(() => { harness.view = null; });

  it('stays visible, lets a reattached client cancel the shutdown, and stops once nobody is attached', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-tui-lease-loss-'));
    const workerPath = path.join(root, 'worker.cjs');
    await fs.writeFile(workerPath, `
      let pending = '';
      let seq = 0;
      const envelope = (command, payload) => ({
        type: 'run:event',
        epoch: 0,
        envelope: {
          sessionId: command.sessionId,
          runId: command.runId,
          seq: ++seq,
          timestamp: Date.now(),
          traceId: 'trace-lease-loss',
          payload,
        },
      });
      const emit = (command, payload) => { process.send(envelope(command, payload)); };
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (data) => {
        pending += data;
        let end;
        while ((end = pending.indexOf('\\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const command = JSON.parse(line);
          if (command.type !== 'chat:start') continue;
          emit(command, { type: 'assistant.status', message: 'working' });
          // Long enough that the Host's idle verdict fires while the turn is
          // still running: the old shutdown closed the stream here.
          setTimeout(() => {
            emit(command, { type: 'assistant.text_block', text: 'still here', messageId: 'm-1', index: 0 });
            emit(command, { type: 'run.completed', status: 'completed' });
            process.send({ type: 'chat:done', sessionId: command.sessionId });
          }, 2_000);
        }
      });
      process.on('disconnect', () => process.exit(0));
    `);
    const host = await startLocalHost({
      dataRoot: root,
      ephemeral: true,
      workerPath,
      clientScoped: true,
      clientLeaseIdleTimeoutMs: 100,
      idleShutdownDrainTimeoutMs: 15_000,
    });
    const client = new HostSessionHttpClient(host.origin, host.token ?? '');
    let running: Promise<number> | undefined;
    try {
      await client.createImportedSession({
        sessionId: 'lease-loss',
        title: 'lease loss',
        workingDirectory: root,
        projectName: 'lease-loss',
      });
      const start = vi.spyOn(client, 'startAgentRun');
      const held = await client.openClientLease();
      expect(held).not.toBeNull();

      running = chatTui(client, 'lease-loss', {});
      await until(() => harness.view !== null, 'the TUI');
      const view = harness.view!;

      view.options.onSubmit('slow');
      await until(() => view.frames.some((frame) => frame.type === 'status'), 'the worker to acknowledge the turn');

      // The lease drops mid-turn. The Host may now start its idle shutdown,
      // but it must not close the stream that carries the answer.
      held!.close();
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // The terminal comes back and reattaches during the drain.
      const reattached = await client.openClientLease();
      expect(reattached).not.toBeNull();

      await until(() => view.frames.some((frame) => frame.type === 'text'), 'the answer to arrive');
      await until(() => !view.options.isBusy(), 'the turn to settle');
      expect(view.errors).toEqual([]);

      const started = await start.mock.results[0]!.value;
      expect(started.accepted).toBe(true);
      if (started.accepted) {
        expect((await client.getAgentRun(started.runId))?.status).toBe('completed');
      }
      // A reattached client cancels the pending shutdown instead of being
      // closed under: the Host is still answering.
      await expect(client.getHealth()).resolves.toBeDefined();

      // The cancel does not latch: once the last client is gone again the
      // Host stops on its own.
      reattached!.close();
      await untilHostGone(client);

      view.options.onExit();
      await expect(running).resolves.toBe(0);
    } finally {
      harness.view?.options.onExit();
      await running;
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
