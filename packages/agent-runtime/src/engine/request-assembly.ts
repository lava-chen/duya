/**
 * The shape of a provider request, as a contract.
 *
 * ## Why this is its own module
 *
 * A model request is assembled from five sources, and the ORDER of those
 * sources is not a formatting detail -- it is the difference between "the
 * model is being asked a question" and "the model is being handed some
 * context". The order used to live in one array expression inside
 * `RunEngineImpl.#modelRequest`, next to a wall of prose explaining it, which
 * is a shape where the rule can only be changed by someone editing the rule
 * they were supposed to obey.
 *
 * Measured on a real TUI session: the prompt was placed FIRST, so the request
 * the model read was
 *
 *     [user(question), user(older conversation), user(rail), user(rail)]
 *
 * and the model answered "the user hasn't asked a new question -- this is
 * just system context attached". The question was in the request the whole
 * time; it was simply not the newest thing in it.
 *
 * So the contract is stated ONCE, here, and the engine calls it.
 *
 * ## The contract
 *
 * The FIRST turn of a run is:
 *
 *     [conversation…, carried…, steering…, THE PROMPT, inbound…]
 *
 * and every later turn is:
 *
 *     [conversation…, carried…, steering…, inbound…]
 *
 * with three rules that the rest of this file exists to protect:
 *
 *  1. **THE PROMPT IS THE NEWEST THING THE PERSON SAID.** It is the last
 *     row before the engine's own injections, so a model reading the request
 *     from the end reads the question, not the context that followed it.
 *  2. **THE PROMPT IS SENT EXACTLY ONCE.** A host that assembles the turn
 *     from its own timeline projects this turn's user row into the messages
 *     it hands over, and that row IS the prompt -- the host committed it
 *     under the id the run input names. The host's row is MOVED to the end
 *     rather than copied there, so the host's own rendering of the turn (its
 *     attachments, its quote prefix) survives, and every other row carrying
 *     that id is dropped, so the question is not asked twice.
 *  3. **A LATER TURN DOES NOT MOVE IT.** Turn 2 is a continuation after tool
 *     results: the question is history now, and what the model has to react
 *     to is the tool result. Moving the question again would put it after the
 *     result it caused.
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
 * projection, and the engine does not reorder them -- it only guarantees
 * that the prompt is after them.
 */

import type { ModelMessage } from './ports.js';

/**
 * The five sources of a request, plus the one fact that changes their order.
 *
 * `isFirstTurn` is a fact about the RUN, not about the request: the prompt
 * rides the first turn only, because a later turn is a continuation after
 * tool results and re-appending the prompt every turn is how a conversation
 * teaches a model to repeat itself.
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
 * See the module header for the contract and the three rules it protects.
 */
export function assembleRequestMessages(parts: RequestAssemblyParts): readonly ModelMessage[] {
  if (!parts.isFirstTurn) {
    // Rule 3: the host's rows stay where the host put them, and the prompt
    // is not re-appended. The tool result this turn is about is the newest
    // thing, and the question it answers is already in the transcript.
    return [...parts.hostMessages, ...parts.carried, ...parts.steering, ...parts.inbound];
  }

  // Rules 1 and 2: the host's own copy of the prompt row is the prompt, and
  // it is the one that is sent. `input.prompt` is only used when the host
  // did not project the row.
  const promptId = parts.prompt.id;
  const hostPrompt = promptId === undefined
    ? undefined
    : parts.hostMessages.find((message) => message.id === promptId);
  const prompt: ModelMessage = hostPrompt ?? parts.prompt;
  const conversation: readonly ModelMessage[] = hostPrompt === undefined
    ? parts.hostMessages
    : parts.hostMessages.filter((message) => message.id !== promptId);

  return [...conversation, ...parts.carried, ...parts.steering, prompt, ...parts.inbound];
}
