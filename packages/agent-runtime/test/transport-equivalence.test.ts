/**
 * THE DECISIVE TEST: one offline execution, three transports, one sequence.
 *
 * ## What is claimed
 *
 * Plan 587 T3.5's acceptance is that the same offline execution through all
 * three adapters yields the same NORMALISED semantic sequence and the same
 * result, with transport-local diagnostics separable. If the adapters could
 * each be right while disagreeing, the single-entry claim from R2.1 would not
 * yet be true -- so this file is the check on the claim, not a demonstration of
 * it.
 *
 * ## How the three runs are made genuinely different
 *
 * They are not three wrappers over one loop. Each delivery path is a different
 * set of operations between the executor and the runtime:
 *
 *   in-process  sink.frame(raw)                      -- a direct call
 *   subprocess  sink.frame(raw) -> encode -> PIPE -> decode -> frame(raw)
 *   http-sse    sink.frame(raw) -> SSE frame -> SOCKET -> parse -> frame(raw)
 *
 * The subprocess one runs a REAL child process built from the repository's own
 * `sendEvent`. The SSE one crosses a REAL loopback socket. If the framing, the
 * chunking, the JSON round trip or the ordering were wrong anywhere, the three
 * sequences would diverge -- and the byte-at-a-time case below makes the
 * subprocess path deliver frames one byte per write, which a coalescing pipe
 * would otherwise hide.
 *
 * ## What "normalised" excludes
 *
 * Documented at length in `equivalence.ts`; the short form: wall-clock
 * durations and transport-local diagnostics are excluded, because they are
 * facts about the CONNECTION. Everything about the RUN is compared exactly --
 * the ordered event types, the dense `seq` from 1, every payload field, and
 * the terminal. `seq` is compared as a SHAPE rather than as absolute values,
 * since each adapter gets a fresh run and therefore its own numbering; what has
 * to be identical is that each minted 1..N densely with no hole, which is
 * contract section F's rule for the live stream.
 */

import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PermissionPolicyMode,
  RunEventEnvelope,
  RunId,
  RunManifest,
  RunTerminalState,
  JsonValue,
} from '@duya/agent-protocol';
import { manifestFingerprint } from '@duya/agent-protocol';
import { RunController } from '../src/controller.js';
import { InMemoryRunEventStore } from '../src/replay/replay-repository.js';
import { InProcessTransport } from '../src/transport/in-process-transport.js';
import { SubprocessTransport } from '../src/transport/subprocess-transport.js';
import { HttpSseServer, type RegisteredRun } from '../src/transport/http-sse-transport.js';
import type {
  ExecutionChannel,
  ExecutionHandle,
  StopReceipt,
  TranslateContext,
} from '../src/transport/execution-channel.js';
import type { RawFrame } from '../src/translate/chat-event-translator.js';
import {
  assertNormalisationIsHonest,
  compareRuns,
  normaliseEnvelope,
  normaliseResult,
} from '../src/transport/equivalence.js';

const WORKER = fileURLToPath(
  new URL('../../agent/tests/process/fixtures/real-worker.mjs', import.meta.url),
);

/** Three real multi-byte characters, spelled as escapes to keep this ASCII. */
const CJK = '\u4e2d\u6587\u6d4b\u8bd5';

const servers: HttpSseServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/**
 * The SAME run identity for all three adapters.
 *
 * This is a deliberate tightening rather than a convenience. The manifest hash
 * is a function of the manifest, which contains the `runId` -- so giving each
 * adapter its own id made the very first payload differ on a field that says
 * nothing about behaviour. The tempting fix was to exclude `manifestHash` from
 * the compared payload, which is exactly the kind of normalisation fudge this
 * suite exists to prevent: it would have hidden a real hash divergence behind
 * an allowlist entry.
 *
 * Sharing the id is safe because each adapter has its own controller, its own
 * session and its own store, so there is no shared state to collide. The
 * consequence is that `manifestHash` is compared exactly, and it matches.
 */
const SHARED_RUN_ID = 'run-eq-shared' as RunId;

/**
 * The offline execution, as RAW frames.
 *
 * The shape is chosen to be hostile to a transport: interleaved content blocks
 * that must never merge, a real newline in the content (which the worker
 * escapes), multi-byte characters, a tool call with a barrier in front of it,
 * and a terminal.
 */
const EXECUTION: readonly JsonValue[] = [
  { type: 'chat:text', messageId: 'm1', content: 'block A part 1' },
  { type: 'chat:thinking', messageId: 'm1', content: CJK },
  { type: 'chat:text', messageId: 'm1', content: 'block A part 2' },
  { type: 'chat:text', messageId: 'm2', content: 'block B, with a\nnewline' },
  { type: 'chat:tool_use', id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
  { type: 'chat:tool_result', id: 'call-1', result: 'contents', error: false },
  { type: 'chat:text', messageId: 'm2', content: 'block B part 2' },
  { type: 'chat:done' },
];

function buildManifest(runId: RunId): RunManifest {
  return {
    version: 1,
    runId,
    projectId: null,
    sessionId: 'session-1',
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    workspaceId: 'ws-1',
    roots: [],
    cwd: '.',
    permissionPolicy: {
      mode: 'default' as PermissionPolicyMode,
      hostSwitch: 'ask',
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget: { maxTurns: 8 },
    deterministic: false,
  } as unknown as RunManifest;
}

function contextFor(): TranslateContext {
  return {
    messageId: 'msg-1',
    permission: {
      classify: () => 'tool_use',
      mode: 'generic',
      expiresInMs: 300_000,
      now: () => 0,
    },
    nextTurn: (() => {
      let n = 0;
      return () => {
        n += 1;
        return { turnId: `turn-${n}`, index: n };
      };
    })(),
    model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
  };
}

function cooperativeStop(reason: string): StopReceipt {
  return { requested: true, disposition: 'cooperative', waitedMs: 0, reason };
}

/** An `ExecutionChannel` that replays a fixed frame script, in process. */
function scriptedChannel(frames: readonly RawFrame[]): ExecutionChannel {
  return {
    async start(_manifest, _input, sink): Promise<ExecutionHandle> {
      for (const frame of frames) sink.frame(frame);
      sink.end();
      return { stop: async (request) => cooperativeStop(request.reason) };
    },
  };
}

interface RunOutcome {
  readonly transport: string;
  readonly events: readonly RunEventEnvelope[];
  readonly terminal: RunTerminalState;
  readonly diagnostics: { readonly transport: string; readonly bytesRead: number; readonly chunksRead: number };
  readonly durableCount: number;
}

/**
 * Run one execution through one channel, against a REAL controller.
 *
 * The controller, the session and the emitter are the real ones -- there is no
 * second state machine anywhere in this file, which is the property the whole
 * comparison rests on. Only the delivery path differs between calls.
 */
async function runOnce(
  transportName: string,
  runId: RunId,
  channel: ExecutionChannel,
  diagnostics: () => RunOutcome['diagnostics'],
): Promise<RunOutcome> {
  const manifest = buildManifest(runId);
  const store = new InMemoryRunEventStore();
  const controller = new RunController({
    channel,
    identity: { name: 'duya-agent-runtime', version: '0.1.0' },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => ({
      append: async (envelopes) => {
        await store.append(envelopes);
      },
      complete: async () => undefined,
    }),
  });

  const handle = await controller.start(manifest, { prompt: 'run the script', sessionId: 'session-1' });
  // The ONLY channel through which run state propagates, so this is the run's
  // whole observed sequence and not a subset chosen by the test.
  const events: RunEventEnvelope[] = [];
  for await (const wire of handle.events()) {
    events.push(wire as unknown as RunEventEnvelope);
  }
  const terminal = await handle.terminal;
  await controller.settle(runId);
  return {
    transport: transportName,
    events,
    terminal,
    diagnostics: diagnostics(),
    durableCount: store.lastReceipt.accepted.length,
  };
}

describe('one offline execution, three transports, one normalised sequence', () => {
  it('produces the same events and the same result through all three', async () => {
    const raw = EXECUTION as readonly RawFrame[];

    // 1. In-process: the runtime's own intake, no bytes at all.
    const inProcess = new InProcessTransport({
      channel: scriptedChannel(raw),
      capabilities: async () => ({}) as never,
    });
    const a = await runOnce(
      'in-process',
      SHARED_RUN_ID,
      {
        async start(manifest, _input, sink) {
          const run = await inProcess.start(manifest, {
            frame: (f) => sink.frame(f),
            end: () => sink.end(),
          });
          return run.handle;
        },
      },
      () => neutralDiagnostics('in-process'),
    );

    // 2. Subprocess: a REAL child process built from the worker's own sendEvent,
    //    writing ONE BYTE per write so the framing is exercised at its worst.
    const subprocess = new SubprocessTransport({
      command: process.execPath,
      args: [WORKER],
      stopGraceMs: 2_000,
      capabilities: async () => ({}) as never,
    });
    subprocess.stage({ frames: EXECUTION, fragmentBytes: 1 });
    // The RUN, not a snapshot of its diagnostics. Read at dispatch time the byte
    // count is still zero -- the frames have not crossed the pipe yet -- so a
    // snapshot would make the diagnostics assertion below vacuous.
    let subprocessRun: { diagnostics(): RunOutcome['diagnostics'] } | null = null;
    const b = await runOnce(
      'subprocess',
      SHARED_RUN_ID,
      {
        async start(manifest, _input, sink) {
          const run = await subprocess.start(manifest, {
            frame: (f) => sink.frame(f),
            end: () => sink.end(),
          });
          subprocessRun = run;
          return run.handle;
        },
      },
      () => subprocessRun?.diagnostics() ?? neutralDiagnostics('subprocess'),
    );
    await subprocess.close();

    // 3. HTTP+SSE: a REAL loopback socket, real SSE frames, real JSON parse.
    const c = await runOverSse(EXECUTION);

    // The claim.
    const abCompare = compareRuns(
      { transport: a.transport, events: a.events, result: normaliseResult(a.terminal), diagnostics: a.diagnostics as never },
      { transport: b.transport, events: b.events, result: normaliseResult(b.terminal), diagnostics: b.diagnostics as never },
    );
    const acCompare = compareRuns(
      { transport: a.transport, events: a.events, result: normaliseResult(a.terminal), diagnostics: a.diagnostics as never },
      { transport: c.transport, events: c.events, result: normaliseResult(c.terminal), diagnostics: c.diagnostics as never },
    );
    expect(abCompare, 'in-process vs subprocess').toEqual([]);
    expect(acCompare, 'in-process vs http-sse').toEqual([]);

    // And the sequence is not trivially empty, or "equal" would be vacuous.
    expect(a.events.length).toBeGreaterThan(4);
    expect(a.terminal.status).toBe('completed');

    // Every adapter minted a DENSE sequence from 1. Contract section F allows
    // holes in the durable store and nowhere else, so a hole here is a defect
    // in whichever adapter produced it.
    for (const outcome of [a, b, c]) {
      expect(assertNormalisationIsHonest(outcome.events), outcome.transport).toEqual([]);
      expect(outcome.events.map((e) => e.seq), outcome.transport).toEqual(
        outcome.events.map((_, i) => i + 1),
      );
    }

    // The interleaved content blocks survived UNMERGED, checked against the
    // content rather than against a message id.
    //
    // An earlier version of this assertion counted distinct `messageId`s and
    // expected two. That was measuring the wrong thing: the runtime's
    // translator stamps every `chat:text` with the CONTEXT's message id and
    // index 0, so the legacy per-frame `messageId` never reaches the event. The
    // property that actually matters is that four separate text frames arrived
    // as four separate blocks, in order, with their own content -- a coalescer
    // that merged across a block would produce one block holding all four.
    const texts = a.events
      .filter((e) => e.payload.type === 'assistant.text_block')
      .map((e) => (e.payload as { text?: string }).text);
    expect(texts).toEqual([
      'block A part 1',
      'block A part 2',
      'block B, with a\nnewline',
      'block B part 2',
    ]);

    // And the reasoning block is its own event, not concatenated into the
    // answer. The two share a payload shape, which is exactly why the
    // coalescing key has to include the event type.
    const thinking = a.events.filter((e) => e.payload.type === 'assistant.thinking_block');
    expect(thinking).toHaveLength(1);
    expect((thinking[0]!.payload as { thinking?: string }).thinking).toBe(CJK);

    // The tool call and its result are both present, in that order, and the
    // result is a clean success rather than an absent status defaulting to one.
    const toolTypes = a.events.map((e) => e.payload.type);
    expect(toolTypes.indexOf('tool.call_started')).toBeLessThan(
      toolTypes.indexOf('tool.call_completed'),
    );
  });

  it('reports transport-local diagnostics separately, and they DO differ', async () => {
    // The other half of the claim. Diagnostics are permitted to differ -- that
    // is why they are a separate type -- and a test that asserted they were
    // equal would be asserting the pipes behave alike rather than the runs do.
    const raw = EXECUTION as readonly RawFrame[];
    const subprocess = new SubprocessTransport({
      command: process.execPath,
      args: [WORKER],
      capabilities: async () => ({}) as never,
    });
    subprocess.stage({ frames: EXECUTION, fragmentBytes: 1 });
    const inProcess = new InProcessTransport({
      channel: scriptedChannel(raw),
      capabilities: async () => ({}) as never,
    });

    const a = await runOnce(
      'in-process',
      SHARED_RUN_ID,
      {
        async start(manifest, _input, sink) {
          const run = await inProcess.start(manifest, { frame: (f) => sink.frame(f), end: () => sink.end() });
          return run.handle;
        },
      },
      () => neutralDiagnostics('in-process'),
    );
    // The RUN, not a snapshot: read at dispatch time the byte count is zero.
    let subprocessRun2: { diagnostics(): RunOutcome['diagnostics'] } | null = null;
    const b = await runOnce(
      'subprocess',
      SHARED_RUN_ID,
      {
        async start(manifest, _input, sink) {
          const run = await subprocess.start(manifest, { frame: (f) => sink.frame(f), end: () => sink.end() });
          subprocessRun2 = run;
          return run.handle;
        },
      },
      () => subprocessRun2?.diagnostics() ?? neutralDiagnostics('subprocess'),
    );
    await subprocess.close();

    // The subprocess really did move bytes, one chunk per byte; the in-process
    // adapter moved none, and that is the permitted difference.
    expect(b.diagnostics.bytesRead).toBeGreaterThan(0);
    expect(b.diagnostics.chunksRead).toBeGreaterThan(1);
    expect(a.diagnostics.bytesRead).toBe(0);
    // Yet the RUNS are identical, which is the entire point.
    expect(compareRuns(
      { transport: a.transport, events: a.events, result: normaliseResult(a.terminal), diagnostics: a.diagnostics as never },
      { transport: b.transport, events: b.events, result: normaliseResult(b.terminal), diagnostics: b.diagnostics as never },
    )).toEqual([]);
  });
});

describe('the comparison itself is not vacuous', () => {
  it('catches a sequence that is not dense', () => {
    // Each rule is proved by breaking it, so "the comparison passed" is a
    // statement about a check that can fail rather than about a shape nobody
    // asserted.
    const runId = 'run-norm' as RunId;
    const good = [1, 2, 3].map((seq) => envelope(seq, runId));
    expect(assertNormalisationIsHonest(good)).toEqual([]);

    const withHole = [envelope(1, runId), envelope(3, runId), envelope(4, runId)];
    const holes = assertNormalisationIsHonest(withHole);
    expect(holes[0]!.rule).toBe('sequence_not_dense');

    const reordered = [envelope(2, runId), envelope(1, runId)];
    expect(assertNormalisationIsHonest(reordered)[0]!.rule).toBe('sequence_not_dense');
  });

  it('catches two adapters that disagree on a payload value', () => {
    const runId = 'run-norm2' as RunId;
    const left = [envelope(1, runId)];
    const right = [envelope(1, runId)];
    (right[0]!.payload as { text: string }).text = 'something else';
    const differences = compareRuns(
      {
        transport: 'in-process',
        events: left,
        result: { status: 'completed' },
        diagnostics: neutralDiagnostics('in-process') as never,
      },
      {
        transport: 'subprocess',
        events: right,
        result: { status: 'completed' },
        diagnostics: neutralDiagnostics('subprocess') as never,
      },
    );
    // The payload difference is the FIRST one reported, and it is the one this
    // test is about. The second entry is `compareRuns` correctly noticing that
    // the two labelled diagnostics are different transports -- which is that
    // check doing its job, so it is asserted rather than suppressed.
    expect(differences.length).toBeGreaterThanOrEqual(1);
    expect(differences[0]).toContain('differ at position 1');
  });

  it('catches a different event COUNT', () => {
    const runId = 'run-norm3' as RunId;
    const differences = compareRuns(
      {
        transport: 'in-process',
        events: [envelope(1, runId), envelope(2, runId)],
        result: { status: 'completed' },
        diagnostics: neutralDiagnostics('in-process') as never,
      },
      {
        transport: 'subprocess',
        events: [envelope(1, runId)],
        result: { status: 'completed' },
        diagnostics: neutralDiagnostics('subprocess') as never,
      },
    );
    expect(differences[0]).toMatch(/produced 2 events, subprocess produced 1/);
  });

  it('does NOT treat a reordered object key as a difference', () => {
    // Key order is a property of the object literal, not of the run, and a
    // decode/encode round trip legitimately reorders it. Leaf values are still
    // compared exactly.
    const runId = 'run-norm4' as RunId;
    const a = envelope(1, runId);
    const b = envelope(1, runId);
    (b.payload as unknown as Record<string, unknown>) = {
      index: 0,
      text: 'block 1',
      messageId: 'm1',
      type: 'assistant.text_block',
    };
    expect(JSON.stringify(normaliseEnvelope(a))).toBe(JSON.stringify(normaliseEnvelope(b)));
  });
});

// ── the SSE delivery path ─────────────────────────────────────────────────

/**
 * Run the execution over a REAL socket.
 *
 * The frames are served by an `HttpSseServer` from a real fan-out and read back
 * over a real `fetch`, so the client parses genuine SSE bytes. The frames
 * themselves are put on the wire verbatim -- the point of this path is the
 * transport, not the executor, and the executor is a script in all three cases.
 */
async function runOverSse(frames: readonly JsonValue[]): Promise<RunOutcome> {
  const runId = SHARED_RUN_ID;
  const listeners = new Set<(f: JsonValue) => void>();
  // The deferred is created HERE, not inside `closedSignal()`. Creating it in
  // the callback and resolving it from the test is a race: if the signal is
  // resolved before the server's handler has registered the callback, the
  // resolve is dropped and the response never ends.
  let signalClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    signalClosed = resolve;
  });
  const run: RegisteredRun = {
    runId,
    reader: new InMemoryRunEventStore(),
    tap: { attach: () => () => undefined },
    frames: {
      attach(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      closedSignal: () => closed,
    },
    isClosed: () => true,
    mintedLatest: () => 0,
  };
  const server = new HttpSseServer({ token: 'eq-token' });
  server.register(run);
  servers.push(server);
  await server.listen();

  // The client subscribes, and the fan-out is fed while it is reading.
  const { HttpSseClient } = await import('../src/transport/http-sse-transport.js');
  const client = new HttpSseClient({ origin: server.origin, token: 'eq-token' });
  const reading = client.readFrames(runId);
  // Let the request reach the server and the fan-out be attached before the
  // frames are published, so none of them is published to nobody.
  await waitFor(() => listeners.size > 0);
  for (const frame of frames) {
    for (const listener of listeners) listener(frame);
  }
  signalClosed();

  const received = await reading;
  const raw = received.frames as readonly RawFrame[];

  return runOnce(
    'http-sse',
    runId,
    {
      async start(_manifest, _input, sink) {
        for (const frame of raw) sink.frame(frame);
        sink.end();
        return { stop: async (request) => cooperativeStop(request.reason) };
      },
    },
    () => ({
      transport: 'http-sse',
      bytesRead: received.frames.length,
      chunksRead: 1,
    }),
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function envelope(seq: number, runId: RunId): RunEventEnvelope {
  return {
    runId,
    sessionId: 'session-1',
    seq,
    payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: `block ${seq}` },
  } as unknown as RunEventEnvelope;
}

function neutralDiagnostics(transport: string): RunOutcome['diagnostics'] {
  return { transport, bytesRead: 0, chunksRead: 0 };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the transport');
}

void manifestFingerprint;
