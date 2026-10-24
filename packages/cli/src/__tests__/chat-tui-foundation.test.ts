import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { CancelAgentRunResult, RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';

interface FakeTuiOptions {
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  readonly isBusy: () => boolean;
  readonly queuedDrafts: () => readonly { readonly text: string; readonly mode: 'steer' | 'queue' }[];
  readonly queuePaused: () => boolean;
  readonly onSteer: (text: string) => void | Promise<void>;
  readonly onQueueDraft: (text: string) => void | Promise<void>;
  readonly onInterruptAndSend: (text: string) => void;
}

interface FakeTui {
  readonly options: FakeTuiOptions;
  readonly users: string[];
  readonly frames: unknown[];
  readonly errors: string[];
  readonly recalled: string[];
  chooseAnswers: ChooseAnswer[];
  stopped: boolean;
}

/** One scripted answer for `choose`: a value, a null, or a function of the rows. */
type ChooseAnswer =
  | string
  | null
  | ((choices: readonly { readonly value: string }[]) => string | null);

const harness = vi.hoisted(() => ({ app: null as FakeTui | null }));

vi.mock('../tui/index.js', () => ({
  TUIApp: class {
    readonly users: string[] = [];
    readonly frames: unknown[] = [];
    readonly errors: string[] = [];
    readonly recalled: string[] = [];
    chooseAnswers: ChooseAnswer[] = [];
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
    recallIntoComposer(text: string): void { this.recalled.push(text); }
    chooseFiltered(): Promise<string | null> { return Promise.resolve(null); }
    choose(
      _title: string,
      choices: readonly { readonly value: string }[],
    ): Promise<string | null> {
      const next = this.chooseAnswers.shift();
      if (typeof next === 'function') return Promise.resolve(next(choices));
      return Promise.resolve(next ?? null);
    }
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
    expect(app.options.queuedDrafts().map((draft) => draft.text)).toEqual(['second']);

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
    expect(app.options.queuedDrafts().map((draft) => draft.text)).toEqual(['pending']);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  /**
   * A steer is written into the running turn's mailbox, not queued behind it.
   * The trap this pins: the row may be claimed by the turn that just ended, so
   * the local draft must recognise "already delivered" and skip instead of
   * starting a second turn with the same text.
   */
  it('writes a steer into the running turn and never sends it twice', async () => {
    const acceptance = deferred<{ accepted: true; runId: RunId }>();
    const firstStream = deferred<void>();
    const starts: string[] = [];
    const enqueued: { content: string; kind: string; submittedRunId: string }[] = [];
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
      enqueue: vi.fn(async (input: { content: string; kind: string; submittedRunId: string }) => {
        enqueued.push(input);
        return { id: 'row-1', status: 'pending', content: input.content };
      }),
      getItem: vi.fn(async () => ({ id: 'row-1', status: 'applied', content: 'steer me' })),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => starts.length === 1);
    acceptance.resolve({ accepted: true, runId: 'run-first' as RunId });
    await waitUntil(() => app.options.isBusy());

    await app.options.onSteer('steer me');
    expect(enqueued).toEqual([
      expect.objectContaining({ content: 'steer me', kind: 'followup', submittedRunId: 'run-first' }),
    ]);
    expect(app.users).toEqual(['first', 'steer me']);
    expect(app.options.queuedDrafts()).toEqual([{ text: 'steer me', mode: 'steer' }]);

    firstStream.resolve();
    await waitUntil(() => !app.options.isBusy());
    expect(starts).toEqual(['first']);
    expect(app.users).toEqual(['first', 'steer me']);
    expect(app.options.queuedDrafts()).toEqual([]);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('sends a queued draft as the next turn once the running turn ends', async () => {
    const firstStream = deferred<void>();
    const starts: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return Promise.resolve({ accepted: true as const, runId: `run-${prompt}` as RunId });
      }),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => app.options.isBusy());
    app.options.onQueueDraft('later');
    expect(app.options.queuedDrafts()).toEqual([{ text: 'later', mode: 'queue' }]);
    expect(starts).toEqual(['first']);

    firstStream.resolve();
    await waitUntil(() => starts.length === 2 && !app.options.isBusy());
    expect(starts).toEqual(['first', 'later']);
    expect(app.users).toEqual(['first', 'later']);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('stops the running turn and sends the interrupted draft next', async () => {
    const acceptance = deferred<{ accepted: true; runId: RunId }>();
    const cancelled: string[] = [];
    const starts: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return starts.length === 1
          ? acceptance.promise
          : Promise.resolve({ accepted: true as const, runId: `run-${prompt}` as RunId });
      }),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId, { signal }: { signal: AbortSignal }) {
        if (runId !== 'run-first') return;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }),
      cancelAgentRun: vi.fn(async (runId: RunId) => {
        cancelled.push(runId);
        return { requested: true, runId, terminal: { status: 'cancelled' } };
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => starts.length === 1);
    acceptance.resolve({ accepted: true, runId: 'run-first' as RunId });
    await waitUntil(() => app.options.isBusy());

    app.options.onInterruptAndSend('correction');
    await waitUntil(() => starts.length === 2 && !app.options.isBusy());
    expect(cancelled).toContain('run-first');
    expect(starts).toEqual(['first', 'correction']);
    expect(app.users).toEqual(['first', 'correction']);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('sends a held draft into the running turn from the /queue panel', async () => {
    const firstStream = deferred<void>();
    const starts: string[] = [];
    const enqueued: { content: string; kind: string }[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return Promise.resolve({ accepted: true as const, runId: `run-${prompt}` as RunId });
      }),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
      enqueue: vi.fn(async (input: { content: string; kind: string }) => {
        enqueued.push(input);
        return { id: 'row-9', status: 'pending', content: input.content };
      }),
      getItem: vi.fn(async () => ({ id: 'row-9', status: 'applied', content: 'held' })),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => app.options.isBusy());
    app.options.onQueueDraft('held');
    expect(app.options.queuedDrafts()).toEqual([{ text: 'held', mode: 'queue' }]);

    app.chooseAnswers.push((choices) => choices[0]?.value ?? null, 'send');
    app.options.onSubmit('/queue');
    await waitUntil(() => enqueued.length === 1);

    expect(enqueued[0]).toMatchObject({ content: 'held', kind: 'followup' });
    expect(app.options.queuedDrafts()).toEqual([{ text: 'held', mode: 'steer' }]);
    expect(app.users).toEqual(['first', 'held']);

    firstStream.resolve();
    await waitUntil(() => !app.options.isBusy());
    // The turn read the steer, so the draft leaves without a second turn.
    expect(starts).toEqual(['first']);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('sends a send-now draft as one user line even when the old turn missed it', async () => {
    const firstStream = deferred<void>();
    const starts: string[] = [];
    const cancelled: { id: string; reason?: string }[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(({ prompt }: { prompt: string }) => {
        starts.push(prompt);
        return Promise.resolve({ accepted: true as const, runId: `run-${prompt}` as RunId });
      }),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
      enqueue: vi.fn(async (input: { content: string }) => ({ id: 'row-9', status: 'pending', content: input.content })),
      getItem: vi.fn(async () => ({ id: 'row-9', status: 'pending', content: 'held' })),
      cancel: vi.fn(async (id: string, reason?: string) => {
        cancelled.push({ id, reason });
        return { id, status: 'cancelled', content: 'held' };
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => app.options.isBusy());
    app.options.onQueueDraft('held');
    app.chooseAnswers.push((choices) => choices[0]?.value ?? null, 'send');
    app.options.onSubmit('/queue');
    await waitUntil(() => app.options.queuedDrafts()[0]?.mode === 'steer');

    // The run settles before its next model boundary, so the steer never
    // reaches it: the drain sends the row's text as a new turn instead.
    firstStream.resolve();
    await waitUntil(() => starts.length === 2);
    expect(cancelled).toEqual([{ id: 'row-9', reason: 'steer_missed_turn' }]);
    expect(starts).toEqual(['first', 'held']);
    // It was echoed when the user pressed send now; taking it over must not
    // print the same line twice.
    expect(app.users).toEqual(['first', 'held']);

    await waitUntil(() => !app.options.isBusy());
    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('withdraws a steer by its mailbox row from the /queue panel', async () => {
    const firstStream = deferred<void>();
    const cancelled: { id: string; reason?: string }[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(async ({ prompt }: { prompt: string }) => ({
        accepted: true as const,
        runId: `run-${prompt}` as RunId,
      })),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
      enqueue: vi.fn(async (input: { content: string }) => ({ id: 'row-1', status: 'pending', content: input.content })),
      cancel: vi.fn(async (id: string, reason?: string) => {
        cancelled.push({ id, reason });
        return { id, status: 'cancelled' };
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => app.options.isBusy());
    await app.options.onSteer('steer me');

    app.chooseAnswers.push((choices) => choices[0]?.value ?? null, 'withdraw');
    app.options.onSubmit('/queue');
    await waitUntil(() => cancelled.length === 1);

    expect(cancelled[0]).toEqual({ id: 'row-1', reason: 'user_withdrew_steer' });
    expect(app.options.queuedDrafts()).toEqual([]);

    firstStream.resolve();
    await waitUntil(() => !app.options.isBusy());
    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('recalls a steer to the composer and withdraws its mailbox row', async () => {
    const firstStream = deferred<void>();
    const cancelled: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(async ({ prompt }: { prompt: string }) => ({
        accepted: true as const,
        runId: `run-${prompt}` as RunId,
      })),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
      enqueue: vi.fn(async (input: { content: string }) => ({ id: 'row-2', status: 'pending', content: input.content })),
      cancel: vi.fn(async (id: string) => {
        cancelled.push(id);
        return { id, status: 'cancelled' };
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => app.options.isBusy());
    await app.options.onSteer('half a thought');

    app.chooseAnswers.push((choices) => choices[0]?.value ?? null, 'recall');
    app.options.onSubmit('/queue');
    await waitUntil(() => app.recalled.length === 1);

    expect(app.recalled).toEqual(['half a thought']);
    expect(cancelled).toEqual(['row-2']);
    expect(app.options.queuedDrafts()).toEqual([]);

    firstStream.resolve();
    await waitUntil(() => !app.options.isBusy());
    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('withdraws every held steer when /queue clear drops the drafts', async () => {
    const firstStream = deferred<void>();
    const cancelled: string[] = [];
    const client = makeClient({
      startAgentRun: vi.fn(async ({ prompt }: { prompt: string }) => ({
        accepted: true as const,
        runId: `run-${prompt}` as RunId,
      })),
      watchAgentRunEvents: vi.fn(async function* (runId: RunId) {
        if (runId === 'run-first') await firstStream.promise;
      }),
      enqueue: vi.fn(async (input: { content: string }) => ({ id: 'row-3', status: 'pending', content: input.content })),
      cancel: vi.fn(async (id: string) => {
        cancelled.push(id);
        return { id, status: 'cancelled' };
      }),
    });
    const { running, app } = await startChat(client);

    app.options.onSubmit('first');
    await waitUntil(() => app.options.isBusy());
    await app.options.onSteer('steer me');
    app.options.onQueueDraft('and this later');

    app.options.onSubmit('/queue clear');
    await waitUntil(() => cancelled.length === 1);

    expect(cancelled).toEqual(['row-3']);
    expect(app.options.queuedDrafts()).toEqual([]);

    firstStream.resolve();
    await waitUntil(() => !app.options.isBusy());
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
