/**
 * Following turns another client runs in the session this terminal shows.
 *
 * The watched state is deliberately small — a set of run ids and a seeded
 * flag — because everything else lives in the run ledger. The cases below pin
 * the three behaviours that make it safe to run a second client at all:
 * history is not replayed, a local run is not followed twice, and a remote
 * approval is reported rather than answered here.
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentRunRecord,
  RunEventEnvelope,
  RunEvent,
  RunId,
  SessionId,
} from '@duya/agent-protocol';
import type { LegacyFrame } from '../tui/blocks.js';
import { RemoteSessionWatch } from '../tui/remote-session-watch.js';

const SESSION = 'session-1' as SessionId;

function run(runId: string, status: AgentRunRecord['status'] = 'running'): AgentRunRecord {
  return { runId: runId as RunId, sessionId: SESSION, status } as AgentRunRecord;
}

function envelope(
  runId: string,
  seq: number,
  payload: RunEvent,
): RunEventEnvelope<RunEvent> {
  return { sessionId: SESSION, runId: runId as RunId, seq, payload };
}

const textBlock = (runId: string, seq: number, text: string, index = 0): RunEventEnvelope<RunEvent> =>
  envelope(runId, seq, {
    type: 'assistant.text_block',
    messageId: 'message-1',
    index,
    text,
  } as RunEvent);

interface Harness {
  readonly watch: RemoteSessionWatch;
  readonly frames: LegacyFrame[];
  readonly notices: string[];
  readonly reloads: number[];
  setRuns: (runs: readonly AgentRunRecord[]) => void;
  readonly followed: RunId[];
  setPaused: (paused: boolean) => void;
}

function harness(initialRuns: readonly AgentRunRecord[], options: {
  local?: readonly string[];
  streams?: Record<string, readonly RunEventEnvelope<RunEvent>[]>;
} = {}): Harness {
  let runs = initialRuns;
  let paused = false;
  const frames: LegacyFrame[] = [];
  const notices: string[] = [];
  const reloads: number[] = [];
  const followed: RunId[] = [];
  const local = new Set(options.local ?? []);

  const client = {
    listAgentRunsBySession: async () => runs,
    // An async generator so `for await` closes when the test stream ends,
    // exactly like the SSE reader does at a terminal event.
    async *watchAgentRunEvents(runId: RunId) {
      followed.push(runId);
      for (const event of options.streams?.[runId] ?? []) yield event;
    },
  };

  const watch = new RemoteSessionWatch({
    client,
    sessionId: SESSION,
    isPaused: () => paused,
    isLocalRun: (runId) => local.has(runId),
    onFrame: (frame) => frames.push(frame),
    onNotice: (text) => notices.push(text),
    onRunSettled: () => {
      reloads.push(Date.now());
    },
  });

  return {
    watch,
    frames,
    notices,
    reloads,
    followed,
    setRuns: (next) => {
      runs = next;
    },
    setPaused: (value) => {
      paused = value;
    },
  };
}

/** Let the fire-and-forget follow loop finish before asserting on it. */
async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RemoteSessionWatch', () => {
  it('treats the first read as history and follows nothing', async () => {
    const h = harness([run('run-old', 'completed')]);
    await h.watch.poll();
    await drainMicrotasks();
    expect(h.followed).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.reloads).toEqual([]);
  });

  it('follows a run another client started and forwards its durable blocks', async () => {
    const h = harness([run('run-old', 'completed')], {
      streams: { 'run-new': [textBlock('run-new', 1, 'hello from the desktop')] },
    });
    await h.watch.poll();
    h.setRuns([run('run-new', 'running'), run('run-old', 'completed')]);
    await h.watch.poll();
    await drainMicrotasks();

    expect(h.followed).toEqual(['run-new']);
    expect(h.frames.map((frame) => frame.type)).toEqual(['text']);
    expect(h.frames[0]?.data).toMatchObject({ content: 'hello from the desktop' });
    expect(h.notices[0]).toContain('run-new'.slice(0, 8));
    // Settling reloads the transcript once, from the durable log.
    expect(h.reloads).toHaveLength(1);
  });

  it('reloads once for a run that already finished instead of following it', async () => {
    const h = harness([], { streams: { 'run-done': [textBlock('run-done', 1, 'late')] } });
    await h.watch.poll();
    h.setRuns([run('run-done', 'completed')]);
    await h.watch.poll();
    await drainMicrotasks();

    expect(h.followed).toEqual([]);
    expect(h.frames).toEqual([]);
    expect(h.notices.join(' ')).toContain('finished in another client');
    expect(h.reloads).toHaveLength(1);
  });

  it('never re-follows a run this terminal started', async () => {
    const h = harness([], { local: ['run-mine'], streams: { 'run-mine': [textBlock('run-mine', 1, 'x')] } });
    await h.watch.poll();
    h.setRuns([run('run-mine', 'running')]);
    await h.watch.poll();
    await drainMicrotasks();

    expect(h.followed).toEqual([]);
    expect(h.reloads).toEqual([]);
  });

  it('does not poll while the transcript is owned by this surface', async () => {
    const h = harness([], { streams: { 'run-new': [textBlock('run-new', 1, 'x')] } });
    await h.watch.poll();
    h.setPaused(true);
    h.setRuns([run('run-new', 'running')]);
    await h.watch.poll();
    await drainMicrotasks();
    expect(h.followed).toEqual([]);

    // Resuming sees the run for the first time and follows it.
    h.setPaused(false);
    await h.watch.poll();
    await drainMicrotasks();
    expect(h.followed).toEqual(['run-new']);
  });

  it('reports a remote approval instead of opening the picker', async () => {
    const permission = envelope('run-new', 1, {
      type: 'permission.requested',
      requestId: 'request-1',
      toolName: 'Write',
      toolInput: {},
      reason: 'needs approval',
      mode: 'ask',
      expiresAt: Date.now() + 60_000,
    } as unknown as RunEvent);
    const h = harness([], { streams: { 'run-new': [permission] } });
    await h.watch.poll();
    h.setRuns([run('run-new', 'running')]);
    await h.watch.poll();
    await drainMicrotasks();

    expect(h.frames).toEqual([]);
    expect(h.notices.some((notice) => notice.includes('answer it there'))).toBe(true);
  });

  it('drops terminal frames and leaves the settle to the reload', async () => {
    const h = harness([], {
      streams: {
        'run-new': [
          textBlock('run-new', 1, 'done soon'),
          envelope('run-new', 2, { type: 'run.completed', status: 'completed' } as unknown as RunEvent),
        ],
      },
    });
    await h.watch.poll();
    h.setRuns([run('run-new', 'running')]);
    await h.watch.poll();
    await drainMicrotasks();

    expect(h.frames.map((frame) => frame.type)).toEqual(['text']);
    expect(h.reloads).toHaveLength(1);
  });

  it('stops following when pointed at another session', async () => {
    const h = harness([], {
      streams: { 'run-new': [textBlock('run-new', 1, 'slow'), textBlock('run-new', 2, 'still going')] },
    });
    await h.watch.poll();
    h.setRuns([run('run-new', 'running')]);
    await h.watch.poll();
    h.watch.setSession('session-2' as SessionId);
    // The new session's ledger holds the same id here, but a switch re-seeds:
    // the run is history again and is not followed a second time.
    await h.watch.poll();
    await drainMicrotasks();

    expect(h.followed).toEqual(['run-new']);
    expect(h.reloads).toEqual([]);
  });

  it('survives a ledger read that fails', async () => {
    const notices: string[] = [];
    const watch = new RemoteSessionWatch({
      client: {
        listAgentRunsBySession: async () => {
          throw new Error('host busy');
        },
        // eslint-disable-next-line require-yield
        async *watchAgentRunEvents() {
          return;
        },
      },
      sessionId: SESSION,
      isPaused: () => false,
      isLocalRun: () => false,
      onFrame: () => undefined,
      onNotice: (text) => notices.push(text),
      onRunSettled: () => undefined,
    });

    await expect(watch.poll()).resolves.toBeUndefined();
    expect(notices).toEqual([]);
  });
});
