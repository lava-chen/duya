import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  WorkflowRuntimeManager,
  type WorkflowRuntimeManagerDeps,
  type WorkflowRuntimeTriggerInput,
  type WorkflowRuntimeTriggerResult,
} from '../workflow-runtime-manager';
import type { Logger } from '../logger';

/**
 * Plan 560 Phase 2: `WorkflowRuntimeManager` is the broker between a run's
 * child process and everything durable (run row, events table, SSE clients).
 * These tests pin the four things that can silently rot:
 *
 *   1. the handshake — `ready` settles the trigger, a pre-`ready` terminal
 *      settles it as a launch failure (so the caller gets a real message
 *      instead of a 201 followed by a failed run card),
 *   2. the write fan-out — create / snapshot / append / finish, with the
 *      failure text going through `updateStatus` (the only writer of
 *      `pause_message`),
 *   3. the SSE contract — `attach(runId, afterSeq)` replays then streams, the
 *      terminal frame closes the story, and an unknown run yields `null` so
 *      the caller can replay from the events table,
 *   4. the edges — capacity refusal, cancel, crash-without-terminal.
 *
 * The child is faked through `deps.forkChild`, so the env construction and the
 * frame wiring stay the real code.
 */

const LLM = {
  apiKey: 'k',
  provider: 'openai' as const,
  model: 'gpt-test',
};

/** An EventEmitter that looks enough like a forked child for the manager. */
type FakeChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { write: (chunk: string) => boolean; written: string[] };
  pid: number;
  /** Last signal passed to `kill` — how the cancel tests assert. */
  lastSignal?: string;
  kill: (signal?: string) => boolean;
};

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  const written: string[] = [];
  ee.stdout = new Readable({ read() { /* push-driven */ } });
  ee.stderr = new Readable({ read() { /* push-driven */ } });
  ee.stdin = {
    written,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
  };
  ee.pid = 4242;
  ee.kill = (signal?: string) => {
    ee.lastSignal = signal;
    return true;
  };
  return ee;
}

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Let queued microtasks (the write chain) settle. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function line(frame: Record<string, unknown>): string {
  return JSON.stringify(frame) + '\n';
}

interface Harness {
  manager: InstanceType<typeof WorkflowRuntimeManager>;
  dbRequest: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  /** Args the manager handed to `fork` — env role stamping is asserted here. */
  forkArgs: Array<{ modulePath: string; options: Record<string, unknown> }>;
  calls: (action: string) => unknown[];
}

function makeHarness(maxConcurrent = 3): Harness {
  const children: FakeChild[] = [];
  const forkArgs: Array<{ modulePath: string; options: Record<string, unknown> }> = [];

  // Typed parameters matter: `mock.calls` is a tuple per declared arity, so an
  // argument-less `vi.fn()` would make every `calls(...)` inspection a type error.
  const dbRequest = vi.fn(
    async (_action: string, _payload: Record<string, unknown>): Promise<unknown> => undefined,
  );
  const manager = new WorkflowRuntimeManager({
    workerPath: 'C:/fake/agent-process-entry.js',
    betterSqlite3Path: 'C:/fake/better-sqlite3',
    dbRequest: dbRequest as unknown as (action: string, payload: Record<string, unknown>) => Promise<unknown>,
    workerDbRequests: new Map<string, ChildProcess>(),
    logger: silentLogger(),
    httpLogger: silentLogger(),
    maxConcurrent,
    artifactsRoot: 'C:/fake/artifacts',
    forkChild: ((modulePath: string, _args: string[], options: Record<string, unknown>) => {
      forkArgs.push({ modulePath, options });
      const child = makeFakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as NonNullable<WorkflowRuntimeManagerDeps['forkChild']>,
  });

  return {
    manager,
    dbRequest,
    children,
    forkArgs,
    calls: (action: string) =>
      dbRequest.mock.calls.filter((c) => c[0] === action).map((c) => c[1]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * `trigger` awaits the run-row write before it spawns, so the child only exists
 * a few microtasks later. Waiting here keeps the spawn assertion honest instead
 * of racing it.
 */
async function triggerAndSpawn(
  h: Harness,
  input: WorkflowRuntimeTriggerInput,
): Promise<{ pending: Promise<WorkflowRuntimeTriggerResult>; child: FakeChild }> {
  const pending = h.manager.trigger(input);
  await flush();
  return { pending, child: h.children[h.children.length - 1] };
}

describe('WorkflowRuntimeManager — handshake', () => {
  it('settles the trigger on `ready` and stores the definition from the frame', async () => {
    const h = makeHarness();
    const { pending, child } = await triggerAndSpawn(h, {
      name: 'wf-a',
      params: { t: 'v' },
      projectDir: 'E:/proj',
      llm: LLM,
    });

    expect(h.children).toHaveLength(1);
    // The child is the chat-worker bundle under a different role — same env
    // (daemon port, sqlite path), stamped role, and no session id.
    expect(h.forkArgs[0].modulePath).toBe('C:/fake/agent-process-entry.js');
    const env = h.forkArgs[0].options.env as Record<string, string>;
    expect(env.DUYA_AGENT_ROLE).toBe('workflow-runtime');
    expect(env.SESSION_ID).toBe('');
    expect(env.DUYA_DAEMON_PORT).toBeTruthy();

    // The run description reaches the child on stdin, in the same shape the
    // child's `parseStdin` loop reads.
    const init = JSON.parse(child.stdin.written[0]) as Record<string, unknown>;
    expect(init.type).toBe('workflow:init');
    expect(init.artifactsRoot).toBe('C:/fake/artifacts');
    expect(init.projectDir).toBe('E:/proj');

    child.stdout.push(line({ type: 'workflow:ready', runId: 'ignored', definition: { name: 'wf-a' } }));

    const result = await pending;
    expect(result.ok).toBe(true);
    // D3: main creates the row before the spawn and stores the snapshot from
    // the `ready` frame — the child never touches a database.
    expect(h.calls('workflowRun:create')).toEqual([
      expect.objectContaining({
        id: result.ok ? result.runId : '',
        workflowName: 'wf-a',
        status: 'active',
        origin: 'library',
        projectDir: 'E:/proj',
        params: { t: 'v' },
      }),
    ]);
    await flush();
    expect(h.calls('workflowRun:saveSnapshot')).toEqual([
      expect.objectContaining({ runId: result.ok ? result.runId : '', definition: { name: 'wf-a' } }),
    ]);
  });

  it('treats a terminal before `ready` as a launch failure, not a started run', async () => {
    const h = makeHarness();
    const { pending, child } = await triggerAndSpawn(h, { name: 'wf-b', llm: LLM });

    child.stdout.push(
      line({ type: 'workflow:finished', status: 'failed', error: 'missing required args: topic' }),
    );

    const result = await pending;
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: 'missing required args: topic',
      runId: expect.any(String),
    });
    await flush();
    // The row exists (it was created up front), so it must not be left `active`.
    expect(h.calls('workflowRun:finish')).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    expect(h.calls('workflowRun:updateStatus')).toEqual([
      expect.objectContaining({ status: 'failed', pauseMessage: 'missing required args: topic' }),
    ]);
  });

  it('refuses a trigger past the concurrency ceiling without spawning', async () => {
    const h = makeHarness(1);
    const { pending, child } = await triggerAndSpawn(h, { name: 'wf-1', llm: LLM });
    child.stdout.push(line({ type: 'workflow:ready' }));
    await pending;

    const second = await h.manager.trigger({ name: 'wf-2', llm: LLM });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(429);
      expect(second.error).toContain('capacity');
      expect(second.runId).toBeUndefined();
    }
    expect(h.children).toHaveLength(1);
  });
});

describe('WorkflowRuntimeManager — event fan-out', () => {
  async function started(): Promise<{ h: Harness; runId: string; child: FakeChild }> {
    const h = makeHarness();
    const { pending, child } = await triggerAndSpawn(h, { name: 'wf', projectDir: 'E:/proj', llm: LLM });
    child.stdout.push(line({ type: 'workflow:ready', definition: { name: 'wf' } }));
    const result = await pending;
    if (!result.ok) throw new Error('expected the run to start');
    return { h, runId: result.runId, child };
  }

  it('persists every journal record and streams it with its seq', async () => {
    const { h, runId, child } = await started();
    const frames: unknown[] = [];
    h.manager.attach(runId, -1, (frame) => frames.push(frame));

    child.stdout.push(
      line({
        type: 'workflow:run-event',
        record: { seq: 0, kind: 'node_result', nodeId: 'n1', status: 'succeeded', nodeKind: 'tool' },
      }),
    );
    await flush();

    expect(h.calls('workflowRun:appendJournal')).toEqual([
      expect.objectContaining({ runId, record: expect.objectContaining({ seq: 0 }) }),
    ]);
    expect(frames).toEqual([
      expect.objectContaining({ frame: 'record', runId, seq: 0 }),
    ]);
  });

  it('replays only past the requested cursor and then streams live', async () => {
    const { h, runId, child } = await started();

    for (const seq of [0, 1, 2]) {
      child.stdout.push(
        line({ type: 'workflow:run-event', record: { seq, kind: 'node_result', nodeId: `n${seq}`, status: 'succeeded' } }),
      );
    }
    await flush();

    const replayed: Array<{ seq?: number }> = [];
    h.manager.attach(runId, 0, (frame) => replayed.push(frame));
    expect(replayed.map((f) => f.seq)).toEqual([1, 2]);

    child.stdout.push(
      line({ type: 'workflow:run-event', record: { seq: 3, kind: 'node_result', nodeId: 'n3', status: 'succeeded' } }),
    );
    await flush();
    expect(replayed.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('reports an artifact the moment it is published and merges it into the summary', async () => {
    const { h, runId, child } = await started();
    const frames: Array<Record<string, unknown>> = [];
    h.manager.attach(runId, -1, (frame) => frames.push(frame as unknown as Record<string, unknown>));

    const artifact = {
      id: 'a1',
      name: '发布 tag 推荐',
      contentType: 'text/markdown',
      bytes: 14400,
      relPath: `${runId}/tag.md`,
    };
    child.stdout.push(line({ type: 'workflow:publish-artifact', ...artifact }));
    child.stdout.push(line({ type: 'workflow:finished', status: 'complete', artifacts: [artifact] }));
    await flush();

    const artifactFrame = frames.find((f) => f.frame === 'artifact');
    expect(artifactFrame).toMatchObject({ frame: 'artifact', artifact });
    const done = frames.find((f) => f.frame === 'done') as { summary: { artifacts: unknown[]; status: string } };
    expect(done.summary.status).toBe('complete');
    expect(done.summary.artifacts).toEqual([artifact]);
    // finish carries the artifacts + status; no failure text means no updateStatus.
    expect(h.calls('workflowRun:finish')).toEqual([
      expect.objectContaining({ id: runId, status: 'complete', artifacts: [artifact] }),
    ]);
    expect(h.calls('workflowRun:updateStatus')).toEqual([]);
  });

  it('sums token usage and counts successful agent steps', async () => {
    const { h, runId, child } = await started();
    const frames: Array<{ frame: string; summary?: { tokens?: number; subagents?: number } }> = [];
    h.manager.attach(runId, -1, (frame) => frames.push(frame as never));

    child.stdout.push(
      line({
        type: 'workflow:run-event',
        record: {
          seq: 0,
          kind: 'node_result',
          nodeId: 'a1',
          status: 'succeeded',
          nodeKind: 'agent',
          usage: { inputTokens: 900, outputTokens: 100 },
        },
      }),
    );
    child.stdout.push(
      line({
        type: 'workflow:run-event',
        record: { seq: 1, kind: 'node_result', nodeId: 'a2', status: 'failed', nodeKind: 'agent' },
      }),
    );
    child.stdout.push(line({ type: 'workflow:finished', status: 'complete' }));
    await flush();

    const done = frames.find((f) => f.frame === 'done');
    expect(done?.summary?.tokens).toBe(1000);
    // Only the succeeded agent counts — a failed one is not a sub-agent that ran.
    expect(done?.summary?.subagents).toBe(1);
    expect(h.calls('workflowRun:finish')).toEqual([
      expect.objectContaining({ spentTokens: 1000 }),
    ]);
  });

  it('closes a subscriber with a terminal frame and returns null for an unknown run', async () => {
    const { h, runId, child } = await started();
    const frames: Array<Record<string, unknown>> = [];
    h.manager.attach(runId, -1, (f) => frames.push(f as unknown as Record<string, unknown>));

    child.stdout.push(line({ type: 'workflow:finished', status: 'complete' }));
    await flush();
    expect(frames[frames.length - 1]?.frame).toBe('done');

    // The router's history path relies on this null to replay from the table.
    expect(h.manager.attach('00000000-0000-0000-0000-000000000000', -1, () => {})).toBeNull();
  });
});

describe('WorkflowRuntimeManager — cancel and crash', () => {
  async function started(): Promise<{ h: Harness; runId: string; child: FakeChild }> {
    const h = makeHarness();
    const { pending, child } = await triggerAndSpawn(h, { name: 'wf', llm: LLM });
    child.stdout.push(line({ type: 'workflow:ready' }));
    const result = await pending;
    if (!result.ok) throw new Error('expected the run to start');
    return { h, runId: result.runId, child };
  }

  it('cancel signals the child and a subsequent exit settles `cancelled`', async () => {
    const { h, runId, child } = await started();
    const frames: Array<{ frame: string; summary?: { status?: string } }> = [];
    h.manager.attach(runId, -1, (f) => frames.push(f as never));

    expect(h.manager.cancel(runId)).toEqual({ ok: true });
    expect(child.stdin.written[1]).toContain('workflow:cancel');
    expect((child as unknown as { lastSignal?: string }).lastSignal).toBe('SIGTERM');

    // No terminal frame arrived — the exit handler is the one that settles it.
    child.emit('exit', null, 'SIGTERM');
    await flush();

    expect(h.calls('workflowRun:finish')).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
    expect(frames[frames.length - 1]).toMatchObject({
      frame: 'done',
      summary: { status: 'cancelled' },
    });
  });

  it('a crash without a terminal frame settles the run as failed', async () => {
    const { h, runId, child } = await started();
    const frames: Array<{ frame: string; summary?: { status?: string; error?: string } }> = [];
    h.manager.attach(runId, -1, (f) => frames.push(f as never));

    child.emit('exit', 1, null);
    await flush();

    expect(h.calls('workflowRun:finish')).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    const done = frames[frames.length - 1];
    expect(done.summary?.status).toBe('failed');
    expect(done.summary?.error).toContain('exited unexpectedly');
    expect(h.manager.activeCount).toBe(0);
  });

  it('cancel on an unknown or already-finished run is not an error', async () => {
    const { h, runId, child } = await started();
    expect(h.manager.cancel('nope')).toEqual({ ok: false, error: 'run is not active in this process' });

    child.stdout.push(line({ type: 'workflow:finished', status: 'complete' }));
    await flush();
    expect(h.manager.cancel(runId)).toEqual({ ok: true });
  });

  it('killAll stops every live run', async () => {
    const { h, runId, child } = await started();
    h.manager.killAll();
    expect((child as unknown as { lastSignal?: string }).lastSignal).toBe('SIGKILL');

    child.emit('exit', null, 'SIGKILL');
    await flush();
    expect(h.calls('workflowRun:finish')).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
    expect(h.manager.listRuns().find((r) => r.runId === runId)?.status).toBe('cancelled');
  });
});
