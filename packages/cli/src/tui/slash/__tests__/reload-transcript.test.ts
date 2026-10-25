/**
 * packages/cli/src/tui/slash/__tests__/reload-transcript.test.ts
 *
 * The `reloadTranscript` action — the chat loop's half of `/compact`.
 *
 * ## Why this is a chat-level test
 *
 * `/compact` rewrote the timeline on the Host, so the conversation on
 * screen is the pre-compaction one until somebody re-reads it. The
 * command cannot do that itself: only the chat loop owns the transcript
 * and the repaint. The action is therefore the seam, and this test pins
 * the loop's side of it.
 *
 * ## What it pins
 *
 *  1. The action re-reads the DURABLE transcript and hands it to the
 *     transcript pane. A reload that painted the previous contents would
 *     leave the user looking at a conversation the Host has already
 *     replaced.
 *
 *  2. It reads the messages the Host holds NOW, not the ones it held
 *     when the session opened. The whole point of the reload is that the
 *     answer changed.
 *
 *  3. It does NOT switch sessions. The session did not change — only its
 *     contents did — so nothing about a switch may be printed, and the
 *     session record the loop is showing must stay the same one.
 *
 * The slash barrel is mocked so a probe command can reach the action:
 * the registry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { SessionId } from '@duya/agent-protocol';
import type { TuiSlashCommandDef } from '../types.js';

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
  /** Every transcript the pane was given, in order. */
  readonly transcripts: unknown[][];
  readonly notices: string[];
  readonly errors: string[];
  stopped: boolean;
}

const harness = vi.hoisted(() => ({ app: null as FakeTui | null }));

vi.mock('../index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.js')>();
  // The probe stands in for `/compact`: it calls the action the chat loop
  // hands to a slash command, and nothing else.
  const probe: TuiSlashCommandDef = {
    name: 'reload-probe',
    description: 'probe the reloadTranscript action',
    group: 'Session ops',
    async run(ctx) {
      await ctx.actions?.reloadTranscript(ctx.session.id);
      return { kind: 'handled' };
    },
  };
  return {
    ...actual,
    hasTuiSlashCommand: (name: string) =>
      name === 'reload-probe' || actual.hasTuiSlashCommand(name),
    resolveTuiSlashCommand: (name: string) =>
      name === 'reload-probe' ? probe : actual.resolveTuiSlashCommand(name),
  };
});

vi.mock('../../index.js', () => ({
  TUIApp: class {
    readonly transcripts: unknown[][] = [];
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
    printNotice(text: string): void { this.notices.push(text); }
    printError(message: string): void { this.errors.push(message); }
    replaceTranscript(messages: unknown): void { this.transcripts.push(messages as unknown[]); }
    clearTranscript(): void {}
    choose(): Promise<string | null> { return Promise.resolve(null); }
    chooseFiltered(): Promise<string | null> { return Promise.resolve(null); }
  },
  shouldUseTui: () => true,
}));

vi.mock('@duya/host/http-client', () => ({ HostSessionHttpClient: class {} }));
vi.mock('@duya/host/local-host', () => ({ startLocalHost: vi.fn() }));
vi.mock('@duya/data', () => ({ resolveDataRoot: () => '' }));

import { chatTui } from '../../../chat.js';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the chat TUI state');
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

/**
 * A client whose transcript changes between reads.
 *
 * The counter is the point: a reload that painted the messages the pane
 * already had would look identical to a reload that read them again.
 */
function makeClient(): { client: HostSessionHttpClient; reads: () => number } {
  let reads = 0;
  const client = {
    get: vi.fn(async () => session()),
    list: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    getSettings: vi.fn(async () => ({})),
    listAgentRunsBySession: vi.fn(async () => []),
    readMessages: vi.fn(async () => {
      reads += 1;
      return {
        sessionId: 'session-1',
        messages: [{
          id: `m-${reads}`,
          sequence: reads,
          createdAt: 1_700_000_000_000 + reads,
          turnId: null,
          entry: {
            type: 'message',
            id: `m-${reads}`,
            parentId: null,
            createdAt: 1_700_000_000_000 + reads,
            message: { role: 'user', content: `read-${reads}`, id: `m-${reads}` },
          },
        }],
        nextCursor: null,
      };
    }),
    startAgentRun: vi.fn(async ({ prompt }: { prompt: string }) => ({
      accepted: true,
      runId: `run-${prompt}` as never,
    })),
    watchAgentRunEvents: vi.fn(async function* () {}),
    getAgentRun: vi.fn(async () => ({ status: 'completed' })),
    cancelAgentRun: vi.fn(async () => undefined),
    countTimeline: vi.fn(async () => 0),
    delete: vi.fn(async () => ({ deleted: true })),
  } as unknown as HostSessionHttpClient;
  return { client, reads: () => reads };
}

describe('the reloadTranscript action', () => {
  beforeEach(() => { harness.app = null; });
  afterEach(() => { harness.app?.options.onExit(); });

  it('re-reads the durable transcript and repaints it', async () => {
    const { client, reads } = makeClient();
    const running = chatTui(client, 'session-1' as SessionId, {});
    await waitUntil(() => harness.app !== null);
    const app = harness.app!;

    // The session opened with one transcript.
    await waitUntil(() => app.transcripts.length === 1);
    expect(app.transcripts[0]).toHaveLength(1);

    app.options.onSubmit('/reload-probe');
    await waitUntil(() => app.transcripts.length === 2);

    // The second paint carries the messages the Host holds NOW, not the
    // ones the pane already had.
    const repainted = app.transcripts[1] as Array<{ content?: unknown }>;
    expect(repainted).toHaveLength(1);
    expect(repainted[0]?.content).toBe('read-2');
    expect(reads()).toBe(2);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });

  it('does not switch sessions', async () => {
    const { client } = makeClient();
    const running = chatTui(client, 'session-1' as SessionId, {});
    await waitUntil(() => harness.app !== null);
    const app = harness.app!;
    await waitUntil(() => app.transcripts.length === 1);

    app.options.onSubmit('/reload-probe');
    await waitUntil(() => app.transcripts.length === 2);

    // The session did not change — only its contents did — so nothing may
    // claim a switch happened.
    expect(app.notices.join('\n')).not.toContain('Switched to');
    expect(app.errors).toEqual([]);

    app.options.onExit();
    await expect(running).resolves.toBe(0);
  });
});
