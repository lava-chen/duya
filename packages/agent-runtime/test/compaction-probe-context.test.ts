/**
 * The compaction PROBE measures the rows the request carries.
 *
 * ## What this file is
 *
 * The engine hands the compaction port a transcript and the port MEASURES it
 * -- "the messages travel, and the port measures them" (`ports.ts`) -- so a
 * probe handed LESS than the request carries under-counts it, and a compaction
 * decided against a smaller number is decided against the WRONG number.
 *
 * Audit finding H-2 put the volatile context BACK on the request after a
 * compaction: the request is built from a PARTITION -- the replacement's
 * conversation plus the host's current context, one row each. Audit finding
 * H-6 is the other half of that: the PROBE was still handed the replacement
 * alone, so it under-counted the request by exactly the rail, and the trigger
 * fired later than it should by the rail's size.
 *
 * ## What is asserted here, and what breaks it
 *
 * | what | arm | what removing the fix does |
 * | --- | --- | --- |
 * | the probe's transcript carries the host's context rows after a compaction | "measures the host's context rows" | the rail is missing from the probe |
 * | the probe's transcript is NOT the replacement | "is not handed the replacement alone" | the replacement's own copy of a context row is measured instead of the host's |
 * | the probe's rows are the request's rows | "measures what the request carries" | the two disagree by the rail |
 * | the emergency probe still carries the deferred fragments | "the emergency probe composes" | the tool results that overflowed drop out of the measurement |
 * | the preflight probe still carries the deferred tool results | "the preflight probe composes" | the payload the preflight exists to catch stops being measured |
 *
 * Every arm is written so that removing the fix breaks it, and the rows come
 * from ONE fixture: the same host projection, the same replacement, the same
 * ids. The replacement is built through `toRuntimeMessage`, the way the host's
 * compaction source builds it, so the `origin` marker on its rows is the
 * ADAPTER's and not the fixture's.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@duya/agent-protocol/transcript';

import { RunEngineImpl } from '../src/engine/run-engine.js';
import { toRuntimeMessage } from '../src/adapters/run-engine-ports.js';
import type {
  AssembledTurn,
  CompactionDecision,
  CompactionDecisionInput,
  CompactionPort,
  CompactionProgress,
  ExtensionPort,
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

// ============================================================================
// The fixture
// ============================================================================

/** The run's prompt. */
const PROMPT: ModelMessage = { role: 'user', id: 'p1', content: 'what does the ui package look like?' };
/** A row the person said earlier. */
const PRIOR: ModelMessage = { role: 'user', id: 'u-1', content: 'hello' };
/**
 * A runtime-context row that IS in the timeline.
 *
 * The compaction replacement re-projects the timeline, so it carries a copy of
 * this row -- and the host's projection carries it too. It is the row that can
 * be measured twice, or measured from the wrong side.
 */
const TIMELINE_CONTEXT: ModelMessage = {
  role: 'user',
  id: 't-1',
  content: '<system-reminder>the attached file</system-reminder>',
  origin: 'context',
};
/**
 * The volatile-context rail: per-request state that never enters the
 * timeline, so the replacement CANNOT carry it.
 *
 * This is the row the probe used to miss.
 */
const RAIL: ModelMessage = {
  role: 'user',
  id: 'rail-1',
  content: '<system-reminder>the environment</system-reminder>',
  origin: 'context',
};

/**
 * What a real host's compaction replacement is: the compacted TIMELINE.
 *
 * It carries the timeline's runtime-context row and cannot carry the rail.
 * Built through `toRuntimeMessage`, the way the host's compaction source builds
 * it (`worker-compaction/engine-sources.ts`: `replacement:
 * run.messages.map(toRuntimeMessage)`), and NOT hand-written -- so removing the
 * adapter's `origin` marker changes what the probe measures, which is the
 * point of a fixture built this way.
 */
function replacement(): readonly ModelMessage[] {
  return [
    toRuntimeMessage(transcriptRow('u-1', 'hello')),
    toRuntimeMessage(
      transcriptRow('t-1', '<system-reminder>the attached file</system-reminder>', {
        runtimeContext: true,
      }),
    ),
    toRuntimeMessage(transcriptRow('p1', 'what does the ui package look like?')),
  ];
}

/** One transcript row, in the shape the timeline stores. */
function transcriptRow(id: string, content: string, metadata?: Record<string, unknown>): Message {
  return {
    id,
    role: 'user',
    content,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** The host's projection: the conversation, then the rows the system attached. */
function hostProjection(): readonly ModelMessage[] {
  return [PRIOR, TIMELINE_CONTEXT, RAIL, PROMPT];
}

/** A tool call, so the run reaches a SECOND turn. */
const CALL_FRAME: ModelFrame = {
  type: 'tool_use',
  call: { callId: 'call-1', name: 'read', input: {}, sideEffect: 'read_only' },
};

/** What the dispatched call hands back, so the drain has something to produce. */
const TOOL_RESULT = 'the file was written';

/** The key of the fragment a `before_model` hook defers. */
const HOOK_KEY = 'hook:block';

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

function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: PROMPT,
    // `by_ref`, so the request's history is the HOST's projection -- which is
    // what a real host hands the engine, and what makes "the probe measures
    // the request's rows" a statement about the same rows on both sides.
    history: { kind: 'by_ref', digest: 'd1', locator: 'agent://transcript' },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

// ============================================================================
// The harness
// ============================================================================

interface ScriptedTurn {
  readonly frames: readonly ModelFrame[];
}

interface Harness {
  readonly ports: RunEnginePorts;
  /** Every decision input the port was asked about, in order. */
  readonly decisions: CompactionDecisionInput[];
  /** Every request the model was sent, in order. */
  readonly sent: ModelMessage[][];
}

function harness(options: {
  readonly turns: readonly ScriptedTurn[];
  /** The verdict for each decision. */
  readonly decide: (input: CompactionDecisionInput) => CompactionDecision;
  /** The transcript the replacement produces. Omit to make `run` return failed. */
  readonly replacement?: readonly ModelMessage[];
  /** Script a `before_model` hook that defers a fragment onto the deferred rail. */
  readonly hookFragment?: boolean;
  /** Make the dispatched call produce no result, so the drain stays empty. */
  readonly noToolResult?: boolean;
}): Harness {
  const decisions: CompactionDecisionInput[] = [];
  const sent: ModelMessage[][] = [];
  const queued: ToolDrainItem[] = [];
  let turnIndex = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      sent.push([...request.messages]);
      const scripted = options.turns[turnIndex];
      turnIndex += 1;
      if (scripted === undefined) {
        yield { type: 'turn_stopped', reason: 'end_turn' };
        return;
      }
      for (const frame of scripted.frames) yield frame;
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const compaction: CompactionPort = {
    async decide(input: CompactionDecisionInput): Promise<CompactionDecision> {
      decisions.push(input);
      return options.decide(input);
    },
    async run(_input: CompactionDecisionInput, _reporter: (p: CompactionProgress) => void) {
      if (options.replacement === undefined) {
        return { kind: 'failed', error: { code: 'summarizer_unavailable', message: 'no summary' } };
      }
      return {
        kind: 'replaced',
        replacement: options.replacement,
        boundaryId: 'boundary-1',
        compactedMessageIds: ['u-1'],
      };
    },
    nextCompactionId(): string {
      return 'cmp-1';
    },
    noteUsage(): void {},
  };

  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
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
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const outcome of queued.splice(0, queued.length)) yield outcome;
      },
      discard(_reason: string): void {},
      describe: (): readonly ToolDescriptor[] => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'you are a test',
          messages: hostProjection(),
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
      publish(_event: unknown): void {},
      proposeTerminal(): void {},
    } as unknown as RunEventStorePort,
    compaction,
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    modeExit: { onRunExit: () => Promise.resolve() },
    ...(options.hookFragment === true ? { extensions: hookPort() } : {}),
  };

  return { ports, decisions, sent };
}

/**
 * A `before_model` hook that defers a fragment.
 *
 * The fragment lands on the run's deferred rail AFTER the request that turn
 * was built (`#modelRequest` consumes the list, and the hook's contribution is
 * adopted after that), so it is in `ctx.deferred.current` when the emergency
 * probe fires -- which is how a tool result that has not been read yet can be
 * part of what overflowed.
 */
function hookPort(): ExtensionPort {
  return {
    list(phase) {
      if (phase !== 'before_model') return [];
      return [
        {
          id: 'hook-1',
          phase: 'before_model',
          order: 0,
          timeoutMs: 1_000,
          async contribute() {
            return [
              {
                key: HOOK_KEY,
                content: { kind: 'hook_context', key: HOOK_KEY, text: 'the hook block' },
                binding: false,
              },
            ];
          },
        },
      ];
    },
    async unload(): Promise<void> {},
  };
}

async function run(h: Harness): Promise<void> {
  const engine = new RunEngineImpl({ now: () => 1_000 });
  await engine
    .execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: new AbortController().signal,
      ports: h.ports,
    })
    .completed();
}

/** The ids of a row list, sorted, so two lists can be compared as SETS. */
function ids(messages: readonly ModelMessage[]): readonly string[] {
  return messages.map((message) => message.id).sort();
}

/** How many times a row id appears in a list. */
function occurrences(messages: readonly ModelMessage[], id: string): number {
  return messages.filter((message) => message.id === id).length;
}

/** The decision the port was asked about at one trigger. */
function decisionFor(h: Harness, trigger: CompactionDecisionInput['trigger']): CompactionDecisionInput {
  const found = h.decisions.find((d) => d.trigger === trigger);
  if (found === undefined) throw new Error(`the port was never asked at the ${trigger} site`);
  return found;
}

// ============================================================================
// The probe measures the request's rows
// ============================================================================

describe('the compaction probe measures the rows the request carries', () => {
  it('measures the host\'s context rows after a compaction', async () => {
    // THE FIX (audit finding H-6).
    //
    // The proactive site compacts on turn 1, so the replacement is in place by
    // the time the preflight site asks. The preflight probe must measure the
    // PARTITION -- the replacement's conversation plus the host's CURRENT
    // context -- and not the replacement alone.
    //
    // The expected list is spelled out row by row, so a failure says WHICH row
    // went missing rather than "the arrays differ":
    //
    //  - 'u-1' and 'p1' come from the REPLACEMENT (its conversation rows).
    //  - 't-1' and 'rail-1' come from the HOST's projection (its context
    //    rows): the timeline's own runtime-context row and the rail.
    //  - 'fragment:tool_result:call-1' is the drained tool result, composed
    //    onto the base by the preflight site.
    let compacted = false;
    const h = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) => {
        if (input.trigger !== 'auto') return { kind: 'skip', reason: 'not the proactive site' };
        if (compacted) return { kind: 'skip', reason: 'already compacted once' };
        compacted = true;
        return { kind: 'compact', trigger: 'auto' };
      },
      replacement: replacement(),
    });

    await run(h);

    const preflight = decisionFor(h, 'preflight_overflow');
    expect(preflight.transcript.map((message) => message.id)).toEqual([
      'u-1',
      'p1',
      't-1',
      'rail-1',
      'fragment:tool_result:call-1',
    ]);
  });

  it('is not handed the replacement alone', async () => {
    // THE COUNTER-EXAMPLE for "the replacement is the transcript".
    //
    // Measured against the replacement, the probe sees 'u-1', 'p1' and the
    // replacement's OWN copy of 't-1' -- and no rail at all, because the rail
    // never enters the timeline and the replacement cannot carry it. That is
    // the under-count: the probe would measure a transcript smaller than the
    // request by the rail's size, and the trigger would fire later than it
    // should.
    //
    // So the rail must be IN the probe's transcript, and the timeline's
    // context row must appear ONCE -- the host's copy, not the replacement's.
    let compacted = false;
    const h = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) => {
        if (input.trigger !== 'auto') return { kind: 'skip', reason: 'not the proactive site' };
        if (compacted) return { kind: 'skip', reason: 'already compacted once' };
        compacted = true;
        return { kind: 'compact', trigger: 'auto' };
      },
      replacement: replacement(),
    });

    await run(h);

    const preflight = decisionFor(h, 'preflight_overflow');
    // The rail is the row the replacement CANNOT carry, so it is the row that
    // proves the probe is not measuring the replacement.
    expect(preflight.transcript.map((message) => message.id)).toContain('rail-1');
    // And the timeline's context row is measured ONCE: the partition excludes
    // the replacement's copy of it, so it cannot be counted twice.
    expect(occurrences(preflight.transcript, 't-1')).toBe(1);
    expect(occurrences(preflight.transcript, 'rail-1')).toBe(1);
  });

  it('measures what the request carries, and the two agree row for row', async () => {
    // The property the finding is about: a compaction decision taken against
    // a transcript SMALLER than the request is a decision taken against the
    // wrong number.
    //
    // So the probe's rows and the NEXT request's rows are compared as SETS:
    // the probe measured the partition, and the request was built from the
    // partition plus the drained tool result -- the same rows, in the
    // request contract's own order.
    let compacted = false;
    const h = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) => {
        if (input.trigger !== 'auto') return { kind: 'skip', reason: 'not the proactive site' };
        if (compacted) return { kind: 'skip', reason: 'already compacted once' };
        compacted = true;
        return { kind: 'compact', trigger: 'auto' };
      },
      replacement: replacement(),
    });

    await run(h);

    const preflight = decisionFor(h, 'preflight_overflow');
    // Two requests: the one the probe ran beside, and the next turn's.
    expect(h.sent).toHaveLength(2);
    // The comparison is over SETS, because the request contract REORDERS the
    // host's rows (the context rows move in front of the prompt on the first
    // turn) -- the rows are the same and the order is the contract's business.
    expect(ids(preflight.transcript)).toEqual(ids(h.sent[1]!));
  });

  it('still measures the assembled transcript before any compaction', async () => {
    // The control for the control.
    //
    // Before a compaction there is no replacement, so there is no partition to
    // apply: the probe measures the host's assembled messages, which is the
    // last point the engine holds a real transcript. This arm exists so the
    // arms above cannot pass by a probe that measures the assembled messages
    // ALWAYS -- which would be a different defect, not this one's fix.
    const h = harness({
      turns: [{ frames: [{ type: 'text', text: 'hi' }] }],
      decide: () => ({ kind: 'skip', reason: 'under the trigger line' }),
      replacement: replacement(),
    });

    await run(h);

    const proactive = decisionFor(h, 'auto');
    expect(proactive.transcript.map((message) => message.id)).toEqual([
      'u-1',
      't-1',
      'rail-1',
      'p1',
    ]);
  });
});

// ============================================================================
// The deferred fragments are still part of what the probe measures
// ============================================================================

describe('the probe still composes the deferred fragments', () => {
  it('the emergency probe carries the deferred fragments onto the partition', async () => {
    // The emergency path fires AFTER a stream has already failed, and the
    // results that overflowed are in `ctx.deferred.current` -- so a probe
    // that could not see them would decline against a transcript the provider
    // had already rejected.
    //
    // The base here is the PARTITION (the proactive site compacted first), so
    // this arm pins both halves at once: the context rows survive the
    // compaction AND the deferred fragment is still composed onto them.
    let compacted = false;
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
        { frames: [{ type: 'text', text: 'recovered' }] },
      ],
      decide: (input) => {
        if (input.trigger === 'emergency') return { kind: 'compact', trigger: 'emergency' };
        if (compacted) return { kind: 'skip', reason: 'already compacted once' };
        compacted = true;
        return { kind: 'compact', trigger: 'auto' };
      },
      replacement: replacement(),
      hookFragment: true,
    });

    await run(h);

    const emergency = decisionFor(h, 'emergency');
    expect(emergency.transcript.map((message) => message.id)).toEqual([
      // The partition: the replacement's conversation, then the host's context.
      'u-1',
      'p1',
      't-1',
      'rail-1',
      // And the deferred fragment, composed onto it.
      `fragment:${HOOK_KEY}`,
    ]);
  });

  it('the preflight probe carries the deferred tool results onto the partition', async () => {
    // The preflight exists to catch the payload that just overflowed, so the
    // drained tool result has to be in what it measures. The base is the
    // partition, because the proactive site compacted earlier in the turn.
    let compacted = false;
    const h = harness({
      turns: [
        { frames: [{ type: 'text', text: 'working' }, CALL_FRAME] },
        { frames: [{ type: 'text', text: 'done' }] },
      ],
      decide: (input) => {
        if (input.trigger !== 'auto') return { kind: 'skip', reason: 'not the proactive site' };
        if (compacted) return { kind: 'skip', reason: 'already compacted once' };
        compacted = true;
        return { kind: 'compact', trigger: 'auto' };
      },
      replacement: replacement(),
    });

    await run(h);

    const preflight = decisionFor(h, 'preflight_overflow');
    // The tool result is IN the measurement...
    expect(preflight.transcript.map((message) => message.id)).toContain(
      'fragment:tool_result:call-1',
    );
    // ...AND the context rows are still there beside it, so the two did not
    // trade places.
    expect(preflight.transcript.map((message) => message.id)).toContain('rail-1');
  });
});
