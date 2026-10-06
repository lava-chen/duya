/**
 * The compaction SOURCE over the two RECOVERY paths: emergency and
 * preflight-overflow.
 *
 * ## Why this file exists
 *
 * A3-2b5 wrapped the pre-turn coordinator and declined the other two triggers
 * BY NAME, with a comment saying the cutover would be unsafe until they were
 * served. That comment was right: `emergency` is the recovery path for a
 * provider that answered `context_length_exceeded`, so a source that declines
 * it reads at the cutover as "the transcript is fine" for a run the provider
 * had already rejected.
 *
 * This file drives both through the REAL `runCompactionPass`, the REAL
 * `buildCompactionPort` and a REAL `CompactionCoordinator` over a REAL
 * `MessageCompactionController` and `MessageTimeline`, so the frames, the
 * boundary and the transcript under test all come from the same code the
 * production source runs.
 *
 * ## What is real and what is fake, and why
 *
 * Real: the coordinator's three gates, the controller, the timeline, the
 * adapter, the port, `runCompactionPass`, and a real emitter over a real
 * session.
 *
 * Fake: the `CompactionManager`. The summarizer is a model call that takes
 * minutes, and a test needs to control WHEN progress is reported and WHEN the
 * run settles -- that is the property under test. Everything the manager
 * contributes to a DECISION is faked too, and that is stated rather than
 * hidden: this file proves the SOURCE carries the gates faithfully, and the
 * gates' own arithmetic is `CompactionCoordinator.ts`'s to test.
 *
 * ## The four mutations this file is built to catch
 *
 * 1. **Buffering the progress.** A source that collects events and reports
 *    them after `resolve` puts `compaction.step` AFTER `compaction.completed`.
 *    The summarizer takes MINUTES, so that ordering means the renderer sees a
 *    terminal frame and then its progress as if it were new. Attacked from two
 *    sides -- frame ORDER cannot distinguish a live reporter from one that
 *    flushes before `runCompactionPass` returns, and the MID-RUN probe is what
 *    distinguishes them.
 * 2. **Dropping the trigger.** A `decide` that answered `compact` for
 *    `emergency` regardless of the provider's words, or that ran the PROACTIVE
 *    gate for it, would fire an emergency compaction on a rate-limit message.
 * 3. **Firing when it should decline.** The dual-evidence rule is fail-closed
 *    on its weak arm: weak wording with no local corroboration must NOT
 *    compact. Dropping that arm is a mutation the "explicit" and "weak+probe"
 *    tests both pass, so the decline cases are asserted separately.
 * 4. **Declining when it should fire.** The preflight gate compares against
 *    the HARD limit, not the trigger line. Using the trigger line would decline
 *    in exactly the window the path exists to catch, and both lines can be
 *    true at once -- which is what makes the pair distinguishable.
 */

import { describe, expect, it } from 'vitest';
import { RunEventEmitter, RunSession, runCompactionPass } from '@duya/agent-runtime';
import type {
  CompactionDecisionInput,
  RunEnginePorts,
} from '@duya/agent-runtime';
// `RunEvent` is the PROTOCOL's member, not the runtime's re-export, so it is
// imported from where it is defined rather than from the package that consumes
// it. The sibling coordinator test imports it from `@duya/agent-runtime` and
// gets TS2305 under a test-inclusive compile; `tsconfig.json` excludes tests, so
// that error is invisible to `typecheck:all`. Reported rather than copied.
import type { RunEvent, RunEventEnvelope, RunId } from '@duya/agent-protocol';
import type { CompactionManager, CompactionManagerEvent } from '../../compact/CompactionManager.js';
import { CompactionCoordinator } from '../../agent/CompactionCoordinator.js';
import type { Message } from '../../types.js';
import { MessageTimeline } from '../../message/message-framework.js';
import type { AgentMessage, MessageEntry } from '../../message/message-framework.js';
import { MessageCompactionController } from '../../message/message-compaction-controller.js';
import { buildCoordinatorCompactionSources } from '../run-engine-compaction.js';
import { buildEnginePorts } from '../run-engine-ports.js';
import type { CompactionSources } from '../run-engine-ports.js';

const RUN_ID = 'run-a3-2b6-recovery' as RunId;
const CREATED_AT = 1_700_000_000_000;
const TURN = 7;

/** Facts that cannot be confused with the transcript they become. */
const PROMPT_TEXT = 'PROMPT-a3-2b6';
const SUMMARY_TEXT = 'COMPACTED-SUMMARY-a3-2b6';
const SYSTEM_PROMPT = 'SYSTEM-a3-2b6';
const FIRST_KEPT_ID = 'u3';
const COMPACTION_ID = 'cmp-recovery-1';
const ENTRY_ID = 'entry-recovery-1';

/** A real provider message, in each of the three classification buckets. */
const EXPLICIT_ERROR =
  "anthropic: prompt is too long: 250000 tokens > 200000 maximum";
const WEAK_ERROR = '429 quota exceeded: your request exceeds limit for this org';
const NOT_CONTEXT_ERROR = 'upstream connect error or disconnect/reset before headers';

// ============================================================================
// Fixtures
// ============================================================================

function agent(role: 'user' | 'assistant', id: string, content: string): AgentMessage {
  return { role, id, timestamp: CREATED_AT, visibility: 'visible', content };
}

function entry(id: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id, parentId: null, createdAt: CREATED_AT, message };
}

/** Six real timeline rows, so the boundary walk has something to cut. */
function seedTimeline(): MessageTimeline {
  const timeline = new MessageTimeline();
  timeline.appendMessage(entry('e-u1', agent('user', 'u1', 'one')));
  timeline.appendMessage(entry('e-a1', agent('assistant', 'a1', 'first reply')));
  timeline.appendMessage(entry('e-u2', agent('user', 'u2', 'two')));
  timeline.appendMessage(entry('e-a2', agent('assistant', 'a2', 'second reply')));
  timeline.appendMessage(entry('e-u3', agent('user', FIRST_KEPT_ID, 'three')));
  timeline.appendMessage(entry('e-a3', agent('assistant', 'a3', 'third reply')));
  return timeline;
}

// ============================================================================
// The harness
// ============================================================================

interface HarnessOptions {
  /**
   * The probe's verdict about the TRIGGER line (max minus reserve).
   *
   * A SEPARATE knob from the hard limit on purpose: the emergency gate reads
   * this one and the preflight gate reads the other, and the mutation "used
   * the trigger line for preflight" is only observable if the two can differ.
   */
  readonly overTriggerLine?: boolean;
  /** The probe's verdict about the HARD limit (the full window). */
  readonly overHardLimit?: boolean;
  /** The image-volume trigger, which forces on the preflight path. */
  readonly imageTriggered?: boolean;
  /** `probeCompaction` throws, as a projection failure does. */
  readonly probeThrows?: boolean;
  /** `compact` resolves with no marker, so the strategy declined. */
  readonly strategyDeclines?: boolean;
  /** `compact` throws, as a summarizer failure does. */
  readonly compactThrows?: boolean;
  /** Progress reported while `compact` is still pending. */
  readonly reportProgress?: boolean;
  /**
   * Called from INSIDE the still-pending `compact`, with a reader for the
   * frames the emitter already holds. This is the probe that tells a live
   * reporter from a buffered one.
   */
  readonly observeMidRun?: (framesSeen: () => number) => void;
}

interface Harness {
  readonly ports: RunEnginePorts;
  readonly sources: CompactionSources;
  readonly emitted: RunEvent[];
  /** How many times the summarizer was actually asked to run. */
  compactCalls(): number;
  /** How many times the probe ran. */
  probeCalls(): number;
  /** How many times the cooldown baseline was re-pinned. */
  pinnedTurn(): number | null;
  /** The `trigger` and `force` the controller was last called with. */
  lastCompactOptions(): { trigger?: string; force?: boolean } | null;
}

/** A real emitter over a real session, so frame order is the CONSUMER's order. */
function emitterFor(emitted: RunEvent[]): RunEventEmitter {
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-a3-2b6',
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
        emitted.push(envelope.payload);
      },
    },
  });
}

function portsFor(sources: CompactionSources, emitted: RunEvent[]): RunEnginePorts {
  return buildEnginePorts({
    openModelStream: () => (async function* () {})(),
    queueTool: () => {},
    drainTools: () => (async function* () {})(),
    discardTools: () => {},
    lookup: { sideEffectOf: () => null, toolNames: () => [], describe: () => null },
    assembleTurn: () =>
      Promise.resolve({
        systemPrompt: SYSTEM_PROMPT,
        messages: [],
        tools: [],
        catalogRevision: 'c',
        revision: 'r',
      }),
    askApproval: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
    emitter: emitterFor(emitted),
    proposeTerminal: () => {},
    interTurn: {
      claim: () => Promise.resolve({ action: 'continue' as const, absorbed: false }),
      seqIndex: 0,
      wakeRun: false,
    },
    compaction: sources,
  });
}

function harness(options: HarnessOptions = {}): Harness {
  const emitted: RunEvent[] = [];
  const framesSeen = (): number => emitted.filter((e) => e.type.startsWith('compaction.')).length;

  // The live channel. The coordinator registers its buffer once per compaction
  // and the manager invokes every handler as it emits, so emitting from inside
  // `compact` is exactly what a real summarizer does.
  const handlers: Array<(e: CompactionManagerEvent) => void> = [];
  const emit = (event: CompactionManagerEvent): void => {
    for (const handler of handlers) handler(event);
  };

  let compactCalls = 0;
  let probeCalls = 0;
  let pinned: number | null = null;
  let lastOptions: { trigger?: string; force?: boolean } | null = null;

  async function compact(
    input: readonly Message[],
    compactOptions?: { trigger?: string; force?: boolean },
  ) {
    compactCalls += 1;
    lastOptions = compactOptions ?? null;
    if (options.reportProgress === true) {
      // `step` names the summarizer's STAGE and `phase` whether that stage
      // began or ended -- the two are distinct unions in
      // `CompactionManagerEvent` and swapping them does not compile.
      emit({
        type: 'compaction_step',
        step: 'summarizing',
        phase: 'started',
        messageCount: input.length,
        tokensBefore: 54_321,
        tokensEstimated: 2_000,
        filesCached: 4,
      });
      emit({ type: 'compaction_over_threshold', tokensRetained: 900, available: 8_000 });
    }
    options.observeMidRun?.(framesSeen);
    if (options.compactThrows === true) {
      throw new Error('summarizer provider returned 500');
    }
    if (options.strategyDeclines === true) {
      return { messages: [...input], tokensRemoved: 0, tokensRetained: 0, strategy: 'micro' };
    }
    const keptFrom = Math.max(1, input.length - 2);
    return {
      messages: [
        { role: 'system', content: SUMMARY_TEXT, timestamp: CREATED_AT } as unknown as Message,
        ...input.slice(keptFrom),
      ],
      tokensRemoved: 800,
      tokensRetained: 200,
      strategy: 'session_memory',
    };
  }

  /** The decision half, as the coordinator reads it. */
  const manager = {
    maybeStartPrefire: () => {},
    probeCompaction: () => {
      probeCalls += 1;
      if (options.probeThrows === true) {
        throw new Error('projection failed');
      }
      return {
        tokens: 54_321,
        imageCount: 0,
        imageTriggered: options.imageTriggered ?? false,
        overTriggerLine: options.overTriggerLine ?? false,
        overHardLimit: options.overHardLimit ?? false,
      };
    },
    maybeRearm: () => false,
    isSuppressed: () => false,
    getObservedPromptTokens: () => undefined,
    addEventHandler: (handler: (e: CompactionManagerEvent) => void) => {
      handlers.push(handler);
    },
    removeEventHandler: () => {},
  } as unknown as CompactionManager;

  const timeline = seedTimeline();
  const controller = new MessageCompactionController({
    timeline,
    compactionManager: { compact, shouldCompact: () => true } as unknown as CompactionManager,
    idGenerator: () => ENTRY_ID,
    clock: () => CREATED_AT,
  });

  const coordinator = new CompactionCoordinator({
    compactionController: controller,
    compactionManager: manager,
    projectModelMessages: (systemPromptContent) => ({
      // The legacy re-projects from the TIMELINE after a compaction, and that
      // timeline is what `compactProactive` just appended to.
      systemPromptContent,
      messages: controller.projectInputMessages(),
    }),
    getMessages: () => controller.projectInputMessages(),
    getLastCompactionTurn: () => 0,
    // Records whether the cooldown baseline was re-pinned, WITHOUT letting the
    // pin change what a later gate would decide. See the "does not re-pin"
    // tests: they assert the pin did not happen, which a probe-count assertion
    // cannot distinguish from a pin that fired and was then ignored.
    setLastCompactionTurn: (turn) => {
      pinned = turn;
    },
    getLastCompactionObservedTokens: () => undefined,
    setLastCompactionObservedTokens: () => {},
    getMinTurnsSinceCompact: () => 3,
    getMinTokensGrowthSinceCompact: () => 1_000,
  });

  const sources = buildCoordinatorCompactionSources({
    coordinator,
    systemPromptContent: () => SYSTEM_PROMPT,
    messages: () => controller.projectInputMessages(),
    nextCompactionId: () => COMPACTION_ID,
    noteUsage: () => {},
  });

  return {
    ports: portsFor(sources, emitted),
    sources,
    emitted,
    compactCalls: () => compactCalls,
    probeCalls: () => probeCalls,
    pinnedTurn: () => pinned,
    lastCompactOptions: () => lastOptions,
  };
}

function decision(overrides: Partial<CompactionDecisionInput> = {}): CompactionDecisionInput {
  return {
    turn: TURN,
    transcript: [{ role: 'user', content: PROMPT_TEXT, id: 'm1' }],
    trigger: 'emergency',
    ...overrides,
  };
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

/** One pass through the REAL runtime function, over the port we bound. */
function pass(
  h: Harness,
  input: CompactionDecisionInput = decision(),
  signal: AbortSignal = neverAborted(),
) {
  return runCompactionPass({
    port: h.ports.compaction,
    events: h.ports.events,
    decision: input,
    signal,
  });
}

function compactionFrames(emitted: readonly RunEvent[]): string[] {
  return emitted.filter((e) => e.type.startsWith('compaction.')).map((e) => e.type);
}

// ============================================================================
// 1. EMERGENCY: the dual-evidence gate, over the provider's own words
// ============================================================================

describe('the emergency path fires on an EXPLICIT provider claim, alone', () => {
  it('replaces the transcript and runs exactly one summarization', async () => {
    // The local budget is NOT over the trigger line here, and that must not
    // matter: an explicit provider claim outranks a local probe, because the
    // probe's own budget may be misresolved (`compactErrors.ts:22`). A
    // mutation that required corroboration on the explicit arm too would
    // decline here.
    const h = harness({ overTriggerLine: false, overHardLimit: false });

    const result = await pass(h, decision({ observation: { providerError: EXPLICIT_ERROR } }));

    expect(result.kind).toBe('replaced');
    expect(h.compactCalls()).toBe(1);
    // The trigger the MANAGER was told, read off the options the controller
    // actually received. Asserting only `compactCalls()` would be satisfied by
    // a run that compacted for the wrong reason.
    expect(h.lastCompactOptions()).toMatchObject({ trigger: 'emergency' });
  });

  it('fires the emergency path even with the probe THROWING', async () => {
    // The probe exists to corroborate WEAK wording and to feed a log line. A
    // probe failure must not become "no evidence, therefore decline" on the
    // explicit arm -- that would refuse the one recovery that can still work
    // precisely when the local view of the context is unavailable.
    const h = harness({ probeThrows: true });

    const result = await pass(h, decision({ observation: { providerError: EXPLICIT_ERROR } }));

    expect(result.kind).toBe('replaced');
    expect(h.compactCalls()).toBe(1);
  });
});

describe('the emergency path on WEAK wording is corroborated by the local probe', () => {
  it('fires when the projection is over the trigger line', async () => {
    // `"exceeds limit"` alone matches quota and payload errors too, which is
    // exactly why the weak arm needs a second, independent piece of evidence.
    const h = harness({ overTriggerLine: true });

    const result = await pass(h, decision({ observation: { providerError: WEAK_ERROR } }));

    expect(result.kind).toBe('replaced');
    expect(h.compactCalls()).toBe(1);
  });

  it('DECLINES when the projection is under the trigger line', async () => {
    // The mirror of the test above, and the one that catches a mutation which
    // drops the corroboration requirement: with the probe reading "under the
    // line", a weak phrase must not compact a transcript the local budget does
    // not consider large. Both assertions are needed -- "fires when over" alone
    // is satisfied by a gate that always fires.
    const h = harness({ overTriggerLine: false });

    const result = await pass(h, decision({ observation: { providerError: WEAK_ERROR } }));

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('weak');
    // Declined means it never tried: a gate that compacts and then reports
    // "declined" would have burned a summarization on a quota message.
    expect(h.compactCalls()).toBe(0);
    // And a decline publishes no frame at all -- not even `started`, which
    // would announce a compaction that never begins.
    expect(compactionFrames(h.emitted)).toEqual([]);
  });

  it('DECLINES weak wording when the probe throws, failing CLOSED', async () => {
    // Plan 577's explicit rule: "probe failure = no evidence = no
    // compaction". A fallback to firing here would turn an unmeasurable
    // session into a threshold-free emergency compaction, which is the exact
    // regression the dual-evidence gate was written to remove.
    const h = harness({ probeThrows: true });

    const result = await pass(h, decision({ observation: { providerError: WEAK_ERROR } }));

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('fail-closed');
    expect(h.compactCalls()).toBe(0);
    expect(compactionFrames(h.emitted)).toEqual([]);
  });
});

describe('the emergency path declines an error that is not a context claim', () => {
  it('names the reason and does not compact', async () => {
    const h = harness({ overTriggerLine: true });

    const result = await pass(h, decision({ observation: { providerError: NOT_CONTEXT_ERROR } }));

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('not a context-length claim');
    expect(h.compactCalls()).toBe(0);
    expect(compactionFrames(h.emitted)).toEqual([]);
  });

  it('declines when the engine reported NO provider text at all', async () => {
    // `outcome.message` is optional on the engine's side (`run-engine.ts:688`
    // spreads it only when defined), so a failed stream that carried no
    // message reaches this arm with no evidence. Inventing a claim here would
    // compact on an error nobody described.
    const h = harness({ overTriggerLine: true });

    const result = await pass(h, decision());

    expect(result.kind).toBe('declined');
    expect(h.compactCalls()).toBe(0);
  });
});

describe('the emergency path carries the REAL boundary and the REAL trigger', () => {
  it('replaces the transcript, names the boundary, and announces the trigger', async () => {
    const h = harness({ overTriggerLine: false });

    const result = await pass(h, decision({ observation: { providerError: EXPLICIT_ERROR } }));

    expect(result.kind).toBe('replaced');
    if (result.kind !== 'replaced') return;

    // Re-derived from the timeline the real controller just appended to, so a
    // source that returned its input unchanged would fail here rather than
    // publishing `completed` for work that did not happen.
    const replacementIds = result.transcript.map((m) => m.id);
    expect(replacementIds).toContain(`${ENTRY_ID}:summary`);
    expect(replacementIds).toContain(FIRST_KEPT_ID);
    expect(result.boundaryId).toBe(FIRST_KEPT_ID);
    expect(result.boundaryId).not.toBe(COMPACTION_ID);
    expect(result.compactedMessageIds).toEqual(['u1', 'a1', 'u2', 'a2']);

    // `compaction.started` reports `emergency` as `threshold` -- the protocol
    // has no `emergency` member (`payloads.ts:550`). Asserting the narrowing
    // matters: a source that reported `auto` here would be indistinguishable
    // from the proactive pass on the wire, which is how an emergency recovery
    // becomes invisible to whoever is watching a run recover.
    const started = h.emitted.find((e) => e.type === 'compaction.started') as
      | { compactionId: string; trigger: string }
      | undefined;
    expect(started).toMatchObject({ compactionId: COMPACTION_ID, trigger: 'threshold' });
  });

  it('does not re-pin the proactive cooldown', async () => {
    // The legacy's emergency site calls `compactProactive` and pins nothing.
    // A pin here would reset the proactive gate's arithmetic, so the turn
    // AFTER a recovery could not compact again for `minTurnsSinceCompact` more
    // turns -- on the very transcript the provider had just rejected once.
    const h = harness({ overTriggerLine: false });

    await pass(h, decision({ observation: { providerError: EXPLICIT_ERROR } }));

    expect(h.pinnedTurn()).toBeNull();
  });

  it('reports an ALREADY-aborted run as cancelled, without starting a summarizer', async () => {
    // A caller that has already given up must not start a summarizer it cannot
    // stop: the summarizer runs behind its own child abort controller
    // (`DuyaAgent.ts:776-780`) and this port cannot reach it.
    //
    // The assertion is `compactCalls`, NOT `probeCalls`. The port splits decide
    // from run (`compaction.ts:141`, `:154`), so the GATE -- and therefore the
    // probe -- has already run by the time the abort is observed; a probe is a
    // projection measurement, not work that outlives the run. What must not
    // have happened is the minutes-long part.
    const h = harness({ overTriggerLine: false });
    const controller = new AbortController();
    controller.abort();

    const result = await pass(
      h,
      decision({ observation: { providerError: EXPLICIT_ERROR } }),
      controller.signal,
    );

    expect(result.kind).toBe('cancelled');
    expect(h.compactCalls()).toBe(0);
  });
});

// ============================================================================
// 2. PREFLIGHT-OVERFLOW: the HARD limit, no cooldown
// ============================================================================

describe('the preflight path fires on the HARD limit, not the trigger line', () => {
  it('fires when the projection is past the window but under the reserve', async () => {
    // The reason this path exists: a single tool call can blow past the 78%
    // trigger line by itself, and waiting for the next proactive check risks
    // a `context_length_exceeded` round-trip (`DuyaAgent.ts:3001-3008`). The
    // only fixture that distinguishes this gate from `decidePreTurn` is one
    // where the two lines DISAGREE.
    const h = harness({ overTriggerLine: false, overHardLimit: true });

    const result = await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(result.kind).toBe('replaced');
    expect(h.compactCalls()).toBe(1);
    expect(h.lastCompactOptions()).toMatchObject({ trigger: 'preflight_overflow' });
  });

  it('DECLINES when under the hard limit, even when over the trigger line', async () => {
    // The mirror, and the one that catches the inverse mutation: a gate
    // comparing the trigger line would compact HERE, where the legacy does
    // not. Asserting "fires over hard limit" alone is satisfied by that gate.
    const h = harness({ overTriggerLine: true, overHardLimit: false });

    const result = await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('hard limit');
    expect(h.compactCalls()).toBe(0);
    expect(compactionFrames(h.emitted)).toEqual([]);
  });

  it('DECLINES when the projection cannot be probed, failing CLOSED', async () => {
    // Best-effort in the legacy: a failed projection falls through to the next
    // iteration rather than compacting blind.
    const h = harness({ probeThrows: true, overHardLimit: true });

    const result = await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('could not be probed');
    expect(h.compactCalls()).toBe(0);
  });

  it('forces and reports `auto` on the image arm, as the legacy paired them', async () => {
    // `force: true` is paired with `trigger: 'auto'` and NOT with
    // `preflight_overflow`, because `CompactionManager` only folds a failure
    // into the suppression ring for an `auto` trigger
    // (`CompactionManager.ts:941`). Reading the options off the controller is
    // what makes the pairing observable; asserting only that it compacted
    // would pass either way.
    const h = harness({ imageTriggered: true, overHardLimit: false });

    const result = await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(result.kind).toBe('replaced');
    expect(h.lastCompactOptions()).toEqual({ trigger: 'auto', force: true });
  });

  it('does not re-pin the proactive cooldown', async () => {
    // Same reason as the emergency path, and the legacy's preflight site pins
    // nothing either. Both recovery paths leaving the cooldown alone is what
    // keeps a recovery from silently postponing the next proactive pass.
    const h = harness({ overHardLimit: true });

    await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(h.pinnedTurn()).toBeNull();
  });
});

// ============================================================================
// 3. LIVE progress on BOTH paths -- the load-bearing property
// ============================================================================

describe.each([
  {
    label: 'emergency',
    options: { overTriggerLine: false },
    make: (providerError: string) => decision({ observation: { providerError } }),
    providerError: EXPLICIT_ERROR,
  },
  {
    label: 'preflight_overflow',
    options: { overHardLimit: true },
    make: () => decision({ trigger: 'preflight_overflow' as const }),
    providerError: '',
  },
] as const)('the $label path forwards progress DURING the run', (path) => {
  // Run as a matrix so the property is asserted on BOTH new paths rather than
  // on the proactive one only. A source that buffered only the recovery paths
  // would pass a single-path test.
  it('publishes each step BETWEEN compaction.started and compaction.completed', async () => {
    const h = harness({ ...path.options, reportProgress: true });

    await pass(h, path.make(path.providerError));

    expect(compactionFrames(h.emitted)).toEqual([
      'compaction.started',
      'compaction.step',
      'compaction.over_threshold',
      'compaction.completed',
    ]);
  });

  it('has already published the progress while the compaction is STILL running', async () => {
    // This is the test a frame-ORDER assertion cannot replace. Both a live
    // reporter and a buffered one that flushes before `runCompactionPass`
    // returns produce the same four frames in the same order; only reading the
    // stream from inside the pending `compact` tells them apart.
    let framesDuringRun = -1;
    const h = harness({
      ...path.options,
      reportProgress: true,
      observeMidRun: (framesSeen) => {
        framesDuringRun = framesSeen();
      },
    });

    await pass(h, path.make(path.providerError));

    // `started` plus both volatile frames, and NO terminal yet.
    expect(framesDuringRun).toBe(3);
    // And the terminal arrived afterwards, so the pass really did still have
    // work outstanding at the moment it was read.
    expect(compactionFrames(h.emitted)).toContain('compaction.completed');
  });

  it('reports the progress verbatim, including the optional members', async () => {
    const h = harness({ ...path.options, reportProgress: true });

    await pass(h, path.make(path.providerError));

    const step = h.emitted.find((e) => e.type === 'compaction.step') as
      | { compactionId: string; step: string; phase: string; tokensBefore?: number }
      | undefined;
    // Every optional member has to survive the hop, or a summarization that
    // actually happened is reported as having estimated nothing.
    expect(step).toMatchObject({
      compactionId: COMPACTION_ID,
      step: 'summarizing',
      phase: 'started',
      tokensBefore: 54_321,
    });
    const over = h.emitted.find((e) => e.type === 'compaction.over_threshold') as
      | { tokensRetained: number; available: number }
      | undefined;
    expect(over).toMatchObject({ tokensRetained: 900, available: 8_000 });
  });

  it('reports a FAILED compaction as failed, never as a decline', async () => {
    // `failed` is the arm that publishes the terminal frame, so a summarizer
    // error cannot leave a consumer holding a `compaction.started` with no
    // ending. A decline here would say "chose not to compact" about a
    // compaction that tried and could not.
    const h = harness({ ...path.options, compactThrows: true });

    const result = await pass(h, path.make(path.providerError));

    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.message).toContain('summarizer provider returned 500');
    expect(compactionFrames(h.emitted)).toEqual(['compaction.started', 'compaction.failed']);
  });

  it('reports a declined strategy as DECLINED, never as a replacement', async () => {
    // `compactProactive` resolving `null` means the strategy returned its
    // input unchanged. Publishing `compaction.completed` for it would be the
    // "announced success for work that did not happen" shape.
    const h = harness({ ...path.options, strategyDeclines: true });

    const result = await pass(h, path.make(path.providerError));

    expect(result.kind).toBe('declined');
    expect(compactionFrames(h.emitted)).toEqual(['compaction.started']);
    expect(h.compactCalls()).toBe(1);
  });
});

// ============================================================================
// 4. Each gate asks its OWN question -- not the proactive one
// ============================================================================

describe('the three gates are three questions, not one gate three times', () => {
  it('asks the emergency gate for an emergency pass and NOT the pre-turn one', async () => {
    // `decidePreTurn` would read `overTriggerLine`, and with both lines over it
    // would ALSO fire -- so "it compacted" is not the assertion. The trigger
    // the MANAGER received is: the proactive path sends `auto`, and the
    // emergency path sends `emergency`. A source that ran `executePreTurn` for
    // an emergency pass would announce a recovery that re-pinned the cooldown
    // and reported the wrong cause.
    const h = harness({ overTriggerLine: true, overHardLimit: true });

    await pass(h, decision({ observation: { providerError: EXPLICIT_ERROR } }));

    expect(h.lastCompactOptions()).toMatchObject({ trigger: 'emergency' });
    expect(h.pinnedTurn()).toBeNull();
  });

  it('asks the preflight gate about the hard limit, not the trigger line', async () => {
    // The same distinction read off the outcome rather than the options: over
    // the TRIGGER line and under the HARD limit is the state the proactive
    // gate fires on and the preflight gate declines. Both lines over would be
    // indistinguishable between the two gates.
    const h = harness({ overTriggerLine: true, overHardLimit: false });

    const result = await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(result.kind).toBe('declined');
  });

  it('asks the gate ONCE per pass, and runs under the answer it published', async () => {
    // The verdict is cached per DECISION OBJECT, so `run` acts on the answer
    // `decide` gave rather than re-deriving one. A second probe would mean the
    // `compaction.started` frame was published for an answer the run did not
    // use -- and would double the projection cost on the emergency path.
    const h = harness({ overHardLimit: true, overTriggerLine: false });

    await pass(h, decision({ trigger: 'preflight_overflow' }));

    expect(h.probeCalls()).toBe(1);
  });
});