import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { HostSessionListItem, RunId, SessionId } from '@duya/agent-protocol';

/**
 * The two halves of "opening a chat and closing it leaves nothing behind":
 *
 *   1. the resume picker never offers a session that has no messages, so the
 *      ghosts left by earlier runs are not offered to the user either;
 *   2. the session a chat surface created and never used is deleted when that
 *      surface closes, so the row stops existing at all.
 *
 * Both are asserted against the same fake the other chat tests use: a stubbed
 * TUIApp and a stubbed Host client.
 */

interface FakeTuiOptions {
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  readonly isBusy: () => boolean;
  readonly queuedDrafts: () => readonly { readonly text: string; readonly mode: 'steer' | 'queue' }[];
  readonly queuePaused: () => boolean;
}

interface FakeTui {
  readonly options: FakeTuiOptions;
  readonly errors: string[];
  /** Every `chooseFiltered` call, in order: [title, choices]. */
  readonly filteredChoices: { readonly title: string; readonly labels: readonly string[] }[];
  stopped: boolean;
}

const harness = vi.hoisted(() => ({ app: null as FakeTui | null }));

vi.mock('../tui/index.js', () => ({
  TUIApp: class {
    readonly errors: string[] = [];
    readonly filteredChoices: { title: string; labels: string[] }[] = [];
    stopped = false;
    readonly options: FakeTuiOptions;

    constructor(options: FakeTuiOptions) {
      this.options = options;
      harness.app = this as unknown as FakeTui;
    }

    start(): void {}
    stop(): void { this.stopped = true; }
    setBusy(_busy: boolean): void {}
    refresh(): void {}
    printUser(_text: string): void {}
    push(_frame: unknown): void {}
    printError(message: string): void { this.errors.push(message); }
    printNotice(_message: string): void {}
    replaceTranscript(_messages: unknown): void {}
    clearTranscript(): void {}
    choose(): Promise<string | null> { return Promise.resolve(null); }
    chooseFiltered(title: string, choices: readonly { label: string }[]): Promise<string | null> {
      this.filteredChoices.push({ title, labels: choices.map((choice) => choice.label) });
      return Promise.resolve(null);
    }
  },
  shouldUseTui: () => true,
}));

vi.mock('@duya/host/http-client', () => ({ HostSessionHttpClient: class {} }));
vi.mock('@duya/host/local-host', () => ({ startLocalHost: vi.fn() }));
vi.mock('@duya/data', () => ({ resolveDataRoot: () => '' }));

import { chatTui } from '../chat.js';
import { OwnedSessions } from '../owned-sessions.js';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for chat TUI state');
}

function session(id: string, title: string) {
  return {
    id: id as SessionId,
    workspace: { state: 'unbound' },
    title,
    providerId: 'anthropic',
    model: 'test-model',
  };
}

function listItem(id: string, title: string, timelineCount: number): HostSessionListItem {
  return { session: session(id, title) as never, timelineCount };
}

function makeClient(overrides: Record<string, unknown> = {}): HostSessionHttpClient {
  const defaults = {
    get: vi.fn(async () => session('session-1', 'Test session')),
    list: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    readMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    countTimeline: vi.fn(async () => 0),
    delete: vi.fn(async () => ({ deleted: true })),
    startAgentRun: vi.fn(async ({ prompt }: { prompt: string }) => ({
      accepted: true,
      runId: `run-${prompt}` as RunId,
    })),
    watchAgentRunEvents: vi.fn(async function* (_runId: RunId) {}),
    getAgentRun: vi.fn(async () => ({ status: 'completed' })),
    cancelAgentRun: vi.fn(async () => undefined),
  };
  return { ...defaults, ...overrides } as unknown as HostSessionHttpClient;
}

async function startChat(
  client: HostSessionHttpClient,
  owned?: OwnedSessions,
): Promise<{ readonly running: Promise<number>; readonly app: FakeTui }> {
  const running = chatTui(client, 'session-1' as SessionId, {}, owned);
  await waitUntil(() => harness.app !== null);
  return { running, app: harness.app! };
}

describe('empty chat sessions', () => {
  beforeEach(() => { harness.app = null; });

  it('never offers a session without messages in the resume picker', async () => {
    const client = makeClient({
      list: vi.fn(async () => ({
        sessions: [
          listItem('empty-1', 'duya chat', 0),
          listItem('used-1', 'a real conversation', 12),
          listItem('empty-2', 'duya chat', 0),
        ],
        nextCursor: null,
      })),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('/resume');
    await waitUntil(() => app.filteredChoices.length > 0);

    const offered = app.filteredChoices.at(-1)?.labels ?? [];
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain('a real conversation');
    expect(offered.some((label) => label.includes('duya chat'))).toBe(false);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('deletes the session it created when the chat closes without a message', async () => {
    const client = makeClient();
    const owned = new OwnedSessions();
    owned.own('session-1' as SessionId);
    const { running, app } = await startChat(client, owned);

    app.options.onExit();
    await expect(running).resolves.toBe(0);

    expect(client.countTimeline).toHaveBeenCalledWith('session-1');
    expect(client.delete).toHaveBeenCalledWith('session-1');
  });

  it('keeps a session that received a message', async () => {
    const client = makeClient({ countTimeline: vi.fn(async () => 12) });
    const owned = new OwnedSessions();
    owned.own('session-1' as SessionId);
    const { running, app } = await startChat(client, owned);

    app.options.onExit();
    await expect(running).resolves.toBe(0);

    expect(client.delete).not.toHaveBeenCalled();
  });

  it('keeps a session whose turn was started, even with an empty timeline', async () => {
    // The worker writes the user's message into the timeline, and a turn
    // cancelled before that leaves the session empty. Deleting it would
    // throw away what the user typed.
    const client = makeClient({ countTimeline: vi.fn(async () => 0) });
    const owned = new OwnedSessions();
    owned.own('session-1' as SessionId);
    owned.markUsed('session-1' as SessionId);
    const { running, app } = await startChat(client, owned);

    app.options.onExit();
    await expect(running).resolves.toBe(0);

    expect(client.delete).not.toHaveBeenCalled();
  });

  it('leaves a session the user resumed alone', async () => {
    const client = makeClient();
    // Nothing is owned: the surface opened a session somebody else created.
    const { running, app } = await startChat(client);

    app.options.onExit();
    await expect(running).resolves.toBe(0);

    expect(client.delete).not.toHaveBeenCalled();
  });
});

describe('OwnedSessions', () => {
  it('deletes an owned session with an empty timeline and keeps one with content', async () => {
    const client = makeClient({
      countTimeline: vi.fn(async (id: string) => (id === 'used' ? 3 : 0)),
    });
    const owned = new OwnedSessions();
    owned.own('empty' as SessionId);
    owned.own('used' as SessionId);

    await owned.releaseEmpty(client);

    expect(client.delete).toHaveBeenCalledTimes(1);
    expect(client.delete).toHaveBeenCalledWith('empty');
  });

  it('survives a Host that cannot answer', async () => {
    const client = makeClient({
      countTimeline: vi.fn(async () => { throw new Error('Host is gone'); }),
    });
    const owned = new OwnedSessions();
    owned.own('session-1' as SessionId);

    await expect(owned.releaseEmpty(client)).resolves.toBeUndefined();
    expect(client.delete).not.toHaveBeenCalled();
  });
});
