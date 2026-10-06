/**
 * Plan 600 S2 step b4a: the engine publishes its deltas from INSIDE the loop.
 *
 * ## The blocker this file exists to remove
 *
 * `run-engine.ts` accumulated `text`, `thinking` and `tool_use_delta` into the
 * turn's message and published the result through `#publishBlocks`, which runs
 * AFTER the `for await`. So a turn's whole answer reached the host in one piece
 * when the stream closed, and the measured order was:
 *
 * ```
 * MODEL: text "Hello "     <- nothing published
 * MODEL: text "world"      <- nothing published
 * MODEL: turn_stopped      <- stream over
 * PUBLISH: assistant.text_block
 * ```
 *
 * `assistant.text_delta`, `assistant.thinking_delta` and `tool.arguments_delta`
 * were emitted ZERO times by the engine, so the projector's arms for them
 * (`project/legacy-sse-projector.ts:65-88`) described a surface that did not
 * exist. This file proves the timing, not the presence.
 *
 * ## Why "it was published" is not the assertion
 *
 * A test that only waits for the run to finish and then finds a delta passes
 * just as well against an engine that buffered every frame and flushed them at
 * the end -- which is the bug. So the central test here parks the model port on
 * a gate the test controls, and asks what the host has received while the stream
 * is still open. A second test counts the frames the port had produced at the
 * moment the first delta was published, which is what tells "published as it
 * arrives" apart from "published at the end" over a stream long enough to
 * measure.
 *
 * ## Ephemeral vs durable is read where it is DECIDED
 *
 * The durability test does not consult a table this file wrote. It wires a real
 * `RunEventEmitter` + `RunSession` behind the engine's `events` port, so the
 * answer comes from `RunEventEmitter.#mint` (`events/event-emitter.ts:553`) and
 * the consequence is checked in the persistence port: every fragment is absent
 * from `append`, every block is in it. That is the storage-blow-up claim,
 * measured rather than asserted. An event the emitter REFUSES never reaches the
 * host, so a refusal is recorded and asserted empty in every test here.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  AssistantMessageRecord,
  ModelFrame,
  ModelPort,
  RunEnginePorts,
  RunInputSnapshot,
  RunManifest,
  ToolCallRequest,
  ToolDrainItem,
} from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope, RunMetrics, RunTerminalState, RunId } from '@duya/agent-protocol';
import { RunEventEmitter } from '../src/events/event-emitter.js';
import { RunSession, type RunPersistence } from '../src/run-session.js';

const ANSWER_HEAD = 'Hello ';
const ANSWER_TAIL = 'world';
const THINKING = 'weighing the options';
const READ_CALL: ToolCallRequest = {
  callId: 'call-1',
  name: 'Read',
  input: { path: 'a.ts' },
  sideEffect: 'read_only',
};

/**
 * How long a test waits for evidence that should already be there.
 *
 * Short on purpose: every use of it waits for something that happens inside a
 * microtask, so a miss is a broken claim rather than a slow machine, and a 10s
 * vitest timeout would report it as neither.
 */
const SLOT_MS = 2_000;

function manifest(runId: string): RunManifest {
  return {
    version: 1,
    runId: runId as RunId,
    projectId: null,
    workspaceId: 'ws',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      cwd: { source: 'unsupported', synthesised: true },
      permissionPolicy: { source: 'unsupported', synthesised: true },
      capabilities: { source: 'unsupported', synthesised: true },
      connectorBindings: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
      agent: { source: 'unsupported', synthesised: true },
      budget: { source: 'unsupported', synthesised: true },
      workspaceId: { source: 'unsupported', synthesised: true },
      projectId: { source: 'unsupported', synthesised: true },
    },
  } as unknown as RunManifest;
}

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'read the file' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as RunInputSnapshot;

function typesOf(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

function ofType<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

/** A gate the test opens, plus the signal that the port reached it. */
function latch(): { readonly open: () => void; readonly reached: Promise<void> } {
  let release!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hit = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { open: () => { arrive(); release(); }, reached: hit };
}

/**
 * `true` if `promise` settles within the slot, `false` if it is still pending.
 *
 * Returns as soon as the promise settles, so the green path costs nothing and
 * only a claim that never arrives pays the slot.
 */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  const PENDING = Symbol('pending');
  const winner = await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(PENDING), SLOT_MS)),
  ]);
  return winner !== PENDING;
}

interface Collected {
  /** Every event the engine published, in order, unfiltered. */
  readonly events: RunEvent[];
  /** `#mint`'s verdict per event, in publish order. */
  readonly verdicts: { type: string; durable: boolean }[];
  /** Events the emitter refused. Non-empty means the host never saw them. */
  readonly refusals: string[];
  /** Everything the durable port was asked to write. */
  readonly appended: RunEventEnvelope[];
  readonly records: AssistantMessageRecord[];
  /**
   * How many frames the model port had produced at each publish.
   *
   * Stamped INSIDE the publish call, so it measures the interleave rather than
   * the outcome: an engine that buffers reports the total here at its first
   * publish, and one that publishes as it arrives reports 1.
   */
  readonly framesAtPublish: number[];
  terminalProposed: boolean;
}

function collectors(): Collected {
  return {
    events: [],
    verdicts: [],
    refusals: [],
    appended: [],
    records: [],
    framesAtPublish: [],
    terminalProposed: false,
  };
}

/** Where the model port is in its own script. The publish path reads it. */
interface PortState {
  framesProduced: number;
  /** False once a generator has returned, i.e. the stream is closed. */
  streamOpen: boolean;
}

/**
 * A real `RunEventEmitter` over a real `RunSession`, behind the engine's
 * `events` port.
 *
 * Used by every test here rather than only the durability one, because it is the
 * path production takes, and a test that recorded refusals into a discarded list
 * would call a refused event a success.
 */
function publishingPort(collected: Collected, runId: string, state: PortState): (event: RunEvent) => void {
  const persistence: RunPersistence = {
    append: async (envelopes) => {
      collected.appended.push(...envelopes);
    },
    complete: async (_terminal: RunTerminalState, _metrics: RunMetrics) => undefined,
  };
  const session = new RunSession({
    runId,
    sessionId: 'sess-1',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence,
    flushEvery: 1,
  });
  const emitter = new RunEventEmitter({ session, stream: { push: (): void => {} }, runId });
  return (event: RunEvent): void => {
    const result = emitter.emit(event);
    if (!result.ok) {
      collected.refusals.push(`${result.code}: ${result.message}`);
      return;
    }
    collected.events.push(event);
    collected.verdicts.push({ type: event.type, durable: result.durable });
    collected.framesAtPublish.push(state.framesProduced);
  };
}

interface Scripted {
  readonly ports: RunEnginePorts;
  readonly state: PortState;
  /** Resolves when the port parks on its gate. Never resolves without one. */
  readonly parked: Promise<void>;
}

/**
 * One model port per TURN of script, so a run that legitimately takes two turns
 * gets two different streams. A single shared script would replay turn one on
 * every turn and silently multiply every count in the assertions below.
 *
 * `parkAfter` (frames into the FIRST turn) makes that turn's generator await
 * `gate` instead of returning. While it waits, the stream is open and has
 * nothing left to give, so anything the host holds can only have come from
 * inside the loop.
 */
function scripted(
  collected: Collected,
  runId: string,
  turns: readonly (readonly ModelFrame[])[],
  parkAfter?: { readonly frames: number; readonly gate: Promise<void> },
): Scripted {
  const state: PortState = { framesProduced: 0, streamOpen: true };
  const publish = publishingPort(collected, runId, state);
  let stream = 0;
  let arrive!: () => void;
  const parked = new Promise<void>((resolve) => {
    arrive = resolve;
  });

  const model: ModelPort = {
    async *stream(): AsyncIterable<ModelFrame> {
      const script = turns[stream];
      stream += 1;
      if (script === undefined) {
        state.streamOpen = false;
        return;
      }
      for (let i = 0; i < script.length; i += 1) {
        if (parkAfter !== undefined && stream === 1 && i === parkAfter.frames) {
          arrive();
          await parkAfter.gate;
        }
        state.framesProduced += 1;
        yield script[i] as ModelFrame;
      }
      if (stream === turns.length) state.streamOpen = false;
    },
  };

  return {
    state,
    parked,
    ports: {
      model,
      tools: {
        dispatch(): void {},
        async *drain(): AsyncIterable<ToolDrainItem> {},
        discard(): void {},
        describe: () => [],
      },
      context: {
        async assemble(): Promise<AssembledTurn> {
          return {
            systemPrompt: 'test',
            messages: [],
            tools: [],
            catalogRevision: 'cat-1',
            revision: 'rev-1',
          };
        },
        defer(): void {},
      },
      approval: {
        async authorize(): Promise<ApprovalVerdict> {
          return { allowed: true, scope: 'once' };
        },
      },
      events: {
        publish,
        proposeTerminal(): void {
          collected.terminalProposed = true;
        },
      },
      // Required since A3-1. Nothing is queued in this harness, and saying so
      // is the point: the port cannot be left out, so a test that does not care
      // about inter-turn input states that it has none.
      interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
      turnOutput: {
        async recordAssistantMessage(record: AssistantMessageRecord): Promise<void> {
          collected.records.push(record);
        },
        async recordToolResult(): Promise<void> {},
        async finishTurn(): Promise<void> {},
      },
    },
  };
}

function start(ports: RunEnginePorts, runId: string, maxTurns = 5) {
  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: maxTurns });
  return engine.execute({
    manifest: manifest(runId),
    input: INPUT,
    signal: new AbortController().signal,
    ports,
  });
}

/** The durable port's writes are floating promises; a macrotask lets them land. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a delta reaches the host while the model stream is still open', () => {
  it('publishes the first text fragment before the loop has seen the second frame', async () => {
    const collected = collectors();
    const gate = latch();
    const { ports, parked, state } = scripted(
      collected,
      'run-open',
      [[
        { type: 'text', text: ANSWER_HEAD },
        { type: 'text', text: ANSWER_TAIL },
        { type: 'turn_stopped', reason: 'end_turn' },
      ]],
      { frames: 1, gate: gate.reached },
    );
    const done = start(ports, 'run-open').completed();

    // The port is now parked with its gate shut: one frame delivered, the rest
    // of the turn unreachable until this test says otherwise.
    expect(await settles(parked), 'the model port never parked, so the timing claim is untested').toBe(true);

    // THE CENTRAL CLAIM. The host already has the first fragment while the
    // generator is suspended, which no post-loop publish could manage.
    const published = typesOf(collected.events);
    expect(
      published,
      'no assistant.text_delta reached the host while the model stream was still open',
    ).toContain('assistant.text_delta');
    // Two expected values from two other places: the message id the engine
    // derives from the run id, and the fragment this file fed the port.
    expect(collected.events).toContainEqual({
      type: 'assistant.text_delta',
      messageId: 'run-open:message',
      index: 0,
      delta: ANSWER_HEAD,
    });
    // Only the first frame's worth: the second fragment is still behind the
    // gate, so finding it here would mean the port was not really parked.
    expect(ofType(collected.events, 'assistant.text_delta')).toHaveLength(1);

    // The stream has NOT ended, so nothing about the turn is finished yet.
    expect(state.streamOpen, 'the model generator had already returned').toBe(true);
    expect(collected.terminalProposed, 'the run proposed a terminal mid-stream').toBe(false);
    // The block is the post-loop half of the design and must not be here yet --
    // if it were, "publishes as it arrives" would be false even though the delta
    // was also published early.
    expect(published, 'the durable block was published before the stream ended').not.toContain(
      'assistant.text_block',
    );
    expect(published).not.toContain('assistant.message_finalized');

    // Let the turn finish, and check the other half of the contract.
    gate.open();
    await done;
    await settleWrites();

    const after = typesOf(collected.events);
    expect(after.indexOf('assistant.text_delta')).toBeLessThan(after.indexOf('assistant.text_block'));
    expect(after).toContain('assistant.text_block');
    expect(after).toContain('assistant.message_finalized');
    expect(ofType(collected.events, 'assistant.text_delta').map((event) => event.delta)).toEqual([
      ANSWER_HEAD,
      ANSWER_TAIL,
    ]);
    expect(collected.refusals).toEqual([]);
  });

  it('does not buffer: the first fragment is published after one frame of forty', async () => {
    const collected = collectors();
    const frameCount = 40;
    const script: ModelFrame[] = [];
    for (let i = 0; i < frameCount; i += 1) script.push({ type: 'text', text: `f${i} ` });
    script.push({ type: 'turn_stopped', reason: 'end_turn' });

    await start(scripted(collected, 'run-buffer', [script]).ports, 'run-buffer').completed();
    await settleWrites();

    // The interleave, read from the stamp taken inside the publish call. A
    // buffering engine reports the whole stream here; one that publishes as it
    // arrives reports 1.
    const firstDeltaAt = collected.framesAtPublish[1];
    expect(firstDeltaAt, 'the first delta was published only after the whole stream was read').toBe(1);

    const deltas = ofType(collected.events, 'assistant.text_delta');
    expect(deltas).toHaveLength(frameCount);
    // Every frame, in order, and the block is their concatenation -- read from
    // two DIFFERENT places: the fragments the engine published, and the block it
    // assembled from the same frames.
    expect(deltas.map((event) => event.delta).join('')).toBe(
      ofType(collected.events, 'assistant.text_block')[0]?.text,
    );
    // One block, not forty: the durable half is still the assembled message.
    expect(ofType(collected.events, 'assistant.text_block')).toHaveLength(1);
    expect(collected.refusals).toEqual([]);
  });
});

describe('the deltas are ephemeral and the blocks are not', () => {
  it('splits the two durability classes at RunEventEmitter#mint, not by convention', async () => {
    const collected = collectors();
    await start(
      scripted(collected, 'run-dur', [[
        { type: 'thinking', text: THINKING },
        { type: 'text', text: ANSWER_HEAD },
        { type: 'tool_use_delta', callId: READ_CALL.callId, delta: '{"path":"' },
        { type: 'tool_use_delta', callId: READ_CALL.callId, delta: 'a.ts"}' },
        { type: 'text', text: ANSWER_TAIL },
        { type: 'turn_stopped', reason: 'end_turn' },
      ]]).ports,
      'run-dur',
    ).completed();
    await settleWrites();

    // The verdict `#mint` returned for each event the engine published, read
    // from the emitter's own result rather than from a table in this file.
    const byType = new Map(collected.verdicts.map((verdict) => [verdict.type, verdict.durable]));
    expect(byType.get('assistant.text_delta'), 'text_delta is registered ephemeral').toBe(false);
    expect(byType.get('assistant.thinking_delta'), 'thinking_delta is registered ephemeral').toBe(false);
    expect(byType.get('tool.arguments_delta'), 'arguments_delta is registered ephemeral').toBe(false);
    expect(byType.get('assistant.text_block'), 'text_block is registered durable').toBe(true);
    expect(byType.get('assistant.thinking_block'), 'thinking_block is registered durable').toBe(true);
    expect(byType.get('assistant.message_finalized'), 'message_finalized is registered durable').toBe(true);

    // The consequence, which is the reason the split exists: the durable port
    // was handed every block and not one fragment of any of them. Cross-referenced
    // against the verdicts above rather than matched on a name suffix, because a
    // fragment published under a DURABLE type would still be written and a
    // suffix test would not see it.
    const ephemeral = new Set(
      collected.verdicts.filter((verdict) => !verdict.durable).map((verdict) => verdict.type),
    );
    // Exactly the three delta families, and nothing else -- a fourth ephemeral
    // type reaching the host would widen the surface silently.
    expect([...ephemeral].sort()).toEqual([
      'assistant.text_delta',
      'assistant.thinking_delta',
      'tool.arguments_delta',
    ]);
    const written = collected.appended.map((envelope) => envelope.payload.type);
    expect(written).toContain('assistant.text_block');
    expect(written).toContain('assistant.thinking_block');
    expect(written).toContain('assistant.message_finalized');
    expect(
      written.filter((type) => ephemeral.has(type)),
      'a fragment was written to the durable log',
    ).toEqual([]);
    // The fragments still took a seq, so they leave holes in the durable
    // numbering rather than being invisible -- which is what makes the count of
    // durable rows meaningful rather than an accident of ordering.
    expect(collected.appended.every((envelope) => envelope.seq > 0)).toBe(true);
    expect(collected.events.filter((event) => event.type === 'assistant.text_delta')).toHaveLength(2);
    expect(collected.refusals).toEqual([]);
  });
});

describe('partial tool-call arguments stream as tool.arguments_delta', () => {
  it('publishes each fragment under the call id, and never accumulates them into the block', async () => {
    const collected = collectors();
    const first = '{"path":"';
    const second = 'a.ts"}';
    // One turn, and one turn only: the call is dispatched, so the loop would
    // otherwise go round again and a second stream would double every count.
    // `maxTurns: 1` is the assertion that the fragments came from THIS call.
    await start(
      scripted(collected, 'run-args', [[
        { type: 'tool_use_delta', callId: READ_CALL.callId, delta: first },
        { type: 'tool_use_delta', callId: READ_CALL.callId, delta: second },
        { type: 'tool_use', call: READ_CALL },
        { type: 'turn_stopped', reason: 'end_turn' },
      ]]).ports,
      'run-args',
      1,
    ).completed();
    await settleWrites();

    const deltas = ofType(collected.events, 'tool.arguments_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => event.delta)).toEqual([first, second]);
    // The two payload fields and the discriminant, and nothing else: a partial
    // call has no name and no parsed arguments yet, so an invented value here
    // would be a claim about the provider that was never made.
    expect(deltas[0]).toEqual({ type: 'tool.arguments_delta', toolCallId: READ_CALL.callId, delta: first });
    expect(Object.keys(deltas[1] ?? {}).sort()).toEqual(['delta', 'toolCallId', 'type']);

    // The fragments concatenate to the arguments the call was dispatched with,
    // read from the tool port's own record -- a third place, neither of the two
    // strings above.
    expect(JSON.parse(deltas.map((event) => event.delta).join(''))).toEqual(READ_CALL.input);
    expect(deltas.every((event) => event.toolCallId === READ_CALL.callId)).toBe(true);

    // Not accumulated into the message: the finalized content holds the
    // `tool_use` block the complete frame carried, once, with the fragments
    // nowhere in it.
    const finalized = ofType(collected.events, 'assistant.message_finalized')[0];
    expect(finalized).toBeDefined();
    expect(finalized?.content).toEqual([
      { type: 'tool_use', id: READ_CALL.callId, name: READ_CALL.name, input: READ_CALL.input },
    ]);
    expect(collected.records[0]?.content).toEqual(finalized?.content);
    expect(collected.refusals).toEqual([]);
  });
});

describe('the blocks still finalize, and the deltas did not replace them', () => {
  it('keeps one messageId across delta, block and finalized, and numbers them alike', async () => {
    const collected = collectors();
    // Turn 1: text, a tool call, then more text. The tool call closes the text
    // run, so the turn assembles TWO text blocks -- and the fragments have to
    // land on those same two indices or the supersession cannot join.
    const turnOne: ModelFrame[] = [
      { type: 'text', text: ANSWER_HEAD },
      { type: 'tool_use', call: READ_CALL },
      { type: 'text', text: ANSWER_TAIL },
      { type: 'turn_stopped', reason: 'tool_use' },
    ];
    // Turn 2: one more text block. The message id is RUN-scoped
    // (`${runId}:message`), so the block index has to carry on rather than
    // restarting at 0 under the same id.
    const turnTwo: ModelFrame[] = [
      { type: 'text', text: ' and again' },
      { type: 'turn_stopped', reason: 'end_turn' },
    ];
    await start(scripted(collected, 'run-ids', [turnOne, turnTwo]).ports, 'run-ids').completed();
    await settleWrites();

    // One message per run, and every family carries it -- that shared id is the
    // whole mechanism by which a finalized entry supersedes the blocks for its
    // message (`replay/transcript-snapshot.ts:28-31`).
    const messageId = 'run-ids:message';
    for (const event of collected.events) {
      if (event.type === 'assistant.text_delta' || event.type === 'assistant.text_block') {
        expect(event.messageId, `${event.type} carried a different messageId`).toBe(messageId);
      }
    }
    expect(ofType(collected.events, 'assistant.message_finalized')[0]?.messageId).toBe(messageId);

    // The numbering: fragments and blocks agree index for index, across the
    // tool-call boundary and across the turn boundary.
    const deltas = ofType(collected.events, 'assistant.text_delta');
    expect(deltas.map((event) => [event.index, event.delta])).toEqual([
      [0, ANSWER_HEAD],
      [1, ANSWER_TAIL],
      [2, ' and again'],
    ]);
    const blocks = ofType(collected.events, 'assistant.text_block');
    expect(blocks.map((event) => [event.index, event.text])).toEqual([
      [0, ANSWER_HEAD],
      // The legacy newline on a text block that follows a tool call
      // (`DuyaAgent.ts:2610-2620`). The fragment is the raw frame, so the block
      // is the authority and the two are not expected to concatenate.
      [1, `\n${ANSWER_TAIL}`],
      [2, ' and again'],
    ]);
    // Every index a fragment claimed is occupied by a completed block, which is
    // what "the block supersedes the deltas" means inside a keyed map.
    expect(blocks.map((event) => event.index)).toEqual(deltas.map((event) => event.index));

    // The finalized entry is the assembled message, once, with the stop reason
    // of the turn the run stopped on.
    const finalized = ofType(collected.events, 'assistant.message_finalized');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.stopReason).toBe('end_turn');
    expect(finalized[0]?.content).toContainEqual({ type: 'text', text: ' and again' });

    // The host's durable copy agrees with the event, so a host that reads
    // records rather than events did not lose the answer. Two turns, two
    // records: a per-turn emission is not what this asserts.
    expect(collected.records).toHaveLength(2);
    expect(collected.records[1]?.messageId).toBe(messageId);
    expect(collected.records[1]?.content).toEqual(finalized[0]?.content);
    expect(collected.refusals).toEqual([]);
  });

  it('streams reasoning fragments and still emits the thinking block they supersede', async () => {
    const collected = collectors();
    await start(
      scripted(collected, 'run-think', [[
        { type: 'thinking', text: THINKING },
        { type: 'thinking', text: ', then answering', signature: 'sig-1' },
        { type: 'text', text: ANSWER_HEAD },
        { type: 'turn_stopped', reason: 'end_turn' },
      ]]).ports,
      'run-think',
    ).completed();
    await settleWrites();

    const deltas = ofType(collected.events, 'assistant.thinking_delta');
    expect(deltas.map((event) => event.delta)).toEqual([THINKING, ', then answering']);
    // One message assembles at most one thinking block however many frames
    // produced it, so every fragment shares the one index the block takes.
    expect(deltas.map((event) => event.index)).toEqual([0, 0]);

    const block = ofType(collected.events, 'assistant.thinking_block')[0];
    expect(block?.thinking).toBe(`${THINKING}, then answering`);
    expect(block?.index).toBe(deltas[0]?.index);
    // The signature is what makes the NEXT request replayable, and it reaches
    // the durable block as well as the finalized message.
    expect(block?.thinkingSignature).toBe('sig-1');
    expect(ofType(collected.events, 'assistant.message_finalized')[0]?.content).toContainEqual({
      type: 'thinking',
      thinking: `${THINKING}, then answering`,
      thinkingSignature: 'sig-1',
    });
    expect(collected.refusals).toEqual([]);
  });

  it('publishes no fragment for an empty frame, and still numbers the block it opens', async () => {
    const collected = collectors();
    // An empty text frame still opens a block (`TurnMessage.addText` pushes it),
    // so the index has to advance even though there is nothing to send. Were
    // the numbering skipped, the block after it would be published one index
    // below the fragment that belongs to it.
    await start(
      scripted(collected, 'run-empty', [[
        { type: 'text', text: '' },
        { type: 'text', text: ANSWER_HEAD },
        { type: 'tool_use_delta', callId: READ_CALL.callId, delta: '' },
        { type: 'turn_stopped', reason: 'end_turn' },
      ]]).ports,
      'run-empty',
    ).completed();
    await settleWrites();

    const deltas = ofType(collected.events, 'assistant.text_delta');
    expect(deltas.map((event) => [event.index, event.delta])).toEqual([[0, ANSWER_HEAD]]);
    expect(ofType(collected.events, 'tool.arguments_delta')).toEqual([]);
    const blocks = ofType(collected.events, 'assistant.text_block');
    expect(blocks.map((event) => [event.index, event.text])).toEqual([[0, ANSWER_HEAD]]);
    expect(collected.refusals).toEqual([]);
  });
});
