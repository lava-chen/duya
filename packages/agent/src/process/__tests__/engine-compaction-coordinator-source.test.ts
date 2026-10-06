/**
 * The compaction SOURCE, bound to the legacy coordinator.
 *
 * ## What this file is for
 *
 * A3-2a built `buildCompactionPort` and tested it against a fake source, which
 * left the interesting half untested: nothing in the tree actually SUPPLIED a
 * `CompactionSources`, so the port had never been driven by the legacy's real
 * compaction. This file drives it by one, through the REAL `runCompactionPass`
 * from `@duya/agent-runtime` and the REAL `buildEnginePorts`.
 *
 * ## What is real here and what is not, and why
 *
 * Real: `CompactionCoordinator` (the thing A3-2b5 split),
 * `MessageCompactionController`, `MessageTimeline`, `buildEnginePorts`,
 * `buildCompactionPort`, `runCompactionPass`, and a real `RunEventEmitter` over
 * a real `RunSession`.
 *
 * Fake: the `CompactionManager`. The summarizer is a model call that takes
 * minutes; a test needs to control WHEN it reports and WHEN it settles, which
 * is the property under test. Everything the manager contributes to a
 * DECISION -- the probe, the suppression ring, the rearm -- is a fake here too,
 * and that is stated rather than hidden: this file proves the ADAPTER carries
 * the coordinator faithfully, and the coordinator's own gate arithmetic is
 * `CompactionCoordinator.ts`'s to test.
 *
 * ## The mutation this file is built to catch
 *
 * A source that collects progress and reports it after `resolve` puts
 * `compaction.step` AFTER `compaction.completed`. The legacy streams
 * `compact:*` DURING for exactly this reason -- the summarizer takes minutes
 * (`DuyaAgent.ts:2583-2590`) -- and the engine binds its reporter straight to
 * `events.publish` (`compaction.ts:150-152`), so a buffered adapter publishes
 * the terminal frame first and the progress that belonged before it afterwards.
 *
 * Two tests below attack it from different sides, because one is not enough:
 * the ORDER test cannot tell a live reporter from a buffered one that flushes
 * before `runCompactionPass` returns (both produce the same three frames in
 * the same order), and the MID-RUN probe is what distinguishes them.
 */

import { describe, expect, it } from 'vitest';
import { RunEventEmitter, RunSession, runCompactionPass } from '@duya/agent-runtime';
import type {
  CompactionDecisionInput,
  CompactionUsageAnchor,
  RunEnginePorts,
  RunEvent,
} from '@duya/agent-runtime';
import type { RunEventEnvelope, RunId } from '@duya/agent-protocol';
import type { CompactionManager, CompactionManagerEvent } from '../../compact/CompactionManager.js';
import { CompactionCoordinator } from '../../agent/CompactionCoordinator.js';
import type { Message } from '../../types.js';
import { MessageTimeline } from '../../message/message-framework.js';
import type { AgentMessage, MessageEntry } from '../../message/message-framework.js';
import { MessageCompactionController } from '../../message/message-compaction-controller.js';
import { buildCoordinatorCompactionSources } from '../run-engine-compaction.js';
import { buildEnginePorts } from '../run-engine-ports.js';
import type { CompactionSources } from '../run-engine-ports.js';

const RUN_ID = 'run-a3-2b5-compaction' as RunId;
const CREATED_AT = 1_700_000_000_000;
const TURN = 3;

/** Facts that cannot be confused with the transcript they become. */
const PROMPT_TEXT = 'PROMPT-a3-2b5';
const SUMMARY_TEXT = 'COMPACTED-SUMMARY-a3-2b5';
const SYSTEM_PROMPT = 'SYSTEM-a3-2b5';
const FIRST_KEPT_ID = 'u3';
const COMPACTION_ID = 'cmp-host-1';
const ENTRY_ID = 'entry-compaction-1';

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
  /** The probe's verdict about the trigger line. */
  readonly overTriggerLine?: boolean;
  /** Suppression ring active. */
  readonly suppressed?: boolean;
  /** The image-volume trigger, which bypasses cooldown AND suppression. */
  readonly imageTriggered?: boolean;
  /** The cooldown baseline. Turn 1 is always inside a 3-turn cooldown. */
  readonly lastCompactionTurn?: number;
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
  /** How many times the gate ran. Two would mean a re-derived gate. */
  gateCalls(): number;
}

/** A real emitter over a real session, so frame order is the CONSUMER's order. */
function emitterFor(emitted: RunEvent[]): RunEventEmitter {
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-a3-2b5',
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
  let gateCalls = 0;

  /**
   * The summarizer half. Its `compact` reports progress, runs the mid-run
   * probe, and only then resolves -- so the probe reads the event stream with
   * this promise still pending.
   */
  async function compact(input: readonly Message[]) {
    compactCalls += 1;
    if (options.reportProgress === true) {
      emit({
        type: 'compaction_step',
        step: 1,
        phase: 'summarizing',
        messageCount: input.length,
        tokensBefore: 12_345,
      });
    }
    options.observeMidRun?.(framesSeen);
    if (options.compactThrows === true) {
      throw new Error('summarizer provider returned 500');
    }
    if (options.strategyDeclines === true) {
      // No marker in the result, so `applyCompactionResult` returns `null`
      // (`message-compaction-controller.ts:257`): the strategy declined.
      return { messages: [...input], tokensRemoved: 0, tokensRetained: 0, strategy: 'micro' };
    }
    // A summary marker followed by the retained tail, carrying REAL timeline
    // ids so the safe-boundary walk finds a cut and lists what it removed.
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
      gateCalls += 1;
      return {
        tokens: 12_345,
        imageCount: 0,
        imageTriggered: options.imageTriggered ?? false,
        overTriggerLine: options.overTriggerLine ?? true,
        overHardLimit: false,
      };
    },
    maybeRearm: () => false,
    isSuppressed: () => options.suppressed ?? false,
    getObservedPromptTokens: () => undefined,
    addEventHandler: (handler: (e: CompactionManagerEvent) => void) => {
      handlers.push(handler);
    },
    removeEventHandler: () => {},
  } as unknown as CompactionManager;

  const timeline = seedTimeline();
  const controller = new MessageCompactionController({
    timeline,
    compactionManager: { compact, shouldCompact: () => true },
    idGenerator: () => ENTRY_ID,
    clock: () => CREATED_AT,
  });

  let lastCompactionTurn = options.lastCompactionTurn ?? 0;

  const coordinator = new CompactionCoordinator({
    compactionController: controller,
    compactionManager: manager,
    projectModelMessages: (systemPromptContent) => ({
      // The legacy re-projects from the TIMELINE after a compaction
      // (`CompactionCoordinator.ts:289-291`), and that timeline is what
      // `compactProactive` just appended to. Deriving the replacement from
      // anywhere else would be a second authority for what the transcript is.
      systemPromptContent,
      messages: controller.projectInputMessages(),
    }),
    getMessages: () => controller.projectInputMessages(),
    getLastCompactionTurn: () => lastCompactionTurn,
    setLastCompactionTurn: (turn) => {
      lastCompactionTurn = turn;
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
    gateCalls: () => gateCalls,
  };
}

function decision(overrides: Partial<CompactionDecisionInput> = {}): CompactionDecisionInput {
  return {
    turn: TURN,
    transcript: [{ role: 'user', content: PROMPT_TEXT, id: 'm1' }],
    trigger: 'auto',
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
// 1. Progress is forwarded LIVE -- the load-bearing property
// ============================================================================

describe('the coordinator source forwards compaction progress DURING the run', () => {
  it('publishes compaction.step BETWEEN compaction.started and compaction.completed', async () => {
    // The order a CONSUMER sees, read off the frames themselves rather than a
    // return value. A source that buffered its progress and flushed after
    // `resolve` would produce started / completed / step.
    const h = harness({ reportProgress: true });

    await pass(h);

    expect(compactionFrames(h.emitted)).toEqual([
      'compaction.started',
      'compaction.step',
      'compaction.completed',
    ]);
  });

  it('has already published the step while the compaction is STILL running', async () => {
    // The property the ORDER test cannot see. A buffered reporter that flushed
    // before `runCompactionPass` returned would produce the same three frames
    // in the same order and pass the test above; this one distinguishes them.
    //
    // The read happens from INSIDE the summarizer, with its promise still
    // pending. `started` and `step` are out; `completed` cannot be, the run
    // has not returned. Two is the live answer and one is the buffered one.
    let midRunFrames = -1;
    const h = harness({
      reportProgress: true,
      observeMidRun: (framesSeen) => {
        midRunFrames = framesSeen();
      },
    });

    await pass(h);

    expect(midRunFrames).toBe(2);
  });

  it('reports the progress verbatim, including the optional members', async () => {
    // The frame is forwarded VERBATIM (`compaction.ts:220-248`), so a member
    // dropped in the hop under-reports a summarization that happened. Asserted
    // on the FRAME rather than on the reporter's argument, because the frame
    // is what a consumer reads.
    const h = harness({ reportProgress: true });

    await pass(h);

    const step = h.emitted.find((e) => e.type === 'compaction.step') as
      | {
          compactionId: string;
          step: number;
          phase: string;
          messageCount?: number;
          tokensBefore?: number;
        }
      | undefined;
    expect(step).toMatchObject({
      // The HOST's id, on the frame rather than off the port's return value.
      compactionId: COMPACTION_ID,
      step: 1,
      phase: 'summarizing',
      tokensBefore: 12_345,
    });
    expect(step?.messageCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// 2. The gate is the COORDINATOR'S, asked once
// ============================================================================

describe('the coordinator source asks the pre-turn gate, and only that gate', () => {
  it('compacts when the gate fires, and asks it exactly once', async () => {
    // Once, not twice. Folding decide and run back together would probe a
    // second time inside `run`, and the caller would then be acting on a
    // possibly-different answer than the one it published `compaction.started`
    // for.
    const h = harness({ overTriggerLine: true });

    const result = await pass(h);

    expect(result.kind).toBe('replaced');
    expect(h.compactCalls()).toBe(1);
    expect(h.gateCalls()).toBe(1);
  });

  it('declines on the cooldown, and never announces a compaction that did not start', async () => {
    // Turn 1 is inside the 3-turn cooldown the harness declares. A source that
    // answered `compact` regardless would publish `compaction.started` on
    // nearly every turn of a real run -- the cooldown gate is what declines
    // the overwhelming majority of them.
    const h = harness({ overTriggerLine: true, lastCompactionTurn: 0 });

    const result = await pass(h, decision({ turn: 1 }));

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('cooldown');
    // No `started` at all: the pass returns before the engine mints one.
    expect(compactionFrames(h.emitted)).toEqual([]);
    expect(h.compactCalls()).toBe(0);
  });

  it('declines on suppression, and names it', async () => {
    const h = harness({ overTriggerLine: true, suppressed: true, lastCompactionTurn: -99 });

    const result = await pass(h);

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('suppression');
    expect(compactionFrames(h.emitted)).toEqual([]);
  });

  it('declines under the trigger line', async () => {
    const h = harness({ overTriggerLine: false, lastCompactionTurn: -99 });

    const result = await pass(h);

    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('trigger line');
  });

  it('still honours the image trigger, which bypasses cooldown AND suppression', async () => {
    // The two overrides the legacy keeps bypassing. Pinned because a source
    // that applied the cooldown to the image path would silently stop
    // compacting image-heavy sessions.
    const h = harness({
      overTriggerLine: false,
      suppressed: true,
      lastCompactionTurn: 0,
      imageTriggered: true,
    });

    const result = await pass(h);

    expect(result.kind).toBe('replaced');
    expect(h.compactCalls()).toBe(1);
  });
});

// ============================================================================
// 3. Two of the three decision points are NOT this coordinator
// ============================================================================

describe('the coordinator source declines the triggers it does not serve, by name', () => {
  for (const trigger of ['emergency', 'preflight_overflow', 'model_switch', 'manual'] as const) {
    it(`declines ${trigger} rather than answering for it`, async () => {
      // `emergency` is the recovery path for a provider that answered
      // `context_length_exceeded` (`DuyaAgent.ts:3756`). Answering `compact`
      // for it and then running the PROACTIVE pass would claim a recovery that
      // never happened; a SILENT decline would read as "the transcript is
      // fine". So the reason names the gap, and the cutover can see it.
      const h = harness();

      const result = await pass(h, decision({ trigger }));

      expect(result.kind).toBe('declined');
      expect(result.kind === 'declined' && result.reason).toContain(
        trigger.replace('_', '-'),
      );
      expect(result.kind === 'declined' && result.reason).toContain('not served');
      // And it did not compact: the whole point is that it stood aside.
      expect(h.compactCalls()).toBe(0);
      expect(compactionFrames(h.emitted)).toEqual([]);
    });
  }
});

// ============================================================================
// 4. The replacement, and the facts only the timeline holds
// ============================================================================

describe('the coordinator source carries the REAL boundary out', () => {
  it('replaces the transcript and reports the ids the entry actually removed', async () => {
    const h = harness();

    const result = await pass(h);

    expect(result.kind).toBe('replaced');
    if (result.kind !== 'replaced') return;

    // Re-derived from the timeline the real controller just appended to, not
    // echoed back. A source that returned its input would make every
    // replacement a no-op that still published `completed`. The synthesised
    // summary message is named after the ENTRY the harness's controller minted,
    // so this cannot be satisfied by a transcript that merely happens to have
    // three members.
    const replacementIds = result.transcript.map((m) => m.id);
    expect(replacementIds).toContain(`${ENTRY_ID}:summary`);
    // The boundary message is the first one kept, so it leads the tail.
    expect(replacementIds).toContain(FIRST_KEPT_ID);
    // And nothing the entry recorded as removed survives in the replacement.
    for (const removed of result.compactedMessageIds) {
      expect(replacementIds).not.toContain(removed);
    }

    // `boundaryId` is the first message the timeline KEPT. The legacy's own
    // `compact:done` carries no boundary at all, so the inbound translator
    // falls back to reusing `compactionId` (`chat-event-translator.ts:734`).
    // This is the real one, and it is a DIFFERENT value from the frame id.
    expect(result.boundaryId).toBe(FIRST_KEPT_ID);
    expect(result.boundaryId).not.toBe(COMPACTION_ID);
    expect(result.compactedMessageIds).not.toContain(FIRST_KEPT_ID);
    expect(result.compactedMessageIds.length).toBeGreaterThan(0);
    expect(result.compactedMessageIds).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('reports the entry the compaction produced on the completed frame', async () => {
    const h = harness();

    await pass(h);

    const completed = h.emitted.find((e) => e.type === 'compaction.completed') as
      | {
          compactionId: string;
          boundaryId: string;
          compactedMessageIds: string[];
          strategy?: string;
        }
      | undefined;
    expect(completed).toMatchObject({
      compactionId: COMPACTION_ID,
      boundaryId: FIRST_KEPT_ID,
      compactedMessageIds: ['u1', 'a1', 'u2', 'a2'],
      strategy: 'session_memory',
    });
  });

  it('does not forward the legacy lifecycle frames a second time', async () => {
    // `compact:start` and `compact:done` are the coordinator's own, and the
    // engine mints `compaction.started` / `compaction.completed` around `run`.
    // Forwarding them would publish each twice, and a doubled terminal leaves a
    // consumer holding two compactions for one.
    const h = harness();

    await pass(h);

    expect(compactionFrames(h.emitted)).toEqual([
      'compaction.started',
      'compaction.completed',
    ]);
  });

  it('reports a declined strategy as DECLINED, never as a replacement', async () => {
    // `compactProactive` returning nothing means the strategy returned its
    // input unchanged. Publishing `compaction.completed` for it would be the
    // "announced success for work that did not happen" shape.
    const h = harness({ strategyDeclines: true });

    const result = await pass(h);

    expect(result.kind).toBe('declined');
    expect(compactionFrames(h.emitted)).toEqual(['compaction.started']);
    expect(h.compactCalls()).toBe(1);
  });
});

// ============================================================================
// 5. Failure and cancellation
// ============================================================================

describe('the coordinator source reports a failed compaction as failed', () => {
  it('closes the sequence with compaction.failed, carrying the provider words', async () => {
    // The legacy emits `compact:error` and CONTINUES
    // (`CompactionCoordinator.ts:311`). This source reports it as `failed`,
    // which is the protocol's own meaning (`chat-event-translator.ts:723-728`
    // maps the same frame to `compaction.failed`) and the only arm that
    // publishes a terminal -- so a `compaction.started` can never be left
    // open. At the proactive site the engine then ends the run
    // (`run-engine.ts:591`), which is STRICTER than the legacy; that
    // divergence is reported in this slice's write-up, not hidden here.
    const h = harness({ compactThrows: true });

    const result = await pass(h);

    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.message).toBe(
      'summarizer provider returned 500',
    );
    expect(compactionFrames(h.emitted)).toEqual([
      'compaction.started',
      'compaction.failed',
    ]);
  });

  it('reports an ALREADY-aborted run as cancelled, without touching the manager', async () => {
    // A caller that has already given up must not start a summarizer it cannot
    // stop: the legacy runs its own child abort controller
    // (`DuyaAgent.ts:776-780`) and this port cannot reach it.
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    const result = await pass(h, decision(), controller.signal);

    expect(result.kind).toBe('cancelled');
    expect(h.compactCalls()).toBe(0);
  });
});

// ============================================================================
// 6. The optional member stays honestly bound
// ============================================================================

describe('the coordinator source binds noteUsage when it has one', () => {
  it('forwards the anchor the engine built, by identity', async () => {
    // `epoch` is load-bearing: filing a pre-compaction request's tokens into
    // the post-compaction generation anchors the new epoch to a size it never
    // had (`ports.ts:1979-1994`). Read off the SOURCE's own record rather
    // than off the port, so the test cannot pass by the member never being
    // bound at all.
    const seen: CompactionUsageAnchor[] = [];
    const emitted: RunEvent[] = [];
    const h = harness();
    const ports = portsFor({ ...h.sources, noteUsage: (anchor) => seen.push(anchor) }, emitted);

    const anchor: CompactionUsageAnchor = {
      turn: 2,
      inputTokens: 1_200,
      outputTokens: 80,
      epoch: 3,
    };
    ports.compaction?.noteUsage?.(anchor);

    expect(seen).toEqual([anchor]);
  });
});
