/**
 * The shape of a provider request, as a contract.
 *
 * ## Why this is its own module
 *
 * A model request is assembled from five sources, and the ORDER of those
 * sources is not a formatting detail -- it is the difference between "the
 * model is being asked a question" and "the model is being handed some
 * context". That order used to be one array expression inside
 * `RunEngineImpl.#modelRequest`, next to a wall of prose explaining it: a
 * shape where the rule can only be changed by someone editing the rule they
 * were supposed to obey.
 *
 * The rule has been broken twice now, both times in the same place -- the
 * prompt's position. `01344cd3` put the engine's copy of the prompt at the
 * FRONT of the request; `b8dda429` fixed that by keeping the host's copy
 * instead. Both fixes were local edits of an expression, and the next one
 * will be too, unless the rule has a name and a table.
 *
 * ## The contract
 *
 * The FIRST turn of a run is:
 *
 *     [steering…, carried…, host rows…, the prompt if the host did not
 *      project it, inbound…]
 *
 * and every later turn is:
 *
 *     [host rows…, carried…, steering…, inbound…]
 *
 * with four rules that the rest of this file exists to protect:
 *
 *  1. **THE PROMPT IS SENT EXACTLY ONCE.** A host that assembles the turn
 *     from its own timeline projects this turn's user row into the messages
 *     it hands over, and that row IS the prompt -- the host committed it
 *     under the id the run input names. The two are one message reached by
 *     two roads, and a request that carries both makes the model answer the
 *     same question twice.
 *  2. **THE HOST'S COPY WINS, WHERE THE HOST PUT IT.** The row the host
 *     committed sits where the conversation puts it -- after the turns it
 *     answers -- and that is the copy the legacy sent, because the legacy's
 *     transcript WAS the timeline. The engine's own copy would sit ahead of
 *     the turns it is answering, so when the host's copy is there, the
 *     engine's is the one that goes.
 *  3. **WHEN THE HOST DID NOT PROJECT IT, THE ENGINE'S COPY GOES AT THE END
 *     OF THE CONVERSATION -- never at the front.** The engine's copy is the
 *     fallback for a host that does not project its own user rows, and a
 *     question at the front of a request is a question the model has to dig
 *     out from under the whole conversation. The end of the conversation is
 *     where the host's own copy would have been, so the two branches of
 *     rule 1 produce the same request.
 *  4. **A LATER TURN DOES NOT CARRY THE PROMPT AT ALL.** Turn 2 is a
 *     continuation after tool results: the question is history now, and what
 *     the model has to react to is the tool result. A prompt re-sent every
 *     turn is how a conversation teaches a model to repeat itself.
 *
 * Identity is the message ID, and it is the only thing it can be: the engine
 * cannot compare prose (the host may have rendered the prompt into the row's
 * content differently) and must not drop a message on a heuristic.
 *
 * ## What the contract does NOT say
 *
 * It does not say where the host's SYSTEM-attached rows go. The volatile
 * context rail, a hook's block and an attachment's extracted text are `user`
 * rows the host projects, and they say in so many words that they are not
 * part of the user's message. The host owns where they sit inside its own
 * projection, and the engine does not reorder them -- it only needs to know
 * where the conversation ENDS, which is what `origin: 'context'` is for.
 */

import type { ModelMessage } from './ports.js';

/**
 * The five sources of a request, plus the one fact that changes their order.
 *
 * `isFirstTurn` is a fact about the RUN, not about the request: the prompt
 * rides the first turn only, because a later turn is a continuation after
 * tool results.
 */
export interface RequestAssemblyParts {
  /**
   * The host's assembled messages: the transcript it projected, plus the rows
   * the SYSTEM attached to it.
   */
  readonly hostMessages: readonly ModelMessage[];
  /** The run's prompt. */
  readonly prompt: ModelMessage;
  /** Fragments the engine carried over from earlier in this run. */
  readonly carried: readonly ModelMessage[];
  /** Steering directives in force for this turn. */
  readonly steering: readonly ModelMessage[];
  /** Text the host injected into this request. */
  readonly inbound: readonly ModelMessage[];
  /** Whether this is the run's first turn -- the only one that carries the prompt. */
  readonly isFirstTurn: boolean;
}

/**
 * Assemble a provider request's messages.
 *
 * See the module header for the contract and the four rules it protects.
 */
export function assembleRequestMessages(parts: RequestAssemblyParts): readonly ModelMessage[] {
  if (!parts.isFirstTurn) {
    // Rule 4. The host's rows are the whole transcript; the engine adds its
    // own material and nothing else.
    return [...parts.hostMessages, ...parts.carried, ...parts.steering, ...parts.inbound];
  }

  const promptId = parts.prompt.id;
  const hostCarriesPrompt = promptId !== undefined &&
    parts.hostMessages.some((message) => message.id === promptId);

  if (hostCarriesPrompt) {
    // Rules 1 and 2. The host's row IS the prompt, it is already in the
    // request, and it stays exactly where the host put it -- and if the host
    // projected it more than once, the FIRST copy is the one that survives,
    // because that is the one in the conversation's own order.
    return [
      ...parts.steering,
      ...parts.carried,
      ...firstCopyOnly(parts.hostMessages, promptId),
      ...parts.inbound,
    ];
  }

  // Rules 1 and 3. The host did not project the prompt row, so the engine
  // supplies its own -- at the end of the CONVERSATION, which is where the
  // host's copy would have been, and never at the front of the request.
  const at = endOfConversation(parts.hostMessages);
  return [
    ...parts.steering,
    ...parts.carried,
    ...parts.hostMessages.slice(0, at),
    parts.prompt,
    ...parts.hostMessages.slice(at),
    ...parts.inbound,
  ];
}

/**
 * The host's rows, with every copy of the prompt but the first dropped.
 *
 * A host that projects the prompt row twice would otherwise answer the
 * question twice, which is the failure rule 1 exists to remove.
 */
function firstCopyOnly(
  messages: readonly ModelMessage[],
  promptId: string | undefined,
): readonly ModelMessage[] {
  if (promptId === undefined) return messages;
  let seen = false;
  return messages.filter((message) => {
    if (message.id !== promptId) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/**
 * The index just after the last row the PERSON said.
 *
 * The rows the system attached (`origin: 'context'`) are not conversation, so
 * they do not count. A host that marks nothing has every row read as
 * conversation, which is the conservative reading: the prompt then lands
 * after the whole host projection rather than inside it.
 */
function endOfConversation(messages: readonly ModelMessage[]): number {
  let at = 0;
  for (const [index, message] of messages.entries()) {
    if (message.origin !== 'context') at = index + 1;
  }
  return at;
}
