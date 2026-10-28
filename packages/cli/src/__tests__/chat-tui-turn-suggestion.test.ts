/**
 * The predicted next prompt at a session boundary.
 *
 * The worker predicts the prompt the user is most likely to send next and the
 * chat loop draws it in the composer's placeholder. That prediction belongs to
 * the session that produced it: after `/new` (or `/resume`, or `/project`) the
 * new conversation has no turn to predict from, and the old suggestion left in
 * the composer would be sent to a conversation it has nothing to do with.
 *
 * The chat loop is the only place that knows a session boundary happened, so
 * this is where the suggestion is retired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { RunId, SessionId } from '@duya/agent-protocol';

interface FakeTuiOptions {
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  readonly isBusy: () => boolean;
  readonly queuedDrafts: () => readonly { readonly text: string; readonly mode: 'steer' | 'queue' }[];
  readonly queuePaused: () => boolean;
  /** The next prompt the worker predicted for the turn that ended. */
  readonly turnSuggestion: () => string | null;
}

interface FakeTui {
  readonly options: FakeTuiOptions;
  readonly notices: string[];
  readonly errors: string[];
  stopped: boolean;
}

const harness = vi.hoisted(() => ({ app: null as FakeTui | null }));

vi.mock('../tui/index.js', () => ({
  TUIApp: class {
    readonly notices: string[] = [];
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
    printUser(_text: string): void {}
    push(_frame: unknown): void {}
    printError(message: string): void { this.errors.push(message); }
    printNotice(message: string): void { this.notices.push(message); }
    replaceTranscript(_messages: unknown): void {}
    clearTranscript(): void {}
    recallIntoComposer(_text: string): void {}
    choose(): Promise<string | null> { return Promise.resolve(null); }
    chooseFiltered(): Promise<string | null> { return Promise.resolve(null); }
    setBackgroundTasks(_snapshot: unknown): void {}
    hasRunningBackgroundTasks(): boolean { return false; }
    isTaskViewOpen(): boolean { return false; }
    showPanel(_title: string, _lines: readonly string[]): void {}
    recheckCompletion(): void {}
  },
  shouldUseTui: () => true,
}));

vi.mock('@duya/host/http-client', () => ({ HostSessionHttpClient: class {} }));
vi.mock('@duya/host/local-host', () => ({ startLocalHost: vi.fn() }));
vi.mock('@duya/data', () => ({ resolveDataRoot: () => '' }));

import { chatTui } from '../chat.js';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for chat TUI state');
}

function session(id: string) {
  return {
    id: id as SessionId,
    workspace: { state: 'unbound' },
    title: 'Test session',
    providerId: 'anthropic',
    model: 'test-model',
  };
}

interface Harness {
  readonly app: FakeTui;
  readonly running: Promise<number>;
  readonly created: Array<Record<string, unknown>>;
}

async function startHarness(suggestion: string): Promise<Harness> {
  const created: Array<Record<string, unknown>> = [];

  const client = {
    get: vi.fn(async () => session('session-1')),
    list: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    readMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    countTimeline: vi.fn(async () => 0),
    delete: vi.fn(async () => ({ deleted: true })),
    readLocalSession: vi.fn(async () => ({ workingDirectory: process.cwd() })),
    listLocalSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    registerLocalDirectory: vi.fn(async () => ({
      workspaceId: 'ws-1',
      rootId: 'root-1',
      relativePath: '',
    })),
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return {
        ...session(`session-${created.length + 1}`),
        workspace: { state: 'bound', workspaceId: input.workspaceId },
      };
    }),
    startAgentRun: vi.fn(async () => ({ accepted: true, runId: 'run-1' as RunId })),
    watchAgentRunEvents: vi.fn(async function* () {
      // No frames: the run is over as soon as the record says so.
    }),
    getAgentRun: vi.fn(async () => ({ status: 'completed' })),
    cancelAgentRun: vi.fn(async () => undefined),
    listBackgroundTasks: vi.fn(async () => ({ observed: false, tasks: [] })),
    readBackgroundTaskOutput: vi.fn(async () => null),
    getLatestTurnSuggestion: vi.fn(async () => ({
      id: 'suggestion-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      suggestion,
      createdAt: Date.now(),
    })),
  } as unknown as HostSessionHttpClient;

  harness.app = null;
  const running = chatTui(client, 'session-1' as SessionId, {});
  await waitUntil(() => harness.app !== null);
  return { app: harness.app!, running, created };
}

describe('chatTui turn suggestion', () => {
  beforeEach(() => { harness.app = null; });
  afterEach(async () => {
    harness.app?.options.onExit();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('carries the prediction of the finished turn into the composer', async () => {
    const { app } = await startHarness('now run the failing test');

    app.options.onSubmit('do the thing');
    await waitUntil(() => app.options.turnSuggestion() !== null);

    expect(app.options.turnSuggestion()).toBe('now run the failing test');
  });

  it('retires the prediction when /new opens another session', async () => {
    const { app, created } = await startHarness('now run the failing test');

    app.options.onSubmit('do the thing');
    await waitUntil(() => app.options.turnSuggestion() !== null);
    // A live run owns the session, and `/new` asked during it is refused
    // rather than queued.
    await waitUntil(() => !app.options.isBusy());

    app.options.onSubmit('/new');
    // The notice is the last thing the switch prints, so it is the point where
    // the switch has already retired the old prediction.
    await waitUntil(() => app.notices.join('\n').includes('Started a new session'));

    // The new session has no turn to predict from: the old suggestion must not
    // sit in the composer waiting to be sent to the wrong conversation.
    expect(app.options.turnSuggestion()).toBeNull();
    expect(created).toHaveLength(1);
  });
});
