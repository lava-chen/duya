/**
 * The compaction seam, bound.
 *
 * ## Why this file exists separately from `engine-drain-carryover.test.ts`
 *
 * That file's `describe('buildEnginePorts binds the turn-output seam
 * all-or-nothing')` is the template this follows, and the two seams are
 * opposites in the one way that matters. `turnOutput` is OPTIONAL at the source
 * because there is nothing to bind: its six effects live inside
 * `DuyaAgent.streamChat`'s own closure. `compaction` is REQUIRED (A3-2a) because
 * a host CAN supply one today and because omitting it loses the transcript
 * rather than a guardrail -- the asymmetry `ports.ts:2059-2073` spells out. So
 * `compaction` is tested the way a required member is tested: asserted to be
 * present, and asserted to carry the properties a silently-broken binding would
 * not have.
 *
 * ## What is NOT tested here, and why that is deliberate
 *
 * Nothing here drives `RunEngineImpl`. The frame ORDER the engine produces is
 * already pinned in `packages/agent-runtime/test/run-engine-compaction.test.ts`
 * against the real engine, and duplicating that here would only test a second
 * harness. What is untested anywhere else is the ADAPTER: that
 * `buildEnginePorts` binds the port at all, that it forwards the engine's
 * reporter live rather than buffering, and that it widens the legacy's
 * throw-or-resolve into the port's four arms. The reporter test below drives
 * the REAL `runCompactionPass` from the runtime package, so the ordering it
 * asserts is produced by the same code that produces it in production, with
 * only the port under test being ours.
 *
 * The mutation this file is built to catch: a source that collects progress and
 * reports it after `resolve` puts `compaction.step` AFTER
 * `compaction.completed`. `run-engine-compaction.test.ts` cannot catch it --
 * that harness supplies its own port and so never runs this adapter.
 */

import { describe, expect, it } from 'vitest';
import { runCompactionPass, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import type {
  CompactionDecisionInput,
  CompactionProgress,
  CompactionUsageAnchor,
  RunEnginePorts,
  RunEvent,
} from '@duya/agent-runtime';
import type { RunEventEnvelope, RunId } from '@duya/agent-protocol';
import { buildEnginePorts } from '../run-engine-ports.js';
import type { CompactionSources } from '../run-engine-ports.js';

const RUN_ID = 'run-a3-2a-compaction' as RunId;

/** A replacement that cannot be confused with the transcript it replaces. */
const REPLACEMENT_TEXT = 'COMPACTED-SUMMARY-4b2e91';

/** The transcript the engine believes it is holding, before any compaction. */
const TRANSCRIPT: CompactionDecisionInput = {
  turn: 3,
  transcript: [{ role: 'user', content: 'hello', id: 'm1' }],
  trigger: 'auto',
};

// ============================================================================
// The harness
// ============================================================================

/**
 * Ports from the REAL `buildEnginePorts`, with the host's compaction source.
 *
 * `emitted` collects what reaches the EMITTER through a real `RunEventEmitter`
 * over a real `RunSession`, not a recorder shaped like one. The tests below
 * assert that a `compaction.step` published by our source lands BETWEEN the two
 * frames the runtime minted, and that ordering only exists if the publish path
 * is the emitter's.
 */
function portsWithCompaction(
  compaction: CompactionSources,
  emitted?: RunEvent[],
): RunEnginePorts {
  return buildEnginePorts({
    openModelStream: () => (async function* () {})(),
    queueTool: () => {},
    drainTools: () => (async function* () {})(),
    discardTools: () => {},
    lookup: { sideEffectOf: () => null, toolNames: () => [], describe: () => null },
    assembleTurn: () =>
      Promise.resolve({
        systemPrompt: 'p',
        messages: [],
        tools: [],
        catalogRevision: 'c',
        revision: 'r',
      }),
    askApproval: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
    emitter: realEmitter(emitted),
    proposeTerminal: () => {},
    interTurn: {
      claim: () => Promise.resolve({ action: 'continue', absorbed: false }),
      seqIndex: 0,
      wakeRun: false,
    },
    compaction,
  });
}

function realEmitter(emitted?: RunEvent[]): RunEventEmitter {
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-compaction',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1,
  });
  return new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: {
      push: (envelope: RunEventEnvelope) => {
        if (emitted !== undefined) emitted.push(envelope.payload);
      },
    },
  });
}

/**
 * One pass through the REAL `runCompactionPass`, over the port we bound.
 *
 * The runtime's own function, not a re-implementation: the ordering this file
 * pins is the ordering that function produces, and a local copy of it would
 * assert whatever the copy happened to do.
 */
function pass(ports: RunEnginePorts, signal: AbortSignal) {
  return runCompactionPass({
    port: ports.compaction,
    events: ports.events,
    decision: TRANSCRIPT,
    signal,
  });
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

const COMPACT = { kind: 'compact', trigger: 'auto' } as const;

/** A source that compacts, replacing the transcript with a distinguishable one. */
function compactingSource(overrides: Partial<CompactionSources> = {}): CompactionSources {
  return {
    decide: () => Promise.resolve(COMPACT),
    compact: () =>
      Promise.resolve({
        kind: 'replaced',
        replacement: [{ role: 'user', content: REPLACEMENT_TEXT, id: 'boundary-1' }],
        boundaryId: 'boundary-1',
        compactedMessageIds: ['m1'],
      }),
    nextCompactionId: () => 'cmp-1',
    ...overrides,
  };
}

// ============================================================================
// 1. The binding exists
// ============================================================================

describe('buildEnginePorts binds the compaction seam', () => {
  it('produces a compaction port, and does not leave the member absent', () => {
    // The pin for the A3-2a binding, and the property the whole slice exists
    // for. `undefined` here would be a port whose absence is indistinguishable
    // from a decision not to compact: the run would grow until the provider
    // rejected it, with the five `compaction.*` frames unreachable
    // (`ports.ts:2059-2073`).
    expect(portsWithCompaction(compactingSource()).compaction).toBeDefined();
  });

  it('reports a decline from the source, and never claims a replacement', async () => {
    // The inverse, and it is the answer a host with nothing to compact gives.
    // Checked so the port cannot be satisfied by a source that always compacts:
    // a binding that ignored `skip` would replace a transcript on every
    // decision point, three times a turn.
    const ports = portsWithCompaction({
      ...compactingSource(),
      decide: () => Promise.resolve({ kind: 'skip', reason: 'under the line' }),
    });

    const result = await pass(ports, neverAborted());

    expect(result.kind).toBe('declined');
    expect(result).toMatchObject({ reason: 'under the line' });
  });
});

// ============================================================================
// 2. The reporter is LIVE
// ============================================================================

describe('buildEnginePorts forwards compaction progress DURING the run', () => {
  it('publishes compaction.step BETWEEN started and completed', async () => {
    // THE assertion of this file.
    //
    // The engine binds its reporter straight to `events.publish`
    // (`compaction.ts:150-152`), so a source that buffered its progress and
    // reported it after `resolve` would put the step after the terminal frame --
    // a `compaction.completed` describing a finished compaction, followed by
    // progress arriving as though it were new. The legacy streams `compact:*`
    // during precisely because the summarizer takes minutes
    // (`DuyaAgent.ts:2144-2151`).
    //
    // `run-engine-compaction.test.ts` pins this order for the ENGINE, against a
    // port that harness supplies itself. This pins it for the ADAPTER, which is
    // the only part that could reintroduce a buffer, and it is the test that
    // goes red when it does.
    const emitted: RunEvent[] = [];
    const ports = portsWithCompaction(
      compactingSource({
        compact: async (_input, reporter) => {
          // Reported mid-run, the way a real summarizer's pump reports.
          reporter({ kind: 'step', step: 1, phase: 'summarizing', messageCount: 1 });
          return {
            kind: 'replaced',
            replacement: [{ role: 'user', content: REPLACEMENT_TEXT, id: 'boundary-1' }],
            boundaryId: 'boundary-1',
            compactedMessageIds: ['m1'],
          };
        },
      }),
      emitted,
    );

    await pass(ports, neverAborted());

    // Read off the frames themselves, not off a return value, so this is the
    // order a CONSUMER sees.
    expect(emitted.filter((e) => e.type.startsWith('compaction.')).map((e) => e.type)).toEqual([
      'compaction.started',
      'compaction.step',
      'compaction.completed',
    ]);
  });

  it('reaches the reporter DURING the source run, not only by the time it returns', async () => {
    // The same property from a DIFFERENT source: the SOURCE'S OWN record of
    // when it had reported, rather than the event store's order. The two sides
    // come from different places, so neither can be satisfied by the other
    // being wrong.
    //
    // The probe is a post-hoc read of the event stream taken from INSIDE the
    // source, before the source's own promise resolved. A buffered reporter
    // leaves it empty; a live one has already published. The event-order test
    // above cannot make this distinction on its own -- both a live and a
    // buffered reporter that flush before `runCompactionPass` returns would
    // produce the same three frames in the same order.
    const emitted: RunEvent[] = [];
    let compactionFramesSeenMidRun = 0;
    const ports = portsWithCompaction(
      compactingSource({
        compact: async (_input, reporter) => {
          reporter({ kind: 'step', step: 1, phase: 'summarizing' });
          // Read the effect of that call immediately, with the source's own
          // promise still pending. `publish` is synchronous, so a live reporter
          // has already reached the emitter by this line.
          compactionFramesSeenMidRun = emitted.filter((e) => e.type.startsWith('compaction.')).length;
          return {
            kind: 'replaced',
            replacement: [{ role: 'user', content: REPLACEMENT_TEXT, id: 'boundary-1' }],
            boundaryId: 'boundary-1',
            compactedMessageIds: ['m1'],
          };
        },
      }),
      emitted,
    );

    await pass(ports, neverAborted());

    // `started` and `step` are both already out; `completed` cannot be, the
    // source has not returned. Two is the live answer and one is the buffered
    // one, so this distinguishes them where the frame-order test cannot.
    expect(compactionFramesSeenMidRun).toBe(2);
  });
});

// ============================================================================
// 3. Two arms into four
// ============================================================================

describe('buildEnginePorts turns a THROWN compaction into a reported failure', () => {
  it('reports a throw as compaction.failed, with the provider words', async () => {
    // The legacy's `compact` either resolves or THROWS
    // (`CompactionManager.ts:744-748` throws on an empty conversation, and a
    // summarizer failure propagates). `runCompactionPass` has no `try` around
    // `port.run` (`compaction.ts:154`), so an uncaught throw would escape with
    // a `compaction.started` already published and NO terminal -- a consumer
    // holding a compaction that never finished. The adapter is the only place
    // that can catch it.
    const emitted: RunEvent[] = [];
    const ports = portsWithCompaction(
      compactingSource({
        compact: () => Promise.reject(new Error('conversation is empty')),
      }),
      emitted,
    );

    const result = await pass(ports, neverAborted());

    expect(result.kind).toBe('failed');
    // The provider's own words, not a generic one: the message is what a user
    // is shown, and an adapter that invented its own would be reporting a
    // failure that did not happen.
    expect(result.kind === 'failed' && result.message).toBe('conversation is empty');
    // And the terminal frame was published, so the sequence is closed.
    expect(emitted.filter((e) => e.type.startsWith('compaction.')).map((e) => e.type)).toEqual([
      'compaction.started',
      'compaction.failed',
    ]);
  });

  it('reports an ABORTED throw as cancelled, not as a broken provider', async () => {
    // An interrupt and an outage call for opposite handling
    // (`ports.ts:1711-1715`), and folding them together tells a user who
    // pressed stop that their provider is broken. The caller's signal is the
    // authority -- the same rule `OneShotTextPort.complete` applies
    // (`ports.ts:1746-1752`): a summarizer that ignored the abort and threw
    // anyway is still a cancellation.
    const controller = new AbortController();
    const ports = portsWithCompaction(
      compactingSource({
        compact: () => {
          // The provider blew up on the way out of an abort.
          controller.abort();
          return Promise.reject(new Error('aborted by provider'));
        },
      }),
    );

    const result = await pass(ports, controller.signal);

    expect(result.kind).toBe('cancelled');
  });

  it('reports a decline from `compact` as declined, never as a replacement', async () => {
    // The legacy's strategy can decline by returning its input unchanged
    // (`types.ts:66-71`). A binding that treated a decline as success would
    // publish `compaction.completed` and hand the engine the SAME transcript,
    // which is the "announced success for work that did not happen" shape the
    // runtime's header is written against.
    const emitted: RunEvent[] = [];
    const ports = portsWithCompaction(
      compactingSource({
        compact: () => Promise.resolve({ kind: 'declined', reason: 'nothing to summarise' }),
      }),
      emitted,
    );

    const result = await pass(ports, neverAborted());

    expect(result).toEqual({ kind: 'declined', reason: 'nothing to summarise' });
    // A declined run publishes `started` and nothing else -- no terminal claims
    // a boundary that was never cut.
    expect(emitted.filter((e) => e.type.startsWith('compaction.')).map((e) => e.type)).toEqual([
      'compaction.started',
    ]);
  });
});

// ============================================================================
// 4. The replacement is the load-bearing value
// ============================================================================

describe('buildEnginePorts carries the replacement transcript out', () => {
  it('hands back the source replacement, and the id the host minted', async () => {
    // `replacement` is the one value a caller needs in order to build the next
    // request from the compacted history (`compaction.ts:166-175`). The
    // assertion reads the replacement off the RESULT and the id off the
    // FRAMES: two different sources, so a binding that returned the original
    // transcript or invented its own id fails rather than agreeing with itself.
    const emitted: RunEvent[] = [];
    const ports = portsWithCompaction(compactingSource(), emitted);

    const result = await pass(ports, neverAborted());

    expect(result.kind).toBe('replaced');
    expect(result.kind === 'replaced' && result.transcript).toEqual([
      { role: 'user', content: REPLACEMENT_TEXT, id: 'boundary-1' },
    ]);
    // The frame carries the HOST's id, and it is the same one on both frames.
    const frames = emitted.filter((e) => e.type.startsWith('compaction.')) as Array<{
      compactionId: string;
    }>;
    expect(frames.map((f) => f.compactionId)).toEqual(['cmp-1', 'cmp-1']);
  });
});

// ============================================================================
// 5. The optional member stays honestly absent
// ============================================================================

describe('buildEnginePorts binds noteUsage all-or-nothing', () => {
  it('omits the method entirely when the source has none', () => {
    // Absent is a DEGRADED but working port (`ports.ts:2118-2132`): the trigger
    // is estimated rather than anchored. What matters is that it is
    // CHECKABLE. A port that always carried the method -- bound to a no-op --
    // would be indistinguishable from one whose host really anchors usage, and
    // the engine could not tell a degraded trigger from an anchored one.
    const ports = portsWithCompaction(compactingSource());
    expect(ports.compaction?.noteUsage).toBeUndefined();
  });

  it('forwards the anchor the engine built, by identity', () => {
    // The inverse, so the test cannot pass by the member simply never being
    // bound. `epoch` is load-bearing: filing a pre-compaction request's tokens
    // into the post-compaction generation anchors the new epoch to a size it
    // never had (`ports.ts:1979-1994`).
    const seen: CompactionUsageAnchor[] = [];
    const ports = portsWithCompaction(
      compactingSource({ noteUsage: (anchor) => seen.push(anchor) }),
    );

    const anchor: CompactionUsageAnchor = { turn: 2, inputTokens: 1_200, outputTokens: 80, epoch: 3 };
    ports.compaction?.noteUsage?.(anchor);

    expect(seen).toEqual([anchor]);
  });
});
