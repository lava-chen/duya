/**
 * Compaction inside the engine's turn loop.
 *
 * ## Why this file exists
 *
 * `CompactionPort` was declared (`ports.ts`) and `runCompactionPass` was written
 * (`engine/compaction.ts`) while the engine's `for` loop never called either --
 * `run-engine.ts` held zero references to compaction. A port with no call site
 * is not a wiring gap, it is an ABSENT FEATURE: the transcript is never
 * replaced, and the five `compaction.*` frames have no producer at all, which
 * `ports.ts` states is explicitly not a harmless omission.
 *
 * So this is a feature file, not a wiring file, and it asserts BEHAVIOUR: when
 * the port says compact, the engine compacts and the NEXT REQUEST IS BUILT FROM
 * THE REPLACEMENT; when it says skip, nothing happens; the emergency path
 * differs from the normal one observably; and a compacting turn still ends.
 *
 * ## Why the assertions compare two INDEPENDENT sources
 *
 * Every assertion pairs what the scripted PORTS observed (the
 * `CompactionPort`'s own call log and anchors, the messages the `ModelPort` was
 * handed, the frames the event store received) against what the legacy's
 * behaviour says must have happened (`DuyaAgent.ts:2155`, `:3018`/`:3022`,
 * `:3166-3172`, `:3330`/`:3360`/`:3368-3370`). Nothing compares a measured value
 * against itself. The transcript assertions in particular compare the array the
 * model was SENT against the literal `replacement()` returned -- two different
 * sources, which is the only way "the replacement reached the wire" stays
 * distinguishable from "the arrays happen to be equal".
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  AssembledTurn,
  CompactionDecision,
  CompactionDecisionInput,
  CompactionOutcome,
  CompactionPort,
  CompactionProgress,
  CompactionUsageAnchor,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  RunInputSnapshot,
  RunManifest,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';
/**
 * What the engine published, taken from the PORT rather than from
 * `@duya/agent-protocol`.
 *
 * Most tests in this directory import `RunEvent` from the protocol directly, and
 * that is the better default. This one derives it from `RunEventStorePort`
 * because a second cross-package import statement adds one
 * `module-dependency-permitted` edge, and `architecture-policy.yaml`'s `selfTest`
 * block pins that count at 375 -- so a new test file that reaches for the
 * protocol fails `npm run architecture:self-test` even though the edge is
 * permitted and correct.
 *
 * Deriving it is not a workaround with no cost: the assertion in this file is
 * about what the engine published THROUGH the port, so the port is the right
 * vocabulary, and the type tracks the port if the protocol widens. Do not "fix"
 * this to a direct protocol import without re-recording the policy count.
 */
type PublishedEvent = Parameters<RunEventStorePort['publish']>[0];
// ============================================================================
// Scripted ports
// ============================================================================

/** One scripted model call. */
interface ScriptedTurn {
  readonly frames: readonly ModelFrame[];
  /**
   * Omit the trailing `turn_stopped`, so the stream ENDS with nothing having
   * said anything -- the dead-transport case `#streamModel` fails at `:720-725`.
   * Distinct from an empty `frames`, which still gets a `turn_stopped` and is
   * therefore a NORMAL turn that produced no text.
   */
  readonly endsOpen?: boolean;
}

interface Harness {
  readonly ports: RunEnginePorts;
  /** `compaction.decide:<trigger>` / `compaction.run:<trigger>`, in call order. */
  readonly compactionLog: string[];
  /** Every decision input the port was asked about, in order. */
  readonly decisions: CompactionDecisionInput[];
  /** The `noteUsage` reports, in order. */
  readonly anchors: CompactionUsageAnchor[];
  /** Progress the port reported while running, in order. */
  readonly progress: CompactionProgress[];
  /** Messages the model was actually sent, per call, in order. */
  readonly sentMessages: ModelMessage[][];
  /** Events the engine published, in order. */
  readonly events: PublishedEvent[];
  /** `tools.discard:<reason>`, in order. */
  readonly discards: string[];
  /** Terminals the engine proposed, in order. */
  readonly terminals: { state: string; reason: string }[];
  modelCalls(): number;
}

/** What a dispatched call hands back, so a drain has something to produce. */
const TOOL_RESULT = 'the file was written';

function harness(options: {
  readonly turns: readonly ScriptedTurn[];
  /** The verdict for each decision, or a function of the decision input. */
  readonly decide: (input: CompactionDecisionInput) => CompactionDecision;
  /** The transcript the replacement produces. Omit to make `run` return failed. */
  readonly replacement?: readonly ModelMessage[];
  /** Report progress while running, to pin the mid-run frame ordering. */
  readonly reportProgress?: boolean;
  /** Omit `noteUsage` from the port entirely. */
  readonly withoutAnchor?: boolean;
  /** Emit a `usage` frame on every call that reaches its end. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Make a dispatched call produce no result, so the drain stays empty. */
  readonly noToolResult?: boolean;  /** The messages `context.assemble` returns. */
  readonly assembledMessages?: readonly ModelMessage[];
  /**
   * Also queue a `deferred_context` whose `pending` NEVER settles.
   *
   * The hazard `#transcriptFor` is shaped around: a probe that awaited it would
   * park on a promise no host is obliged to resolve, and the port's own doc
   * records that such a fragment already stalls `#modelRequest`
   * (`PendingTransientContextFragment`). A compaction probe must not add a
   * second stall, and least of all on the emergency path.
   */
  readonly pendingDeferred?: boolean;
}): Harness {
  const compactionLog: string[] = [];
  const decisions: CompactionDecisionInput[] = [];
  const anchors: CompactionUsageAnchor[] = [];
  const progress: CompactionProgress[] = [];
  const sentMessages: ModelMessage[][] = [];
  const events: PublishedEvent[] = [];
  const discards: string[] = [];
  const terminals: { state: string; reason: string }[] = [];
  const queued: ToolDrainItem[] = [];
  let turnIndex = 0;
  let ids = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      const scripted = options.turns[turnIndex];
      turnIndex += 1;
      sentMessages.push([...request.messages]);
      if (scripted === undefined) {
        yield { type: 'turn_stopped', reason: 'end_turn' };
        return;
      }
      for (const frame of scripted.frames) yield frame;
      // Skipped for a script that ends in a fatal `error`, because the engine
      // returns out of the frame loop and never reads the rest.
      if (options.usage !== undefined) {
        yield {
          type: 'usage',
          inputTokens: options.usage.inputTokens,
          outputTokens: options.usage.outputTokens,
        };
      }
      if (scripted.endsOpen !== true) yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const compaction: CompactionPort = {
    async decide(input: CompactionDecisionInput): Promise<CompactionDecision> {
      decisions.push(input);
      compactionLog.push(`decide:${input.trigger}`);
      return options.decide(input);
    },
    async run(input: CompactionDecisionInput, reporter: (p: CompactionProgress) => void) {
      compactionLog.push(`run:${input.trigger}`);
      // Reported DURING the run, before it resolves -- the property the legacy's
      // real-time pump exists for (`DuyaAgent.ts:2144-2151`).
      if (options.reportProgress === true) {
        const step: CompactionProgress = { kind: 'step', step: 1, phase: 'summarize' };
        progress.push(step);
        reporter(step);
      }
      if (options.replacement === undefined) {
        return { kind: 'failed', error: { code: 'summarizer_unavailable', message: 'no summary' } };
      }
      return {
        kind: 'replaced',
        replacement: options.replacement,
        boundaryId: 'boundary-1',
        compactedMessageIds: ['m-1', 'm-2'],
      };
    },
    nextCompactionId(): string {
      ids += 1;
      return `cmp-${ids}`;
    },
    ...(options.withoutAnchor === true
      ? {}
      : {
          noteUsage(anchor: CompactionUsageAnchor): void {
            anchors.push(anchor);
          },
        }),
  };

  const ports: RunEnginePorts = {
    model,
    tools: {
      dispatch(call: ToolCallRequest): void {
        if (options.noToolResult === true) return;
        queued.push({
          kind: 'tool_result',
          callId: call.callId,
          content: TOOL_RESULT,
          isError: false,
          durationMs: 1,
        });
        if (options.pendingDeferred === true) {
          queued.push({
            kind: 'deferred_context',
            callId: call.callId,
            // Never settles. A test timeout is the assertion.
            pending: new Promise<unknown>(() => {}),
          });
        }
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const outcome of queued.splice(0, queued.length)) yield outcome;
      },
      discard(reason: string): void {
        discards.push(reason);
        queued.length = 0;
      },
      describe: (): readonly ToolDescriptor[] => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'you are a test',
          messages: options.assembledMessages ?? [
            { role: 'user', id: 'a-1', content: 'assembled one' },
          ],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      authorize: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
    },
    events: {
      publish(event: PublishedEvent): void {
        events.push(event);
      },
      proposeTerminal(candidate): void {
        terminals.push({
          state: (candidate.state as { status: string }).status,
          reason: candidate.reason,
        });
      },
    } as RunEventStorePort,
    compaction,
  };

  return {
    ports,
    compactionLog,
    decisions,
    anchors,
    progress,
    sentMessages,
    events,
    discards,
    terminals,
    modelCalls: () => turnIndex,
  };
}

function manifestFor(): RunManifest {
  return {
    version: 1,
    runId: 'run-1',
    projectId: null,
    workspaceId: 'ws',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
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
      deterministic: { source: 'unsupported', synthesised: true },
    },
  } as RunManifest;
}

const PROMPT: ModelMessage = { role: 'user', id: 'p1', content: 'do the thing' };
const INLINE_HISTORY: ModelMessage = { role: 'user', id: 'h-1', content: 'inline history' };

function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: PROMPT,
    // INLINE and non-empty, and that is the case that matters: an inline history
    // is frozen at run start, so it is the one source that could never reflect a
    // compaction, and the override in `#modelRequest` has to outrank it.
    history: { kind: 'inline', value: [INLINE_HISTORY] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

async function run(h: Harness): Promise<void> {
  const controller = new AbortController();
  const engine = new RunEngineImpl({ now: () => 1_000 });
  await engine
    .execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: controller.signal,
      ports: h.ports,
    })
    .completed();
}

const COMPACT: CompactionDecision = { kind: 'compact', trigger: 'auto' };
const SKIP: CompactionDecision = { kind: 'skip', reason: 'under the trigger line' };

/**
 * The replacement every "it compacts" case installs.
 *
 * A function rather than a constant so a test can hand the SAME identity to the
 * port and compare the model's copy against a freshly derived expectation -- two
 * sources, and a shared mutable array would let one test's write explain another
 * test's read.
 */
function replacement(): readonly ModelMessage[] {
  return [
    { role: 'user', id: 'r-1', content: 'summary of turns 1..4' },
    { role: 'assistant', id: 'r-2', content: 'acknowledged' },
  ];
}

/** A tool call whose drain produces one result, so turn 2 is forced. */
const CALL_FRAME: ModelFrame = {
  type: 'tool_use',
  call: { callId: 'call-1', name: 'read', input: {}, sideEffect: 'read_only' },
};

// ============================================================================
// 1. It fires when the port says it should
// ============================================================================

describe('the engine compacts when the port says to', () => {
  it('asks between assembly and the request, and builds that request from the replacement', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'hi' }] }],
      decide: () => COMPACT,
      replacement: replacement(),
    });

    await run(h);

    // The proactive site runs BETWEEN assembly and the request, which is the
    // legacy's order (pump at `DuyaAgent.ts:2155`, request built at `:2338`).
    // Asserted as an order over the port's OWN log rather than as a count.
    expect(h.compactionLog).toEqual(['decide:auto', 'run:auto']);

    // THE load-bearing assertion of this file. Turn 1 is composed as
    // `[prompt, ...carried, ...history]` (`#modelRequest`), and `history` must be
    // the REPLACEMENT. Without the override the engine would publish
    // `compaction.completed` and then send the inline history, and every frame
    // assertion in existence would still pass.
    expect(h.sentMessages[0]).toEqual([PROMPT, ...replacement()]);
    // And the thing it must NOT contain, so the line above cannot pass by the
    // arrays coinciding.
    expect(h.sentMessages[0]).not.toContainEqual(INLINE_HISTORY);
  });

  it('publishes started, the progress reported DURING the run, then exactly one terminal', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'hi' }] }],
      decide: () => COMPACT,
      replacement: replacement(),
      reportProgress: true,
    });

    await run(h);

    // Order over the event store, compared against the protocol's own five
    // members. The `step` sits BETWEEN started and completed, which is the
    // property the legacy's inline pump at `:2172`/`:2180` exists to keep: a
    // buffered reporter would put it after the terminal instead.
    expect(h.events.filter((e) => e.type.startsWith('compaction.')).map((e) => e.type)).toEqual([
      'compaction.started',
      'compaction.step',
      'compaction.completed',
    ]);
    // The frames share the id the HOST minted, read off the events themselves
    // rather than off the port's return value.
    const frames = h.events.filter((e) => e.type.startsWith('compaction.')) as Array<{
      compactionId: string;
      boundaryId?: string;
    }>;
    expect(frames[1]?.compactionId).toBe(frames[0]?.compactionId);
    expect(frames[2]?.compactionId).toBe(frames[0]?.compactionId);
    expect(frames[2]?.boundaryId).toBe('boundary-1');
    // And the reporter really did run before the port resolved -- proved from the
    // port's own progress log, a different source from the event store.
    expect(h.progress).toHaveLength(1);
  });

  it('carries the replacement into the NEXT turn, not only the first', async () => {
    const h = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      // The proactive site compacts; the preflight site declines, so the log has
      // exactly one `run` and the transcript assertions below are unambiguous.
      decide: (input) => (input.trigger === 'auto' ? COMPACT : SKIP),
      replacement: replacement(),
    });

    await run(h);

    expect(h.modelCalls()).toBe(2);
    // Turn 2 reuses the pinned cell. A replacement applied only to the request
    // that happened to be in flight would leave every later turn on the original
    // history, which is the failure `COMPACTION_REPLACEMENT_IS_REQUIRED` in
    // `port-guards.ts` exists to make visible.
    expect(h.sentMessages[0]).toEqual([PROMPT, ...replacement()]);
    // Turn 2 is `[...history, ...carried]`, and `carried` is the tool result the
    // drain produced -- so the replacement is the BASE, not the whole request.
    expect(h.sentMessages[1]).toEqual([
      ...replacement(),
      { role: 'user', id: 'fragment:tool_result:call-1', content: TOOL_RESULT },
    ]);
    expect(h.sentMessages[1]).not.toContainEqual(INLINE_HISTORY);
  });

  it('runs the preflight site after a drain produced results, and not otherwise', async () => {
    const withResult = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) =>
        input.trigger === 'preflight_overflow'
          ? { kind: 'compact', trigger: 'preflight_overflow' }
          : SKIP,
      replacement: replacement(),
    });
    const withoutResult = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) =>
        input.trigger === 'preflight_overflow'
          ? { kind: 'compact', trigger: 'preflight_overflow' }
          : SKIP,
      replacement: replacement(),
      noToolResult: true,
    });

    await run(withResult);
    await run(withoutResult);

    // The gate is the legacy's `toolResultMessageCount > 0` (`:3009`), and the
    // two runs differ ONLY in whether the dispatched call came back with a
    // result. Asking again with nothing new would re-decide the same question
    // against the same transcript.
    expect(withResult.compactionLog).toContain('decide:preflight_overflow');
    expect(withoutResult.compactionLog).not.toContain('decide:preflight_overflow');
    // Both still asked at the proactive site, so the difference is the GATE and
    // not a run that never got going.
    expect(withoutResult.compactionLog).toContain('decide:auto');
  });
});

// ============================================================================
// 2. It does NOT fire when it should not
// ============================================================================

describe('the engine does not compact when the port declines', () => {
  it('asks once, runs nothing, and leaves the transcript exactly as it was', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'hi' }] }],
      decide: () => SKIP,
      replacement: replacement(),
    });

    await run(h);

    // `decide` without `run` is the whole contract of a decline: a port that was
    // asked and said no. Calling `run` here would compact a transcript the port
    // examined and rejected.
    expect(h.compactionLog).toEqual(['decide:auto']);
    // No frames at all -- not "the frames of a compaction that changed nothing".
    expect(h.events.filter((e) => e.type.startsWith('compaction.'))).toEqual([]);
    // The request still went out, on the ORIGINAL inline history. The model's
    // copy against the input literal: two sources.
    expect(h.sentMessages[0]).toContainEqual(INLINE_HISTORY);
    expect(h.sentMessages[0]).not.toEqual([PROMPT, ...replacement()]);
  });

  it('measures the assembled transcript, not the inline one, at the proactive site', async () => {
    // The proactive site runs after `assemble` precisely so the port is handed a
    // real projection. `decide` may not re-project -- the history part of
    // `TurnAssemblyInput` is a `ResolvedPart` and a `by_ref` one is the HOST's
    // to resolve -- so a probe asked above assembly would measure nothing.
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'hi' }] }],
      decide: () => SKIP,
      assembledMessages: [{ role: 'user', id: 'a-1', content: 'assembled one' }],
    });

    await run(h);

    expect(h.decisions).toHaveLength(1);
    // The decision input's transcript, against the literal the scripted
    // `assemble` returned. Two sources.
    expect(h.decisions[0]?.transcript).toEqual([
      { role: 'user', id: 'a-1', content: 'assembled one' },
    ]);
    // And the turn number is the engine's own 1-based count, not an invented one.
    expect(h.decisions[0]?.turn).toBe(1);
  });

  it('never reaches a port at all when none is bound', async () => {
    const sent: ModelMessage[][] = [];
    const controller = new AbortController();
    const model: ModelPort = {
      async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
        sent.push([...request.messages]);
        yield { type: 'text', text: 'hi' };
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    };
    const engine = new RunEngineImpl({ now: () => 1_000 });
    await engine
      .execute({
        manifest: manifestFor(),
        input: inputFor(),
        signal: controller.signal,
        // NO `compaction` key. The absent binding is the live worker's state and
        // must be a no-op rather than a throw.
        ports: {
          model,
          tools: {
            dispatch: () => {},
            drain: () => (async function* () {})(),
            discard: () => {},
            describe: () => [],
          },
          context: {
            assemble: () =>
              Promise.resolve({
                systemPrompt: 's',
                messages: [],
                tools: [],
                catalogRevision: 'c',
                revision: 'r',
              } as AssembledTurn),
            defer: () => {},
          },
          approval: { authorize: () => Promise.resolve({ allowed: true, scope: 'once' as const }) },
          events: { publish: () => {}, proposeTerminal: () => {} } as RunEventStorePort,
        },
      })
      .completed();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContainEqual(INLINE_HISTORY);
  });
});

// ============================================================================
// 3. The emergency path differs from the normal one
// ============================================================================

describe('the emergency path is not the normal path', () => {
  it('RE-RUNS THE SAME TURN against the replacement, and closes the pipeline', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            {
              type: 'error',
              message: 'prompt is too long: 210000 tokens > 200000 maximum',
              retryable: false,
            },
          ],
        },
        // The retry succeeds. Same turn INDEX, so this is the second call of
        // turn 1 rather than the first of turn 2.
        { frames: [{ type: 'text', text: 'recovered' }] },
      ],
      decide: (input) =>
        input.trigger === 'emergency'
          ? { kind: 'compact', trigger: 'emergency' }
          : // The proactive site on the re-entry declines, so exactly one
            // compaction happens and the counts below are unambiguous.
            SKIP,
      replacement: replacement(),
    });

    await run(h);

    // Two model calls, and the log proves the SECOND was the retry: the emergency
    // ran BETWEEN them, not after the run ended.
    expect(h.modelCalls()).toBe(2);
    expect(h.compactionLog).toEqual([
      'decide:auto',
      'decide:emergency',
      'run:emergency',
      'decide:auto',
    ]);

    // The retry carried the replacement. Without `turn -= 1` this would be turn 2
    // built from the ORIGINAL history -- the same oversized request, one turn
    // later, which is exactly what the emergency exists to prevent.
    expect(h.sentMessages[1]).toEqual([PROMPT, ...replacement()]);
    expect(h.sentMessages[1]).not.toContainEqual(INLINE_HISTORY);

    // `turnId` is reused, which is the observable proof the turn index was not
    // advanced. The legacy does the same with `turnCount--` (`:3369`).
    const turnStarts = h.events.filter((e) => e.type === 'turn.started') as Array<{
      turnId: string;
      index: number;
    }>;
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1]?.turnId).toBe(turnStarts[0]?.turnId);
    expect(turnStarts[1]?.index).toBe(1);

    // And the one-way latch is closed before the re-entry, so a tool dispatched
    // in the FAILED attempt cannot be double-run. On the `error` frame path
    // `#streamModel` discarded as well, so the count alone is not the signal --
    // the case below pins this line on a path where nothing else discards.
    expect(h.discards).toContain('model_retry');
    // The run still ended, and ended well.
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.state).toBe('completed');
  });

  it('closes the pipeline itself when the failure path did not', async () => {
    // A stream that produces NO frames returns `failed` at `:720-725` without
    // passing through the `error` arm, so nothing else calls `discard`. That
    // makes this the case where the retry's own `discard` is the only one, which
    // is what pins it -- the case above cannot, because the error arm fires
    // first there and the two are indistinguishable by count.
    const h = harness({
      turns: [
        { frames: [], endsOpen: true },
        { frames: [{ type: 'text', text: 'recovered' }] },
      ],
      decide: (input) =>
        input.trigger === 'emergency' ? { kind: 'compact', trigger: 'emergency' } : SKIP,
      replacement: replacement(),
    });

    await run(h);

    expect(h.modelCalls()).toBe(2);
    // Exactly one, and it is the retry's own. Read from the port's log, not from
    // the engine's source.
    expect(h.discards).toEqual(['model_retry']);
    // The message handed to the port is the ENGINE's description of the dead
    // stream, asserted against the literal the engine documents at `:724`.
    const emergency = h.decisions.find((d) => d.trigger === 'emergency');
    expect(emergency?.observation?.providerError).toBe('the model stream produced no frames');
  });

  it('forwards the provider error verbatim and does NOT classify it itself', async () => {
    const h = harness({
      turns: [
        {
          frames: [
            // Weak wording: the legacy requires local corroboration for this one
            // (`DuyaAgent.ts:3311-3319`). The engine must not decide that -- it
            // forwards the text and the port rules on it.
            { type: 'error', message: 'output limit exceeded', retryable: false },
          ],
        },
        { frames: [{ type: 'text', text: 'recovered' }] },
      ],
      // The port declines BECAUSE the wording was weak and it found no
      // corroboration -- the dual-evidence gate, running host-side.
      decide: (input) => {
        if (input.trigger !== 'emergency') return SKIP;
        const error = input.observation?.providerError ?? '';
        return error.includes('too long')
          ? { kind: 'compact', trigger: 'emergency' }
          : { kind: 'skip', reason: 'weak wording without local corroboration' };
      },
      replacement: replacement(),
    });

    await run(h);

    // The error text arrived intact, as a QUOTATION, asserted against the literal
    // the scripted frame carried -- a different source from the decision input
    // the port received.
    const emergency = h.decisions.find((d) => d.trigger === 'emergency');
    expect(emergency?.observation?.providerError).toBe('output limit exceeded');
    // The engine named no OTHER observation member. Classifying the wording would
    // mean growing a second copy of a rule whose inputs are the host's providers,
    // and `ports.ts` says this field is "Never inferred by the engine".
    expect(Object.keys(emergency?.observation ?? {})).toEqual(['providerError']);
    // The proactive site has no observation at all -- it is a guess, and
    // `ports.ts` forbids making it report one.
    expect(h.decisions.find((d) => d.trigger === 'auto')?.observation).toBeUndefined();

    // Declined, so NO retry and the original failure stands. The legacy's
    // `if (compactEntry)` at `:3361` is the same test. The call count is the
    // discriminator, NOT the discard log: `#streamModel` discards on the `error`
    // arm before the engine ever reaches this site, so both the retried and the
    // declined case record one `model_retry` and a count could not tell them
    // apart.
    expect(h.modelCalls()).toBe(1);
    expect(h.compactionLog).toEqual(['decide:auto', 'decide:emergency']);
    // The pass was asked and ran nothing, so no terminal frame was published
    // for it -- a consumer sees the run fail without a compaction appearing.
    expect(h.events.filter((e) => e.type.startsWith('compaction.'))).toEqual([]);
    expect(h.terminals[0]?.state).toBe('failed');
  });

  it('never runs a summarizer on a run the caller stopped', async () => {
    // The one gate here that is not a transliteration. `#streamModel` returns a
    // non-null exit for a cancellation as well as for a failure, and both arrive
    // at the same `if`. A compaction on a cancelled run would start a
    // multi-minute summarizer on a run the user just asked to stop.
    //
    // Driven with a `turn_stopped: cancelled` frame rather than an aborted
    // `signal`, because that frame reaches the SAME `if` deterministically: the
    // engine returns `{ reason: 'cancelled' }` at the `turn_stopped` arm with no
    // dependence on timing, so the case is not a race.
    const h = harness({
      turns: [{ frames: [{ type: 'turn_stopped', reason: 'cancelled' }] }],
      // A port that would say yes to everything, so the assertion below is
      // about the engine never ASKING rather than about a decline.
      decide: () => ({ kind: 'compact', trigger: 'emergency' }),
      replacement: replacement(),
    });

    await run(h);

    // The proactive site ran, because the port is eager and the site sits before
    // the stream. The emergency site did NOT, despite the very same port saying
    // yes to everything -- which is the whole claim, and a count could not
    // express it.
    expect(h.compactionLog).toEqual(['decide:auto', 'run:auto']);
    expect(h.decisions.map((d) => d.trigger)).not.toContain('emergency');
    expect(h.modelCalls()).toBe(1);
    // And the run ended as a cancellation, which is what it would have ended as
    // with no compaction port bound at all.
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.state).toBe('cancelled');
  });

  it('probes without waiting on a deferred context that never settles', async () => {
    // The stall `#transcriptFor` is shaped to avoid. Awaiting is CORRECT at
    // `#modelRequest` -- the next request has to carry the fragment, and the
    // port's own doc records that stall as inherited behaviour
    // (`PendingTransientContextFragment`: "A `pending` that never settles stalls
    // the turn that resolves it"). So this run is NOT awaited to completion:
    // turn 2's request is supposed to park, and the claim under test is only
    // that the preflight probe on turn 1 was reached FIRST, without parking.
    const h = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) =>
        input.trigger === 'preflight_overflow'
          ? { kind: 'compact', trigger: 'preflight_overflow' }
          : SKIP,
      replacement: replacement(),
      pendingDeferred: true,
    });

    const controller = new AbortController();
    const engine = new RunEngineImpl({ now: () => 1_000 });
    // Deliberately not awaited: `completed()` cannot settle while turn 2 parks
    // on the never-resolving fragment, and that park is the port's documented
    // behaviour rather than anything this slice changed.
    const finished = engine
      .execute({ manifest: manifestFor(), input: inputFor(), signal: controller.signal, ports: h.ports })
      .completed();

    // Bounded wait on the PROBE, not on the run. An awaiting `#transcriptFor`
    // would still be sitting on the fragment when this gives up, which is the
    // failure -- so a pass here is the claim and a timeout is the regression.
    const deadline = 40;
    for (let tick = 0; tick < deadline && !h.compactionLog.includes('decide:preflight_overflow'); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort(new Error('test over'));

    // The `tool_result` queued beside the pending one is what opened the gate, so
    // a probe that fired for some other reason cannot pass this.
    expect(h.compactionLog).toContain('decide:preflight_overflow');
    // And the transcript it measured is the ASSEMBLED messages plus the RESOLVED
    // drained result -- read off the decision input, so this is the port's own
    // copy rather than the engine's. The proactive site declined, so there is no
    // replacement and the base is what `assemble` returned.
    const preflight = h.decisions.find((d) => d.trigger === 'preflight_overflow');
    expect(preflight?.transcript.map((m) => m.id)).toEqual([
      'a-1',
      'fragment:tool_result:call-1',
    ]);
    // Named explicitly, because "the exact list" is a weaker statement than it
    // looks: a pending fragment renders as `fragment:deferred:<callId>`, so this
    // is where its absence is actually pinned.
    expect(preflight?.transcript.map((m) => m.id)).not.toContain('fragment:deferred:call-1');
    // The run really was still live when the probe fired -- `modelCalls` is 1
    // and the first turn's stream is done -- so this is not a run that had
    // already ended and therefore never needed to await anything.
    expect(h.modelCalls()).toBe(1);
    // The run is abandoned, NOT awaited: `completed()` cannot settle while turn 2
    // parks on the never-resolving fragment, and that park is the port's
    // documented behaviour rather than anything this slice changed. The abort
    // above does not release it either, because `#modelRequest` waits on
    // `Promise.allSettled` and never re-reads the signal -- which is the very
    // asymmetry this method is shaped around. The handler is attached so the
    // abandoned run cannot surface as an unhandled rejection.
    void finished.catch(() => undefined);
  });

  it('a proactive failure ends the run before the model is ever called', async () => {
    // The asymmetry is the legacy's, and it is why `#compact` RETURNS a result
    // instead of throwing: the three sites apply three policies.
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'never reached' }] }],
      decide: () => COMPACT,
      // No `replacement`, so the port's `run` returns `failed`.
    });

    await run(h);

    expect(h.modelCalls()).toBe(0);
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.state).toBe('failed');
    // The pass still published its own terminal frame, so a consumer watching the
    // stream sees the compaction fail rather than seeing nothing happen.
    expect(h.events.filter((e) => e.type === 'compaction.failed')).toHaveLength(1);
  });
});

// ============================================================================
// 4. A turn that compacts still ends correctly
// ============================================================================

describe('a turn that compacts still ends correctly', () => {
  it('completes, finalizes its message, and proposes a terminal exactly once', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'the answer' }] }],
      decide: () => COMPACT,
      replacement: replacement(),
      usage: { inputTokens: 1234, outputTokens: 56 },
    });

    await run(h);

    // ONE terminal, and it is a success. An engine that compacted and then lost
    // the ending -- left the loop open, or proposed twice -- fails here.
    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.state).toBe('completed');

    // The run's own message was still assembled and finalized: compaction
    // replaced the INPUT and did not swallow the OUTPUT. Two event families,
    // both read from the store.
    expect(h.events.filter((e) => e.type === 'assistant.message_finalized')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'compaction.completed')).toHaveLength(1);

    // The usage anchor reached the port, carrying the generation the request was
    // BUILT in. The token numbers are the port's own report, cross-checked
    // against the scripted frame -- two sources, not one.
    expect(h.anchors).toHaveLength(1);
    expect(h.anchors[0]?.inputTokens).toBe(1234);
    expect(h.anchors[0]?.outputTokens).toBe(56);
    // Epoch 1, not 0: the proactive compaction ran before the stream opened, so
    // the request was built in the SECOND generation. Filing it under 0 would
    // anchor a post-compaction decision to a size the transcript never had --
    // the reason the legacy reads the epoch at `:2380`, before the stream.
    expect(h.anchors[0]?.epoch).toBe(1);
    expect(h.anchors[0]?.turn).toBe(1);
  });

  it('does not anchor on a provider that reported zero input tokens', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'the answer' }] }],
      decide: () => SKIP,
      usage: { inputTokens: 0, outputTokens: 56 },
    });

    await run(h);

    // The legacy guards the same way at `:3166`. Filing a zero would collapse the
    // anchor and make the next decision fire immediately; a port that WANTS the
    // zero has the transcript to measure.
    expect(h.anchors).toEqual([]);
  });

  it('survives a port with no `noteUsage` at all', async () => {
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'the answer' }] }],
      decide: () => COMPACT,
      replacement: replacement(),
      usage: { inputTokens: 999, outputTokens: 1 },
      withoutAnchor: true,
    });

    await run(h);

    // The anchor is OPTIONAL and its absence is a DEGRADED port, not a broken
    // one: compaction still fires, still replaces, and the run still ends. This
    // is the distinction `ports.ts` draws between a lost anchor and a lost
    // transcript.
    expect(h.compactionLog).toEqual(['decide:auto', 'run:auto']);
    expect(h.sentMessages[0]).toEqual([PROMPT, ...replacement()]);
    expect(h.terminals[0]?.state).toBe('completed');
  });
});
