/**
 * Plan 600 S2 step b3a: the engine emits the ASSEMBLED assistant message.
 *
 * ## The blocker this file exists to remove
 *
 * `run-engine.ts` handled `text`, `thinking` and `tool_use_delta` as
 * `default: break` with the comment "they decide nothing" -- which is true, and
 * was also the whole of the problem. Those three frames are the only place the
 * model's actual answer exists, and the legacy loop accumulated every one of
 * them into `finalAssistantContent` and pushed it durable
 * (`DuyaAgent.ts:2645-2678`). A turn loop migrated onto this engine would have
 * kept all four decisions and silently dropped every message.
 *
 * ## The shape legacy produced, and what has to survive
 *
 * The content order is load-bearing at both ends, and the engine reproduces it
 * rather than tidying it:
 *
 *  1. the REDACTED block first -- empty text plus the encrypted payload --
 *     because Anthropic's thinking-mode validation wants it to lead the turn;
 *  2. then thinking WITH its signature, which is what lets `transformMessages`
 *     replay the block natively next turn instead of downgrading it to text;
 *  3. then text and `tool_use` in stream order, consecutive text merged, and a
 *     text block that follows a tool call prefixed with a newline.
 *
 * ## Why these assertions are not `a === a`
 *
 * Every expected value comes from a place other than the one being read: a frame
 * this file fed the model port, a second event of the same run, or a
 * derivation this file computes itself. The three that matter most are the
 * signature (a string written here, read back off the emitted block), the
 * identity (the `messageId` off an `assistant.text_block` compared with the one
 * on that run's `assistant.message_finalized`), and the aggregated text (joined
 * here from the frames, compared with the block the engine built). Nothing
 * compares a value with itself, and nothing asserts only that a function exists.
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
import type { RunEvent, RunId } from '@duya/agent-protocol';

const SIGNATURE = 'sig-thinking-0f2c';
const ENCRYPTED = 'encrypted-payload-A1';
const ANSWER_ONE = 'the first sentence.';
const ANSWER_TWO = 'the second sentence.';

const READ_CALL: ToolCallRequest = {
  callId: 'call-1',
  name: 'Read',
  input: { path: 'a.ts' },
  sideEffect: 'read_only',
};

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

interface TurnScript {
  readonly frames: readonly ModelFrame[];
  /** What the drain yields after this turn's stream. */
  readonly drain?: readonly ToolDrainItem[];
}

interface EngineRun {
  /** Every event the engine published, in order, unfiltered. */
  readonly events: readonly RunEvent[];
  /** Every record the host was handed, in order. */
  readonly records: readonly AssistantMessageRecord[];
  /** Interleaving of three different ports, in call order. */
  readonly order: readonly string[];
}

function types(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * The one `assistant.message_finalized` a run emitted, or `undefined`.
 *
 * Asserting the COUNT as well as the value is deliberate: a per-turn emission
 * would satisfy "the last one has the right content" while producing N events
 * that collapse to one in the consumer's `messageId`-keyed map, which is the
 * loss `RunEngineImpl.#finalizeLastMessage` exists to avoid.
 */
function onlyFinalized(
  events: readonly RunEvent[],
): Extract<RunEvent, { type: 'assistant.message_finalized' }> {
  const found = events.filter(
    (event): event is Extract<RunEvent, { type: 'assistant.message_finalized' }> =>
      event.type === 'assistant.message_finalized',
  );
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0] as Extract<RunEvent, { type: 'assistant.message_finalized' }>;
}

function blocksOfType<T extends 'assistant.text_block' | 'assistant.thinking_block'>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

/**
 * Drive a real `RunEngineImpl` over scripted frames and collect what came out.
 *
 * Nothing about the assistant message is hand-fed: the frames go in through
 * `ModelPort.stream`, and everything asserted below is read off the engine's own
 * `publish` calls and its own port calls.
 */
async function engineRun(
  turns: readonly TurnScript[],
  runId = 'run-assistant',
  maxTurns = 5,
): Promise<EngineRun> {
  const events: RunEvent[] = [];
  const records: AssistantMessageRecord[] = [];
  const order: string[] = [];
  const controller = new AbortController();
  let streams = 0;

  const model: ModelPort = {
    async *stream(): AsyncIterable<ModelFrame> {
      const script = turns[streams];
      streams += 1;
      if (script === undefined) return;
      for (const frame of script.frames) yield frame;
    },
  };

  const ports: RunEnginePorts = {
    model,
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const item of turns[streams - 1]?.drain ?? []) yield item;
      },
      discard(): void {},
      describe: () => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        order.push('assemble');
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
      publish(event: RunEvent): void {
        events.push(event);
      },
      proposeTerminal(): void {
        order.push('terminal');
      },
    },
    turnOutput: {
      async recordAssistantMessage(record: AssistantMessageRecord): Promise<void> {
        order.push('assistant');
        records.push(record);
      },
      async recordToolResult(): Promise<void> {
        order.push('toolResult');
      },
      async finishTurn(): Promise<void> {
        order.push('finish');
      },
    },
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: maxTurns });
  await engine
    .execute({ manifest: manifest(runId), input: INPUT, signal: controller.signal, ports })
    .completed();
  return { events, records, order };
}

/** What the test itself believes the answer is, computed from its own frames. */
function textOf(frames: readonly ModelFrame[]): string {
  return frames
    .filter((frame): frame is Extract<ModelFrame, { type: 'text' }> => frame.type === 'text')
    .map((frame) => frame.text)
    .join('');
}

describe('the engine emits the model answer, in the shape the legacy loop produced', () => {
  it('aggregates a streamed answer into one finalized message', async () => {
    const frames: ModelFrame[] = [
      { type: 'text', text: ANSWER_ONE },
      { type: 'text', text: ANSWER_TWO },
      { type: 'turn_stopped', reason: 'end_turn' },
    ];
    const result = await engineRun([{ frames }]);

    const finalized = onlyFinalized(result.events);
    expect(finalized).toBeDefined();
    expect(finalized.stopReason).toBe('end_turn');
    // Two sources: the frames this file fed the model, and what was published.
    expect(finalized.content).toEqual([{ type: 'text', text: textOf(frames) }]);

    // The host is handed the same content through the port, and the two agree --
    // a projection that re-derived the string differently shows up here.
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.content).toEqual(finalized.content);
    expect(result.records[0]?.turn).toBe(1);
  });

  it('carries the thinking SIGNATURE, which is what makes the next turn replayable', async () => {
    // Without the signature `transformMessages` downgrades the block to text on
    // the next request, so the degradation is silent and shows up one turn late.
    const frames: ModelFrame[] = [
      { type: 'thinking', text: 'weighing the options' },
      { type: 'thinking', text: ' and then answering', signature: SIGNATURE },
      { type: 'text', text: ANSWER_ONE },
      { type: 'turn_stopped', reason: 'end_turn' },
    ];
    const result = await engineRun([{ frames }]);

    const thinking = onlyFinalized(result.events).content.filter(
      (block) => block.type === 'thinking',
    );
    expect(thinking).toHaveLength(1);
    // The expected signature is the string THIS FILE wrote into the frame.
    expect(thinking[0]).toEqual({
      type: 'thinking',
      thinking: 'weighing the options and then answering',
      thinkingSignature: SIGNATURE,
    });
    // The per-block event carries it too, so a consumer that reads blocks rather
    // than the finalized message is not the one that loses it.
    const blocks = blocksOfType(result.events, 'assistant.thinking_block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.thinkingSignature).toBe(SIGNATURE);

    // The port copy is the one a host persists, so it carries the signature as a
    // string rather than the event vocabulary's boolean.
    const recordThinking = result.records[0]?.content.filter((block) => block.type === 'thinking') ?? [];
    expect(recordThinking[0]?.thinkingSignature).toBe(SIGNATURE);
  });

  it('puts the redacted block FIRST, ahead of the thinking and the text', async () => {
    // The encrypted payload has to lead the assistant turn for Anthropic
    // thinking-mode validation, and it arrives LAST in the frame stream -- an
    // engine that appended in arrival order would put it exactly the wrong way
    // round.
    const frames: ModelFrame[] = [
      { type: 'text', text: ANSWER_ONE },
      { type: 'thinking', text: 'reasoning', signature: SIGNATURE },
      { type: 'text', text: ANSWER_TWO },
      { type: 'thinking', text: '', redacted: true, encrypted: ENCRYPTED },
      { type: 'turn_stopped', reason: 'end_turn' },
    ];
    const result = await engineRun([{ frames }]);

    const content = onlyFinalized(result.events).content;
    // The ORDER, read in the order a consumer will replay it in.
    expect(content.map((block) => block.type)).toEqual(['thinking', 'thinking', 'text']);
    expect(content[0]).toEqual({ type: 'thinking', thinking: '', redacted: true, encrypted: true });
    expect(content[1]).toMatchObject({
      type: 'thinking',
      thinking: 'reasoning',
      thinkingSignature: SIGNATURE,
    });
    // The two texts MERGE, and no newline is inserted between them. That is the
    // legacy rule and it is counter-intuitive enough to be worth pinning: the
    // merge looks at the previous block of the BODY (text and tool_use), and
    // thinking is held apart from the body entirely
    // (`DuyaAgent.ts:2606-2608`), so an interleaved thinking frame does not
    // break a run of text. The newline belongs to a text block that follows a
    // TOOL CALL, which the next test pins.
    expect(content[2]).toEqual({ type: 'text', text: textOf(frames) });

    // The port record keeps the payload ITSELF, because the host replays it.
    expect(result.records[0]?.content[0]).toEqual({
      type: 'thinking',
      thinking: '',
      redacted: true,
      encrypted: ENCRYPTED,
    });
  });

  it('emits a text block that follows a tool call with the leading newline markdown needs', async () => {
    const frames: ModelFrame[] = [
      { type: 'text', text: 'before the call' },
      { type: 'tool_use', call: READ_CALL },
      { type: 'text', text: '### after the call' },
      { type: 'turn_stopped', reason: 'end_turn' },
    ];
    const result = await engineRun([{ frames }]);

    const content = onlyFinalized(result.events).content;
    // Three body blocks, and the newline lands on the SECOND text one because
    // the tool call between them is what breaks the run -- without it the
    // heading is swallowed into the previous paragraph (`DuyaAgent.ts:2610-2620`).
    expect(content.map((block) => block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(content[0]).toEqual({ type: 'text', text: 'before the call' });
    expect(content[2]).toEqual({ type: 'text', text: '\n### after the call' });
    // The call is in the message with its own id, because that is what the next
    // request replays alongside its result.
    expect(content[1]).toEqual({
      type: 'tool_use',
      id: READ_CALL.callId,
      name: READ_CALL.name,
      input: READ_CALL.input,
    });
  });

  it('gives the finalized message the SAME messageId its text blocks carry', async () => {
    // The consumer keys its block map and its finalized map by `payload.messageId`
    // and treats the finalized entry as superseding the blocks
    // (`transcript-snapshot.ts:195-200`), so a mismatch puts one message in the
    // transcript under two identities and the supersession never joins. The id
    // is read off the emitted EVENTS, not off a constant.
    const result = await engineRun([
      {
        frames: [
          { type: 'text', text: 'turn one' },
          { type: 'tool_use', call: READ_CALL },
          { type: 'turn_stopped', reason: 'tool_use' },
        ],
      },
      { frames: [{ type: 'text', text: 'turn two' }, { type: 'turn_stopped', reason: 'end_turn' }] },
    ]);

    const blocks = blocksOfType(result.events, 'assistant.text_block');
    const finalized = onlyFinalized(result.events);
    // Two turns, so two blocks, so the identity has something to disagree with.
    expect(blocks.map((block) => block.text)).toEqual(['turn one', 'turn two']);
    for (const block of blocks) {
      expect(block.messageId).toBe(finalized.messageId);
    }
    // ONE id for the run, not one per turn: a per-turn id would leave the blocks
    // of a message the finalized event does not name.
    expect(new Set(blocks.map((block) => block.messageId)).size).toBe(1);
    // And the blocks are DISTINCT under that shared id, which is what the
    // per-kind index is for -- a consumer keyed on (messageId, index) keeps both.
    expect(blocks.map((block) => block.index)).toEqual([0, 1]);
  });

  it('keeps two runs message ids apart, so a replay cannot be mistaken for a message', async () => {
    const frames: ModelFrame[] = [{ type: 'text', text: 'a' }, { type: 'turn_stopped', reason: 'end_turn' }];
    const first = await engineRun([{ frames }], 'run-one');
    const second = await engineRun([{ frames }], 'run-two');

    const firstId = onlyFinalized(first.events).messageId;
    const secondId = onlyFinalized(second.events).messageId;
    // Identical content, different runs: an id minted per message rather than
    // derived from the run would collide here.
    expect(firstId).not.toBe(secondId);
    expect(blocksOfType(first.events, 'assistant.text_block')[0]?.messageId).toBe(firstId);
    expect(blocksOfType(second.events, 'assistant.text_block')[0]?.messageId).toBe(secondId);
  });

  it('finalizes the turn the run STOPPED on, and represents an earlier one by its blocks', async () => {
    // A turn that asks for tools stops on `tool_use`, which the event union
    // cannot state -- and that is the NORMAL shape of a tool-calling turn, not an
    // edge case. So the engine finalizes the turn the loop actually stopped on
    // and leaves the earlier one to its durable block events, which is the same
    // division of labour the inbound path has (one finalized frame per
    // `chat:done`, blocks for everything).
    const result = await engineRun([
      {
        frames: [
          { type: 'text', text: 'turn one' },
          { type: 'tool_use', call: READ_CALL },
          { type: 'turn_stopped', reason: 'tool_use' },
        ],
        drain: [
          {
            kind: 'tool_result',
            callId: READ_CALL.callId,
            content: 'file contents',
            isError: false,
            durationMs: 3,
          },
        ],
      },
      { frames: [{ type: 'text', text: ANSWER_TWO }, { type: 'turn_stopped', reason: 'end_turn' }] },
    ]);

    // Exactly one, and it is the LAST turn's message.
    const finalized = onlyFinalized(result.events);
    expect(finalized.content).toEqual([{ type: 'text', text: ANSWER_TWO }]);
    // Both turns are still durable, under the one shared id.
    expect(blocksOfType(result.events, 'assistant.text_block').map((block) => block.text)).toEqual([
      'turn one',
      ANSWER_TWO,
    ]);
    // And the host received BOTH messages, refusal or not.
    expect(result.records.map((record) => record.turn)).toEqual([1, 2]);
  });

  it('refuses to state the run last stop reason, and says so in a diagnostic', async () => {
    // `tool_use` means "the loop is going round again". None of the six protocol
    // `StopReason` values says that, and `completed` would claim a normal finish
    // that did not happen -- so the frame is left unmapped. The ceiling is what
    // makes this the run's LAST turn: without it the loop would go round again.
    const result = await engineRun(
      [
        {
          frames: [
            { type: 'text', text: ANSWER_ONE },
            { type: 'tool_use', call: READ_CALL },
            { type: 'turn_stopped', reason: 'tool_use' },
          ],
        },
      ],
      'run-refused',
      1,
    );

    expect(types(result.events)).not.toContain('assistant.message_finalized');
    // Not a silence: a diagnostic names the turn and the reason it could not
    // state, which is the counted-diagnostic rule the unmapped sub-agent frame
    // already follows.
    const diagnostic = result.events.find((event) => event.type === 'diagnostic');
    expect(diagnostic?.message).toContain('tool_use');
    expect(diagnostic?.data).toMatchObject({ turn: 1 });
    // The blocks are still durable, so a consumer is not left with nothing.
    expect(blocksOfType(result.events, 'assistant.text_block')).toHaveLength(1);
    // And the host still received the message: the refusal is about the EVENT
    // vocabulary, not about the answer, because the port record has no closed
    // union to satisfy.
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.content).toEqual([
      { type: 'text', text: ANSWER_ONE },
      { type: 'tool_use', id: READ_CALL.callId, name: READ_CALL.name, input: READ_CALL.input },
    ]);
  });

  it('normalises max_tokens to the protocol own spelling', async () => {
    const result = await engineRun([
      { frames: [{ type: 'text', text: ANSWER_ONE }, { type: 'turn_stopped', reason: 'max_tokens' }] },
    ]);
    // `events/payloads.ts` documents this normalisation, and the asserted word is
    // a DIFFERENT one from the frame's.
    expect(onlyFinalized(result.events).stopReason).toBe('length');
  });

  it('reports usage as the single-call snapshot, never a turn sum', async () => {
    // Plan 546: `usage` is the in-memory anchor every context estimator scans, so
    // a sum here would inflate the anchor by the prompt. A provider reports usage
    // more than once per request and the last report is the total.
    const first = { inputTokens: 100, outputTokens: 0 };
    const last = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    const result = await engineRun([
      {
        frames: [
          { type: 'usage', ...first },
          { type: 'text', text: ANSWER_ONE },
          { type: 'usage', ...last },
          { type: 'turn_stopped', reason: 'end_turn' },
        ],
      },
    ]);

    const finalized = onlyFinalized(result.events);
    expect(finalized.usage).toEqual(last);
    // Not the sum of the two reports, which is what a naive accumulator reports.
    expect(finalized.usage?.inputTokens).not.toBe(first.inputTokens + last.inputTokens);
    // The port copy is the same value, read from one place.
    expect(result.records[0]?.usage).toEqual(finalized.usage);
  });

  it('hands the message over BEFORE any tool result, and finalizes before the terminal', async () => {
    // OpenAI requires `assistant (tool_calls) -> tool (result)`
    // (`DuyaAgent.ts:2641-2642`), and the message stops changing strictly before
    // the run ends. Three different ports, one order.
    const result = await engineRun([
      {
        frames: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', call: READ_CALL },
          { type: 'turn_stopped', reason: 'tool_use' },
        ],
        drain: [
          {
            kind: 'tool_result',
            callId: READ_CALL.callId,
            content: 'file contents',
            isError: false,
            durationMs: 3,
          },
        ],
      },
      { frames: [{ type: 'text', text: ANSWER_ONE }, { type: 'turn_stopped', reason: 'end_turn' }] },
    ]);

    expect(result.order).toEqual([
      'assemble',
      'assistant',
      'toolResult',
      'finish',
      'assemble',
      'assistant',
      'finish',
      'terminal',
    ]);
    // The finalized event is the LAST thing published, because it is emitted
    // ahead of the terminal proposal (`agent-process-entry.ts:3482-3488`) and
    // the engine publishes no terminal of its own.
    //
    // That second clause is a b4d measurement rather than a restatement: the
    // engine proposed publishing `run.completed` here and does not, because
    // doing so makes `RunSession.#closeDanglingTools` write after the run's own
    // terminal. Asserted explicitly so the day the engine does publish one, this
    // test says so instead of the ordering quietly changing underneath it.
    expect(result.events[result.events.length - 1]?.type).toBe('assistant.message_finalized');
    expect(types(result.events)).not.toContain('run.completed');
    expect(types(result.events)).not.toContain('run.failed');
  });

  it('emits no message for a turn whose stream died before producing a frame', async () => {
    // `sawFrame === false` is a failed run, and a message assembled from nothing
    // is not a message. Absence, not an empty finalized event.
    const result = await engineRun([{ frames: [] }]);
    expect(types(result.events)).not.toContain('assistant.message_finalized');
    expect(result.records).toHaveLength(0);
  });

  it('emits no message for a turn a fatal error frame ended mid-stream', async () => {
    // The legacy loop pushed the message at the `done` boundary, and a fatal
    // provider error produces no `done` -- so the partial answer is not
    // finalized. Reproduced rather than improved, and stated so the next reader
    // knows it is a decision.
    const result = await engineRun([
      {
        frames: [
          { type: 'text', text: ANSWER_ONE },
          { type: 'error', message: 'provider went away', retryable: false },
        ],
      },
    ]);
    expect(types(result.events)).not.toContain('assistant.message_finalized');
    expect(result.records).toHaveLength(0);
  });
});
