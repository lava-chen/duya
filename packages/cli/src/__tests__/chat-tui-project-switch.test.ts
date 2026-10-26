/**
 * `/project` inside the running chat loop.
 *
 * `project.test.ts` covers what the command decides; this covers the part only
 * the loop can do: bind a session to a directory the process was not launched
 * in, and then keep naming THAT directory to the Host instead of `process.cwd()`
 * for every later run. The second half is the one that matters — a switch that
 * left the runs in the launch directory would move the picker and not the work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { RunId, SessionId } from '@duya/agent-protocol';

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
  readonly notices: string[];
  readonly errors: string[];
  readonly cleared: number[];
  stopped: boolean;
}

const harness = vi.hoisted(() => ({ app: null as FakeTui | null }));

vi.mock('../tui/index.js', () => ({
  TUIApp: class {
    readonly notices: string[] = [];
    readonly errors: string[] = [];
    readonly cleared: number[] = [];
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
    clearTranscript(): void { this.cleared.push(1); }
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
import { OwnedSessions } from '../owned-sessions.js';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for chat TUI state');
}

function session(id: string, extensions?: Record<string, unknown>) {
  return {
    id: id as SessionId,
    workspace: { state: 'unbound' },
    title: 'Test session',
    providerId: 'anthropic',
    model: 'test-model',
    ...(extensions === undefined ? {} : { extensions }),
  };
}

/**
 * One Host, as many scratch projects as a test needs.
 *
 * `registerLocalDirectory` hands back an identity that the created session has
 * to carry, so a test can follow the directory typed into `/project` all the
 * way to the workspace the next run is charged to.
 */
interface Harness {
  readonly client: HostSessionHttpClient;
  readonly app: FakeTui;
  readonly running: Promise<number>;
  readonly runInputs: Array<Record<string, unknown>>;
  readonly created: Array<Record<string, unknown>>;
  readonly registered: string[];
}

interface HarnessOptions {
  /** The directory the session this loop adopted runs in. */
  readonly currentDirectory: string | null;
  readonly initialExtensions?: Record<string, unknown>;
  readonly owned?: OwnedSessions;
  readonly holdRunOpen?: boolean;
}

async function startHarness(options: HarnessOptions): Promise<Harness> {
  const registered: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const runInputs: Array<Record<string, unknown>> = [];

  const client = {
    get: vi.fn(async () => session('session-1', options.initialExtensions)),
    list: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    readMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    countTimeline: vi.fn(async () => 0),
    delete: vi.fn(async () => ({ deleted: true })),
    // The local projection is where the command reads "the directory I am in";
    // null stands for a Host that does not expose it at all.
    readLocalSession: vi.fn(async () => {
      if (options.currentDirectory === null) throw new Error('local_session_projection_unavailable');
      return { workingDirectory: options.currentDirectory };
    }),
    listLocalSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    registerLocalDirectory: vi.fn(async (directory: string) => {
      registered.push(directory);
      return { workspaceId: `ws-${registered.length}`, rootId: `root-${registered.length}`, relativePath: '' };
    }),
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return {
        ...session(`session-${created.length + 1}`),
        workspace: { state: 'bound', workspaceId: input.workspaceId },
      };
    }),
    startAgentRun: vi.fn(async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return { accepted: true, runId: `run-${runInputs.length}` as RunId };
    }),
    watchAgentRunEvents: vi.fn(async function* (_runId: RunId, { signal }: { signal: AbortSignal }) {
      if (options.holdRunOpen === true) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
    }),
    getAgentRun: vi.fn(async () => ({ status: 'completed' })),
    cancelAgentRun: vi.fn(async () => undefined),
    listBackgroundTasks: vi.fn(async () => ({ observed: false, tasks: [] })),
    readBackgroundTaskOutput: vi.fn(async () => null),
  } as unknown as HostSessionHttpClient;

  harness.app = null;
  const running = chatTui(client, 'session-1' as SessionId, {}, options.owned);
  await waitUntil(() => harness.app !== null);
  return { client, app: harness.app!, running, runInputs, created, registered };
}

describe('chatTui /project switch', () => {
  const scratch: string[] = [];

  function tempDirectory(label: string): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), `duya-project-${label}-`));
    scratch.push(directory);
    return directory;
  }

  beforeEach(() => { harness.app = null; });
  afterEach(async () => {
    harness.app?.options.onExit();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (scratch.length > 0) {
      const directory = scratch.pop();
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds the new session to the typed directory and stops naming the launch cwd', async () => {
    const target = tempDirectory('bind');
    const { app, registered, created, runInputs } = await startHarness({ currentDirectory: process.cwd() });

    app.options.onSubmit(`/project ${target}`);
    await waitUntil(() => created.length === 1);

    expect(registered).toEqual([target]);
    expect(created[0]).toMatchObject({
      workspaceId: 'ws-1',
      workspaceRootId: 'root-1',
      projectName: path.basename(target),
    });

    app.options.onSubmit('now work here');
    await waitUntil(() => runInputs.length === 1);
    // The point of the whole command: the run is charged to the project the
    // user picked, and to the session created inside it — not to the directory
    // `duya chat` happened to be launched from.
    expect(runInputs[0]?.workingDirectory).toBe(target);
    expect(runInputs[0]?.sessionId).toBe('session-2');
    expect(app.cleared.length).toBeGreaterThan(0);
    expect(app.notices.join('\n')).toContain(`Started a session in ${target}`);
  });

  it('keeps a per-session checkout cursor ahead of the surface directory', async () => {
    const cursor = tempDirectory('cursor');
    const target = tempDirectory('target');
    const { app, runInputs, created } = await startHarness({
      currentDirectory: target,
      initialExtensions: { executionLocation: { cwd: cursor } },
    });

    app.options.onSubmit('first turn');
    await waitUntil(() => runInputs.length === 1);
    // The switch needs the turn to settle first: a live run owns the session,
    // and `/project` asked during it is refused rather than queued.
    await waitUntil(() => !app.options.isBusy());
    expect(runInputs[0]?.workingDirectory).toBe(cursor);

    app.options.onSubmit(`/project ${target}`);
    await waitUntil(() => app.notices.join('\n').includes('Already working in'));
    // `/worktree` still wins over the surface: the checkout is a per-session
    // fact, and a project switch does not move a session underneath its fence.
    expect(created).toHaveLength(0);
    expect(runInputs[0]?.workingDirectory).toBe(cursor);
  });

  it('does not spend a session on a directory it is already working in', async () => {
    const here = tempDirectory('here');
    const { app, created, registered } = await startHarness({ currentDirectory: here });

    app.options.onSubmit(`/project ${here}`);
    await waitUntil(() => app.notices.join('\n').includes('Already working in'));

    expect(created).toHaveLength(0);
    expect(registered).toHaveLength(0);
  });

  it('refuses mid-turn, because the live run owns the session it would replace', async () => {
    const target = tempDirectory('busy');
    const { app, created } = await startHarness({
      currentDirectory: process.cwd(),
      holdRunOpen: true,
    });

    app.options.onSubmit('a turn that is still going');
    await waitUntil(() => app.options.isBusy());
    app.options.onSubmit(`/project ${target}`);
    await waitUntil(() => app.errors.join('\n').includes('while a turn is running'));

    expect(created).toHaveLength(0);
    app.options.onInterrupt();
    await waitUntil(() => !app.options.isBusy());
  });

  it('owns the session it created in the other project, so an unused one is cleaned up', async () => {
    const target = tempDirectory('owned');
    const owned = new OwnedSessions();
    const { app, client, running } = await startHarness({ currentDirectory: process.cwd(), owned });

    app.options.onSubmit(`/project ${target}`);
    await waitUntil(() => (client.create as ReturnType<typeof vi.fn>).mock.calls.length === 1);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
    // The switch created this row, so this surface has to release it: `/project`
    // must not become a way to leave ghosts behind.
    expect(client.delete).toHaveBeenCalledWith('session-2');
  });

  it('reports a directory the Host will not take instead of pretending it moved', async () => {
    const target = tempDirectory('refuse');
    const { app, client } = await startHarness({ currentDirectory: process.cwd() });
    vi.mocked(client.create).mockImplementationOnce(async () => {
      throw new Error('Directory must be an absolute, accessible local directory');
    });

    app.options.onSubmit(`/project ${target}`);
    await waitUntil(() => app.errors.some((message) => message.includes('Could not start a session in')));
    expect(app.errors.join('\n')).toContain('accessible local directory');
  });
});
