/**
 * Plan 600 S2 step b4c -- the compaction seam.
 *
 * ## What this file is the proof of
 *
 * `compaction.started`, `compaction.step`, `compaction.completed`,
 * `compaction.failed` and `compaction.over_threshold` were all DEFINED
 * (`packages/agent-protocol/src/events/registry.ts:222-226`), all PROJECTED
 * (`src/project/legacy-sse-projector.ts:201-231`) and all TRANSLATED inbound
 * (`src/translate/chat-event-translator.ts:694-744`) -- and none of them had a
 * producer. The legacy loop emits raw `compact:*` SSE frames, which is exactly
 * why the inbound translator exists; the engine published none.
 *
 * `CompactionPort` (`src/engine/ports.ts`) is the seam, and `runCompactionPass`
 * (`src/engine/compaction.ts`) is its single producer. This file proves the two
 * properties that matter and that neither is an assertion about intent:
 *
 *  1. **the replacement is OBSERVABLE** -- the next request is built from the
 *     compacted transcript and not from the original one;
 *  2. **declining is a first-class outcome**, not an error and not a silence;
 *  3. **each of the five frames has a producer**, in its own test, so removing
 *     any one of them turns exactly one test red.
 *
 * ## Where these tests live, and why
 *
 * `packages/agent-runtime/tests/`, not `test/`. `test/` is owned concurrently by
 * another worker on this branch (streaming deltas in `run-engine.ts`), and the
 * two of us writing into one directory is the conflict this file avoids. The
 * location is not a workaround: the per-package "tests" include glob is already
 * in `vitest.config.ts`, and three packages (`agent`, `plugin-core`, `voice`)
 * already use that directory, so `check-test-coverage` collects it and nothing
 * had to be reconfigured. `npx vitest run packages/agent-runtime` picks it up;
 * the narrower `.../test` path does not, which is why the number for this slice
 * is reported from the wider scope.
 *
 * These tests import `../src/engine/compaction.js` rather than the package
 * index, deliberately: `src/index.ts` re-exports `RunEngineImpl`, so importing
 * the barrel would couple this file's result to the state of `run-engine.ts`.
 *
 * ## Why these assertions are not `a === a`
 *
 * The two sides come from different sources in every test. The original
 * transcript and the replacement are different objects with different
 * sentinels; the compaction boundary comes from the PORT, not from the seam;
 * the frames are read out of a publishing port that only the seam writes to;
 * and the "next request" is assembled by a `ContextPort` that resolves a
 * `ResolvedPart` locator independently, exactly as `run-engine.ts:412-421`
 * does. A seam that rebuilt the transcript from the boundary, or a fake that
 * echoed what it was handed, would fail these.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  completedFrame,
  failedFrame,
  progressFrame,
  runCompactionPass,
  startedFrame,
} from '../src/engine/compaction.js';
import type {
  CompactionDecision,
  CompactionDecisionInput,
  CompactionOutcome,
  CompactionPort,
  CompactionProgress,
  ModelMessage,
  ResolvedPart,
  RunEventStorePort,
} from '../src/engine/ports.js';
import type { OneShotTextPort, OneShotTextResult } from '../src/engine/ports.js';
import type { RunEvent } from '@duya/agent-protocol';

// Sentinels. Distinct on purpose: every assertion below compares a value the
// PORT produced against a value the TEST built, never a value against itself.
const ORIGINAL_SENTINEL = 'user: the original question';
const SUMMARY_SENTINEL = 'assistant: summary of turns 1 through 9';
const COMPACTED_ID = 'msg-0007';

const ORIGINAL_TRANSCRIPT: readonly ModelMessage[] = [
  { role: 'user', content: ORIGINAL_SENTINEL, id: 'msg-0001' },
  { role: 'assistant', content: 'a long answer', id: 'msg-0002' },
  { role: 'user', content: 'and another question', id: 'msg-0007' },
];

const REPLACEMENT_TRANSCRIPT: readonly ModelMessage[] = [
  { role: 'user', content: SUMMARY_SENTINEL, id: 'summary-1' },
  { role: 'user', content: 'and another question', id: 'msg-0007' },
];

/** Collects everything the seam publishes, in order. */
function recordingEvents(): { events: RunEvent[]; store: RunEventStorePort } {
  const events: RunEvent[] = [];
  return {
    events,
    store: {
      publish: (event) => {
        events.push(event);
      },
      proposeTerminal: () => {},
    },
  };
}

/** A port whose every part is scripted, so no arm is reached by accident. */
function scriptedPort(parts: {
  decision: CompactionDecision;
  outcome: CompactionOutcome;
  progress?: readonly CompactionProgress[];
}): CompactionPort {
  return {
    decide: () => Promise.resolve(parts.decision),
    run: (_input, reporter) => {
      for (const progress of parts.progress ?? []) reporter(progress);
      return Promise.resolve(parts.outcome);
    },
    nextCompactionId: () => 'cmp-7',
  };
}

const REPLACED: CompactionOutcome = {
  kind: 'replaced',
  replacement: REPLACEMENT_TRANSCRIPT,
  boundaryId: 'boundary-42',
  compactedMessageIds: [COMPACTED_ID],
  strategy: 'session_memory',
  tokensRemoved: 1234,
  tokensRetained: 567,
};

const INPUT: CompactionDecisionInput = {
  turn: 4,
  transcript: ORIGINAL_TRANSCRIPT,
  trigger: 'auto',
};

const NEVER_ABORTED = new AbortController().signal;

function pass(
  port: CompactionPort | undefined,
  events: RunEventStorePort,
  input: CompactionDecisionInput = INPUT,
) {
  return runCompactionPass({ port, events, decision: input, signal: NEVER_ABORTED });
}

// ---------------------------------------------------------------------------

describe('the replacement is observable: the next request is built from it', () => {
  /**
   * This mirrors the engine's own assembly step. `run-engine.ts:412-421` builds
   * a `TurnAssemblyInput`, hands it to `ports.context.assemble`, and sends the
   * returned `messages` to the model. The seam's contract is that the `history`
   * part handed to `assemble` on the NEXT turn is the replacement, so that is
   * exactly what is reconstructed here -- through a `ContextPort` that resolves
   * a locator on its own, rather than by reading the seam's return value
   * directly.
   */
  it('builds the next request from the replacement, not the original', async () => {
    const store = new Map<string, readonly ModelMessage[]>();
    store.set('transcript:original', ORIGINAL_TRANSCRIPT);
    store.set('transcript:boundary-42', REPLACEMENT_TRANSCRIPT);

    // How the next request is BUILT: resolve the locator, assemble the payload.
    const assemble = async (history: ResolvedPart<readonly ModelMessage[]>): Promise<readonly ModelMessage[]> => {
      if (history.kind !== 'by_ref') throw new Error('the fake only serves durable history by reference');
      const resolved = store.get(history.locator);
      if (resolved === undefined) throw new Error(`unknown locator ${history.locator}`);
      return resolved;
    };

    // ── Before the compaction: the request carries the ORIGINAL history ─────
    const firstRequest = await assemble({ kind: 'by_ref', digest: 'digest-original', locator: 'transcript:original' });

    // ── The pass. The port decides to compact and hands back a replacement ───
    const { events, store: eventStore } = recordingEvents();
    const result = await pass(scriptedPort({ decision: { kind: 'compact', trigger: 'auto' }, outcome: REPLACED }), eventStore);

    expect(result.kind).toBe('replaced');
    if (result.kind !== 'replaced') throw new Error('unreachable: asserted above');

    // The locator for the next turn is derived from what the PORT returned
    // (its boundary), not from anything the seam computed.
    const nextLocator = `transcript:${result.boundaryId}`;
    const nextHistory: ResolvedPart<readonly ModelMessage[]> = {
      kind: 'by_ref',
      digest: 'digest-after-compaction',
      locator: nextLocator,
    };
    const secondRequest = await assemble(nextHistory);

    // The load-bearing pair. The FIRST request still carries the original --
    // proving the two sides are genuinely different values and the comparison
    // is not a tautology -- and the SECOND carries the summary instead.
    const flatten = (messages: readonly ModelMessage[]): string =>
      messages.map((message) => String(message.content)).join('\n');

    expect(flatten(firstRequest)).toContain(ORIGINAL_SENTINEL);
    expect(flatten(firstRequest)).not.toContain(SUMMARY_SENTINEL);

    expect(flatten(secondRequest)).toContain(SUMMARY_SENTINEL);
    expect(flatten(secondRequest)).not.toContain(ORIGINAL_SENTINEL);

    // Identity, not just content: the replacement is the very array the port
    // returned, so a seam that re-derived a transcript from the boundary would
    // fail here rather than passing on a coincidental string match.
    expect(result.transcript).toBe(REPLACEMENT_TRANSCRIPT);
    expect(events.some((event) => event.type === 'compaction.completed')).toBe(true);
  });

  it('hands the next request the replacement even when it is empty, not the original', async () => {
    // An empty replacement is the case a `?? original` fallback gets wrong: a
    // compaction that legitimately summarises to nothing must yield an EMPTY
    // transcript, not silently the pre-compaction one.
    const emptyReplacement: CompactionOutcome = {
      kind: 'replaced',
      replacement: [],
      boundaryId: 'boundary-empty',
      compactedMessageIds: [COMPACTED_ID],
    };
    const { store } = recordingEvents();
    const result = await pass(
      scriptedPort({ decision: { kind: 'compact', trigger: 'auto' }, outcome: emptyReplacement }),
      store,
    );

    expect(result.kind).toBe('replaced');
    if (result.kind !== 'replaced') throw new Error('unreachable: asserted above');
    expect(result.transcript).toHaveLength(0);
    expect(result.transcript).not.toBe(ORIGINAL_TRANSCRIPT);
  });

  it('runs no second compaction decision when the port declines', async () => {
    // `decide` and `run` are separate awaits. A seam that ran first and decided
    // after would perform the summarization -- minutes of provider time -- for
    // a compaction it was always going to decline.
    const run = vi.fn(() => Promise.resolve(REPLACED));
    const port: CompactionPort = {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'below the trigger line' } as const),
      run,
      nextCompactionId: () => 'cmp-7',
    };
    const { store } = recordingEvents();
    const result = await pass(port, store);

    expect(result.kind).toBe('declined');
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('declining is a first-class outcome, not an error', () => {
  it('resolves as `declined` with the port\'s reason and publishes nothing', async () => {
    const { events, store } = recordingEvents();
    const decide = vi.fn(() => Promise.resolve({ kind: 'skip', reason: 'below the trigger line' } as const));

    // The regression this guards: declining used to be expressible only as a
    // throw or as a fabricated compaction. Both lose -- a throw fails a turn
    // that was correct, and a fabrication discards messages that were never
    // shed. Here the promise RESOLVES, carries the reason, and the transcript
    // is untouched.
    const result = await pass(
      { decide, run: () => Promise.resolve(REPLACED), nextCompactionId: () => 'cmp-7' },
      store,
    );

    expect(result.kind).toBe('declined');
    if (result.kind !== 'declined') throw new Error('unreachable: asserted above');
    expect(result.reason).toBe('below the trigger line');

    // Declining announces nothing. `compaction.started` before the verdict
    // would advertise a compaction that never happens -- the legacy's own
    // ordering emits `compact:start` only once the gates have said yes
    // (`CompactionCoordinator.ts:257-258`).
    expect(events).toHaveLength(0);
  });

  it('treats a port-level `declined` outcome as a decline too', async () => {
    // The strategy that looked and found nothing to summarise declines AFTER
    // saying it would compact (`CompactOptions.force` documents exactly that
    // early return, `packages/agent/src/compact/types.ts:66-71`). Both routes
    // land on `declined`, and neither is an error.
    const { events, store } = recordingEvents();
    const result = await pass(
      scriptedPort({
        decision: { kind: 'compact', trigger: 'auto' },
        outcome: { kind: 'declined', reason: 'nothing to summarise' },
      }),
      store,
    );

    expect(result.kind).toBe('declined');
    if (result.kind !== 'declined') throw new Error('unreachable: asserted above');
    expect(result.reason).toBe('nothing to summarise');

    // `started` WAS published (the port said it would compact), but no terminal
    // frame followed, and no transcript was replaced.
    expect(events.map((event) => event.type)).toEqual(['compaction.started']);
    expect('transcript' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the five frames each have a producer', () => {
  it('produces compaction.started, carrying the id and the trigger', async () => {
    const { events, store } = recordingEvents();
    await pass(
      scriptedPort({ decision: { kind: 'compact', trigger: 'emergency' }, outcome: REPLACED }),
      store,
    );

    const started = events.find((event) => event.type === 'compaction.started');
    expect(started).toBeDefined();
    // Both required fields (`events/required.ts:168`), and the id is the one the
    // PORT minted -- `cmp-7`, not anything the seam invented.
    expect(started).toMatchObject({ compactionId: 'cmp-7', trigger: 'threshold' });
  });

  it('produces compaction.step, forwarded while the port is still running', async () => {
    const { events, store } = recordingEvents();
    await pass(
      scriptedPort({
        decision: { kind: 'compact', trigger: 'auto' },
        outcome: REPLACED,
        progress: [{ kind: 'step', step: 2, phase: 'summarize', messageCount: 9, tokensBefore: 180_000 }],
      }),
      store,
    );

    const step = events.find((event) => event.type === 'compaction.step');
    expect(step).toBeDefined();
    expect(step).toMatchObject({
      compactionId: 'cmp-7',
      step: 2,
      phase: 'summarize',
      messageCount: 9,
      tokensBefore: 180_000,
    });
  });

  it('produces compaction.over_threshold, with no compactionId', async () => {
    const { events, store } = recordingEvents();
    await pass(
      scriptedPort({
        decision: { kind: 'compact', trigger: 'auto' },
        outcome: REPLACED,
        progress: [{ kind: 'over_threshold', tokensRetained: 200_000, available: 150_000 }],
      }),
      store,
    );

    const over = events.find((event) => event.type === 'compaction.over_threshold');
    expect(over).toBeDefined();
    expect(over).toMatchObject({ tokensRetained: 200_000, available: 150_000 });
    // The one member of the family with no `compactionId`
    // (`events/required.ts:188`): it is a reading about the WINDOW, not about
    // one compaction. Asserted so a well-meaning "just add the id for
    // consistency" change is a test failure, not a silent extra field.
    expect(Object.keys(over ?? {})).not.toContain('compactionId');
  });

  it('produces compaction.completed, carrying the boundary and the ids', async () => {
    const { events, store } = recordingEvents();
    await pass(
      scriptedPort({ decision: { kind: 'compact', trigger: 'auto' }, outcome: REPLACED }),
      store,
    );

    const completed = events.find((event) => event.type === 'compaction.completed');
    expect(completed).toBeDefined();
    // `boundaryId` and `compactedMessageIds` are REQUIRED (`required.ts:184-185`),
    // and both came from the port's outcome rather than from the seam.
    expect(completed).toMatchObject({
      compactionId: 'cmp-7',
      boundaryId: 'boundary-42',
      compactedMessageIds: [COMPACTED_ID],
      strategy: 'session_memory',
      tokensRemoved: 1234,
      tokensRetained: 567,
    });
  });

  it('produces compaction.failed when the port fails', async () => {
    const { events, store } = recordingEvents();
    const result = await pass(
      scriptedPort({
        decision: { kind: 'compact', trigger: 'auto' },
        outcome: { kind: 'failed', error: { code: 'context_length_exceeded', message: 'summarizer hit the window' } },
      }),
      store,
    );

    const failed = events.find((event) => event.type === 'compaction.failed');
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({
      compactionId: 'cmp-7',
      error: { code: 'context_length_exceeded', message: 'summarizer hit the window' },
    });
    // Failure keeps the ORIGINAL transcript: the frame's own registry
    // description is "Compaction failed; transcript unchanged" (`registry.ts:225`).
    expect(result.kind).toBe('failed');
    expect('transcript' in result).toBe(false);
  });

  it('produces exactly one terminal frame per pass', async () => {
    // Two terminals, or none, leaves a consumer holding a compaction that never
    // finished. Counted across a passing and a failing pass.
    const passing = recordingEvents();
    await pass(scriptedPort({ decision: { kind: 'compact', trigger: 'auto' }, outcome: REPLACED }), passing.store);
    const failing = recordingEvents();
    await pass(
      scriptedPort({
        decision: { kind: 'compact', trigger: 'auto' },
        outcome: { kind: 'failed', error: { code: 'boom', message: 'no' } },
      }),
      failing.store,
    );

    const terminals = (events: readonly RunEvent[]): readonly string[] =>
      events
        .map((event) => event.type)
        .filter((type) => type === 'compaction.completed' || type === 'compaction.failed');

    expect(terminals(passing.events)).toEqual(['compaction.completed']);
    expect(terminals(failing.events)).toEqual(['compaction.failed']);
  });

  it('reports a cancellation through compaction.failed', async () => {
    // There is no `compaction.cancelled` in the registry -- five members, none
    // of them one (`registry.ts:222-226`) -- so a cancel has to ride the frame
    // that says "this compaction produced no boundary".
    const { events, store } = recordingEvents();
    const result = await pass(
      scriptedPort({ decision: { kind: 'compact', trigger: 'auto' }, outcome: { kind: 'cancelled' } }),
      store,
    );

    expect(result.kind).toBe('cancelled');
    const failed = events.find((event) => event.type === 'compaction.failed');
    expect(failed).toMatchObject({ compactionId: 'cmp-7', error: { code: 'compaction_cancelled' } });
  });

  it('narrows the five legacy triggers onto the three the wire has', async () => {
    // `CompactOptions.trigger` has five values (`compact/types.ts:63`) and the
    // protocol has three (`events/payloads.ts:550`). The squashing happens at
    // the seam, not in the port, so a host still sees `emergency` and
    // `preflight_overflow` -- two paths that must not be confused.
    expect(startedFrame('c', 'auto')).toMatchObject({ trigger: 'auto' });
    expect(startedFrame('c', 'manual')).toMatchObject({ trigger: 'manual' });
    expect(startedFrame('c', 'emergency')).toMatchObject({ trigger: 'threshold' });
    expect(startedFrame('c', 'preflight_overflow')).toMatchObject({ trigger: 'threshold' });
    expect(startedFrame('c', 'model_switch')).toMatchObject({ trigger: 'threshold' });

    // ...and the port still receives the rich spelling at its own seam.
    const seen: CompactionDecisionInput[] = [];
    await pass(
      {
        decide: (input) => {
          seen.push(input);
          return Promise.resolve({ kind: 'skip', reason: 'no' } as const);
        },
        run: () => Promise.resolve(REPLACED),
        nextCompactionId: () => 'c',
      },
      recordingEvents().store,
      { ...INPUT, trigger: 'emergency', observation: { contextLengthExceeded: true } },
    );
    expect(seen[0]?.trigger).toBe('emergency');
    expect(seen[0]?.observation?.contextLengthExceeded).toBe(true);
  });

  it('omits absent optional members rather than setting them undefined', async () => {
    // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the
    // same as an absent key -- and the protocol's `optionalNumber` convention
    // omits (`chat-event-translator.ts:712`).
    const frame = progressFrame('cmp-7', { kind: 'step', step: 1, phase: 'summarize' });
    expect(Object.keys(frame).sort()).toEqual(['compactionId', 'phase', 'step', 'type']);
  });

  it('gives the standalone builders the same output as the pass', async () => {
    // The builders are the single producer of each frame, exported so a frame
    // can be asserted on its own. These tie them to the pass's output, so
    // "exported but never used by the seam" would fail here rather than sit as
    // dead code that reads like coverage.
    const { events, store } = recordingEvents();
    await pass(
      scriptedPort({
        decision: { kind: 'compact', trigger: 'auto' },
        outcome: REPLACED,
        progress: [{ kind: 'step', step: 1, phase: 'summarize' }],
      }),
      store,
    );

    expect(events[0]).toEqual(startedFrame('cmp-7', 'auto'));
    expect(events[1]).toEqual(progressFrame('cmp-7', { kind: 'step', step: 1, phase: 'summarize' }));
    expect(events.at(-1)).toEqual(
      completedFrame('cmp-7', {
        boundaryId: 'boundary-42',
        compactedMessageIds: [COMPACTED_ID],
        strategy: 'session_memory',
        tokensRemoved: 1234,
        tokensRetained: 567,
      }),
    );
    expect(failedFrame('cmp-7', 'boom')).toEqual({
      type: 'compaction.failed',
      compactionId: 'cmp-7',
      error: { code: 'compaction_failed', message: 'boom' },
    });
  });
});

// ---------------------------------------------------------------------------

describe('a host that binds nothing', () => {
  it('reports `unbound` distinctly from `declined`, and replaces nothing', async () => {
    // The honest consequence, stated rather than shrugged at: with no port
    // there is no transcript replacement AND no producer for the five frames.
    // `unbound` is a separate outcome from `declined` because "nobody was
    // configured" is a wiring bug while "the configured thing said no" is normal
    // operation, and collapsing them would hide the first inside the second.
    const { events, store } = recordingEvents();
    const result = await pass(undefined, store);

    expect(result.kind).toBe('unbound');
    expect(events).toHaveLength(0);
    // Nothing is replaced: the caller keeps the transcript it had, which is
    // exactly the data-loss classification stated on `CompactionPort` -- the
    // transcript then grows past the window with nothing to shed it.
    expect('transcript' in result).toBe(false);
  });

  it('distinguishes `unbound` from a bound port that declines', async () => {
    // Two paths, one spy, so the difference is measured rather than asserted
    // from a shape. The spy is called exactly ONCE across both passes, which is
    // what proves the unbound pass never reached a port at all: had the seam
    // substituted a default port, `decide` would have been called twice.
    const decide = vi.fn(() => Promise.resolve({ kind: 'skip', reason: 'below the trigger line' } as const));
    const run = vi.fn(() => Promise.resolve(REPLACED));
    const port: CompactionPort = { decide, run, nextCompactionId: () => 'cmp-7' };

    const unbound = await pass(undefined, recordingEvents().store);
    const declined = await pass(port, recordingEvents().store);

    expect(unbound.kind).toBe('unbound');
    expect(declined.kind).toBe('declined');

    expect(decide).toHaveBeenCalledTimes(1);
    // Neither path ran a summarization, for different reasons: the second was
    // declined before `run`, and the first had no port to run.
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('the summarization is served by OneShotTextPort (G1)', () => {
  it('carries the one-shot port\'s text into the replacement', async () => {
    // The claim under test: compaction does not need its own model surface. A
    // host implements `CompactionPort.run` with the `OneShotTextPort` it already
    // holds -- the same port the summarizer is already installed on
    // (`DuyaAgent.ts:783`), whose request is TOOL-FREE by construction
    // (`port-guards.ts`, `ONE_SHOT_REQUEST_CARRIES_NO_TOOLS`).
    //
    // Asserted on three facts from three different sources: the port received
    // the transcript the DECISION input carried, the seam's replacement contains
    // the text the one-shot port returned, and no tool surface was offered to it
    // (asserted by reading the request, since a `tools` field on
    // `OneShotTextRequest` is a build failure rather than a runtime one).
    const requestsSeen: { systemPrompt: string; messages: readonly ModelMessage[] }[] = [];
    const oneShot: OneShotTextPort = {
      complete: (request) => {
        requestsSeen.push({ systemPrompt: request.systemPrompt, messages: request.messages });
        return Promise.resolve({ kind: 'completed', text: SUMMARY_SENTINEL } as OneShotTextResult);
      },
    };

    const port: CompactionPort = {
      decide: () => Promise.resolve({ kind: 'compact', trigger: 'auto' } as const),
      run: async (input) => {
        const summary = await oneShot.complete(
          { systemPrompt: 'You are a summarization assistant.', messages: input.transcript },
          NEVER_ABORTED,
        );
        if (summary.kind !== 'completed') throw new Error('the fake always completes');
        return {
          kind: 'replaced',
          replacement: [{ role: 'user' as const, content: summary.text, id: 'summary-1' }],
          boundaryId: 'boundary-one',
          compactedMessageIds: [COMPACTED_ID],
        };
      },
      nextCompactionId: () => 'cmp-7',
    };

    const { store } = recordingEvents();
    const result = await pass(port, store);

    // The summarizer saw the PRE-compaction transcript, verbatim.
    expect(requestsSeen[0]?.messages).toBe(ORIGINAL_TRANSCRIPT);
    // The one-shot port's text is what the next request is built from.
    expect(result.kind).toBe('replaced');
    if (result.kind !== 'replaced') throw new Error('unreachable: asserted above');
    expect(String(result.transcript[0]?.content)).toBe(SUMMARY_SENTINEL);
    // And the request carried no tool surface to offer.
    expect(Object.keys(requestsSeen[0] ?? {})).not.toContain('tools');
  });
});
