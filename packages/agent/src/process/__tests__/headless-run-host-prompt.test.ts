/**
 * The caller's prompt must arrive at the executor, and these are the tests
 * that make that claim checkable rather than assumed.
 *
 * ## The defect this file pins
 *
 * Four hops stood between `HeadlessRunHost.start(intent)` and
 * `agent.streamChat`, and the third discarded the input. The controller bridge
 * in `headless-run-host.ts` accepted the run layer's real `RunStartInput` and
 * forwarded only the sink, so `InProcessTransport.start` had nothing to
 * dispatch and fabricated an empty one. Every headless and CLI run therefore
 * called `streamChat('', ...)`, whatever the caller had passed. The prompt did
 * not arrive degraded; it did not arrive at all.
 *
 * ## Why this suite is separate from the host's composition suite
 *
 * `headless-run-host.test.ts` proves the host is built from the real run layer,
 * and its executor doubles record the prompt into an array that no assertion
 * reads. The gap this file closes is narrow and deliberate: the double below
 * takes BOTH parameters and the assertions read what the executor was actually
 * handed. A double that cannot see the value cannot observe this defect, which
 * is the whole reason it shipped with every other gate green.
 *
 * ## What is deliberately NOT asserted here
 *
 * Nothing about the run layer's own behaviour. A prompt that arrives is the
 * only claim; whether the run then completes, budgets, or cancels is
 * `headless-run-host.test.ts`'s subject, and duplicating those assertions here
 * would make a failure ambiguous between the two files.
 */

import { describe, expect, it } from 'vitest';
import type { RunId } from '@duya/agent-protocol';
import {
  createHeadlessRunHost,
  type HeadlessAgent,
  type HeadlessFinalMessage,
} from '../headless-run-host.js';

/** The exact prompt the caller passes, so a mismatch is unambiguous. */
const CANARY = 'THE-PROMPT-abc123';

/** A session id the caller names, distinct from anything the host invents. */
const CANARY_SESSION = 'cli-session-abc123';

/** The run id this host is pinned to, so the runtime's own ids are checkable. */
const RUN_ID = 'run-prompt-1' as RunId;

/**
 * A stand-in for the caller's tool registry, compared BY IDENTITY.
 *
 * Deep equality would pass for a copy, and a copied registry would still be a
 * different object to a tool that compares itself against the agent's own.
 */
const TOOL_REGISTRY = { id: 'sentinel-registry', tools: ['Read', 'Bash'] } as const;

/** What the executor was actually handed, read from the executor's own mouth. */
interface Observed {
  readonly prompts: string[];
  readonly options: Readonly<Record<string, unknown>>[];
}

/**
 * The turn the executor replays.
 *
 * Held as a `const` array rather than written inline in the generator, for the
 * same reason the sibling suite holds its turn the same way: `HeadlessAgent`
 * types the yielded event as `{ type, data? }`, so an inline literal carrying a
 * third field (`reason` on `done`) trips the excess-property check. Yielding
 * from a pre-declared value is not a fresh literal and does not.
 *
 * `done` carries a `reason` because the finalized frame REQUIRES a stop reason;
 * a turn that ended without one produces no finalized message at all.
 */
const TURN = [
  { type: 'turn_start', data: { turnCount: 1 } },
  { type: 'text', data: 'ack' },
  { type: 'done', reason: 'completed' },
] as const;

/**
 * An executor double that RECEIVES the prompt and the options.
 *
 * Both parameters are taken on purpose, and that is the entire design of this
 * file: a double that does not RECORD what it was handed cannot assert on it.
 *
 * Worth being precise about why this defect survived, because the obvious
 * explanation is wrong. The sibling suite's `scriptedAgent` DOES declare
 * `streamChat(prompt)` and DOES push it into a `prompts` array -- it was never
 * structurally blind. `prompts` was populated on every run and asserted on
 * never. So the gap was a single missing assertion, not an unobservable
 * quantity, and the honest description of the fix is "assert what was already
 * being recorded", not "make it observable".
 *
 * `final` is returned rather than yielded, because the generator's RETURN
 * value is the authoritative assistant message on this path and the finalized
 * frame is built from it.
 */
function observingAgent(final: HeadlessFinalMessage | null = null): HeadlessAgent & Observed {
  const prompts: string[] = [];
  const options: Readonly<Record<string, unknown>>[] = [];
  return {
    prompts,
    options,
    async *streamChat(
      prompt: string,
      opts?: Readonly<Record<string, unknown>>,
    ): AsyncGenerator<
      { readonly type: string; readonly data?: unknown },
      HeadlessFinalMessage | void,
      unknown
    > {
      prompts.push(prompt);
      options.push(opts ?? {});
      for (const event of TURN) yield event;
      return final ?? undefined;
    },
    interrupt(): void {},
  };
}

function host(agent: HeadlessAgent) {
  return createHeadlessRunHost({
    agent,
    mintRunId: () => RUN_ID,
    now: () => 1_700_000_000_000,
  });
}

const BASE_INTENT = {
  sessionId: CANARY_SESSION,
  cwd: process.cwd(),
  model: 'test-model',
  providerId: 'test-provider',
} as const;

/** Drain a run's whole event stream, which is what settles it. */
async function collect(run: {
  events(): AsyncGenerator<{ seq: number; payload: { type: string } }, void, unknown>;
}): Promise<{ seq: number; payload: { type: string } }[]> {
  const seen: { seq: number; payload: { type: string } }[] = [];
  for await (const envelope of run.events()) seen.push(envelope);
  return seen;
}

describe('the caller\'s prompt reaches the executor', () => {
  it('delivers the prompt the caller passed, byte for byte', async () => {
    const agent = observingAgent();
    const run = await host(agent).start({ ...BASE_INTENT, prompt: CANARY });
    await collect(run);

    // The array is what the executor saw, one entry per `streamChat` call. An
    // empty string here is the defect in its whole: the run opened, the turn
    // completed, and the model was asked nothing.
    expect(agent.prompts).toEqual([CANARY]);
  });

  it('delivers a prompt that needs no cleaning, and cleans none of it', async () => {
    // Leading and trailing whitespace, an interior newline, and a multi-byte
    // character: a host that trimmed, collapsed, or normalised would still pass
    // the canary above and fail here, which is why the two cases are separate
    // rather than one prompt trying to be both.
    const messy = '  \u4e2d\u6587 first line\n  second line  ';
    const agent = observingAgent();
    const run = await host(agent).start({ ...BASE_INTENT, prompt: messy });
    await collect(run);

    expect(agent.prompts).toEqual([messy]);
  });

  it('delivers an intentionally empty prompt as empty, rather than inventing one', async () => {
    // The counterpart to the canary. An empty prompt is a real caller choice,
    // and the fix must not paper over it -- proving the value travels rather
    // than proving a substitution stopped.
    const agent = observingAgent();
    const run = await host(agent).start({ ...BASE_INTENT, prompt: '' });
    await collect(run);

    expect(agent.prompts).toEqual(['']);
  });

  it('does not assert the session, because the translator drops it by design', async () => {
    // The forwarded input carries `sessionId` too, and it reaches the frame
    // `buildMessageFinalizedEvent` builds -- but it is NOT observable from
    // here, and a test that could not observe it would be asserting on a value
    // nothing consumes. `translateMessageFinalized` substitutes the runtime's
    // own `ctx.messageId` for the producer's id precisely so one message cannot
    // appear in a transcript under two identities
    // (`chat-event-translator.ts:636-682`). The finalised event therefore
    // carries `m-${runId}`, whatever session the caller named, and the session
    // stops there.
    //
    // What this pins is the real fact: the executor ran with the caller's
    // session in its input, the finalised frame was produced from it, and the
    // run completed. The prompt assertions above are what prove the input
    // arrived rather than being discarded.
    const agent = observingAgent({ id: 'msg-1', content: [{ type: 'text', text: 'ack' }] });
    const run = await host(agent).start({ ...BASE_INTENT, prompt: CANARY });
    const events = await collect(run);

    const finalized = events.find((e) => e.payload.type === 'assistant.message_finalized');
    expect(finalized).toBeDefined();
    // The runtime's own message id, not the producer's -- the substitution the
    // translator documents. Read through a cast because `RunEvent` is a
    // discriminated union and `messageId` exists on one arm of it, not on all.
    const finalizedPayload = finalized?.payload as unknown as { messageId?: string };
    expect(finalizedPayload.messageId).toBe(`m-${RUN_ID}`);
    expect((await run.terminal).status).toBe('completed');
  });

  it('delivers the caller\'s tool registry to the executor', async () => {
    // The consequence of forwarding a real input rather than only the prompt:
    // `HeadlessRunHost.start` puts `toolRegistry` into the run layer's input
    // options, and until now those options were discarded alongside the prompt,
    // so a CLI run with a registry executed with no tools at all.
    const agent = observingAgent();
    const run = await host(agent).start({
      ...BASE_INTENT,
      prompt: CANARY,
      toolRegistry: TOOL_REGISTRY,
    });
    await collect(run);

    expect(agent.options).toHaveLength(1);
    // Identity, not equality: the executor must receive the caller's object.
    expect(agent.options[0]?.toolRegistry).toBe(TOOL_REGISTRY);
  });

  it('still merges the manifest turn ceiling into the executor\'s options', async () => {
    // The merge predates this fix and must survive it. Read together with the
    // registry assertion above, this is the shape of the options now: the
    // caller's own fields, plus the run layer's ceiling.
    const agent = observingAgent();
    const run = await host(agent).start({
      ...BASE_INTENT,
      prompt: CANARY,
      toolRegistry: TOOL_REGISTRY,
      maxTurns: 8,
    });
    await collect(run);

    expect(agent.options[0]).toMatchObject({ toolRegistry: TOOL_REGISTRY, maxTurns: 8 });
  });

  it('calls the executor once per run', async () => {
    // Guards the assertions above from passing for the wrong reason. A host
    // that dispatched twice, or that compared only the first entry of the
    // array, could satisfy an `toEqual([CANARY])` with a second lost prompt.
    const agent = observingAgent();
    const run = await host(agent).start({ ...BASE_INTENT, prompt: CANARY });
    await collect(run);

    expect(agent.prompts).toHaveLength(1);
  });
});