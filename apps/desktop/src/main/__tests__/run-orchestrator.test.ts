/**
 * The agent-server's run layer, driven the way the router drives it.
 *
 * ## What this covers that the runtime suite cannot
 *
 * `packages/agent-runtime` is proven end to end in
 * `reference-run.test.ts`, with a scripted executor. What is left untested
 * there is the ADAPTER: the translation from the router's `db:request` channel
 * into the Control Plane's actions, and from a normalised worker frame into
 * `observeFrame`. That adapter is where a wrong action name or a wrong payload
 * shape would live, and both would fail silently — the chat would work, the
 * chat would always work, and no run would ever be recorded.
 *
 * So this test asserts on the CALLS, using a `dbRequest` double that records
 * every action and payload. `run:create` must be issued before any frame is
 * observed, `run:append` must carry the durable envelopes, and `run:complete`
 * must carry the terminal state.
 */

import { describe, expect, it } from 'vitest';
import type { RunTerminalState } from '@duya/agent-protocol';
import { RunOrchestrator, createWorkerExecutionChannel } from '../agents/server/run-orchestrator';

interface Call {
  action: string;
  payload: Record<string, unknown>;
}

function recorder(): { calls: Call[]; request: (a: string, p: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = [];
  return {
    calls,
    request: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'run:create') return { ok: true, runId: payload.runId };
      if (action === 'run:append') {
        return { ok: true, written: (payload.events as unknown[]).length };
      }
      return { ok: true, applied: true };
    },
  };
}

function makeOrchestrator(dbRequest: (a: string, p: Record<string, unknown>) => Promise<unknown>) {
  let dispatched = 0;
  const orchestrator = new RunOrchestrator({
    dbRequest,
    channel: createWorkerExecutionChannel(() => {
      dispatched += 1;
    }),
  });
  return { orchestrator, dispatchCount: () => dispatched };
}

const intent = {
  workingDirectory: '/repo',
  model: 'claude-opus',
  providerId: 'anthropic-main',
  apiFormat: 'anthropic' as const,
  origin: 'user' as const,
};

describe('RunOrchestrator', () => {
  it('opens the run through the Control Plane with a frozen manifest', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);

    const runId = await orchestrator.openRun('session-1', intent);
    expect(runId).not.toBeNull();

    const create = calls.find((c) => c.action === 'run:create');
    expect(create).toBeDefined();
    expect(create?.payload.runId).toBe(runId);
    expect(create?.payload.sessionId).toBe('session-1');
    // The manifest is persisted VERBATIM, and the hash is pinned by the
    // Control Plane before the run exists. A hash that is only computed later
    // proves nothing about what the run was given.
    expect(typeof create?.payload.manifestHash).toBe('string');
    expect((create?.payload.manifestHash as string).length).toBe(64);
    expect((create?.payload.manifest as { cwd: string }).cwd).toBe('/repo');
  });

  it('never lets a Control Plane refusal block the chat', async () => {
    // Losing the durable record is a degradation; refusing the user's message
    // is a regression. `openRun` must return null and the router must carry on.
    const { orchestrator } = makeOrchestrator(async () => ({ ok: false, error: 'no core stores' }));
    await expect(orchestrator.openRun('session-1', intent)).resolves.toBeNull();
  });

  it('never lets a Control Plane throw block the chat', async () => {
    const { orchestrator } = makeOrchestrator(async () => {
      throw new Error('db:request channel closed');
    });
    await expect(orchestrator.openRun('session-1', intent)).resolves.toBeNull();
  });

  it('records run.started before the first frame is observed', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);

    // Everything the run is OPENED with must be on the wire before
    // `openRun` resolves, because the host dispatches the execution the moment
    // it does. `run.started` is flushed on its own and awaited for exactly
    // that reason: a run that crashes on its first frame still leaves the
    // record that says what it was given.
    await orchestrator.openRun('session-1', intent);
    const openWindow = calls.length;

    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
    await vi.waitFor(() => {
      expect(calls.some((c) => c.action === 'run:complete')).toBe(false);
    });

    const createIndex = calls.findIndex((c) => c.action === 'run:create');
    const firstAppendIndex = calls.findIndex((c) => c.action === 'run:append');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(firstAppendIndex).toBeGreaterThan(createIndex);
    // Both landed inside `openRun`, not after it.
    expect(firstAppendIndex).toBeLessThan(openWindow);

    const events = calls[firstAppendIndex]?.payload.events as Array<{ payload: { type: string } }>;
    // The first batch is `run.started` ALONE — proof it was not batched behind
    // the turn event that followed it.
    expect(events.map((e) => e.payload.type)).toEqual(['run.started']);
    expect(calls[firstAppendIndex]?.payload.runId).toBe(calls[createIndex]?.payload.runId);
  });

  it('settles the run when the worker reports done', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    const runId = await orchestrator.openRun('session-1', intent);

    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
    orchestrator.observe('session-1', { type: 'text', data: { content: 'hi' } });
    orchestrator.observe('session-1', { type: 'done', data: {} });

    await vi.waitFor(() => {
      expect(calls.some((c) => c.action === 'run:complete')).toBe(true);
    });
    const complete = calls.find((c) => c.action === 'run:complete');
    expect(complete?.payload.runId).toBe(runId);
    const terminal = complete?.payload.terminal as RunTerminalState;
    expect(terminal.status).toBe('completed');
    // Cancellation is not failure, and natural completion carries no error.
    expect(complete?.payload.terminal).not.toHaveProperty('error');
  });

  it('settles a run whose stream ended with no terminal frame as a crash', async () => {
    // Silence is not consent. Without this, a worker that dies mid-turn leaves
    // a `running` row that no process will ever close.
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    await orchestrator.openRun('session-1', intent);

    orchestrator.observe('session-1', { type: 'turn_start', data: { turnCount: 1 } });
    await orchestrator.settleSession('session-1');

    const complete = calls.find((c) => c.action === 'run:complete');
    const terminal = complete?.payload.terminal as RunTerminalState;
    expect(terminal.status).toBe('failed');
    if (terminal.status === 'failed') expect(terminal.error.code).toBe('runtime_crash');
  });

  it('keeps concurrent sessions on separate runs', async () => {
    // The bug this guards is a single shared "current run" field, which would
    // route one session's events into the other session's row.
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);

    const runA = await orchestrator.openRun('session-a', intent);
    const runB = await orchestrator.openRun('session-b', intent);
    expect(runA).not.toBe(runB);

    orchestrator.observe('session-a', { type: 'turn_start', data: { turnCount: 1 } });
    orchestrator.observe('session-b', { type: 'turn_start', data: { turnCount: 1 } });
    await Promise.resolve();
    await Promise.resolve();

    const appends = calls.filter((c) => c.action === 'run:append');
    const owners = new Set(appends.map((c) => c.payload.runId));
    expect(owners.has(runA as string)).toBe(true);
    expect(owners.has(runB as string)).toBe(true);
  });

  it('ignores frames for a session with no run', async () => {
    const { calls, request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    // A GET-reconnect for a session whose run was never opened must not write
    // anything, and must not throw.
    expect(() => orchestrator.observe('unknown-session', { type: 'text', data: { content: 'x' } })).not.toThrow();
    expect(calls.filter((c) => c.action === 'run:append')).toHaveLength(0);
  });

  it('forwards a frame it could not model, flagged as forward-only', async () => {
    const { request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    await orchestrator.openRun('session-1', intent);

    // `workflow_run` has no protocol counterpart, and the renderer renders it.
    // Dropping it would break the UI, which is the one thing this plan must
    // not do.
    const outcome = orchestrator.observe('session-1', { type: 'workflow_run', data: { run: { id: 'w1' } } });
    expect(outcome.forwardOnly).toBe(true);
    expect(outcome.legacy).toBeNull();
  });

  it('drops an internal control-plane frame instead of recording it', async () => {
    const { request } = recorder();
    const { orchestrator } = makeOrchestrator(request);
    await orchestrator.openRun('session-1', intent);

    const outcome = orchestrator.observe('session-1', { type: 'pong' });
    expect(outcome.forwardOnly).toBe(false);
    expect(outcome.legacy).toBeNull();
  });

  it('hands the run id to the host dispatch callback and nothing more', async () => {
    // The seam's contract: `controller.start` asks the channel to begin, and
    // the channel forwards the runId to whatever the HOST wired up. The desktop
    // host wires a no-op, because the router issues `chat:start` itself
    // immediately after `openRun` returns. So the assertion that matters is
    // which runId the channel was handed — not that a callback fired, since
    // whether one fires at all is the host's decision, not the run layer's.
    const seen: string[] = [];
    const orchestrator = new RunOrchestrator({
      dbRequest: async (action, payload) =>
        action === 'run:create' ? { ok: true, runId: payload.runId } : { ok: true },
      channel: createWorkerExecutionChannel((runId) => {
        seen.push(runId);
      }),
    });

    const runId = await orchestrator.openRun('session-1', intent);
    // The channel fired exactly once, and with the run's own id — so a host
    // that wants the run layer to drive execution can, without the run layer
    // inventing a second source of run identity to do it with.
    expect(seen).toEqual([runId]);
  });
});
