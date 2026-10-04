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

/** Deps over a client scripted to die retryably, then succeed. */
function replayDeps(client: unknown, onRetryReset: () => void): TurnStreamRunnerDeps {
  return {
    llmClient: client as TurnStreamRunnerDeps['llmClient'],
    llmMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
    systemPromptContent: 'sys',
    tools: [{ name: 'echo', description: 'echo', input_schema: { type: 'object' } }],
    maxTokens: 1024,
    temperature: 1,
    signal: new AbortController().signal,
    turnCount: 1,
    turnCommitted: false,
    refreshDeclaredTools: () => new Set(['echo']),
    onRetryReset,
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
    const leg = buildTurnModelLeg({ turn: 1, deps: replayDeps(dyingClient(calls), () => (resets += 1)) });

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
    const leg = buildTurnModelLeg({
      turn: 1,
      deps: replayDeps(dyingClient(calls), () => undefined),
    });

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
    const leg = buildTurnModelLeg({
      turn: 1,
      deps: {
        ...replayDeps({}, () => undefined),
        llmMessages: messages,
      },
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

function stubLeg(turn: number, signal?: AbortSignal): TurnModelLeg {
  return {
    turn,
    client: {} as TurnModelLeg['client'],
    messages: () => [],
    declaredTools: [],
    signal: signal ?? new AbortController().signal,
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
    publisher.publish(stubLeg(3, controller.signal));
    controller.abort();

    // Streaming it would yield nothing, which is indistinguishable from a model
    // that chose to say nothing.
    expect(() => publisher.requireLeg()).toThrow(/request signal has fired/);
  });
});
