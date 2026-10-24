/**
 * The request contract, as a matrix.
 *
 * ## What this file is
 *
 * `request-assembly.ts` states the shape of a provider request. This file is
 * the shape's TEST MATRIX: every combination of the five sources, and the
 * request each one must produce.
 *
 * It is a separate file rather than more cases in `run-engine-loop.test.ts`
 * because this is a CONTRACT, and a contract is read as a table: "these
 * inputs, this output". The engine's own loop tests ask whether the LOOP
 * works; this one asks what the request LOOKS LIKE, with the loop out of the
 * picture entirely.
 *
 * ## Why the matrix is the thing that keeps the order from drifting
 *
 * The prompt's position has been broken three times in this same expression,
 * every time the same way: the rule lived in a comment, and the next edit to
 * the expression did not have to obey it. A rule that lives in a table, with a
 * case per combination, breaks LOUDLY.
 *
 * ## The property under test
 *
 * THE REQUEST ENDS WITH THE QUESTION. Not "the question is after every row
 * the person said" -- that was the previous contract, and it is too weak: the
 * system-attached rows are `user` rows too, so a request that ends with the
 * rail still reads to the model as a turn with no question in it.
 *
 * The rows the host INJECTED are system rows as well, and that is the case
 * this file pins hardest: the inter-turn sweep runs on the FIRST turn too,
 * so a first turn's request can carry injected rows, and a request that ends
 * with one of them has the same defect with a different hat.
 */

import { describe, expect, it } from 'vitest';
import { assembleRequestMessages } from '../src/engine/request-assembly.js';
import type { ModelMessage } from '../src/engine/ports.js';

/** The run's prompt, as the engine carries it. */
const PROMPT: ModelMessage = { role: 'user', id: 'p1', content: 'what does the ui package look like?' };
/** The host's own rendering of the same message: same id, different content. */
const HOST_PROMPT: ModelMessage = { role: 'user', id: 'p1', content: 'what does the ui package look like? [host rendering]' };
/** A row the person said earlier. */
const PRIOR_UTTERANCE: ModelMessage = { role: 'user', id: 'u-1', content: 'hello' };
/** The model's own reply to it. */
const REPLY: ModelMessage = { role: 'assistant', id: 'a-1', content: 'hi' };
/** The volatile context rail: a row the SYSTEM attached. */
const RAIL: ModelMessage = {
  role: 'user',
  id: 'rail-1',
  content: '<system-reminder>the environment</system-reminder>',
  origin: 'context',
};
/** A hook's block: also attached by the SYSTEM, also a `user` row. */
const HOOK: ModelMessage = {
  role: 'user',
  id: 'hook-1',
  content: '<system-reminder>a hook said this</system-reminder>',
  origin: 'context',
};
/** An attachment's extracted text: the third kind of attached row. */
const ATTACHMENT: ModelMessage = {
  role: 'user',
  id: 'attachment-1',
  content: '<system-reminder>the attached file</system-reminder>',
  origin: 'context',
};
/** A fragment the engine carried over from earlier in the run. */
const CARRIED: ModelMessage = { role: 'user', id: 'fragment:tool_result:call-1', content: 'the tool result' };
/** A steering directive in force for this turn. */
const STEERING: ModelMessage = { role: 'user', id: 'steer-1', content: 'focus on the sidebar' };
/**
 * A row the host INJECTED into the request.
 *
 * NOT something the person typed. Every row the inter-turn sweep claims is
 * projected by the host through `projectRuntimeContextToProviderMessage`
 * (`packages/agent-core/src/message/message-projectors.ts:150`), which
 * stamps `metadata.runtimeContext = true`. The kinds are
 * `background_notification` -- which the host wraps in "system context, not
 * a user message" (`packages/host/src/worker-session-runtime.ts:1423`) -- and
 * agent-to-agent guidance.
 *
 * So it is a SYSTEM row of the same class as the rail, and rule 5 moves it
 * in front of the prompt with the rest of them.
 *
 * It deliberately carries NO `origin` marker: the placement must not depend
 * on a marker the adapter may or may not stamp, and the engine moves the
 * `inbound` ARRAY as a whole because the port it arrives on is the injected
 * port.
 */
const INBOUND: ModelMessage = { role: 'user', id: 'in-1', content: 'system context, not a user message: a background task finished' };

function assemble(overrides: {
  readonly hostMessages?: readonly ModelMessage[];
  readonly carried?: readonly ModelMessage[];
  readonly steering?: readonly ModelMessage[];
  readonly inbound?: readonly ModelMessage[];
  readonly isFirstTurn?: boolean;
}): readonly ModelMessage[] {
  return assembleRequestMessages({
    hostMessages: overrides.hostMessages ?? [],
    prompt: PROMPT,
    carried: overrides.carried ?? [],
    steering: overrides.steering ?? [],
    inbound: overrides.inbound ?? [],
    isFirstTurn: overrides.isFirstTurn ?? true,
  });
}

const ids = (messages: readonly ModelMessage[]): readonly string[] => messages.map((m) => m.id);

describe('the request contract', () => {
  it('ends with the question, moving the system-attached rows in front of it', () => {
    // The shape the host actually produces: the prompt is committed to the
    // timeline, and then the rail, the hook blocks and the attachment text
    // are APPENDED to the projection. Rule 5 moves the attached rows in
    // front of the question, so the request ENDS with what the person said.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'hook-1', 'rail-1', 'attachment-1', 'p1']);
    expect(messages.at(-1)?.id).toBe('p1');
    expect(messages.at(-1)?.content).toBe(HOST_PROMPT.content);
  });

  it('keeps the conversation ahead of the system-attached rows', () => {
    // The attached rows are moved, not promoted: they stay `user` rows with
    // no privilege, and they stay after the conversation they describe.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, RAIL],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'rail-1', 'p1']);
    expect(messages.find((m) => m.id === 'rail-1')?.origin).toBe('context');
  });

  it('sends the prompt once even when the host projected its id twice', () => {
    // Rule 1 is unconditional: one question, one request. The host's FIRST
    // copy is the one that survives, because that is the one in the
    // conversation's own order.
    const messages = assemble({
      hostMessages: [HOST_PROMPT, PRIOR_UTTERANCE, HOST_PROMPT, RAIL],
    });

    expect(messages.filter((m) => m.id === 'p1')).toHaveLength(1);
    expect(ids(messages)).toEqual(['u-1', 'rail-1', 'p1']);
    expect(messages.at(-1)?.id).toBe('p1');
  });

  it('stands the engine\'s own copy in when the host did not project it', () => {
    // The fallback stands where the host's copy would have been -- and the
    // request still ends with it.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, RAIL],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'rail-1', 'p1']);
    expect(messages.at(-1)?.content).toBe(PROMPT.content);
  });

  it('never puts the engine\'s copy at the front of the request', () => {
    // The defect this contract exists for: a question at the front of a
    // request is a question the model has to dig out from under the whole
    // conversation, with the system's context between it and the reader.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'p1']);
    expect(messages.at(-1)?.content).toBe(PROMPT.content);
  });

  it('leads with the engine\'s own new material on the first turn', () => {
    // Steering and carried fragments belong to this turn, and the
    // conversation is what they answer.
    //
    // The injected row is the host's INJECTION, and it is a SYSTEM row: the
    // sweep projects every claimed row through
    // `projectRuntimeContextToProviderMessage`, which stamps
    // `metadata.runtimeContext = true` -- a background notification or an
    // agent-to-agent guidance row, never something the person typed. So
    // rule 5 moves it in front of the prompt with the rest of the
    // system-attached rows, and the request ends with the question.
    //
    // This expectation CHANGED: it used to be `['…', 'rail-1', 'p1', 'in-1']`,
    // which put an injected row behind the question.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, HOST_PROMPT, RAIL],
      carried: [CARRIED],
      steering: [STEERING],
      inbound: [INBOUND],
    });

    expect(ids(messages)).toEqual(['steer-1', 'fragment:tool_result:call-1', 'u-1', 'rail-1', 'in-1', 'p1']);
    expect(messages.at(-1)?.id).toBe('p1');
  });

  it('ends with the question even when the sweep injected something', () => {
    // Rule 5 over the case the sweep makes possible. The inter-turn sweep
    // runs on EVERY turn, the first one included, so a first turn's request
    // can carry injected rows -- and a request whose last row is one of them
    // reads to the model as a turn with no question in it.
    //
    // Both kinds of system row are in this one request: the rail, the hook
    // blocks and the attachment text the host attached, and the row the
    // sweep injected. None of them may sit behind the question.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
      inbound: [INBOUND],
    });

    expect(messages.at(-1)?.id).toBe('p1');
    // No row at all behind the question -- not a system row, not a
    // conversation row.
    const promptIndex = ids(messages).indexOf('p1');
    expect(promptIndex).toBe(messages.length - 1);
    expect(messages.slice(promptIndex + 1)).toEqual([]);
  });

  it('never lets an injected row close the request', () => {
    // THE COUNTER-EXAMPLE.
    //
    // Every other case in this file asserts an ORDER; this one asserts the
    // PROPERTY the order exists to serve, so it fails for ANY arrangement
    // that leaves the injected row behind the question -- which is exactly
    // what the code did before the row was moved.
    //
    // The injected row is a SYSTEM row, and that is not an assumption this
    // test makes: the sweep claims mailbox rows and the host projects every
    // one of them through `projectRuntimeContextToProviderMessage`, which
    // stamps `metadata.runtimeContext = true`. The kinds are
    // `background_notification` (the host wraps it in "system context, not
    // a user message") and agent-to-agent guidance. Not one of them is
    // something the person typed.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, HOST_PROMPT, RAIL],
      inbound: [INBOUND],
    });

    const promptIndex = ids(messages).indexOf('p1');
    const injectedIndex = ids(messages).indexOf('in-1');
    expect(injectedIndex, 'the injected row must be in the request at all').toBeGreaterThanOrEqual(0);
    expect(promptIndex, 'the question must be in the request at all').toBeGreaterThanOrEqual(0);
    // The injected row comes BEFORE the question...
    expect(injectedIndex).toBeLessThan(promptIndex);
    // ...and the question is the LAST row, so nothing the system injected
    // can be what the model reads last.
    expect(messages.at(-1)?.id).toBe('p1');
  });

  it('moves the injected row in front of the engine\'s own copy of the prompt', () => {
    // The fallback branch has the same obligation as the host's-copy branch:
    // a request whose last row is an injected notification reads to the
    // model as a turn with no question in it, whichever copy of the prompt
    // ended up in the request.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, RAIL],
      inbound: [INBOUND],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'rail-1', 'in-1', 'p1']);
    expect(messages.at(-1)?.content).toBe(PROMPT.content);
  });

  it('trails with the engine\'s own new material on a later turn', () => {
    // Turn 2 is a continuation after tool results: the question is history
    // now, and what the model has to react to is the tool result. Moving the
    // question again would put it after the result it caused.
    //
    // The injected row stays LAST here, and that is the point: on a later
    // turn it is the most recent thing in the conversation, so it must not
    // be reordered BEHIND a history the model has already read. Rule 5 does
    // not apply to a turn that asks nothing.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, HOST_PROMPT, REPLY, RAIL],
      carried: [CARRIED],
      steering: [STEERING],
      inbound: [INBOUND],
      isFirstTurn: false,
    });

    expect(ids(messages)).toEqual(['u-1', 'p1', 'a-1', 'rail-1', 'fragment:tool_result:call-1', 'steer-1', 'in-1']);
    expect(messages.filter((m) => m.id === 'p1')).toHaveLength(1);
  });

  it('keeps a later turn\'s order EXACTLY as it was, injected row last', () => {
    // The explicit statement of the carve-out, so the two halves of the
    // contract cannot drift apart silently.
    //
    // On the FIRST turn the injected rows are moved in front of the prompt,
    // because rule 5 is about the turn that asks a question. On a LATER turn
    // nothing is moved at all: the host's rows keep the host's order, and the
    // injected row stays at the END. A tool continuation is not a turn that
    // ends with the question -- Anthropic carries tool results in `user` rows
    // too -- so there is nothing for rule 5 to fix there.
    //
    // This expectation did NOT change: it is the behaviour before this fix
    // and the behaviour after it, stated rather than incidental.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, HOST_PROMPT, REPLY, RAIL],
      carried: [CARRIED],
      steering: [STEERING],
      inbound: [INBOUND],
      isFirstTurn: false,
    });

    // The host's four rows, in the host's order, untouched.
    expect(ids(messages).slice(0, 4)).toEqual(['u-1', 'p1', 'a-1', 'rail-1']);
    // The engine's own material, then the injected row, last.
    expect(ids(messages).slice(4)).toEqual(['fragment:tool_result:call-1', 'steer-1', 'in-1']);
    expect(messages.at(-1)?.id).toBe('in-1');
  });

  it('does not re-send the prompt on a later turn', () => {
    // The host's rows are the whole transcript; the engine adds nothing but
    // its own injections. A prompt re-sent every turn is how a conversation
    // teaches a model to repeat itself.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY],
      isFirstTurn: false,
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1']);
  });

  it('leaves the host\'s order alone on a tool continuation', () => {
    // A tool continuation is NOT a turn that ends with the question. Anthropic
    // carries tool results in `user` rows, so a later turn's order is the
    // host's to keep -- moving rows there would break the tool call/result
    // pairing the provider needs.
    const toolResult: ModelMessage = {
      role: 'user',
      id: 'fragment:tool_result:call-1',
      content: 'the tool result',
    };
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, HOST_PROMPT, toolResult, RAIL],
      isFirstTurn: false,
    });

    expect(ids(messages)).toEqual(['u-1', 'p1', 'fragment:tool_result:call-1', 'rail-1']);
  });

  it('leaves an empty request empty', () => {
    expect(assemble({})).toEqual([PROMPT]);
  });

  it('ends with the question whatever the host attached', () => {
    // The property the whole contract exists for, over every kind of row the
    // system can attach: the question is the request's LAST row.
    //
    // Every case below also carries an INJECTED row, because the sweep runs
    // on the first turn too and a request that ends with a notification
    // instead of the question is the same defect with a different hat.
    const hosts: readonly (readonly ModelMessage[])[] = [
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, RAIL],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, ATTACHMENT],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
      [HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
    ];

    for (const hostMessages of hosts) {
      const messages = assemble({ hostMessages, inbound: [INBOUND] });
      expect(messages.at(-1)?.id).toBe('p1');
      expect(messages.filter((m) => m.id === 'p1')).toHaveLength(1);
      expect(ids(messages)).toContain('in-1');
    }
  });

  it('never leaves a system-attached row behind the question', () => {
    // The assertion that would have caught the defect: it is not enough for
    // the question to be the last thing the PERSON said -- the rows the
    // system attached are `user` rows too, and a request that ends with one
    // of them reads to the model as a turn with no question in it.
    //
    // The INJECTED rows are covered by their own case above, because they
    // do not carry the `origin` marker this one filters on -- the engine
    // moves them because the port they arrive on is the injected port.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
    });

    const promptIndex = ids(messages).indexOf('p1');
    const attachedAfter = messages.findIndex(
      (m, index) => index > promptIndex && m.origin === 'context',
    );
    expect(attachedAfter).toBe(-1);
  });
});
