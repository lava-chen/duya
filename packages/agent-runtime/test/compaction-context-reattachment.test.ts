/**
 * COUNTER-EXAMPLES for the compaction / volatile-context split.
 *
 * ## What this file is
 *
 * The inverted probe (`request-assembly-context-survives-compaction.test.ts`)
 * proves that the rail is BACK after a compaction. That assertion alone would
 * also pass against an implementation that simply carries the rail TWICE, so
 * this file pins the OTHER half of the contract: the context rows ride the
 * request EXACTLY ONCE, and they are the HOST'S rows rather than the
 * replacement's.
 *
 * Every arm here is written so that removing the fix breaks it:
 *
 * | what is removed | which arm fails |
 * | --- | --- |
 * | the context re-attachment (`#requestHistory`) | "the rail rides every request" and "the rail rides exactly once" |
 * | the `origin` marker on the replacement (`toRuntimeMessage`) | "a timeline context row is not counted twice" |
 * | both | every arm |
 *
 * ## The fixture, and why it is shaped this way
 *
 * The host's projection carries TWO kinds of context row:
 *
 *  - `TIMELINE_CONTEXT` -- a runtime-context row that is IN the timeline (an
 *    attachment's extracted text, a durable reminder). The compaction's
 *    replacement re-projects the timeline, so the replacement carries a copy
 *    of it. This is the row that CAN be duplicated.
 *  - `RAIL` -- the volatile-context rail. It never enters the timeline, so the
 *    replacement cannot carry it at all. This is the row that can be LOST.
 *
 * A real host's projection is a superset of the timeline's runtime-context
 * rows -- the timeline is not rewritten by a compaction, and the projection
 * walks all of it -- so the two copies of `TIMELINE_CONTEXT` below are the same
 * row seen twice, which is what makes "exactly once" a real question rather
 * than a hypothetical.
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
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEvent,
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
 * be counted twice.
 */
const TIMELINE_CONTEXT: ModelMessage = {
  role: 'user',
  id: 't-1',
  content: '<system-reminder>the attached file</system-reminder>',
  origin: 'context',
};
/**
 * The volatile-context rail: per-request state that never enters the
 * timeline, so the replacement cannot carry it.
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
 *
 * Built through `toRuntimeMessage`, the way the host's compaction source
 * builds it (`worker-compaction/engine-sources.ts`: `replacement:
 * run.messages.map(toRuntimeMessage)`), and NOT hand-written. That is what
 * makes the duplication arm below a real test: the replacement's copy of the
 * timeline's context row is classified by the ADAPTER, so removing the
 * adapter's `origin` marker changes what the request carries. A fixture that
 * wrote the marker in by hand would pass against an implementation that had
 * lost it.
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
    history: { kind: 'by_ref', digest: 'd1', locator: 'agent://transcript' },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

/** A tool call, so the run reaches a SECOND turn. */
const CALL_FRAME: ModelFrame = {
  type: 'tool_use',
  call: { callId: 'call-1', name: 'read', input: {}, sideEffect: 'read_only' },
};

interface Harness {
  /** Every request the model was sent, in order. */
  readonly sent: ModelMessage[][];
  readonly ports: RunEnginePorts;
}

/**
 * The engine, with a host whose projection carries the context rows.
 *
 * `withRail: false` builds the NEGATIVE CONTROL: the same host, the same
 * compaction, but a projection with no context rows at all. If the engine
 * invented the rail, that run would still carry one -- and the "the rail rides
 * the request" assertion would be vacuous.
 */
function harness(options: {
  readonly compact: boolean;
  readonly withRail: boolean;
  readonly twoTurns: boolean;
}): Harness {
  const sent: ModelMessage[][] = [];
  let turnIndex = 0;

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      sent.push([...request.messages]);
      turnIndex += 1;
      if (options.twoTurns && turnIndex === 1) {
        yield CALL_FRAME;
        yield { type: 'turn_stopped', reason: 'end_turn' };
        return;
      }
      yield { type: 'text', text: 'hi' };
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const compaction: CompactionPort = {
    async decide(input: CompactionDecisionInput): Promise<CompactionDecision> {
      // The proactive site compacts; every later site declines, so the run has
      // exactly ONE replacement and the assertions below are unambiguous.
      if (!options.compact) return { kind: 'skip', reason: 'under the trigger line' };
      return input.trigger === 'auto'
        ? { kind: 'compact', trigger: 'auto' }
        : { kind: 'skip', reason: 'not the proactive site' };
    },
    async run(_input: CompactionDecisionInput, _reporter: (p: CompactionProgress) => void) {
      return {
        kind: 'replaced',
        replacement: replacement(),
        boundaryId: 'boundary-1',
        compactedMessageIds: ['u-1'],
      };
    },
    nextCompactionId(): string {
      return 'cmp-1';
    },
    noteUsage(): void {},
  };

  const queued: ToolDrainItem[] = [];

  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    model,
    tools: {
      dispatch(call: ToolCallRequest): void {
        queued.push({
          kind: 'tool_result',
          callId: call.callId,
          content: 'the file was written',
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
        // The HOST's projection: the conversation, then the rows the system
        // attached -- the timeline's own runtime-context row and the rail --
        // then the prompt.
        return {
          systemPrompt: 'you are a test',
          messages: options.withRail
            ? [PRIOR, TIMELINE_CONTEXT, RAIL, PROMPT]
            : [PRIOR, TIMELINE_CONTEXT, PROMPT],
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
      publish(_event: RunEvent): void {},
      proposeTerminal(): void {},
    } as RunEventStorePort,
    compaction,
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    modeExit: { onRunExit: () => Promise.resolve() },
  };

  return { sent, ports };
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

/** The rows the system attached to a request. */
function contextRows(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.filter((message) => message.origin === 'context');
}

/** How many times a row id appears in a request. */
function occurrences(messages: readonly ModelMessage[], id: string): number {
  return messages.filter((message) => message.id === id).length;
}

// ============================================================================
// The counter-examples
// ============================================================================

describe('the volatile context across a compaction', () => {
  it('the rail rides the request, and the request is not built from the replacement alone', async () => {
    // THE COUNTER-EXAMPLE for "the replacement wins".
    //
    // A request built from the replacement ALONE carries the timeline's own
    // context row and NO rail -- the rail is working-array state and never
    // enters the timeline, so the replacement cannot carry it. This arm fails
    // for that implementation, which is the point of it.
    const h = harness({ compact: true, withRail: true, twoTurns: false });
    await run(h);

    expect(h.sent.length).toBeGreaterThan(0);
    expect(contextRows(h.sent[0]!).map((m) => m.id)).toEqual(['t-1', 'rail-1']);
  });

  it('a timeline context row is not counted twice', async () => {
    // THE COUNTER-EXAMPLE for the duplication.
    //
    // The replacement carries a copy of the timeline's runtime-context row
    // (it re-projects the timeline) and the host's projection carries it too.
    // The two halves are DISJOINT -- the replacement contributes the
    // conversation, the host contributes the context -- so the row is in the
    // request exactly ONCE.
    //
    // This arm fails if the `origin` marker is dropped on the replacement's
    // rows (`toRuntimeMessage`): the replacement's copy would then be
    // indistinguishable from a person speaking, would survive the exclusion,
    // and the row would be counted twice.
    const h = harness({ compact: true, withRail: true, twoTurns: false });
    await run(h);

    const request = h.sent[0]!;
    expect(occurrences(request, 't-1')).toBe(1);
    expect(occurrences(request, 'rail-1')).toBe(1);
    expect(contextRows(request)).toHaveLength(2);
  });

  it('the rail rides EVERY request of the run, not only the first', async () => {
    // The defect was not one request: it was "for the rest of the run"
    // (audit finding H-2). A compaction's replacement is PINNED for the whole
    // run (`ctx.compacted.current` is a run-scoped cell), so every later turn
    // built its history from it.
    //
    // Turn 2 is a tool continuation, so the request contract leaves the host's
    // rows in the host's own order (rule 4) -- the rail is present, but it is
    // not moved in front of a prompt, because a later turn carries no prompt.
    // What is asserted here is PRESENCE and COUNT, not position.
    const h = harness({ compact: true, withRail: true, twoTurns: true });
    await run(h);

    expect(h.sent.length).toBe(2);
    for (const request of h.sent) {
      expect(contextRows(request).map((m) => m.id)).toEqual(['t-1', 'rail-1']);
      expect(occurrences(request, 'rail-1')).toBe(1);
      expect(occurrences(request, 't-1')).toBe(1);
    }
  });

  it('a host that attaches no context gets a request with no context', async () => {
    // THE NEGATIVE CONTROL, and the reason the arms above are not vacuous.
    //
    // Same engine, same compaction, same replacement -- only the host's
    // projection differs, and it carries no rail. If the engine manufactured
    // the rail, this request would carry one, and "the rail rides the
    // request" would be measuring the engine rather than the fix.
    const h = harness({ compact: true, withRail: false, twoTurns: false });
    await run(h);

    expect(h.sent.length).toBeGreaterThan(0);
    expect(contextRows(h.sent[0]!).map((m) => m.id)).toEqual(['t-1']);
    expect(occurrences(h.sent[0]!, 'rail-1')).toBe(0);
  });

  it('a compaction that never happens leaves the request alone', async () => {
    // The control for the CONTROL: without a compaction the host's projection
    // is the whole history, so the request is the host's rows, in the host's
    // order, and the rail is at the end -- which is where the host puts it.
    const h = harness({ compact: false, withRail: true, twoTurns: false });
    await run(h);

    expect(contextRows(h.sent[0]!).map((m) => m.id)).toEqual(['t-1', 'rail-1']);
    expect(occurrences(h.sent[0]!, 'rail-1')).toBe(1);
  });
});
