/**
 * Plan 600 S2 (model leg): the adapter that lets the engine drive a REAL model
 * stream instead of `emptyModelStream()`.
 *
 * ## What this file is the proof of
 *
 * `RunEngineImpl`'s first decision is `ports.model.stream(...)`
 * (`run-engine.ts:445`). Until this adapter existed, production bound a stream
 * that yields nothing (`agent-process-entry.ts:3196`), so a real `chat:start`
 * ran a phantom turn that failed on `sawFrame === false` and was only logged.
 *
 * Two things therefore have to hold, and they fail DIFFERENTLY, so both are
 * pinned here:
 *
 *  1. **The outbound direction.** Every provider event the legacy loop branches
 *     on survives the narrowing to `ModelFrame`. Drop one and the engine
 *     silently stops dispatching a tool.
 *  2. **The inbound direction.** The engine's `ModelRequest` reaches the
 *     provider client with its system prompt, tools and — the one the port
 *     contract exists for — the CALLER'S `AbortSignal`, un-wrapped.
 *
 * ## Why these are not `a === a`
 *
 * Every frame assertion compares a value the TEST wrote against a value read
 * off the mapped frame, where the test's value came from the PROVIDER's field
 * spelling (`input_tokens`, `data.id`) and the expectation from the fact the
 * legacy loop consumed. A guard that dropped a field, or renamed one, cannot
 * satisfy these.
 *
 * The two cancellation tests are the strongest here and are NOT identity: they
 * abort a real controller and assert the provider observed it, once through the
 * port and once through a full `RunEngineImpl` whose `handle.stop` is the only
 * thing that can abort it. `ports.ts:214-228` states that the signal a port
 * receives must not be the caller's own object, so an `===` on identity would
 * be asserting the opposite of the contract.
 *
 * ## What this file does NOT prove
 *
 * That the LIVE `chat:start` no longer calls `agent.streamChat(`. This drives
 * the engine directly with the real adapter, which is what makes the adapter
 * trustworthy, but the worker entry still reaches the legacy generator — see
 * the handoff. Only removing that call can close G7/G8.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createLegacyModelPort,
  STOP_REASON_VALUE_IS_MAPPED,
  toModelFrame,
  toProviderMessages,
  type LegacyModelSources,
} from '../run-engine-model.js';
import { RunEngineImpl, type ModelRequest } from '@duya/agent-runtime';
import type { SSEEvent, ToolUse } from '@duya/ai';

// ============================================================================
// Provider event builders — shaped the way the PRODUCER builds them
// ============================================================================

function toolUse(overrides: Partial<ToolUse> = {}): ToolUse {
  return {
    id: 'call-1',
    name: 'Read',
    input: { file_path: 'a.ts' },
    ...overrides,
  };
}

/**
 * `reason` is distinguished by PRESENCE, so a test for the absent case is
 * writable at all — `reason ?? 'end_turn'` in the builder would turn an
 * explicit `undefined` back into a value and make "no reason" untestable.
 */
const ABSENT = Symbol('absent');

function done(reason: StopReasonInput = 'completed'): SSEEvent {
  return (reason === ABSENT ? { type: 'done' } : { type: 'done', reason }) as SSEEvent;
}

type StopReasonInput =
  | 'completed'
  | 'aborted'
  | 'max_turns'
  | 'max_tokens'
  | 'error'
  | 'tool_use'
  | 'end_turn'
  | 'stop_sequence'
  | 'repeated_tool_calls'
  | typeof ABSENT;

// ============================================================================
// The narrowing: outbound
// ============================================================================

describe('toModelFrame — every event the legacy loop branches on survives', () => {
  it('carries text across, because the turn IS its text', () => {
    const frame = toModelFrame({ type: 'text', data: 'hello' });
    expect(frame).toEqual({ type: 'text', text: 'hello' });
  });

  it('carries thinking across WITH its redacted flag, because redacted text is empty', () => {
    // A redacted block has `data: ''` (`types.ts:188`), so without the flag a
    // host cannot tell "the provider redacted this" from "the model thought
    // nothing". Dropping the flag makes those two identical values.
    const frame = toModelFrame({ type: 'thinking', data: '', redacted: true });
    expect(frame).toEqual({ type: 'thinking', text: '', redacted: true });
  });

  it('carries the thinking signature when the provider sent one', () => {
    const frame = toModelFrame({ type: 'thinking', data: 'hmm', signature: 'sig-1' });
    expect(frame).toEqual({ type: 'thinking', text: 'hmm', signature: 'sig-1' });
  });

  it('does NOT invent a redacted flag the provider omitted', () => {
    // The mirror of the case above: an absent optional must stay absent, so a
    // host cannot mistake "not redacted" for "redacted: false".
    const frame = toModelFrame({ type: 'thinking', data: 'plain' });
    expect(frame).toEqual({ type: 'thinking', text: 'plain' });
    expect('redacted' in (frame as object)).toBe(false);
  });

  it('carries tool_use_started with the call the engine dispatches', () => {
    const frame = toModelFrame({ type: 'tool_use_started', data: toolUse() });
    expect(frame).toEqual({
      type: 'tool_use_started',
      call: { callId: 'call-1', name: 'Read', input: { file_path: 'a.ts' }, sideEffect: 'undeclared' },
    });
  });

  it('renames the provider `id` to the runtime `callId` on a delta', () => {
    // `types.ts:182` spells it `id`; `ports.ts:169` spells it `callId`. These
    // are the same value under different names, and `ToolCallId` is a string
    // alias — so a `callId: event.data.callId` typo compiles and yields
    // `undefined` at run time.
    const frame = toModelFrame({
      type: 'tool_use_delta',
      data: { id: 'call-9', name: 'Read', delta: '{"fil' },
    });
    expect(frame).toEqual({ type: 'tool_use_delta', callId: 'call-9', delta: '{"fil' });
  });

  it('carries tool_use — the frame that actually dispatches', () => {
    const frame = toModelFrame({ type: 'tool_use', data: toolUse({ id: 'call-2' }) });
    expect(frame).toEqual({
      type: 'tool_use',
      call: { callId: 'call-2', name: 'Read', input: { file_path: 'a.ts' }, sideEffect: 'undeclared' },
    });
  });

  it('stamps `undeclared` and NEVER `read_only` on a call the model named', () => {
    // The load-bearing assertion of this file. `run-engine.ts:760` grants a
    // synthetic ledger ticket to exactly `read_only` when no ledger is attached,
    // so a fabricated `read_only` would authorise a side effect nobody
    // declared. `resolveSideEffectClass` overwrites it at dispatch
    // (`run-engine-ports.ts:180`); the model may not guess it.
    const frame = toModelFrame({ type: 'tool_use', data: toolUse() });
    expect(frame).not.toBeNull();
    expect((frame as { call: { sideEffect: string } }).call.sideEffect).toBe('undeclared');
  });
});

describe('toModelFrame — usage reads the SNAKE_CASE fields', () => {
  it('maps the provider token fields onto the runtime camelCase ones', () => {
    // `TokenUsage` is `input_tokens` (`content.ts:352`); `ModelFrame.usage` is
    // `inputTokens` (`ports.ts:171`). Reading the camelCase spelling off the
    // provider event yields `undefined`, which reaches `spend.addTokens(NaN)`
    // (`run-engine.ts:462`) — a silently corrupt ledger, not a crash.
    const frame = toModelFrame({
      type: 'result',
      data: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
    });
    expect(frame).toEqual({ type: 'usage', inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  });

  it('omits totalTokens when the provider sent none, so the engine can fall back', () => {
    // `run-engine.ts:462` computes `input + output` when `totalTokens` is
    // absent. Inventing `0` replaces a correct fallback with a wrong number,
    // and budget accounting is the thing that decides whether a run continues.
    const frame = toModelFrame({ type: 'result', data: { input_tokens: 7, output_tokens: 3 } });
    expect(frame).toEqual({ type: 'usage', inputTokens: 7, outputTokens: 3 });
    expect('totalTokens' in (frame as object)).toBe(false);
  });
});

describe('toModelFrame — the two decisions', () => {
  it('maps done to turn_stopped, and reads the reason', () => {
    expect(toModelFrame(done('tool_use'))).toEqual({ type: 'turn_stopped', reason: 'tool_use' });
  });

  it('maps an ABSENT done reason to end_turn, not to a failure', () => {
    // `types.ts:189` makes `reason` optional. Reading absent as an error would
    // turn every provider that omits the field into a failed run; reading it as
    // `tool_use` would make the engine think work is outstanding.
    expect(toModelFrame(done(ABSENT))).toEqual({ type: 'turn_stopped', reason: 'end_turn' });
  });

  it('maps aborted to cancelled, which is what makes a stop discard queued calls', () => {
    // `run-engine.ts:475` discards and returns `cancelled` on this exact value.
    // Mapping `aborted` to `end_turn` instead leaves every tool the model had
    // already asked for queued, and a replay dispatches them twice.
    expect(toModelFrame(done('aborted'))).toEqual({ type: 'turn_stopped', reason: 'cancelled' });
  });

  it('maps the host-level stop reasons to end_turn, because the ENGINE owns them', () => {
    // `max_turns` and `repeated_tool_calls` are a run ceiling and a loop guard —
    // host facts. The engine derives both itself (`run-engine.ts:697`), so
    // claiming them through the model port would be a host decision arriving
    // through the wrong door.
    expect(toModelFrame(done('max_turns'))).toEqual({ type: 'turn_stopped', reason: 'end_turn' });
    expect(toModelFrame(done('repeated_tool_calls'))).toEqual({ type: 'turn_stopped', reason: 'end_turn' });
  });

  it('treats a non-retryable error as a FAILED RUN', () => {
    // `run-engine.ts:469` returns `failed` when `retryable` is false. An error
    // frame with no `isRetryable` is an error nobody promised was transient,
    // so it must not be laundered into a retryable one.
    expect(toModelFrame({ type: 'error', data: 'boom' })).toEqual({
      type: 'error',
      message: 'boom',
      retryable: false,
    });
  });

  it('keeps the provider\'s retryability claim when it makes one', () => {
    const frame = toModelFrame({
      type: 'error',
      data: 'rate limited',
      code: '429',
      metadata: { isRetryable: true },
    });
    expect(frame).toEqual({
      type: 'error',
      message: 'rate limited',
      code: '429',
      retryable: true,
    });
  });

  it('does NOT read an absent isRetryable as retryable', () => {
    // The green-mutation trap in miniature: `metadata?.isRetryable === true`
    // and `metadata?.isRetryable ?? false` agree on every input EXCEPT an
    // explicit `false`, and `?? true` would turn that into a retryable error
    // the engine then ignores (`run-engine.ts:474`). Assert the explicit false.
    const frame = toModelFrame({
      type: 'error',
      data: 'hard failure',
      metadata: { isRetryable: false },
    });
    expect((frame as { retryable: boolean }).retryable).toBe(false);
  });

  it('maps every member of the provider stop-reason union', () => {
    // Value-level counterpart to `STOP_REASON_VALUE_IS_MAPPED`, driven from the
    // protocol's OWN list so a new member cannot be added there and left
    // undecided in this file without a test failing.
    const every: readonly StopReasonInput[] = [
      'completed',
      'aborted',
      'max_turns',
      'max_tokens',
      'error',
      'tool_use',
      'end_turn',
      'stop_sequence',
      'repeated_tool_calls',
      ABSENT,
    ];
    const mapped = every.map((reason) => toModelFrame(done(reason)));
    expect(mapped.every((frame) => frame?.type === 'turn_stopped')).toBe(true);
    expect(STOP_REASON_VALUE_IS_MAPPED).toBe(true);
  });
});

describe('toModelFrame — renderer projections are not frames', () => {
  it('drops tool_group_progress, which is a renderer hint and not a fact about generation', () => {
    expect(toModelFrame({ type: 'tool_group_progress', data: { title: 't', source: 'tool_fallback' } })).toBeNull();
  });

  it('drops text_delta, because the turn loop has no arm for it and mapping it DOUBLEs the text', () => {
    // `DuyaAgent.ts:2515` branches `event.type === 'text'`. There is no
    // `text_delta` arm anywhere in `:2377-3120` — the delta spelling is read
    // only by the side-question summarizer at `:4434`, which is not this port.
    expect(toModelFrame({ type: 'text_delta', data: 'partial' })).toBeNull();
  });

  it('drops thinking_delta for the same reason', () => {
    expect(toModelFrame({ type: 'thinking_delta', data: 'partial' })).toBeNull();
  });

  it('drops tool_result, because a result comes back through the DRAIN', () => {
    // A tool result is a drain item (`run-engine.ts:595`), not a model output.
    // Mapping it here would let a result reach the model with no dispatch.
    expect(
      toModelFrame({
        type: 'tool_result',
        data: { tool_use_id: 'call-1', content: 'ok', is_error: false },
      }),
    ).toBeNull();
  });

  it('drops the lifecycle and UI families wholesale', () => {
    // Each is a distinct event type, so this asserts the mapping stays NULL for
    // all of them rather than one shape standing in for the group.
    const dropped: readonly SSEEvent[] = [
      { type: 'turn_start', data: { turnCount: 1 } },
      { type: 'system', data: 'note' },
      { type: 'tool_progress', data: { toolName: 'Read', elapsedSeconds: 1 } },
      { type: 'tool_timeout', data: { toolName: 'Read', elapsedSeconds: 9 } },
      { type: 'agent_progress', data: { type: 'text', data: 'sub', agentId: 'a' } },
      { type: 'mode_changed', data: { mode: 'plan', source: 'user' } },
      { type: 'clipboard_write', data: { text: 'copied' } },
      { type: 'compact:start' },
      { type: 'compact:done' },
      { type: 'compact:error' },
      { type: 'compact:step', data: { step: 'projecting', counts: undefined } as never },
      { type: 'compact:over_threshold', data: { tokensRetained: 1, available: 2 } },
    ];
    for (const event of dropped) {
      expect(toModelFrame(event), `${event.type} must not become a frame`).toBeNull();
    }
  });
});

// ============================================================================
// The narrowing: inbound
// ============================================================================

describe('toProviderMessages', () => {
  it('carries the role, the content and the stable id', () => {
    // `id` is what a provider replay keys on; dropping it is invisible until a
    // turn is replayed, which is exactly when it cannot be debugged.
    const messages = toProviderMessages([
      { role: 'user', content: 'hi', id: 'm1' },
      { role: 'assistant', content: 'hello', id: 'm2' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'hi', id: 'm1' },
      { role: 'assistant', content: 'hello', id: 'm2' },
    ]);
  });

  it('carries a tool message, which is how a result reaches the model', () => {
    const messages = toProviderMessages([{ role: 'tool', content: 'file contents', id: 'm3' }]);
    expect(messages[0]?.role).toBe('tool');
    expect(messages[0]?.content).toBe('file contents');
  });

  it('keeps content-block arrays intact rather than flattening them', () => {
    const content = [{ type: 'text' as const, text: 'block' }];
    const messages = toProviderMessages([{ role: 'user', content, id: 'm4' }]);
    expect(messages[0]?.content).toBe(content);
  });
});

// ============================================================================
// The port
// ============================================================================

/** A client that records what it was called with and replays a fixed script. */
function fakeClient(script: readonly SSEEvent[]) {
  const seen: { messages: unknown; options: Record<string, unknown> }[] = [];
  return {
    seen,
    streamChat(messages: unknown, options: Record<string, unknown>) {
      seen.push({ messages, options });
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
  };
}

/**
 * A client that serves a DIFFERENT script per turn.
 *
 * Needed because the engine really does loop: a turn that dispatched a tool has
 * work the model has not seen, so `#shouldStop` returns `null`
 * (`run-engine.ts:714`) and the next turn runs. A client that replays one
 * `tool_use` script on every call therefore dispatches forever — an infinite
 * loop that exhausts the heap rather than failing an assertion. Modelling the
 * real shape (ask for a tool, then answer) is both correct and terminating.
 */
function scriptedClient(turns: readonly (readonly SSEEvent[])[]) {
  const seen: { messages: unknown; options: Record<string, unknown> }[] = [];
  return {
    seen,
    streamChat(messages: unknown, options: Record<string, unknown>) {
      const index = seen.length;
      seen.push({ messages, options });
      const script = turns[Math.min(index, turns.length - 1)] ?? [];
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
  };
}

function sourcesFor(client: unknown, overrides: Partial<LegacyModelSources> = {}): LegacyModelSources {
  return {
    llmClient: client as never,
    llmMessages: () => [{ role: 'user', content: 'hi', id: 'm1' }],
    declaredTools: () => [
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    ],
    turnCount: () => 1,
    ...overrides,
  };
}

const REQUEST: ModelRequest = {
  systemPrompt: 'you are duya',
  messages: [{ role: 'user', content: 'hi', id: 'm1' }],
  tools: [],
};

describe('createLegacyModelPort', () => {
  it('reaches the provider with the system prompt and the messages', async () => {
    const client = fakeClient([{ type: 'text', data: 'hi' }]);
    const port = createLegacyModelPort(sourcesFor(client));
    const frames = [];
    for await (const frame of port.stream(REQUEST, new AbortController().signal)) frames.push(frame);

    expect(frames).toEqual([{ type: 'text', text: 'hi' }]);
    expect(client.seen[0]?.options.systemPrompt).toBe('you are duya');
    expect(client.seen[0]?.messages).toEqual([{ role: 'user', content: 'hi', id: 'm1' }]);
  });

  it('advertises the host catalog as provider tool schemas', async () => {
    const client = fakeClient([{ type: 'text', data: 'x' }]);
    const port = createLegacyModelPort(sourcesFor(client));
    for await (const _frame of port.stream(REQUEST, new AbortController().signal)) void _frame;

    expect(client.seen[0]?.options.tools).toEqual([
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    ]);
  });

  it('omits maxTokens and temperature when the manifest named neither', async () => {
    // `ports.ts:387-390` makes both optional because `RunManifest.agent` is.
    // A fabricated default would be a ceiling the manifest never agreed to.
    const client = fakeClient([{ type: 'text', data: 'x' }]);
    const port = createLegacyModelPort(sourcesFor(client));
    for await (const _frame of port.stream(REQUEST, new AbortController().signal)) void _frame;

    expect('maxTokens' in (client.seen[0]?.options ?? {})).toBe(false);
    expect('temperature' in (client.seen[0]?.options ?? {})).toBe(false);
  });

  it('passes the ceiling through when the manifest DID name one', async () => {
    const client = fakeClient([{ type: 'text', data: 'x' }]);
    const port = createLegacyModelPort(sourcesFor(client));
    for await (const _frame of port.stream({ ...REQUEST, maxOutputTokens: 512 }, new AbortController().signal)) {
      void _frame;
    }
    expect(client.seen[0]?.options.maxTokens).toBe(512);
  });

  it('gives the provider the CALLER\'s signal, un-wrapped', async () => {
    // `ports.ts:353-362`: the signal is injected rather than created here so
    // cancellation reaches context assembly and the FIRST model call, which is
    // the gap `DuyaAgent.ts:963` leaves open by building its controller too
    // late to cover them. A port that created its own would abort nobody.
    const client = fakeClient([{ type: 'text', data: 'x' }]);
    const port = createLegacyModelPort(sourcesFor(client));
    const controller = new AbortController();
    controller.abort(new Error('user pressed stop'));

    for await (const _frame of port.stream(REQUEST, controller.signal)) void _frame;

    const observed = client.seen[0]?.options.signal as AbortSignal | undefined;
    expect(observed?.aborted).toBe(true);
    expect((observed?.reason as Error | undefined)?.message).toBe('user pressed stop');
  });

  it('reads the messages AT REQUEST TIME, so a tool result joined between turns is seen', async () => {
    // The host hands over a MUTABLE reference (`TurnStreamRunner.ts:78`). A
    // snapshot taken at port-construction time would send the same context on
    // every turn — the run would loop forever on a prompt the model has
    // already answered.
    //
    // The fixture returns a FRESH ARRAY per call rather than mutating one, and
    // that is load-bearing rather than stylistic: mutating a single array is
    // indistinguishable from a reference snapshot, because the snapshot would be
    // the same object. A host that rebuilds its provider messages per turn is
    // what this models, and it is the only shape that can tell the two
    // implementations apart.
    const client = fakeClient([{ type: 'text', data: 'x' }]);
    let turn = 0;
    const port = createLegacyModelPort(
      sourcesFor(client, {
        llmMessages: () => {
          turn += 1;
          const history = [{ role: 'user' as const, content: 'hi', id: 'm1' }];
          if (turn > 1) history.push({ role: 'tool' as const, content: 'file contents', id: 'm2' });
          return history as never;
        },
      }),
    );

    for await (const _frame of port.stream(REQUEST, new AbortController().signal)) void _frame;
    for await (const _frame of port.stream(REQUEST, new AbortController().signal)) void _frame;

    expect(client.seen).toHaveLength(2);
    expect(client.seen[0]?.messages).toEqual([{ role: 'user', content: 'hi', id: 'm1' }]);
    expect(client.seen[1]?.messages).toEqual([
      { role: 'user', content: 'hi', id: 'm1' },
      { role: 'tool', content: 'file contents', id: 'm2' },
    ]);
  });

  it('drops the null frames and keeps the rest', async () => {
    // The narrowing's `null` has to actually filter, or every renderer
    // projection would be yielded into the engine's switch as narration.
    const client = fakeClient([
      { type: 'tool_group_progress', data: { title: 't', source: 'tool_fallback' } },
      { type: 'text', data: 'a' },
      { type: 'text_delta', data: 'ignored' },
      { type: 'text', data: 'b' },
    ]);
    const port = createLegacyModelPort(sourcesFor(client));
    const frames = [];
    for await (const frame of port.stream(REQUEST, new AbortController().signal)) frames.push(frame);

    expect(frames).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });
});

// ============================================================================
// The engine, driven through the real adapter
// ============================================================================

/**
 * The three fixtures every engine case shares.
 *
 * Factored out because they are identical boilerplate in all four cases, and a
 * copy that differs by one field between tests would make a failure ambiguous:
 * the reader could not tell whether a case differed because of the MODEL leg or
 * because of the manifest. `runId` is the only field that varies per case, so it
 * is passed in rather than shared.
 */
const MANIFEST = {
  version: 1,
  runId: 'run-x',
  projectId: null,
  workspaceId: 'w',
  roots: [],
  cwd: '.',
  permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
  capabilities: { profiles: [], modes: [], tools: [] },
  connectorBindings: [],
  env: { ref: 'env:test', hash: 'h' },
  budget: {},
  deterministic: false,
  provenance: {
    roots: { source: 's', synthesised: true },
    cwd: { source: 's', synthesised: true },
    permissionPolicy: { source: 's', synthesised: true },
    capabilities: { source: 's', synthesised: true },
    connectorBindings: { source: 's', synthesised: true },
    env: { source: 's', synthesised: true },
    agent: { source: 's', synthesised: true },
  },
} as never;

const INPUT = {
  revision: 'r1',
  prompt: { role: 'user', content: 'hi', id: 'p1' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: '', locator: 'catalog://test' },
  steering: [],
  options: {},
} as never;

const ASSEMBLED = {
  systemPrompt: 'you are duya',
  messages: [],
  tools: [],
  catalogRevision: 'c',
  revision: 'r',
};

describe('the engine drives a turn through the real model adapter', () => {
  it('streams from the provider, dispatches the tool it asked for, and completes', async () => {
    // The point of the whole leg. `emptyModelStream()` yields nothing, so the
    // engine reported `failed` on `sawFrame === false` (`run-engine.ts:487`)
    // and every `chat:start` produced a phantom run. Here the SAME engine
    // object is handed a port backed by a real client and reaches `completed`
    // with a tool dispatched — which is what a real turn looks like.
    // TWO turns, because the engine genuinely loops: turn 1 dispatches a tool,
    // so `#shouldStop` returns `null` (`run-engine.ts:714`) and turn 2 runs to
    // answer it. A single-turn script would dispatch forever.
    const client = scriptedClient([
      [
        { type: 'tool_use', data: toolUse({ id: 'call-1', name: 'Read' }) },
        { type: 'result', data: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
        { type: 'done', reason: 'tool_use' },
      ],
      [
        { type: 'text', data: 'the file is empty' },
        { type: 'result', data: { input_tokens: 40, output_tokens: 8, total_tokens: 48 } },
        { type: 'done', reason: 'end_turn' },
      ],
    ]);

    const dispatched: { name: string; callId: string }[] = [];
    const terminals: string[] = [];

    const engine = new RunEngineImpl({ now: () => 0, defaultMaxTurns: 4 });
    const handle = engine.execute({
      manifest: MANIFEST,
      signal: new AbortController().signal,
      input: INPUT,
      ports: {
        model: createLegacyModelPort(sourcesFor(client)),
        tools: {
          dispatch(call) {
            dispatched.push({ name: call.name, callId: call.callId });
          },
          drain: () => (async function* () {})(),
          discard: () => {},
          describe: () => [],
        },
        context: { assemble: () => Promise.resolve(ASSEMBLED), defer: () => {} },
        approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' } as const) },
        sideEffects: {
          // Attached deliberately, and this is a FINDING rather than test
          // furniture. `#ticket` (`run-engine.ts:757-768`) REFUSES any call whose
          // class is not `read_only` when no ledger is attached — and this
          // adapter stamps `undeclared` on every call, correctly. So a model
          // leg wired without a side-effect ledger refuses every tool the model
          // asks for, and the run fails on the refusal rather than on the model.
          // The ledger is therefore part of what makes this leg real, not an
          // optional extra.
          begin: (call) =>
            Promise.resolve({ attemptKey: `k:${call.callId}`, sequence: 1, recordedAt: 0 }),
          settle: () => Promise.resolve(),
          reconcile: () => {
            throw new Error('not wired');
          },
          read: () => Promise.resolve([]),
        },
        events: {
          publish: () => {},
          proposeTerminal: (candidate) => {
            terminals.push(`${candidate.state.status}`);
          },
        },
      },
    });

    await handle.completed();

    // The provider was actually called — once per turn, which is the loop.
    expect(client.seen).toHaveLength(2);
    // The tool the model asked for was actually dispatched — under
    // `emptyModelStream` this list is empty, because no frame ever arrives.
    expect(dispatched).toEqual([{ name: 'Read', callId: 'call-1' }]);
    // And the run reached a terminal instead of failing on an empty stream.
    expect(terminals).toEqual(['completed']);
  });

  it('refuses to dispatch a tool when no side-effect ledger is attached', async () => {
    // The counterpart to the finding above, and the reason the ledger is not
    // optional in the live wiring. Without one, `#ticket` throws for every
    // class except `read_only`, and the model port may not stamp `read_only` on
    // a call the model merely named. So the run fails as `failed` — which is
    // the engine refusing to make an effect it could not record, which is the
    // correct behaviour and not a defect in the adapter.
    const client = fakeClient([
      { type: 'tool_use', data: toolUse({ id: 'call-1', name: 'Bash' }) },
      { type: 'done', reason: 'tool_use' },
    ]);

    const dispatched: string[] = [];
    const terminals: string[] = [];
    const engine = new RunEngineImpl({ now: () => 0, defaultMaxTurns: 3 });
    const handle = engine.execute({
      manifest: MANIFEST,
      signal: new AbortController().signal,
      input: INPUT,
      ports: {
        model: createLegacyModelPort(sourcesFor(client)),
        tools: {
          dispatch: (call) => {
            dispatched.push(call.name);
          },
          drain: () => (async function* () {})(),
          discard: () => {},
          describe: () => [],
        },
        context: { assemble: () => Promise.resolve(ASSEMBLED), defer: () => {} },
        approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' } as const) },
        events: {
          publish: () => {},
          proposeTerminal: (candidate) => {
            terminals.push(candidate.state.status);
          },
        },
      },
    });

    await handle.completed();

    expect(dispatched).toEqual([]);
    expect(terminals).toEqual(['failed']);
  });

  it('records the provider\'s tokens into the run spend', async () => {
    // `usage` is the frame that makes budget accounting possible at all
    // (`run-engine.ts:462`). With the snake_case reading removed this reports
    // `NaN`, which is not an error — it is a budget that never exhausts.
    const client = fakeClient([
      { type: 'result', data: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
      { type: 'done', reason: 'end_turn' },
    ]);

    const report: { tokens: number; turns: number }[] = [];
    const engine = new RunEngineImpl({
      now: () => 0,
      defaultMaxTurns: 3,
      onReport: (r) => report.push({ tokens: r.spend.tokens, turns: r.turns }),
    });

    const handle = engine.execute({
      manifest: MANIFEST,
      signal: new AbortController().signal,
      input: INPUT,
      ports: {
        model: createLegacyModelPort(sourcesFor(client)),
        tools: {
          dispatch: () => {},
          drain: () => (async function* () {})(),
          discard: () => {},
          describe: () => [],
        },
        context: { assemble: () => Promise.resolve(ASSEMBLED), defer: () => {} },
        approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' } as const) },
        events: { publish: () => {}, proposeTerminal: () => {} },
      },
    });

    await handle.completed();

    expect(report).toHaveLength(1);
    expect(report[0]?.tokens).toBe(120);
    expect(report[0]?.turns).toBe(1);
  });

  it('a stop during the turn aborts the PROVIDER, not just the engine loop', async () => {
    // The whole reason `ModelPort.stream` takes a signal (`ports.ts:353-362`).
    // `run-engine.ts:214-232` forwards the caller\'s signal into one internal
    // controller and hands THAT to the ports, so the signal a provider sees is
    // deliberately not the caller\'s own object. Asserting the abort REACHED
    // the provider is therefore the only honest form of this assertion — an
    // identity check would assert the opposite of the contract.
    const observed: AbortSignal[] = [];
    const client = {
      streamChat(_messages: unknown, options: Record<string, unknown>) {
        observed.push(options.signal as AbortSignal);
        return (async function* (): AsyncGenerator<SSEEvent> {
          // A provider that streams slowly enough for a stop to land mid-turn.
          await new Promise((resolve) => setTimeout(resolve, 25));
          yield { type: 'text', data: 'late' };
          yield { type: 'done', reason: 'end_turn' };
        })();
      },
    };

    const terminals: string[] = [];
    const engine = new RunEngineImpl({ now: () => 0, defaultMaxTurns: 3 });
    const handle = engine.execute({
      manifest: MANIFEST,
      signal: new AbortController().signal,
      input: INPUT,
      ports: {
        model: createLegacyModelPort(sourcesFor(client)),
        tools: {
          dispatch: () => {},
          drain: () => (async function* () {})(),
          discard: () => {},
          describe: () => [],
        },
        context: {
          assemble: () => Promise.resolve({ ...REQUEST, messages: [], tools: [], catalogRevision: 'c', revision: 'r' }),
          defer: () => {},
        },
        approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' } as const) },
        events: {
          publish: () => {},
          proposeTerminal: (candidate) => {
            terminals.push(candidate.state.status);
          },
        },
      },
    });

    const receipt = await handle.stop({ graceMs: 0, reason: 'user pressed stop' });
    await handle.completed();

    expect(observed).toHaveLength(1);
    // The provider was reached and its signal is the one that aborted.
    expect(observed[0]?.aborted).toBe(true);
    // And the stop was reported as having reached a live run.
    expect(receipt.requested).toBe(true);
    expect(terminals).toEqual(['cancelled']);
  });
});
