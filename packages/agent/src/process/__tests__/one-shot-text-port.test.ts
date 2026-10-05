/**
 * Plan 600 S2 step b1 (one-shot text port): the contract for a model call that
 * is NOT a turn, driven over a real provider client.
 *
 * ## What this file is the proof of
 *
 * Two call sites in `DuyaAgent` open a provider stream outside the agentic turn
 * loop, and both are single-shot, tool-free text generation: the compaction
 * summarizer (`:781`) and the side question (`:4483`). They are the only two
 * lines in that file matching `TURN_LOOP_SHAPE.modelStream`
 * (`/\.streamChat\s*\(/`), so they are what G7 and G8 are still open on.
 *
 * `ModelPort` cannot serve either of them -- `ModelRequest` has no
 * `toolChoice` (`ports.ts:372-391`) and the summarizer needs
 * `toolChoice: 'none'` deliberately (plan 523 P4.1) -- and `createLegacyModelPort`
 * cannot either, because it hardcodes `sources.llmMessages()` and
 * `sources.declaredTools()` (`run-engine-model.ts:371,373`) and serves ONE turn's
 * assembly rather than a standalone request. So this port is narrow on purpose,
 * and this file pins the four properties that narrowness buys.
 *
 * ## The four properties, and how each one can fail
 *
 *  1. **The text is aggregated correctly, and only once.** The summarizer joins
 *     `text` events; the side question concatenated them the same way. A
 *     dropped event loses a sentence, and a
 *     double-counted one is the same bug wearing the opposite sign -- which is
 *     why `text_delta` is in the script below rather than only in a comment.
 *  2. **The caller's `AbortSignal` reaches the provider.** This is the property
 *     the port exists for (`ports.ts`, "Why the signal is a parameter"). A
 *     wrapped or freshly built signal aborts nobody, and the summarizer's
 *     parent-linked child controller (`:776-780`) is the only thing that makes
 *     an interrupt reach it.
 *  3. **A failure is never an empty string.** The pre-b2 summarizer `break`ed on
 *     an `error` frame and returned the accumulated text, so a provider that
 *     failed on its first token stored `''` as a summary. An empty answer and a
 *     dead provider are different facts and get different `kind`s.
 *  4. **An unnamed ceiling stays the CLIENT's.** Same reasoning as
 *     `run-engine-model.ts:378-384`: a default invented here is a limit no
 *     caller agreed to, and it would be applied without anything in the request
 *     record showing it.
 *
 * ## Why these assertions are not `a === a`
 *
 * The aggregation expectations are literals written from what the provider
 * events MEAN, compared against text the implementation accumulated by walking
 * the stream, so a dropped or repeated event cannot satisfy them. The
 * cancellation test compares the signal object the CLIENT received by identity
 * against the controller this test built -- two different objects in the failing
 * implementation, because a wrapped signal is a new object. The defaults test
 * asserts PRESENCE of a key rather than its value, which is the only form a
 * hardcoded default cannot survive unless it happens to equal the client's own.
 *
 * ## What this file does NOT prove
 *
 * That either call site USES this port. This file tests the port in isolation;
 * the cutover, and the gate-regex assertion that it really happened, live in
 * `packages/agent/tests/unit/agent/one-shot-calls.test.ts` (step b2).
 */

import { describe, expect, it } from 'vitest';
import { createOneShotTextPort } from '../run-engine-model.js';
import type { OneShotTextRequest } from '@duya/agent-runtime';
import type { SSEEvent } from '@duya/ai';

// ============================================================================
// Fixtures — shaped the way the PRODUCER builds them
// ============================================================================

/** The summarizer's system prompt, verbatim (`DuyaAgent.ts:793`). */
const SUMMARIZER_SYSTEM_PROMPT =
  'You are a summarization assistant. Follow the instructions embedded in the user message.';

/** The transcript plus the nine-section contract, in ONE user turn (`:768-773`). */
const TRANSCRIPT_AND_INSTRUCTIONS = 'USER: ship the thing\nASSISTANT: shipped\n\n## Summary\n1. ...';

const REQUEST: OneShotTextRequest = {
  systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
  messages: [
    { role: 'user', content: TRANSCRIPT_AND_INSTRUCTIONS, id: 'm1' },
    // Block-shaped on purpose: `toProviderMessages` is a real projection, so a
    // request that flattens or drops the blocks fails here where a
    // string-content-only fixture would pass either way.
    { role: 'assistant', content: [{ type: 'text', text: 'noted' }], id: 'm2' },
  ],
};

const OK: SSEEvent = { type: 'done', reason: 'end_turn' };

/**
 * A client that records every call and replays a fixed script.
 *
 * `ignoreSignal` models a provider that cannot be cancelled, and it is the only
 * way to test the case the port has to get right on its own: the caller asked to
 * stop, the provider answered anyway, and nothing in the provider's own output
 * says so.
 */
function oneShotClient(
  script: readonly SSEEvent[],
  options: {
    readonly ignoreSignal?: boolean;
    /** Thrown by the generator once the script is exhausted, as a transport would. */
    readonly throwAfterScript?: unknown;
    /** Runs as each event is produced, so a test can cancel MID-STREAM. */
    readonly onEvent?: (event: SSEEvent) => void;
  } = {},
) {
  const seen: { messages: unknown; options: Record<string, unknown> }[] = [];
  return {
    seen,
    streamChat(messages: unknown, requestOptions: Record<string, unknown>) {
      seen.push({ messages, options: requestOptions });
      const signal = requestOptions.signal as AbortSignal | undefined;
      const cancelled = (): boolean => signal?.aborted === true && options.ignoreSignal !== true;
      return (async function* () {
        for (const event of script) {
          // What a `fetch`-backed stream does: an abort is observable, and the
          // generator stops instead of finishing. Checked BEFORE the first yield
          // too, because a provider handed an already-aborted signal never
          // produces anything at all.
          if (cancelled()) throw abortError();
          options.onEvent?.(event);
          yield event;
          if (cancelled()) throw abortError();
        }
        if (options.throwAfterScript !== undefined) throw options.throwAfterScript;
      })();
    },
  };
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** A live, unaborted signal -- the "nothing went wrong" control. */
function live(): AbortSignal {
  return new AbortController().signal;
}

function portFor(client: unknown): ReturnType<typeof createOneShotTextPort> {
  // `as never` for the same reason `run-engine-model-frames.test.ts:401` uses it:
  // the fake is structurally an `AIClient` but does not implement every member.
  return createOneShotTextPort(client as never);
}

// ============================================================================
// 1. The text
// ============================================================================

describe('createOneShotTextPort — the aggregated answer', () => {
  it('joins the provider text in order, and stops at done', async () => {
    const client = oneShotClient([
      { type: 'text', data: '## Summary\n' },
      { type: 'text', data: '- kept the plan\n' },
      { type: 'text', data: '- dropped the noise' },
      OK,
      // The provider said it was done. Anything after this is not part of the
      // answer, and the pre-b2 loop broke on `done` too.
      { type: 'text', data: 'TEXT AFTER DONE' },
    ]);

    const result = await portFor(client).complete(REQUEST, live());

    expect(result).toEqual({
      kind: 'completed',
      text: '## Summary\n- kept the plan\n- dropped the noise',
    });
  });

  it('counts each piece ONCE, so a text_delta cannot double the answer', async () => {
    // No provider emits the SSE `text_delta`: the internal event system carries
    // one (`packages/ai/src/types.ts:415`) and the single funnel into the SSE
    // vocabulary maps it to `text` (`emit-sse.ts:23-27`). The side question used
    // to read both arms before step b2, so an implementation that
    // accumulated both would double every answer the day a provider started
    // emitting one. The expected text is built from the `text` events ALONE.
    const client = oneShotClient([
      { type: 'text', data: 'one ' },
      { type: 'text_delta', data: 'one ' },
      { type: 'text', data: 'two' },
      OK,
    ]);

    const result = await portFor(client).complete(REQUEST, live());

    expect(result).toEqual({ kind: 'completed', text: 'one two' });
  });

  it('returns the text UNTRIMMED, because trimming is the caller\'s storage decision', async () => {
    // Both call sites trim (`DuyaAgent.ts:814`, `:4526`) and both are
    // right to: a trim belongs to whoever stores or displays the answer. A port
    // that trimmed would fold "the model emitted only whitespace" into the same
    // `''` as "the model emitted nothing" -- the one distinction the `kind` on
    // the result exists to keep.
    const client = oneShotClient([{ type: 'text', data: '  ## Summary  ' }, OK]);

    const result = await portFor(client).complete(REQUEST, live());

    expect(result).toEqual({ kind: 'completed', text: '  ## Summary  ' });
  });

  it('reports a real empty answer as a completion, not as a failure', async () => {
    // The model chose to say nothing. That is a fact about the ANSWER, and it
    // must not be reported through the arm that means "the provider died".
    const client = oneShotClient([OK]);

    const result = await portFor(client).complete(REQUEST, live());

    expect(result).toEqual({ kind: 'completed', text: '' });
  });
});

// ============================================================================
// 2. The request that reaches the provider
// ============================================================================

describe('createOneShotTextPort — what reaches the provider', () => {
  it('carries the system prompt and the projected messages', async () => {
    const client = oneShotClient([{ type: 'text', data: 'x' }, OK]);

    await portFor(client).complete(REQUEST, live());

    expect(client.seen[0]?.options.systemPrompt).toBe(SUMMARIZER_SYSTEM_PROMPT);
    // The provider shape, not the runtime shape: `id` is preserved and block
    // content survives as blocks. Written out rather than compared against
    // `REQUEST.messages`, because the whole crossing is a projection.
    expect(client.seen[0]?.messages).toEqual([
      { role: 'user', content: TRANSCRIPT_AND_INSTRUCTIONS, id: 'm1' },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }], id: 'm2' },
    ]);
    // And it is a different array: the provider annotates the messages it is
    // given (surrogate sanitising, model-identity transforms), so handing over
    // the caller's array would let it mutate the caller's own request.
    expect(client.seen[0]?.messages).not.toBe(REQUEST.messages);
  });

  it('forbids tool calling, and sends no tool set at all', async () => {
    // The reason this port exists rather than a `ModelRequest` with
    // `tools: []`: plan 523 P4.1 added `toolChoice: 'none'` because the
    // summarizer was emitting tool-call tokens instead of a summary, and the
    // provider implements it by omitting the
    // tools field from the wire payload (`packages/ai/src/types.ts:497-502`).
    // "No tools available" is a weaker promise than "tools forbidden".
    const client = oneShotClient([{ type: 'text', data: 'x' }, OK]);

    await portFor(client).complete(REQUEST, live());

    expect(client.seen[0]?.options.toolChoice).toBe('none');
    expect('tools' in (client.seen[0]?.options ?? {})).toBe(false);
  });

  it('leaves the client\'s own defaults in place when the caller named neither', async () => {
    // PRESENCE, not value. `run-engine-model.ts:378-384` makes the same
    // argument for the turn: `maxTokens: undefined` is a different request from
    // no `maxTokens` at all, and a hardcoded default satisfies a value check
    // only if it happens to coincide with the client's.
    const client = oneShotClient([{ type: 'text', data: 'x' }, OK]);

    await portFor(client).complete(REQUEST, live());

    expect('maxTokens' in (client.seen[0]?.options ?? {})).toBe(false);
    expect('temperature' in (client.seen[0]?.options ?? {})).toBe(false);
  });

  it('forwards the caller\'s ceiling and temperature when it named both', async () => {
    // The summarizer's real pair (`DuyaAgent.ts:802-803`), so this doubles as
    // evidence that both call sites fit the port with no default needed.
    const client = oneShotClient([{ type: 'text', data: 'x' }, OK]);

    await portFor(client).complete(
      { ...REQUEST, maxOutputTokens: 8192, temperature: 0.3 },
      live(),
    );

    expect(client.seen[0]?.options.maxTokens).toBe(8192);
    expect(client.seen[0]?.options.temperature).toBe(0.3);
  });
});

// ============================================================================
// 3. Cancellation
// ============================================================================

describe('createOneShotTextPort — the caller\'s signal reaches the provider', () => {
  it('hands over the EXACT signal object, and reports the call as cancelled', async () => {
    const client = oneShotClient([{ type: 'text', data: 'never delivered' }, OK]);
    const controller = new AbortController();
    controller.abort(new Error('user pressed stop'));

    const result = await portFor(client).complete(REQUEST, controller.signal);

    // Identity, not "it is aborted": a port that built its own controller would
    // abort nobody, and the provider would never learn the user stopped. The
    // summarizer's whole reason for a parent-linked CHILD controller
    // (`DuyaAgent.ts:776-780`) is that this is the caller's linkage to own.
    const observed = client.seen[0]?.options.signal as AbortSignal | undefined;
    expect(observed).toBe(controller.signal);
    expect(observed?.aborted).toBe(true);
    expect((observed?.reason as Error).message).toBe('user pressed stop');
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('reports a cancel that lands mid-stream as cancelled, not as a short answer', async () => {
    const controller = new AbortController();
    const client = oneShotClient(
      [{ type: 'text', data: 'half a ' }, { type: 'text', data: 'summary' }, OK],
      { onEvent: (event) => (event.type === 'text' ? controller.abort() : undefined) },
    );

    const result = await portFor(client).complete(REQUEST, controller.signal);

    // `'half a '` is real text the provider produced, and it is deliberately
    // NOT the answer: the pre-b2 summarizer stored whatever it had accumulated
    // when it stopped, which is how a half-written
    // summary became a durable record.
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('reports cancelled even when the provider answers despite the abort', async () => {
    // The case a thrown-value check cannot catch: the provider ignored its
    // signal and produced a complete answer, so nothing in its output says the
    // user stopped. The caller asked to stop and has no way to detect that, so
    // the port has to decide it from the caller's own signal.
    const script: readonly SSEEvent[] = [{ type: 'text', data: 'the full answer' }, OK];
    const controller = new AbortController();
    controller.abort();
    const ignoring = oneShotClient(script, { ignoreSignal: true });

    const cancelled = await portFor(ignoring).complete(REQUEST, controller.signal);
    // Control: the SAME script, unaborted, is a completed answer. Without this
    // the assertion above would also pass for an implementation that always
    // returns `cancelled`.
    const control = await portFor(oneShotClient(script)).complete(REQUEST, live());

    expect(cancelled).toEqual({ kind: 'cancelled' });
    expect(control).toEqual({ kind: 'completed', text: 'the full answer' });
  });
});

// ============================================================================
// 4. Failure is never an empty string
// ============================================================================

describe('createOneShotTextPort — a failure is not an empty answer', () => {
  it('reports a provider error event with the provider\'s own words', async () => {
    const client = oneShotClient([
      { type: 'text', data: 'partial' },
      { type: 'error', data: 'context_length_exceeded' },
    ]);

    const result = await portFor(client).complete(REQUEST, live());

    // `data` IS the provider's message (`packages/ai/src/types.ts:190`) and it is
    // the string the side question rethrows (`DuyaAgent.ts:4532`).
    // The partial text is not carried on the failure, so nothing here can be
    // mistaken for a summary.
    expect(result).toEqual({ kind: 'failed', error: { message: 'context_length_exceeded' } });
  });

  it('reports a thrown transport failure rather than letting it read as empty', async () => {
    // NO `done` in this script, and that is the point: a transport that dies
    // mid-answer never sends one. The half-answer it had already produced is
    // real text, so an implementation that swallowed the throw would report a
    // summary cut off mid-word as a finished one.
    //
    // (A `done` followed by a throw is deliberately NOT this fixture: `done` is
    // the provider saying it finished, so a failure after it has nothing left
    // to invalidate.)
    const client = oneShotClient([{ type: 'text', data: 'half' }], {
      throwAfterScript: new Error('socket hang up'),
    });

    const result = await portFor(client).complete(REQUEST, live());

    expect(result).toEqual({ kind: 'failed', error: { message: 'socket hang up' } });
  });

  it('keeps the empty completion and the failure as two different values', async () => {
    // The property the whole union exists for. Before it, both the summarizer
    // that `break`s on `error` (`:807-809`) and a hypothetical provider that
    // died on its first token produced the same `''`, and that value went into
    // storage as a compaction summary.
    const empty = await portFor(oneShotClient([OK])).complete(REQUEST, live());
    const failed = await portFor(oneShotClient([{ type: 'error', data: 'upstream 503' }])).complete(
      REQUEST,
      live(),
    );

    expect(empty).toEqual({ kind: 'completed', text: '' });
    expect(failed).toEqual({ kind: 'failed', error: { message: 'upstream 503' } });
    // Two different `kind`s, and only one of them carries an error -- so a
    // consumer that switches on `kind` cannot conflate them even if it ignores
    // every field.
    expect(empty.kind).not.toBe(failed.kind);
    expect('error' in empty).toBe(false);
    expect('error' in failed).toBe(true);
  });
});
