/**
 * The real Host: a chat surface that is opened and closed without a message
 * leaves nothing behind.
 *
 * The mocked suite next door proves the wiring; this one proves the
 * contract the wiring depends on. Everything here is production code: a real
 * Host on a loopback port, a real SQLite database in a throwaway data root,
 * the real HTTP API, and the real session store. Only the terminal painter is
 * replaced, because a terminal is the one thing a test cannot provide.
 *
 * What it pins down:
 *   1. the session a surface created and never used is gone from the Host's
 *      session list after the surface closes — not merely hidden from it;
 *   2. a session that received a message is still there afterwards, because
 *      "empty" is the only reason to delete anything;
 *   3. an empty session is invisible to the resume picker, while a session
 *      with messages is offered.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost } from '@duya/host/local-host';
import type { SessionId } from '@duya/agent-protocol';

interface View {
  readonly options: {
    onSubmit(text: string): void;
    onInterrupt(): void;
    onExit(): void;
    isBusy(): boolean;
  };
  readonly errors: string[];
  readonly filteredChoices: { readonly title: string; readonly labels: readonly string[] }[];
}

const harness = vi.hoisted(() => ({ view: null as View | null, useTui: true }));

vi.mock('../tui/index.js', () => ({
  shouldUseTui: () => harness.useTui,
  TUIApp: class {
    readonly errors: string[] = [];
    readonly filteredChoices: { title: string; labels: string[] }[] = [];
    constructor(readonly options: View['options']) { harness.view = this as unknown as View; }
    start() {}
    stop() {}
    setBusy() {}
    refresh() {}
    printUser() {}
    printNotice() {}
    printError(message: string) { this.errors.push(message); }
    push() {}
    replaceTranscript() {}
    clearTranscript() {}
    chooseFiltered(title: string, choices: readonly { label: string }[]) {
      this.filteredChoices.push({ title, labels: choices.map((choice) => choice.label) });
      return Promise.resolve(null);
    }
    choose() { return Promise.resolve(null); }
  },
}));

// The readline fallback: a terminal that is not a TTY gets a plain REPL
// instead of the full-screen surface. Only the prompt loop is replaced —
// the surface still runs the real Host client underneath it.
vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      prompt: () => {},
      close: () => {},
      on: (event: string, handler: () => void) => {
        if (event === 'close') queueMicrotask(handler);
      },
    }),
  },
}));

import { chatInteractive, chatTui } from '../chat.js';
import { OwnedSessions } from '../owned-sessions.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the TUI to start');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** A worker that never answers: no run is started in this suite. */
const IDLE_WORKER = `
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', () => {});
  process.on('disconnect', () => process.exit(0));
`;

async function withHost(
  run: (client: HostSessionHttpClient, root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-empty-session-'));
  const workerPath = path.join(root, 'worker.cjs');
  await fs.writeFile(workerPath, IDLE_WORKER);
  const host = await startLocalHost({ dataRoot: root, ephemeral: true, workerPath });
  const client = new HostSessionHttpClient(host.origin, host.token ?? '');
  try {
    await run(client, root);
  } finally {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** The sessions the Host would show a user right now. */
async function visibleSessions(client: HostSessionHttpClient): Promise<{ id: string; timelineCount: number }[]> {
  const page = await client.list({ includeAllSessions: true, includeArchived: false, includeDeleted: false, limit: 100 });
  return page.sessions.map((item) => ({ id: item.session.id, timelineCount: item.timelineCount }));
}

async function createSession(client: HostSessionHttpClient, id: string, title: string) {
  await client.createImportedSession({ sessionId: id, title, workingDirectory: os.tmpdir(), projectName: 'duya' });
  return id as SessionId;
}

describe('a chat surface against a real Host', () => {
  afterEach(() => { harness.view = null; harness.useTui = true; });

  it('deletes the session it created and never used', async () => {
    await withHost(async (client) => {
      const sessionId = await createSession(client, 'empty-session', 'duya chat');
      expect((await visibleSessions(client)).map((item) => item.id)).toContain(sessionId);

      const owned = new OwnedSessions();
      owned.own(sessionId);
      const running = chatTui(client, sessionId, {}, owned);
      await until(() => harness.view !== null);
      harness.view!.options.onExit();
      await expect(running).resolves.toBe(0);

      expect(await client.countTimeline(sessionId)).toBe(0);
      expect((await visibleSessions(client)).map((item) => item.id)).not.toContain(sessionId);
    });
  });

  it('deletes the session it created on the readline surface too', async () => {
    harness.useTui = false;
    await withHost(async (client) => {
      const sessionId = await createSession(client, 'empty-repl-session', 'duya chat');
      expect((await visibleSessions(client)).map((item) => item.id)).toContain(sessionId);

      const owned = new OwnedSessions();
      owned.own(sessionId);
      await expect(chatInteractive(client, sessionId, {}, owned)).resolves.toBe(0);

      expect((await visibleSessions(client)).map((item) => item.id)).not.toContain(sessionId);
    });
  });

  it('keeps a session whose turn was started, even with an empty timeline', async () => {
    await withHost(async (client) => {
      const sessionId = await createSession(client, 'cancelled-turn-session', 'duya chat');
      expect(await client.countTimeline(sessionId)).toBe(0);

      const owned = new OwnedSessions();
      owned.own(sessionId);
      // A turn was started on it: the worker writes the user's message into
      // the timeline, so an empty timeline here does not mean "nothing was
      // said".
      owned.markUsed(sessionId);
      const running = chatTui(client, sessionId, {}, owned);
      await until(() => harness.view !== null);
      harness.view!.options.onExit();
      await expect(running).resolves.toBe(0);

      expect((await visibleSessions(client)).map((item) => item.id)).toContain(sessionId);
    });
  });

  it('keeps a session that received a message', async () => {
    await withHost(async (client) => {
      const sessionId = await createSession(client, 'used-session', 'a real conversation');
      await client.appendTimeline(sessionId, {
        entries: [{
          id: 'entry-1',
          type: 'message',
          parentId: null,
          createdAt: Date.now(),
          message: { role: 'user', content: 'hello' },
        } as never],
      });
      expect(await client.countTimeline(sessionId)).toBe(1);

      const owned = new OwnedSessions();
      owned.own(sessionId);
      const running = chatTui(client, sessionId, {}, owned);
      await until(() => harness.view !== null);
      harness.view!.options.onExit();
      await expect(running).resolves.toBe(0);

      expect((await visibleSessions(client)).map((item) => item.id)).toContain(sessionId);
    });
  });

  it('offers a session with messages in the resume picker and hides an empty one', async () => {
    await withHost(async (client) => {
      const emptyId = await createSession(client, 'ghost-session', 'duya chat');
      const usedId = await createSession(client, 'real-session', 'a real conversation');
      await client.appendTimeline(usedId, {
        entries: [{
          id: 'entry-1',
          type: 'message',
          parentId: null,
          createdAt: Date.now(),
          message: { role: 'user', content: 'hello' },
        } as never],
      });

      const running = chatTui(client, emptyId, {}, undefined);
      await until(() => harness.view !== null);
      const view = harness.view!;
      view.options.onSubmit('/resume');
      await until(() => view.filteredChoices.length > 0);

      const offered = view.filteredChoices.at(-1)?.labels ?? [];
      expect(offered.some((label) => label.includes('a real conversation'))).toBe(true);
      expect(offered.some((label) => label.includes('duya chat'))).toBe(false);

      view.options.onExit();
      await expect(running).resolves.toBe(0);
    });
  });
});
