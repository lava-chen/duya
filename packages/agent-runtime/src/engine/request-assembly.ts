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
 * The rule has been broken three times now, all in the same place -- the
 * prompt's position. `01344cd3` put the engine's copy of the prompt at the
 * FRONT of the request; `b8dda429` fixed that by keeping the host's copy
 * instead; `69a84dab` made the order a contract and, in doing so, pinned the
 * host's copy to "where the host put it" -- which is STILL not the end of the
 * request, because the host appends its system-attached rows AFTER the
 * prompt. Every one of those fixes was a local edit of an expression, and
 * the next one will be too, unless the rule has a name and a table.
 *
 * ## The defect this contract exists for
 *
 * A TUI session asked the agent a question and the model answered that no
 * new question had been asked -- that it had only been handed context. The
 * question WAS in the request. It was not the LAST thing in it: the host's
 * volatile-context rail, the hook blocks and the attachment text are all
 * `user` rows the host appends AFTER the prompt, and each says in so many
 * words that it is not part of the user's message. A model reads a
 * conversation from the end, so it read the rail and concluded there was no
 * question.
 *
 * The fix is not "put the prompt last among the rows the PERSON said". It is
 * "put the prompt last, period" -- rule 5 below.
 *
 * ## The contract
 *
 * The FIRST turn of a run is:
 *
 *     [steering…, carried…, conversation…, system-attached…, inbound…, the prompt]
 *
 * and every later turn is:
 *
 *     [host rows…, carried…, steering…, inbound…]
 *
 * with five rules that the rest of this file exists to protect:
 *
 *  1. **THE PROMPT IS SENT EXACTLY ONCE.** A host that assembles the turn
 *     from its own timeline projects this turn's user row into the messages
 *     it hands over, and that row IS the prompt -- the host committed it
 *     under the id the run input names. The two are one message reached by
 *     two roads, and a request that carries both makes the model answer the
 *     same question twice.
 *  2. **THE HOST'S COPY WINS.** The row the host committed sits where the
 *     conversation puts it -- after the turns it answers -- and that is the
 *     copy the legacy sent, because the legacy's transcript WAS the timeline.
 *     The engine's own copy would sit ahead of the turns it is answering, so
 *     when the host's copy is there, the engine's is the one that goes.
 *  3. **WHEN THE HOST DID NOT PROJECT IT, THE ENGINE'S COPY STANDS IN.** The
 *     engine's copy is the fallback for a host that does not project its own
 *     user rows. It is placed where the host's copy would have been -- which
 *     is the end of the conversation -- and never at the front of the
 *     request, where a question is a question the model has to dig out from
 *     under the whole conversation.
 *  4. **A LATER TURN DOES NOT CARRY THE PROMPT AT ALL.** Turn 2 is a
 *     continuation after tool results: the question is history now, and what
 *     the model has to react to is the tool result. A prompt re-sent every
 *     turn is how a conversation teaches a model to repeat itself. A tool
 *     continuation is also NOT a turn that ends with the question: Anthropic
 *     carries tool results in `user` rows too, so a later turn's order is
 *     left exactly as the host built it -- including the `inbound` rows,
 *     which stay at the END of a later turn's request. Rule 5 is a rule
 *     about the turn that ASKS something, and a later turn does not.
 *  5. **THE REQUEST ENDS WITH THE QUESTION.** Every row the SYSTEM attached
 *     is moved in FRONT of the prompt -- the rail, the hook blocks, the
 *     attachment text AND the `inbound` rows -- so the prompt is the
 *     request's last row. This is the rule the defect above turns on, and
 *     it is why the host's position for the prompt is not the host's to
 *     keep: the host appends the rail, the hook blocks and the attachment
 *     text to the END of its projection, and a request whose last row is one
 *     of those reads to the model as a turn with no question in it.
 *
 * Identity is the message ID, and it is the only thing it can be: the engine
 * cannot compare prose (the host may have rendered the prompt into the row's
 * content differently) and must not drop a message on a heuristic.
 *
 * ## What `inbound` IS, and why rule 5 covers it
 *
 * `inbound` is the text the HOST injected into this request: the rows the
 * inter-turn sweep claimed and projected into the request
 * (`run-engine.ts`, the `interTurn.sweep({checkpoint: 'before_model_turn'})`
 * call). The sweep runs on EVERY turn, the first one included.
 *
 * Every one of those rows was built by `projectRuntimeContextToProviderMessage`
 * (`packages/agent-core/src/message/message-projectors.ts:150`), which
 * stamps `metadata.runtimeContext = true`. The kinds are
 * `background_notification` -- explicitly wrapped in "system context, not a
 * user message" by the host (`packages/host/src/worker-session-runtime.ts:1423`)
 * -- and agent-to-agent guidance. NOT ONE of them is a message the person
 * typed: they are system-attached rows of exactly the same class as the
 * rail, which is why they are `user` rows that say in so many words that
 * they are not part of the user's message.
 *
 * So they are moved with the other system-attached rows, and the first
 * turn's request ends with the question whether the sweep claimed anything
 * or not. Leaving them at the END was an unnamed exception to rule 5, and
 * an unnamed exception is a rule the next editor does not have to obey.
 *
 * ## What the contract does NOT say
 *
 * It does not say WHERE INSIDE the conversation the system-attached rows go,
 * or that the engine may promote them to a privileged role. They are context
 * the host chose to attach, and their trust level is the host's business:
 * a project file's instructions are not the same thing as the agent's own
 * identity, and only the provider adapter knows which channel can carry
 * which. The engine moves them and nothing else.
 *
 * Nor does it say the engine RECOGNISES a system row. The `inbound` rows are
 * system rows by the port's construction -- the port is the injected-rows
 * port, and the sweep only ever hands over rows the host projected as
 * runtime context -- so the engine moves that ARRAY and never inspects the
 * rows inside it. Nothing here depends on a row carrying an `origin` marker
 * it may or may not carry.
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
  /**
   * Text the host injected into this request.
   *
   * The rows the inter-turn sweep claimed: background-task notifications and
   * agent-to-agent guidance. They are SYSTEM rows by construction -- every one
   * of them was projected by `projectRuntimeContextToProviderMessage`, which
   * stamps `metadata.runtimeContext = true` -- and not one of them is a
   * message the person typed. See the module header, "What `inbound` IS".
   */
  readonly inbound: readonly ModelMessage[];
  /** Whether this is the run's first turn -- the only one that carries the prompt. */
  readonly isFirstTurn: boolean;
}

/**
 * Assemble a provider request's messages.
 *
 * See the module header for the contract and the five rules it protects.
 */
export function assembleRequestMessages(parts: RequestAssemblyParts): readonly ModelMessage[] {
  if (!parts.isFirstTurn) {
    // Rule 4. The host's rows are the whole transcript; the engine adds its
    // own material and nothing else. A TOOL CONTINUATION is not a turn that
    // asks a question: the tool result is the newest thing the model has to
    // react to, and Anthropic carries tool results in `user` rows too, so the
    // order of the host's rows is load-bearing here and is not touched.
    //
    // The `inbound` rows stay at the END of a later turn's request, and that
    // is deliberate rather than an oversight: they ride every request for the
    // rest of the run because they edited the transcript, and the legacy's
    // reason for putting them last is that the injected message is the most
    // recent thing in the conversation, so it must not be reordered BEHIND a
    // history the model has already read. Rule 5 does not apply here -- it
    // is the rule about the turn that ASKS something, and a tool continuation
    // does not ask anything.
    return [...parts.hostMessages, ...parts.carried, ...parts.steering, ...parts.inbound];
  }

  const promptId = parts.prompt.id;
  const hostCarriesPrompt = promptId !== undefined &&
    parts.hostMessages.some((message) => message.id === promptId);

  if (hostCarriesPrompt) {
    // Rules 1, 2 and 5. The host's row IS the prompt, it is already in the
    // request, and it is the row the request ENDS with. If the host projected
    // it more than once, the FIRST copy is the one that survives, because that
    // is the one in the conversation's own order.
    //
    // The rows the system attached are moved in front of it (rule 5), which
    // is the whole point of the reordering: the host appends them to the END
    // of its projection, and a request whose LAST row is a system-attached
    // row reads to the model as a turn with no question in it.
    //
    // The `inbound` rows are moved with them, and for the same reason: the
    // sweep runs on the first turn too, so a request that ended with them
    // ended with a notification rather than with the question. They are
    // placed AFTER the host's own context rows and BEFORE the prompt, so the
    // prompt is the request's last row whatever the sweep claimed.
    const promptRow = firstCopyOf(parts.hostMessages, promptId);
    const context = parts.hostMessages.filter((message) => message.origin === 'context');
    const rest = parts.hostMessages.filter(
      (message) => message.origin !== 'context' && message.id !== promptId,
    );
    return [
      ...parts.steering,
      ...parts.carried,
      ...rest,
      ...context,
      ...parts.inbound,
      promptRow,
    ];
  }

  // Rules 1, 3 and 5. The host did not project the prompt row, so the engine
  // supplies its own -- and the request still ENDS with it: the rows the
  // system attached are moved in front of it, never behind it. The `inbound`
  // rows are system rows too (the module header says why), so they move with
  // them.
  const context = parts.hostMessages.filter((message) => message.origin === 'context');
  const rest = parts.hostMessages.filter((message) => message.origin !== 'context');
  return [
    ...parts.steering,
    ...parts.carried,
    ...rest,
    ...context,
    ...parts.inbound,
    parts.prompt,
  ];
}

/**
 * The FIRST copy of the prompt row, or undefined when the host has none.
 *
 * Rule 1: the prompt is sent exactly once, and the copy that survives is the
 * first one -- the one in the conversation's own order.
 */
function firstCopyOf(
  messages: readonly ModelMessage[],
  promptId: string | undefined,
): ModelMessage {
  if (promptId === undefined) {
    throw new Error('assembleRequestMessages: the prompt has no id to anchor on');
  }
  const found = messages.find((message) => message.id === promptId);
  if (found === undefined) {
    throw new Error(`assembleRequestMessages: the host does not carry prompt ${promptId}`);
  }
  return found;
}
