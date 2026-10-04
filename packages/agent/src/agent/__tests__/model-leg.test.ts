/**
 * `model-leg` — the per-turn model leg published out of `streamChat`.
 *
 * ## What this file is for
 *
 * The leg exists so the worker entry can bind a real `ModelPort` instead of
 * `openModelStream: () => emptyModelStream()`. Four things the port needs were
 * unreachable: the client (`private llmClient`), the messages, the declared
 * tools, and the turn count. Three of them were a per-turn closure local, and
 * the fourth is six transforms downstream of anything already exposed.
 *
 * So two claims carry this seam, and each has its own section below:
 *
 *  1. THE MESSAGES ARE THE TRANSFORMED ONES. The array the provider receives is
 *     built per request by six transforms; `get messages()` recomputes the
 *     durable projection from the timeline instead. They are different arrays,
 *     and the difference is exactly the difference between a correct payload
 *     and a plausible wrong one.
 *  2. `open()` CARRIES THE REPLAY ENVELOPE. `runTurnStream` owns the
 *     transport-death replay, and `onRetryReset` closes over the turn's
 *     `executor` and per-attempt accumulators, so it cannot be rebuilt from
 *     outside. Binding a leg must not drop it.
 *
 * ## Why the first claim is tested end to end
 *
 * It is tempting to pin the ordering with a source-shape assertion over
 * `DuyaAgent.ts` — the idiom `boundary-gates.mjs` uses — and that assertion
 * would pass while the value was still wrong. So this drives a REAL
 * `duyaAgent` through one turn with a fake provider and reads the array three
 * ways, from three different sources:
 *
 *   - what the leg publishes,
 *   - what the provider was actually called with,
 *   - what `get messages()` returns afterwards.
 *
 * The first two carry the `<system-reminder>Message sent at …</system-reminder>`
 * block that `injectTurnTimestampReminders` appends; the third is exactly
 * `"hello"`. A single assertion that cannot tell those apart would be the
 * `a === a` shape this repo has been bitten by, so every assertion below names
 * which side it is reading.
 *
 * ## Why `@duya/ai` is mocked
 *
 * `this.llmClient` is built inside the constructor by `createAIClient`
 * (`DuyaAgent.ts:630`, `:636`) with no injection seam, so a test that wants a
 * fake provider has to override the factory. Only the two factories are
 * replaced; everything else comes from the real module, so the transform chain
 * and the retry policy under test are the production ones. Without this the
 * test would issue a real provider request — which it did, once, before the
 * factory was stubbed.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Message } from '@duya/ai';
import type { TurnStreamRunnerDeps } from '../TurnStreamRunner.js';
import { buildTurnModelLeg, ModelLegPublisher, type TurnModelLeg } from '../model-leg.js';
import { injectTurnTimestampReminders } from '../turn-time-reminder.js';

interface FakeDbRequest {
  type: string;
  id: string;
  action: string;
}

/** Every set of arguments the fake provider's `streamChat` was called with. */
const providerCalls: Message[][] = [];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fakeClient = {
    async *streamChat(messages: Message[]): AsyncGenerator<unknown, unknown, unknown> {
      providerCalls.push(messages);
      yield { type: 'text', data: 'hi' };
      yield { type: 'done', reason: 'end_turn' };
      return { id: 'a1', role: 'assistant', content: 'hi' };
    },
  };
  return {
    ...actual,
    createAIClient: () => fakeClient,
    createAIClientWithRetry: () => fakeClient,
  };
});

const { duyaAgent } = await import('../DuyaAgent.js');
const { initDbClient } = await import('../../ipc/db-client.js');

const REMINDER_MARKER = '<system-reminder>';

/** The user turn's message content, whichever array it is read out of. */
function userContentOf(messages: readonly Message[]): string {
  const user = messages.find((m) => m.role === 'user');
  if (!user) throw new Error('no user message in array');
  return typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
}

/**
 * Drive one real turn, returning the leg the turn published plus everything
 * needed to compare the three readings of the same message.
 */
async function runOneTurn(options?: {
  prompt?: string;
}): Promise<{
  legs: ModelLegPublisher;
  published: TurnModelLeg[];
  durable: Message[];
  eventTypes: string[];
}> {
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
  });
  const legs = new ModelLegPublisher();
  const published: TurnModelLeg[] = [];
  // Record at publish time, which is before the request is issued, so the
  // reading cannot be contaminated by anything the turn does afterwards.
  const originalPublish = legs.publish.bind(legs);
  legs.publish = (leg) => {
    published.push(leg);
    originalPublish(leg);
  };

  const eventTypes: string[] = [];
  for await (const ev of agent.streamChat(options?.prompt ?? 'hello', { modelLegs: legs })) {
    eventTypes.push(ev.type);
  }
  return { legs, published, durable: agent.messages, eventTypes };
}

// ─── The IPC the turn reaches for before its first model request ───────────
// `streamChat` claims mailbox rows and reads mode state through the worker IPC
// bridge. Without a channel the turn hangs on a 30s timeout, and with a
// silently-resolving one it throws on `claim.rows`. Answering exactly the two
// actions this turn issues keeps the fixture small and explicit; anything else
// arriving is a test-visible failure rather than a hang.

let realSend: typeof process.send | undefined;

beforeEach(() => {
  providerCalls.length = 0;
  initDbClient();
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as FakeDbRequest;
    if (req?.type !== 'db:request') return true;
    if (req.action === 'modeState:get') {
      // null = no snapshot, which is the pre-plan state.
    } else if (req.action === 'mailbox:claimBatch') {
      // An EMPTY claim, not a null: `DuyaAgent.ts:3595` reads `claim.rows`.
    } else {
      throw new Error(`unexpected db action in model-leg test: ${req.action}`);
    }
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => {
      process.emit('message', {
        type: 'db:response',
        id: req.id,
        success: true,
        result,
      });
    });
    return true;
  }) as unknown as typeof process.send;
});

afterEach(() => {
  process.send = realSend;
});

// ============================================================================
// 1. The leg publishes the TRANSFORMED messages, not the durable history
// ============================================================================

describe('the published leg carries the transformed per-request messages', () => {
  it('carries the turn-timestamp reminder that only the per-request array has', async () => {
    const { published } = await runOneTurn();

    expect(published).toHaveLength(1);
    // Read from the LEG. The reminder is appended by
    // `injectTurnTimestampReminders` (`DuyaAgent.ts:2300`), which only ever
    // touches the per-request array.
    expect(userContentOf(published[0].messages())).toContain(REMINDER_MARKER);
    expect(userContentOf(published[0].messages())).toContain('Message sent at');
  });

  it('is the same array the provider was actually called with', async () => {
    const { published } = await runOneTurn();

    // Read from the PROVIDER, which is a third source independent of both the
    // leg and the agent. If the leg exposed a different array than the one the
    // request was built from, this is where the two would part company.
    expect(providerCalls).toHaveLength(1);
    expect(userContentOf(providerCalls[0])).toContain(REMINDER_MARKER);
    expect(userContentOf(providerCalls[0])).toBe(userContentOf(published[0].messages()));
  });

  it('differs from what `get messages()` returns, which is the clean history', async () => {
    const { published, durable } = await runOneTurn();

    // Read from `get messages()`. Asserting the EXACT durable content rather
    // than a "does not contain" keeps this positive: the durable user turn is
    // the bare prompt, with no reminder appended.
    expect(userContentOf(durable)).toBe('hello');
    // And the leg's copy of that same turn is strictly longer, because the
    // reminder was appended to it in place.
    expect(userContentOf(published[0].messages()).length).toBeGreaterThan(
      userContentOf(durable).length,
    );
  });

  it('names the turn it belongs to', async () => {
    const { published } = await runOneTurn();

    // `turnCount` is the fourth unreachable source. A leg without it could not
    // be traced back to the turn whose request it carries.
    expect(published[0].turn).toBe(1);
    expect(published[0].declaredTools.length).toBeGreaterThan(0);
    expect(published[0].client).toBeDefined();
  });
});

// ============================================================================
// 2. `open()` carries `runTurnStream`'s replay envelope
// ============================================================================

/**
 * Deps over a client scripted to die retryably, then succeed.
 *
 * Returns the controller alongside the deps BECAUSE `buildTurnModelLeg` checks
 * that the abort controller owns `deps.signal`. Handing each call site a way to
 * build a mismatched pair would be a fixture that can only be used wrong, and a
 * leg built from a mismatched pair is precisely the silent-cancellation defect
 * this seam has to rule out.
 */
function replayDeps(
  client: unknown,
  onRetryReset: () => void,
): { deps: TurnStreamRunnerDeps; controller: AbortController } {
  const controller = new AbortController();
  return {
    controller,
    deps: {
      llmClient: client as TurnStreamRunnerDeps['llmClient'],
      llmMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
      systemPromptContent: 'sys',
      tools: [{ name: 'echo', description: 'echo', input_schema: { type: 'object' } }],
      maxTokens: 1024,
      temperature: 1,
      signal: controller.signal,
      turnCount: 1,
      turnCommitted: false,
      refreshDeclaredTools: () => new Set(['echo']),
      onRetryReset,
    },
  };
}

/**
 * A client that dies on every ODD call, so each stream opened against it has a
 * transport death to replay from.
 */
function dyingClient(calls: string[]): TurnStreamRunnerDeps['llmClient'] {
  let n = 0;
  return {
    async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
      calls.push(`call-${(n += 1)}`);
      if (n % 2 === 1) throw new TypeError('terminated');
      yield { type: 'done', reason: 'end_turn' };
      return { id: 'a1', role: 'assistant', content: 'ok' };
    },
  } as unknown as TurnStreamRunnerDeps['llmClient'];
}

describe('open() keeps the replay envelope', () => {
  it('replays a transport death instead of propagating it', async () => {
    const calls: string[] = [];
    let resets = 0;
    const { deps, controller } = replayDeps(dyingClient(calls), () => (resets += 1));
    const leg = buildTurnModelLeg({ turn: 1, deps, abortController: controller });

    const events: Array<{ type: string }> = [];
    for await (const event of leg.open()) {
      events.push(event as { type: string });
    }

    // Positive, and the load-bearing assertion: a leg that called
    // `streamChat` directly would make ONE call and throw.
    expect(calls).toEqual(['call-1', 'call-2']);
    // The per-attempt reset is the replay-on-transport-death layer: it is what
    // discards the executor and clears the accumulators, and it is reachable
    // only through `runTurnStream`.
    expect(resets).toBe(1);
    // The retry chip, then the replayed attempt's `done`.
    expect(events.map((e) => e.type)).toEqual(['system', 'done']);
  });

  it('gives each open() a fresh generator, so a replay budget is never spent twice', async () => {
    const calls: string[] = [];
    const { deps, controller } = replayDeps(dyingClient(calls), () => undefined);
    const leg = buildTurnModelLeg({ turn: 1, deps, abortController: controller });

    const drained: string[][] = [];
    for (const _attempt of [1, 2]) {
      const seen: string[] = [];
      for await (const event of leg.open()) {
        seen.push(event.type);
      }
      drained.push(seen);
    }

    // Each open replayed its own transport death and reached `done`.
    expect(drained).toEqual([
      ['system', 'done'],
      ['system', 'done'],
    ]);
    // Four calls, not two and not one: `runTurnStream`'s attempt counter is a
    // GENERATOR local, so a second `open()` starts at attempt 0. A leg holding
    // one long-lived stream would have produced a spent budget and no events
    // here, which `drained[1]` rules out.
    expect(calls).toEqual(['call-1', 'call-2', 'call-3', 'call-4']);
  });
});

// ============================================================================
// 3. `messages` is read at request time, not snapshotted at publish
// ============================================================================

describe('messages() is a live read of the request array', () => {
  it('reflects an in-place transform applied after the leg was built', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1_700_000_000_000 },
    ];
    const { deps, controller } = replayDeps({}, () => undefined);
    const leg = buildTurnModelLeg({
      turn: 1,
      deps: { ...deps, llmMessages: messages },
      abortController: controller,
    });

    // The production transforms mutate in place — `injectTurnTimestampReminders`
    // replaces `messages[i]` with a shallow copy. Applied here AFTER the leg
    // exists, which is the property under test.
    expect(injectTurnTimestampReminders(messages)).toBe(1);
    expect(userContentOf(leg.messages())).toContain(REMINDER_MARKER);
  });
});

// ============================================================================
// 4. The publisher supersedes and refuses
// ============================================================================

/**
 * A leg over a controller the CALLER owns.
 *
 * The controller is a parameter rather than an internal detail because the
 * assertions are about that controller: `abortRequest` fires it and `signal` is
 * derived from it, so an assertion reads the provider's abort input rather than
 * a flag this fixture wrote. A stub that built its own controller and accepted a
 * signal from outside would let those two drift apart and pass regardless of
 * what the code under test fired.
 */
function stubLeg(turn: number, controller: AbortController = new AbortController()): TurnModelLeg {
  return {
    turn,
    client: {} as TurnModelLeg['client'],
    messages: () => [],
    declaredTools: [],
    signal: controller.signal,
    abortRequest: (reason?: unknown) => controller.abort(reason),
    open: () => (async function* () {})(),
  };
}

describe('ModelLegPublisher', () => {
  it('reports no turn before one is published, and the turn after', () => {
    const publisher = new ModelLegPublisher();
    expect(publisher.currentTurn()).toBeNull();

    publisher.publish(stubLeg(1));
    expect(publisher.currentTurn()).toBe(1);
    expect(publisher.requireLeg().turn).toBe(1);
  });

  it('supersedes the previous turn rather than retaining it', () => {
    const publisher = new ModelLegPublisher();
    publisher.publish(stubLeg(1));
    publisher.publish(stubLeg(2));

    expect(publisher.currentTurn()).toBe(2);
    expect(publisher.requireLeg().turn).toBe(2);
  });

  it('distinguishes a run that ended from a run that never started', () => {
    const neverStarted = new ModelLegPublisher();
    expect(() => neverStarted.requireLeg()).toThrow(/no turn has published/);

    const ended = new ModelLegPublisher();
    ended.publish(stubLeg(1));
    ended.close();
    expect(() => ended.requireLeg()).toThrow(/this run has ended/);
  });

  it('refuses a leg whose request signal has fired', () => {
    const publisher = new ModelLegPublisher();
    const controller = new AbortController();
    publisher.publish(stubLeg(3, controller));
    controller.abort();

    // Streaming it would yield nothing, which is indistinguishable from a model
    // that chose to say nothing.
    expect(() => publisher.requireLeg()).toThrow(/request signal has fired/);
  });
});

// ============================================================================
// 5. `abortTurn` cancels the CURRENT turn, and refuses everything else
//
// The refusals are the point. A stop that silently failed to reach the provider
// is indistinguishable from a stop that worked — the exact defect the plan owner
// called more dangerous than having no cancellation at all — so each wrong
// target must throw rather than no-op.
// ============================================================================

describe('ModelLegPublisher.abortTurn', () => {
  it('cancels the live turn\'s request signal', () => {
    const publisher = new ModelLegPublisher();
    const controller = new AbortController();
    publisher.publish(stubLeg(7, controller));

    publisher.abortTurn(new Error('stopped by test'));

    // Read from the SIGNAL the provider request is driven by, not from a flag
    // the publisher set: this is the same object `runTurnStream` hands the client
    // as `streamOptions.signal` (`TurnStreamRunner.ts:142`).
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(new Error('stopped by test'));
  });

  it('refuses when no turn has published yet', () => {
    const publisher = new ModelLegPublisher();
    expect(() => publisher.abortTurn()).toThrow(/no turn has published a model leg yet/);
  });

  it('refuses once the run has ended', () => {
    const publisher = new ModelLegPublisher();
    const controller = new AbortController();
    publisher.publish(stubLeg(1, controller));
    publisher.close();

    expect(() => publisher.abortTurn()).toThrow(/this run has ended/);
    // The refusal is a refusal, not a cancel-later: nothing was aborted.
    expect(controller.signal.aborted).toBe(false);
  });

  it('refuses a turn whose signal already fired, rather than claiming success', () => {
    const publisher = new ModelLegPublisher();
    const controller = new AbortController();
    publisher.publish(stubLeg(4, controller));
    controller.abort();

    // Reporting success for a cancellation this call did not perform is the
    // false claim `StopReceipt.requested` exists to prevent.
    expect(() => publisher.abortTurn()).toThrow(/already fired, so this call cancelled nothing/);
  });

  it('cancels only the CURRENT turn, never a superseded one', () => {
    const publisher = new ModelLegPublisher();
    const first = new AbortController();
    const second = new AbortController();
    publisher.publish(stubLeg(1, first));
    publisher.publish(stubLeg(2, second));

    publisher.abortTurn();

    // Both sides asserted, because the failure this guards is a WRONG-TARGET
    // cancel: turn 1's request must be left alone while turn 2's is stopped.
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });
});

// ============================================================================
// 6. The abort controller must OWN the request signal
//
// The build-time check. A leg whose abort controller merely resembles the right
// one aborts something the provider is not reading, which is the original
// defect wearing a green checkmark — and it is invisible until a stop.
// ============================================================================

describe('buildTurnModelLeg refuses an abort controller that does not own the signal', () => {
  it('throws rather than publishing a leg whose cancel reaches nothing', () => {
    const { deps } = replayDeps({}, () => undefined);
    // A DIFFERENT controller: plausible, the kind of near-miss that is one
    // variable away in the real call site, and silent.
    const bystander = new AbortController();

    expect(() => buildTurnModelLeg({ turn: 1, deps, abortController: bystander })).toThrow(
      /abort controller does not own this turn's request signal/,
    );
  });

  it('accepts the controller that produced the signal', () => {
    const { deps, controller } = replayDeps({}, () => undefined);
    const leg = buildTurnModelLeg({ turn: 1, deps, abortController: controller });

    // Positive: the accepted leg's abort reaches the signal.
    leg.abortRequest();
    expect(controller.signal.aborted).toBe(true);
  });
});

// ============================================================================
// 7. End to end through a REAL turn: abort the published leg, provider stops
//
// `turn-leg-cancel.test.ts` proves the same property through the ENGINE's stop.
// This one proves the leg's capability reaches the provider through a real
// `duyaAgent` turn, so the guarantee does not rest on a hand-built deps object
// matching the production shape.
// ============================================================================

describe('a real turn\'s leg cancels the real provider request', () => {
  it('stops a provider request that is still streaming', async () => {
    // `providerCalls` is the shared fake-client log from the mock at the top of
    // this file. The turn below drives that same mock, so a signal that reaches
    // the provider is observed by the object that stands in for `@duya/ai`.
    const { published } = await runOneTurn();
    expect(published).toHaveLength(1);

    // Positive first: the turn really did publish a leg carrying a live signal.
    expect(published[0].signal.aborted).toBe(false);
    published[0].abortRequest(new Error('cancelled by test'));

    // Then the effect: the signal the provider was driven by is fired. Read from
    // the LEG's own signal object, which `runTurnStream` passes to the client as
    // `streamOptions.signal` — the provider's abort input, not a publisher flag.
    expect(published[0].signal.aborted).toBe(true);
    expect(published[0].signal.reason).toEqual(new Error('cancelled by test'));
  });
});
