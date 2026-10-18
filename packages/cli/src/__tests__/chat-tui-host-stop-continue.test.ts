/**
 * `duya chat-tui-host-stop-continue` — stop and continue through the real Host.
 *
 * ## This file was RED, and the 15 s budget was not why
 *
 * The failure was reported as `TUI/Host transition timed out`, which reads like
 * a tight wall-clock budget under CI load. It is not. Instrumenting `until()`
 * with the frames that actually arrived showed **`frames: []` and `errors: []`**:
 * the run was accepted and the client watched a stream that never produced a
 * single event. A timeout that starts from nothing is a symptom, not a cause.
 *
 * ## The real cause: the fixture spoke a protocol the Host no longer surfaces
 *
 * The fake worker answered `chat:start` with legacy `chat:status` / `chat:text` /
 * `chat:done` frames. The Host counts those as a degradation and appends them to
 * the ledger (`run-orchestrator.ts`, the `append` arm — `#translatedEventsByRun`),
 * but it does **not** publish them on the live arm a client subscribes to: the
 * native channel is the only writer (`worker-process-entry.ts` sends
 * `{ type: 'run:event', epoch, envelope }`, and `queueNativeRunEvent` →
 * `readNativeWireFrame` refuses anything without an integer `epoch`, a `runId`,
 * a `seq >= 1` and a typed `payload`). `run-orchestrator.ts` warns about exactly
 * this shape: "produced legacy frames but no native run events".
 *
 * So the fixture now emits native envelopes. That moved the failure: frames go
 * from `[]` to `[status, status, text]`, which is the whole point — the TUI now
 * receives real Host events.
 *
 * ## Where it stands
 *
 * Still red, and **not** claimed green. The remaining gap is termination: no
 * `done` frame arrives and `isBusy()` never falls back, i.e. the run-event stream
 * does not close after the run settles. `chatTui` learns the outcome from
 * `getAgentRun` after its `for await` ends (`chat.ts`), so a `done` frame may
 * legitimately never come — which makes "why does the stream not close" the open
 * question, not "why is there no done frame".
 *
 * Next step is that question, on the Host side. Do not "fix" it by raising the
 * deadline: the budget was never the constraint.
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
    if (Date.now() >= deadline) {
      const seen = harness.view?.frames.map((f) => f.type) ?? [];
      const errs = harness.view?.errors ?? [];
      throw new Error(
        `TUI/Host transition timed out; frames seen: [${seen.join(', ')}]; errors: ${JSON.stringify(errs)}`,
      );
    }
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
      let seq = 0;
      // The Host only surfaces NATIVE run events to a client
      // (worker-process-entry.ts sends { type: 'run:event', epoch, envelope }).
      // A worker that answers with legacy chat:* frames is counted as a
      // degradation and never reaches the TUI, so this fixture speaks native.
      const emit = (command, payload) => {
        process.send({
          type: 'run:event',
          epoch: 0,
          envelope: {
            sessionId: command.sessionId,
            runId: command.runId,
            seq: ++seq,
            timestamp: Date.now(),
            traceId: 'trace-tui-stop',
            payload,
          },
        });
      };
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (data) => {
        pending += data;
        let end;
        while ((end = pending.indexOf('\\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const command = JSON.parse(line);
          if (command.type === 'chat:interrupt' && ${JSON.stringify(mode)} === 'cooperative') {
            emit(command, { type: 'run.completed', status: 'cancelled' });
          }
          if (command.type !== 'chat:start') continue;
          emit(command, { type: 'assistant.status', message: 'working' });
          if (command.prompt === 'continue') {
            emit(command, { type: 'assistant.text_block', text: 'continued', messageId: 'm-1', index: 0 });
            emit(command, { type: 'run.completed', status: 'completed' });
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
