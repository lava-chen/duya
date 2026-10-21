import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { CancelAgentRunResult, RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';

interface FakeTuiOptions {
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  readonly isBusy: () => boolean;
  readonly queuedPrompts: () => readonly string[];
  readonly queuePaused: () => boolean;
}

interface FakeTui {
  readonly options: FakeTuiOptions;
  readonly users: string[];
  readonly frames: unknown[];
  readonly errors: string[];
  stopped: boolean;
}

const harness = vi.hoisted(() => ({ app: null as FakeTui | null }));

vi.mock('../tui/index.js', () => ({
  TUIApp: class {
    readonly users: string[] = [];
    readonly frames: unknown[] = [];
    readonly errors: string[] = [];
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
    printUser(text: string): void { this.users.push(text); }
    push(frame: unknown): void { this.frames.push(frame); }
    printError(message: string): void { this.errors.push(message); }
    printNotice(_message: string): void {}
    replaceTranscript(_messages: unknown): void {}
    clearTranscript(): void {}
    chooseFiltered(): Promise<string | null> { return Promise.resolve(null); }
    choose(): Promise<string | null> { return Promise.resolve(null); }
  },
  shouldUseTui: () => true,
}));

vi.mock('@duya/host/http-client', () => ({ HostSessionHttpClient: class {} }));
vi.mock('@duya/host/local-host', () => ({ startLocalHost: vi.fn() }));
vi.mock('@duya/data', () => ({ resolveDataRoot: () => '' }));

import { chatTui } from '../chat.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for chat TUI state');
}

function session() {
  return {
    id: 'session-1' as SessionId,
    workspace: { state: 'unbound' },
    title: 'Test session',
    providerId: 'anthropic',
    model: 'test-model',
  };
}

function makeClient(overrides: Record<string, unknown> = {}): HostSessionHttpClient {
  const defaults = {
    get: vi.fn(async () => session()),
    list: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    readMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
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

function envelope(seq: number, runId: string, text: string, sessionId = 'session-1') {
  return {
    sessionId,
    runId,
    seq,
    payload: { type: 'assistant.text_delta', delta: text },
  } as RunEventEnvelope;
}

async function startChat(client: HostSessionHttpClient): Promise<{
  readonly running: Promise<number>;
  readonly app: FakeTui;
}> {
  const running = chatTui(client, 'session-1' as SessionId, {});
  await waitUntil(() => harness.app !== null);
  return { running, app: harness.app! };
}

describe('chatTui production callback wiring', () => {
  it('refuses admission when a failed cancellation leaves the old run live', async () => {
    const client = makeClient({
      watchAgentRunEvents: vi.fn(async function* (_id: RunId, { signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }),
      cancelAgentRun: vi.fn(async () => { throw new Error('Host cancel unavailable'); }),
      getAgentRun: vi.fn(async () => ({ status: 'running' })),
    });
    const { running, app } = await startChat(client);
    app.options.onSubmit('first');
    await waitUntil(() => vi.mocked(client.watchAgentRunEvents).mock.calls.length === 1);
    app.options.onInterrupt();
    await waitUntil(() => !app.options.isBusy());
    app.options.onSubmit('second');
    await waitUntil(() => app.errors.some((message) => message.includes('no new run was started')));
    expect(client.startAgentRun).toHaveBeenCalledTimes(1);
    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('holds admission until an interrupted live run has finished cancelling', async () => {
    const cancellation = deferred<CancelAgentRunResult>();
    const starts: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(async ({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return { accepted: true, runId: ('run-' + prompt) as RunId };
      }),
      watchAgentRunEvents: vi.fn(async function* (_runId: RunId, { signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }),
      // The Host answers a cancel with a `CancelAgentRunResult` — the shape
      // `chat.ts` reads `requested` and `terminal` off. A bare `undefined` is
      // not a value the API can produce, and reading it made the whole
      // cancellation look like a failure.
      cancelAgentRun: vi.fn(() => cancellation.promise),
    });
    const { running, app } = await startChat(client);
    app.options.onSubmit('first');
    await waitUntil(() => vi.mocked(client.watchAgentRunEvents).mock.calls.length === 1);
    app.options.onInterrupt();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(app.options.isBusy()).toBe(true);
    app.options.onSubmit('second');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(['first']);
    cancellation.resolve({ requested: true, runId: 'run-first' as RunId });
    await waitUntil(() => starts.length === 2);
    await waitUntil(() => vi.mocked(client.watchAgentRunEvents).mock.calls.length === 2);
    app.options.onInterrupt();
    await waitUntil(() => !app.options.isBusy());
    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  beforeEach(() => { harness.app = null; });
  afterEach(() => { harness.app?.options.onExit(); });

  it('admits one run at a time and drains pending drafts in FIFO order', async () => {
    const acceptance = deferred<{ accepted: true; runId: RunId }>();
    const firstStream = deferred<void>();
    const starts: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return starts.length === 1
          ? acceptance.promise
          : Promise.resolve({ accepted: true as const, runId: `run-${prompt}` as RunId });
      }),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => starts.length === 1);
    app.options.onSubmit('second');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(starts).toEqual(['first']);
    expect(app.users).toEqual(['first']);
    expect(app.options.queuedPrompts()).toEqual(['second']);

    acceptance.resolve({ accepted: true, runId: 'run-first' as RunId });
    await waitUntil(() => app.options.isBusy());
    expect(starts).toEqual(['first']);
    expect(app.users).toEqual(['first']);

    firstStream.resolve();
    await waitUntil(() => starts.length === 2);
    expect(starts).toEqual(['first', 'second']);
    expect(app.users).toEqual(['first', 'second']);
    await waitUntil(() => !app.options.isBusy());
    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('cancels a run accepted after interrupt and pauses queued work', async () => {
    const acceptance = deferred<{ accepted: true; runId: RunId }>();
    const cancelled: string[] = [];
    const starts: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return acceptance.promise;
      }),
      cancelAgentRun: vi.fn(async (runId: RunId) => {
        cancelled.push(runId);
        return { requested: true, runId } satisfies CancelAgentRunResult;
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('active');
    await waitUntil(() => starts.length === 1);
    app.options.onSubmit('pending');
    app.options.onInterrupt();
    acceptance.resolve({ accepted: true, runId: 'run-active' as RunId });

    await waitUntil(() => cancelled.includes('run-active') && !app.options.isBusy());
    expect(starts).toEqual(['active']);
    expect(cancelled).toContain('run-active');
    expect(app.options.queuePaused()).toBe(true);
    expect(app.options.queuedPrompts()).toEqual(['pending']);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('filters duplicate, stale and foreign-run events before pushing frames', async () => {
    const client = makeClient({
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        yield envelope(1, runId, 'accepted');
        yield envelope(1, runId, 'duplicate');
        yield envelope(0, runId, 'stale');
        yield envelope(2, 'other-run', 'foreign');
        yield envelope(2, runId, 'next');
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('prompt');
    await waitUntil(() => !app.options.isBusy());

    expect(app.frames).toHaveLength(2);
    expect(app.frames.map((frame) => (frame as { data: { content: string } }).data.content))
      .toEqual(['accepted', 'next']);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('stops on exit and discards queued work, including while start is pending', async () => {
    const acceptance = deferred<{ accepted: true; runId: RunId }>();
    const cancellation = deferred<void>();
    const starts: string[] = [];
    const cancelled: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return acceptance.promise;
      }),
      cancelAgentRun: vi.fn(async (runId: RunId) => {
        cancelled.push(runId);
        await cancellation.promise;
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('active');
    await waitUntil(() => starts.length === 1);
    app.options.onSubmit('queued');
    app.options.onExit();
    expect(app.stopped).toBe(true);
    let exited = false;
    void running.then(() => { exited = true; });
    await Promise.resolve();
    expect(exited).toBe(false);

    acceptance.resolve({ accepted: true, runId: 'run-active' as RunId });
    await waitUntil(() => cancelled.includes('run-active'));
    expect(exited).toBe(false);
    cancellation.resolve();
    await expect(running).resolves.toBe(0);
    expect(starts).toEqual(['active']);
    expect(app.users).toEqual(['active']);
  });
});
