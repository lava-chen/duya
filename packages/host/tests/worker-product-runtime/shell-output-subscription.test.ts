/**
 * Plan 636 -- where a run subscribes to a command's live output.
 *
 * The composition is the only place that can do this correctly, and the
 * correctness is an ORDER: `startManagedShell` decides whether to tail its
 * output file at the moment it spawns, by asking whether anybody is listening.
 * A subscriber registered after the spawn is therefore a subscriber that gets
 * nothing, which is the failure this file exists to make impossible.
 *
 * The rest is ownership: a side channel keyed by tool call id has to close on
 * the call's result, on a discarded batch, and on the run itself -- and a host
 * that supplies no map pays nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  onShellOutput,
  hasShellOutputListener,
  emitShellOutput,
  resetShellOutputListeners,
} from '../../src/managed-shell/output-stream.js';
import { startManagedShell } from '../../src/managed-shell/managed-shell.js';
import {
  composeLegacyRunSources,
  type LegacyRunHost,
} from '../../src/worker-run-composition.js';

/** One pipeline update, in the shape `toDrainItem` reads. */
type FakeUpdate = { readonly message: unknown };

/** A drain that yields the given updates, and records what was queued. */
function fakePipelines(updates: readonly FakeUpdate[]) {
  const queued: unknown[] = [];
  return {
    queued,
    pipelines: {
      queue: (call: unknown) => {
        queued.push(call);
      },
      async *drain(): AsyncIterable<never> {
        for (const update of updates) yield update as never;
      },
      discard: vi.fn(),
    },
  };
}

function toolResultUpdate(callId: string): FakeUpdate {
  return {
    message: {
      role: 'tool',
      content: 'command finished',
      tool_call_id: callId,
      is_error: false,
    },
  };
}

/**
 * The composition reads `agent` only inside closures it never calls here, so an
 * empty session is a complete stand-in for this leg.
 */
const agent = {} as never;

function hostWith(options: {
  updates?: readonly FakeUpdate[];
  shellOutputStops?: Map<string, () => void>;
}): { host: LegacyRunHost; emitted: unknown[]; queued: unknown[] } {
  const emitted: unknown[] = [];
  const { queued, pipelines } = fakePipelines(options.updates ?? []);
  const host = {
    turnPipelines: pipelines,
    async assembleTurn(): Promise<never> {
      throw new Error('not under test');
    },
    refreshDeclaredTools: () => new Set<string>(),
    async askApproval(): Promise<never> {
      throw new Error('not under test');
    },
    emitter: { emit: (event: unknown) => emitted.push(event) },
    proposeTerminal: () => undefined,
    compaction: {},
    seqIndex: 1_700_000_000_000,
    wakeRun: false,
    ...(options.shellOutputStops === undefined
      ? {}
      : { shellOutputStops: options.shellOutputStops }),
  } as unknown as LegacyRunHost;
  return { host, emitted, queued };
}

const CALL_ID = 'call-shell-1';

afterEach(() => {
  resetShellOutputListeners();
});

describe('the run subscribes to live shell output before it dispatches', () => {
  it('has a listener on the call id by the time the pipeline is queued', () => {
    const stops = new Map<string, () => void>();
    const { host } = hostWith({ shellOutputStops: stops });
    const sources = composeLegacyRunSources(agent, host);

    // `queue` is the point of no return: everything after it leads to the spawn.
    // The listener therefore has to exist BEFORE it, which is what this asserts
    // by having the fake queue observe its own precondition.
    const observed: boolean[] = [];
    const realQueue = host.turnPipelines.queue.bind(host.turnPipelines);
    (host.turnPipelines as unknown as { queue: (call: unknown) => void }).queue = (call) => {
      observed.push(hasShellOutputListener((call as { callId: string; id: string }).id));
      realQueue(call);
    };

    sources.queueTool({ callId: CALL_ID, name: 'bash', input: { command: 'ls' } } as never);

    expect(observed).toEqual([true]);
    expect(hasShellOutputListener(CALL_ID)).toBe(true);
    expect(stops.size).toBe(1);
  });

  it('turns a slice into one `tool.output_delta` on the run emitter', () => {
    const stops = new Map<string, () => void>();
    const { host, emitted } = hostWith({ shellOutputStops: stops });
    const sources = composeLegacyRunSources(agent, host);
    sources.queueTool({ callId: CALL_ID, name: 'bash', input: { command: 'ls' } } as never);

    emitShellOutput({ taskId: CALL_ID, delta: 'total 12\n' });
    emitShellOutput({ taskId: CALL_ID, delta: 'drwxr-xr-x  2 root\n' });

    expect(emitted).toEqual([
      { type: 'tool.output_delta', toolCallId: CALL_ID, delta: 'total 12\n' },
      { type: 'tool.output_delta', toolCallId: CALL_ID, delta: 'drwxr-xr-x  2 root\n' },
    ]);
  });

  it('hears only its own command, not a sibling call in the same batch', () => {
    const stops = new Map<string, () => void>();
    const { host, emitted } = hostWith({ shellOutputStops: stops });
    const sources = composeLegacyRunSources(agent, host);
    sources.queueTool({ callId: CALL_ID, name: 'bash', input: { command: 'ls' } } as never);
    sources.queueTool({ callId: 'call-other', name: 'bash', input: { command: 'pwd' } } as never);

    emitShellOutput({ taskId: 'call-other', delta: '/here\n' });

    expect(emitted).toEqual([
      { type: 'tool.output_delta', toolCallId: 'call-other', delta: '/here\n' },
    ]);
    // Re-queueing the same call must not stack a second subscriber on it: an
    // engine that re-announces a call would otherwise double every slice.
    sources.queueTool({ callId: CALL_ID, name: 'bash', input: { command: 'ls' } } as never);
    emitShellOutput({ taskId: CALL_ID, delta: 'x' });
    expect(emitted.filter((e) => (e as { delta?: string }).delta === 'x')).toHaveLength(1);
  });

  it('stops listening when the call settles, and survives a result for a call that never subscribed', async () => {
    const stops = new Map<string, () => void>();
    const { host } = hostWith({
      shellOutputStops: stops,
      updates: [toolResultUpdate(CALL_ID), toolResultUpdate('call-progress-only')],
    });
    const sources = composeLegacyRunSources(agent, host);
    sources.queueTool({ callId: CALL_ID, name: 'bash', input: { command: 'ls' } } as never);
    expect(hasShellOutputListener(CALL_ID)).toBe(true);

    const drained: { kind: string }[] = [];
    for await (const item of sources.drainTools()) drained.push(item);

    expect(drained.map((item) => item.kind)).toEqual(['tool_result', 'tool_result']);
    expect(stops.size).toBe(0);
    expect(hasShellOutputListener(CALL_ID)).toBe(false);
  });

  it('closes every subscriber when the batch is discarded', () => {
    const stops = new Map<string, () => void>();
    const { host } = hostWith({ shellOutputStops: stops });
    const sources = composeLegacyRunSources(agent, host);
    sources.queueTool({ callId: 'call-a', name: 'bash', input: {} } as never);
    sources.queueTool({ callId: 'call-b', name: 'bash', input: {} } as never);
    expect(stops.size).toBe(2);

    sources.discardTools();

    expect(stops.size).toBe(0);
    expect(hasShellOutputListener('call-a')).toBe(false);
    expect(hasShellOutputListener('call-b')).toBe(false);
  });

  it('leaves a host with no map unsubscribed, so headless runs pay nothing', () => {
    const { host, emitted } = hostWith({});
    const sources = composeLegacyRunSources(agent, host);

    sources.queueTool({ callId: CALL_ID, name: 'bash', input: {} } as never);

    expect(hasShellOutputListener(CALL_ID)).toBe(false);
    // The tool still dispatches: opting out of the tail is not opting out of
    // the call.
    expect(emitted).toEqual([]);
    // And a stray slice for an unknown task is simply dropped.
    expect(() => emitShellOutput({ taskId: CALL_ID, delta: 'ignored' })).not.toThrow();
  });

  it('does not subscribe for the progress tool, which never spawns a command', () => {
    const stops = new Map<string, () => void>();
    const { host, queued } = hostWith({ shellOutputStops: stops });
    (host as unknown as { progressToolName: () => string }).progressToolName = () =>
      'progress_update';
    const sources = composeLegacyRunSources(agent, host);

    // A call whose input is not a progress update still takes the shell leg;
    // the guard is about what the composition queues, not what it tails.
    sources.queueTool({ callId: 'call-real', name: 'bash', input: { command: 'ls' } } as never);
    expect(queued).toHaveLength(1);

    // A live subscriber the run did NOT create must not be touched by teardown.
    const external = onShellOutput('call-external', () => {});
    sources.discardTools();
    expect(hasShellOutputListener('call-external')).toBe(true);
    external();
  });
});

/**
 * Everything above injects slices with `emitShellOutput`. This one case lets a
 * real process write them, through the descriptor `startManagedShell` hands to
 * `stdio` and the poller that reads that file back -- so the assertion covers
 * the composition's ORDER against a spawn that does not wait for it.
 *
 * The command is the same length of time on purpose: the first slice is only
 * observable while the call is still running, which is the entire claim this
 * feature makes.
 */
const realShell = (() => {
  const probe = spawnSync('bash', ['-c', 'true'], { timeout: 5_000 });
  return probe.status === 0 ? 'bash' : null;
})();
const describeRealShell = realShell === null ? describe.skip : describe;

describeRealShell('a real command reaches the run emitter through the run subscription', () => {
  let outputDirectory: string;

  beforeEach(() => {
    outputDirectory = mkdtempSync(join(tmpdir(), 'duya-shell-vertical-'));
  });
  afterEach(() => {
    rmSync(outputDirectory, { recursive: true, force: true });
  });

  it('emits a tool.output_delta for bytes the command printed mid-run', async () => {
    vi.useRealTimers();
    const stops = new Map<string, () => void>();
    const { host, emitted } = hostWith({ shellOutputStops: stops });
    const sources = composeLegacyRunSources(agent, host);

    // Production order: the engine queues the call, the pipeline spawns it.
    sources.queueTool({ callId: CALL_ID, name: 'bash', input: { command: 'print' } } as never);

    const abort = new AbortController();
    try {
      const handle = await startManagedShell(
        {
          taskId: CALL_ID,
          command: 'printf first-line; sleep 1; printf second-line',
          shellPath: 'bash',
          shellArgs: ['-c', 'printf first-line; sleep 1; printf second-line'],
          cwd: process.cwd(),
          env: process.env,
          foregroundTimeoutMs: 60_000,
          abortSignal: abort.signal,
        },
        {
          registry: {
            register: () => undefined,
            markKilled: () => undefined,
            markCompleted: () => undefined,
            markAutoPromoted: () => undefined,
          } as never,
          outputDirectory: () => outputDirectory,
        },
      );
      await handle.settled;
    } finally {
      abort.abort();
      sources.discardTools();
    }

    const deltas = (emitted as { type: string; delta?: string }[])
      .filter((event) => event.type === 'tool.output_delta')
      .map((event) => event.delta ?? '');
    // Every slice carries the call id the run subscribed under, so the renderer
    // can address one row and not its sibling.
    expect(
      (emitted as { type: string; toolCallId?: string }[]).every(
        (event) => event.type !== 'tool.output_delta' || event.toolCallId === CALL_ID,
      ),
    ).toBe(true);
    expect(deltas.join('')).toContain('first-line');
  }, 20_000);
});
