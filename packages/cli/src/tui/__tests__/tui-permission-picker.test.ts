/**
 * The permission picker, driven through the real blessed app.
 *
 * Plan 611 Wave 4 (P0-2): the overlay answers through the promise-facing
 * `requestPermissionApproval` entrance the wiring calls, the keys route
 * through the picker, and destructive allows need the second Enter. The
 * keyboard path is the real one — synthetic stdin, the same bytes a terminal
 * ships — because the routing (keypress vs key-name vs contended aliases) is
 * exactly where a state-level test would lie.
 */

import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleRendered(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS + 40));
}

type Decision = 'once' | 'always' | 'deny' | null;

function makeApp(
  options: Partial<ConstructorParameters<typeof TUIApp>[0]> = {},
  stdin: PassThrough = new PassThrough(),
) {
  const out = sink();
  const app = new TUIApp({
    output: out.stream,
    input: stdin,
    canAnswerPermissions: () => true,
    onSubmit: () => {},
    // Default the override map to EMPTY, not to `loadKeyOverrides()`: the
    // constructor falls back to config + env, and a test that asserts on
    // DEFAULT bindings must not depend on the developer's own
    // `~/.duya/config.toml`.
    keyOverrides: {},
    ...options,
  });
  return { app, out, stdin };
}

describe('TUIApp permission picker', () => {
  it('queues independent permission frames without denying the earlier tool', async () => {
    const { app, stdin } = makeApp();
    const decisions: Array<{ id: string; decision: Decision }> = [];
    app.onPermissionDecision = (id, decision) => decisions.push({ id, decision });
    app.start();
    try {
      await settle();
      for (const id of ['p1', 'p2']) app.push({ type: 'permission', data: {
        requestId: id, toolName: 'bash', toolInput: { command: 'echo fixture' },
      } });
      expect(decisions).toEqual([]);
      stdin.write('y');
      await settle();
      expect(decisions).toEqual([{ id: 'p1', decision: 'once' }]);
      stdin.write('n');
      await settle();
      expect(decisions).toEqual([{ id: 'p1', decision: 'once' }, { id: 'p2', decision: 'deny' }]);
    } finally { app.stop(); }
  });

  it('resolves a y press through the promise and the decision hook', async () => {
    const decisions: Array<{ id: string; decision: Decision }> = [];
    const { app, stdin } = makeApp();
    app.onPermissionDecision = (id, decision) => decisions.push({ id, decision });
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'p1',
      toolName: 'Bash',
      toolInput: { command: 'npm install' },
      reason: 'network',
    });
    await settleRendered();
    stdin.write('y');
    await settle();

    expect(await pending).toBe('once');
    expect(decisions).toEqual([{ id: 'p1', decision: 'once' }]);
    app.stop();
  });

  it('navigates with arrows and confirms with Enter', async () => {
    const { app, stdin } = makeApp();
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'p2',
      toolName: 'Bash',
      toolInput: { command: 'npm run build' },
      reason: 'writes files',
    });
    await settleRendered();
    stdin.write('\x1b[B'); // down → always
    await settle();
    stdin.write('\r'); // Enter → confirm
    await settle();

    expect(await pending).toBe('always');
    app.stop();
  });

  it('stages a destructive allow behind a second Enter', async () => {
    const { app, out, stdin } = makeApp();
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'p3',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf ./dist' },
      reason: 'cleanup',
      destructive: true,
    });
    await settleRendered();
    stdin.write('y');
    await settleRendered();
    // Staged, not answered: the body says so, and no resolution yet.
    expect(out.text()).toContain('press Enter again to confirm');
    stdin.write('y');
    await settle();
    expect(await pending).toBe('once');
    app.stop();
  });

  it('Esc resolves null and never allows', async () => {
    const { app, stdin } = makeApp();
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'p4',
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      reason: '',
    });
    await settleRendered();
    stdin.write('\x1b');
    await settle();
    expect(await pending).toBeNull();
    app.stop();
  });

  it('queues a second concurrent ask and shows it after the first is answered', async () => {
    const { app, out, stdin } = makeApp();
    app.start();
    await settle();

    const first = app.requestPermissionApproval({
      requestId: 'q1',
      toolName: 'Bash',
      toolInput: { command: 'a' },
      reason: '',
    });
    const second = app.requestPermissionApproval({
      requestId: 'q2',
      toolName: 'Bash',
      toolInput: { command: 'b' },
      reason: '',
    });
    await settleRendered();
    expect(out.text()).toContain('+1 more request waiting');
    stdin.write('y');
    await settle();
    expect(await first).toBe('once');
    await settleRendered();
    // The head is now the second ask; deny it.
    stdin.write('n');
    await settle();
    expect(await second).toBe('deny');
    app.stop();
  });

  it('shows the queued-prompt count in the status bar', async () => {
    const { app, out } = makeApp({ queuedCount: () => 2 });
    app.start();
    app.printNotice('tick');
    await settleRendered();
    expect(out.text()).toContain('⧗ 2');
    app.stop();
  });

  it('rebinds a global toggle through keyOverrides', async () => {
    const { app, out, stdin } = makeApp({ keyOverrides: { history: 'F2' }, history: ['old prompt'] });
    app.start();
    await settle();
    stdin.write('\x1bOQ'); // F2
    await settleRendered();
    expect(out.text()).toContain('Input history');
    expect(out.text()).toContain('old prompt');
    app.stop();
  });
});
