/**
 * T3.2 鈥?the sink cannot bypass the ledger.
 *
 * This is the end-to-end version of `event-emitter.test.ts`. That file proves
 * the emitter is correct; this one proves the CONTROLLER actually routes through
 * it, which is the part that was wrong. The `ExecutionSink.envelope` arm used
 * to be a bare `active.stream.push(envelope)`, and the only thing that ever
 * exercised it was a scripted test executor 鈥?so the arm looked healthy to every
 * test that did not check whether the event was recorded.
 *
 * The properties asserted here are all about persistence and numbering, because
 * those are what the bypass skipped.
 */

import { describe, expect, it } from 'vitest';
import { RunController } from '../src/controller.js';
import type {
  ExecutionChannel,
  ExecutionHandle,
  ExecutionSink,
  RunManifest,
  RunMetrics,
  RunPersistence,
  RunTerminalState,
  TranslateContext,
  ConnectorBinding,
  PermissionPolicyMode,
} from '../src/index.js';
import type { RunEventEnvelope } from '@duya/agent-protocol';

function buildManifest(runId: string): RunManifest {
  const permissionPolicy = {
    mode: 'default' as PermissionPolicyMode,
    hostSwitch: 'ask' as const,
    defaultTimeoutMs: 300_000,
  };
  const connectorBindings: readonly ConnectorBinding[] = [];
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/tmp/workspace'],
    cwd: '/tmp/workspace',
    permissionPolicy,
    capabilities: { profiles: [], modes: ['general'], tools: ['Read'] },
    connectorBindings,
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget: { maxTurns: 12 },
    deterministic: false,
  };
}

function contextFor(): TranslateContext {
  let n = 0;
  return {
    messageId: 'msg-1',
    permission: { classify: () => 'tool_use', mode: 'generic', expiresInMs: 300_000, now: () => 1_000 },
    nextTurn: () => {
      n += 1;
      return { turnId: `turn-${n}`, index: n };
    },
    model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
  };
}

interface Recorder {
  readonly persistence: RunPersistence;
  readonly durable: RunEventEnvelope[];
  readonly completed: RunTerminalState[];
}

/** Appends are asynchronous; the assertions read what the run offered. */
function recorder(): Recorder {
  const durable: RunEventEnvelope[] = [];
  const completed: RunTerminalState[] = [];
  const persistence: RunPersistence = {
    append: async (envelopes) => {
      durable.push(...envelopes);
    },
    complete: async (terminal) => {
      completed.push(terminal);
    },
  };
  return { persistence, durable, completed };
}

const STOPPED: ExecutionHandle = {
  stop: async () => ({ requested: false, disposition: 'not_requested', waitedMs: 0, reason: 'none' }),
};

/** A channel that captures the sink so a test can push native envelopes. */
function capturingChannel(sinkRef: { current: ExecutionSink | null }): ExecutionChannel {
  return {
    start: async (_manifest, _input, sink) => {
      sinkRef.current = sink;
      return STOPPED;
    },
  };
}

async function startRun(controller: RunController, runId: string): Promise<void> {
  await controller.start(buildManifest(runId), { prompt: 'hello', sessionId: 'sess-1' });
}

/**
 * Wait for the run's durable writes to land.
 *
 * `RunSession.observe` flushes without awaiting by design 鈥?observing a frame
 * must never block on a cross-process write 鈥?so a test that asserts on
 * persistence has to ask for the barrier explicitly. This is the same await
 * `start` does for `run.started`.
 */
async function drain(controller: RunController, runId: string): Promise<void> {
  await controller.activeRun(runId)?.flush();
}

describe('an inbound native envelope goes through the ledger, not around it', () => {
  it('re-mints the sequence and persists a durable event the bypass would have dropped', async () => {
    const rec = recorder();
    const sinkRef: { current: ExecutionSink | null } = { current: null };
    const controller = new RunController({
      channel: capturingChannel(sinkRef),
      identity: { name: 'test', version: '0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => rec.persistence,
      now: () => 1_000,
      clock: () => 0,
    });

    await startRun(controller, 'run-1');
    const sink = sinkRef.current;
    if (sink === null) throw new Error('the channel never received a sink');

    // The executor claims a large sequence of its own. Under the old arm this
    // landed on the stream verbatim and in no storage at all.
    const runId = 'run-1';
    sink.envelope?.({
      runId,
      sessionId: 'sess-1',
      seq: 9_000,
      timestamp: 5,
      traceId: 't',
      payload: { type: 'assistant.text_block', messageId: 'm', index: 0, text: 'from the executor' },
    });
    await drain(controller, runId);

    // `run.started` is seq 1 and was flushed on its own. The inbound event is
    // the one that follows it, numbered by the run.
    const block = rec.durable.find((e) => e.payload.type === 'assistant.text_block');
    expect(block, 'the inbound durable event never reached persistence').toBeDefined();
    expect(block?.seq).toBe(2);
    expect(block?.seq).not.toBe(9_000);
  });

  it('records a diagnostic when the producer numbers an event differently', async () => {
    const rec = recorder();
    const sinkRef: { current: ExecutionSink | null } = { current: null };
    const controller = new RunController({
      channel: capturingChannel(sinkRef),
      identity: { name: 'test', version: '0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => rec.persistence,
      now: () => 1_000,
      clock: () => 0,
    });

    await startRun(controller, 'run-1');
    const sink = sinkRef.current;
    if (sink === null) throw new Error('the channel never received a sink');

    sink.envelope?.({
      runId: 'run-1',
      sessionId: 'sess-1',
      seq: 9_000,
      timestamp: 5,
      traceId: 't',
      payload: { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'x' },
    });

    const session = controller.activeRun('run-1');
    expect(session, 'the run should still be live').toBeDefined();
    // The disagreement is visible on the run's stream rather than silently
    // renumbered. `diagnostic` is ephemeral, so read the sequence instead.
    expect(session?.seq).toBe(3); // started + the delta + the diagnostic
  });

  it('refuses an inbound event that would break a lifecycle invariant', async () => {
    const rec = recorder();
    const sinkRef: { current: ExecutionSink | null } = { current: null };
    const controller = new RunController({
      channel: capturingChannel(sinkRef),
      identity: { name: 'test', version: '0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => rec.persistence,
      now: () => 1_000,
      clock: () => 0,
    });

    await startRun(controller, 'run-1');
    const sink = sinkRef.current;
    if (sink === null) throw new Error('the channel never received a sink');

    // A tool completion for a call that never started. The ledger refuses it;
    // the old arm would have published it to the UI.
    sink.envelope?.({
      runId: 'run-1',
      sessionId: 'sess-1',
      seq: 1,
      timestamp: 5,
      traceId: 't',
      payload: {
        type: 'tool.call_completed',
        toolCallId: 'never-started',
        content: [],
        outcome: { outcome: 'success' },
        durationMs: 1,
      },
    });
    await drain(controller, 'run-1');

    expect(rec.durable.map((e) => e.payload.type)).not.toContain('tool.call_completed');
  });

  it('refuses an inbound envelope that names another run', async () => {
    const rec = recorder();
    const sinkRef: { current: ExecutionSink | null } = { current: null };
    const controller = new RunController({
      channel: capturingChannel(sinkRef),
      identity: { name: 'test', version: '0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => rec.persistence,
      now: () => 1_000,
      clock: () => 0,
    });

    await startRun(controller, 'run-1');
    const sink = sinkRef.current;
    if (sink === null) throw new Error('the channel never received a sink');

    sink.envelope?.({
      runId: 'a-different-run',
      sessionId: 'sess-1',
      seq: 1,
      timestamp: 5,
      traceId: 't',
      payload: { type: 'assistant.text_block', messageId: 'm', index: 0, text: 'not mine' },
    });
    await drain(controller, 'run-1');

    expect(rec.durable.map((e) => e.payload.type)).not.toContain('assistant.text_block');
  });
});

describe('a legacy frame still flows through the same entry point', () => {
  it('persists the translated durable event and keeps the sequence gapless', async () => {
    const rec = recorder();
    let frame: ((raw: Record<string, unknown>) => void) | null = null;
    const channel: ExecutionChannel = {
      start: async (_m, _i, sink) => {
        frame = (raw) => sink.frame(raw);
        return STOPPED;
      },
    };
    const controller = new RunController({
      channel,
      identity: { name: 'test', version: '0' },
      protocol: { major: 1, minor: 0 },
      contextFor,
      persistenceFor: () => rec.persistence,
      now: () => 1_000,
      clock: () => 0,
    });

    await startRun(controller, 'run-1');
    if (frame === null) throw new Error('the channel never received a sink');

    // A normalised legacy `text` frame, the shape the router produces.
    const send = frame as (raw: Record<string, unknown>) => void;
    send({ type: 'text', data: { content: 'hello' } });
    await drain(controller, 'run-1');

    const text = rec.durable.find((e) => e.payload.type === 'assistant.text_block');
    expect(text, 'the legacy frame never reached the durable log').toBeDefined();
    expect(text?.seq).toBe(2);
  });
});
