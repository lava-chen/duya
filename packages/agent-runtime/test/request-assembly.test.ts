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
/** Text the host injected into this request. */
const INBOUND: ModelMessage = { role: 'user', id: 'in-1', content: 'the user typed while you were working' };

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
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, HOST_PROMPT, RAIL],
      carried: [CARRIED],
      steering: [STEERING],
      inbound: [INBOUND],
    });

    expect(ids(messages)).toEqual(['steer-1', 'fragment:tool_result:call-1', 'u-1', 'rail-1', 'p1', 'in-1']);
  });

  it('trails with the engine\'s own new material on a later turn', () => {
    // Turn 2 is a continuation after tool results: the question is history
    // now, and what the model has to react to is the tool result. Moving the
    // question again would put it after the result it caused.
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
    const hosts: readonly (readonly ModelMessage[])[] = [
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, RAIL],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, ATTACHMENT],
      [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
      [HOST_PROMPT, HOOK, RAIL, ATTACHMENT],
    ];

    for (const hostMessages of hosts) {
      const messages = assemble({ hostMessages });
      expect(messages.at(-1)?.id).toBe('p1');
      expect(messages.filter((m) => m.id === 'p1')).toHaveLength(1);
    }
  });

  it('never leaves a system-attached row behind the question', () => {
    // The assertion that would have caught the defect: it is not enough for
    // the question to be the last thing the PERSON said -- the rows the
    // system attached are `user` rows too, and a request that ends with one
    // of them reads to the model as a turn with no question in it.
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
