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
 * The prompt's position has been broken twice in this same expression, both
 * times the same way: the rule lived in a comment, and the next edit to the
 * expression did not have to obey it. A rule that lives in a table, with a
 * case per combination, breaks LOUDLY.
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
/** A row the SYSTEM attached: the volatile context rail. */
const RAIL: ModelMessage = {
  role: 'user',
  id: 'rail-1',
  content: '<system-reminder>the environment</system-reminder>',
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
  it('keeps the host\'s prompt row where the host put it, and drops the engine\'s copy', () => {
    // The host committed the row after the turns it answers, and that is the
    // copy the legacy sent. The engine's copy would sit ahead of them.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, RAIL],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'p1', 'rail-1']);
    expect(messages.filter((m) => m.id === 'p1')).toHaveLength(1);
    expect(messages.find((m) => m.id === 'p1')?.content).toBe(HOST_PROMPT.content);
  });

  it('sends the prompt once even when the host projected its id twice', () => {
    // Rule 1 is unconditional: one question, one request. The host's FIRST
    // copy is the one that survives, because that is the one in the
    // conversation's own order.
    const messages = assemble({
      hostMessages: [HOST_PROMPT, PRIOR_UTTERANCE, HOST_PROMPT],
    });

    expect(messages.filter((m) => m.id === 'p1')).toHaveLength(1);
    expect(ids(messages)).toEqual(['p1', 'u-1']);
  });

  it('puts the engine\'s own copy at the end of the CONVERSATION when the host did not project it', () => {
    // The fallback slot is where the host's copy would have been: after the
    // last thing the person said, and before the rows the SYSTEM attached.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, RAIL],
    });

    expect(ids(messages)).toEqual(['u-1', 'a-1', 'p1', 'rail-1']);
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

    expect(ids(messages)).toEqual(['steer-1', 'fragment:tool_result:call-1', 'u-1', 'p1', 'rail-1', 'in-1']);
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

  it('leaves an empty request empty', () => {
    expect(assemble({})).toEqual([PROMPT]);
  });

  it('keeps the prompt after every row the PERSON said', () => {
    // The property the whole contract exists for, stated over the source
    // that matters: nothing the person said comes after the question. A row
    // the SYSTEM attached may follow it -- the host owns where its own
    // context sits -- but a later utterance would mean the question is no
    // longer the newest thing said.
    const messages = assemble({
      hostMessages: [PRIOR_UTTERANCE, REPLY, HOST_PROMPT, RAIL],
    });

    const promptIndex = ids(messages).indexOf('p1');
    const laterUtterance = messages.findIndex(
      (m, index) => index > promptIndex && m.origin !== 'context',
    );
    expect(laterUtterance).toBe(-1);
  });
});
