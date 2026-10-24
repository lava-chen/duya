/**
 * The Model Request boundary: what a provider request must look like.
 *
 * ## Why this module exists
 *
 * A model request is assembled by FOUR modules, each with a local contract:
 * the host projects the conversation and attaches its context rows, the
 * runtime merges the prompt with what it carries, the engine orders the
 * parts, and the provider adapter converts them to the wire shape. Every one
 * of them can be locally correct while the COMBINED request is wrong.
 *
 * The failure this module was written for is the clearest example: the
 * question was in the request, but it was not the LAST thing in it. The
 * rows the system attaches -- the volatile-context rail, a hook's block, an
 * attachment's text -- are `user` rows, and a model reads a conversation from
 * the end, so it read the rail and concluded that no question had been asked.
 *
 * ## What a local test cannot see
 *
 * The engine's own order is not what the model reads. The adapter merges
 * consecutive `user` rows into one block (Anthropic rejects same-role
 * neighbours), reorders tool results around their calls, and drops orphans.
 * A test that asserts on the engine's array proves the ENGINE is right; only
 * a test that asserts on the ADAPTER'S PAYLOAD proves the MODEL is right.
 *
 * So the claim this module makes is deliberately narrow and deliberately
 * checkable at the outermost boundary: given the FINAL payload an adapter
 * produced, does it carry the question once, at the end, as a user turn, with
 * no system-attached row behind it?
 *
 * ## How to use it
 *
 *   const violations = checkModelRequest(
 *     canonicalizeAnthropicPayload(payload),
 *     { question: 'what does the ui package look like?' },
 *   );
 *
 * `checkModelRequest` REPORTS; it does not throw. A caller that wants the
 * request to be rejected says so, and a caller that wants to observe says
 * so. A boundary that throws by default cannot be used to prove that a
 * defect is still detectable.
 *
 * ## What it does NOT check
 *
 * It does not decide whether the request is CORRECT -- that is the host's and
 * the runtime's business. It checks the handful of properties that every
 * correct request shares, and that a broken one loses. It does not know what
 * the question was until the caller tells it, because at the wire boundary
 * the question is just text like everything else.
 */

/**
 * The disclaimer the product's user-channel reminder envelope carries.
 *
 * A row that contains it is a row the SYSTEM attached, whatever its role.
 * This is the only marker that survives every adapter: the envelope text is
 * part of the payload, while `metadata` and `origin` do not cross the wire.
 */
export const SYSTEM_ATTACHED_MARKER =
  'This context was attached automatically by the system.';

/**
 * One row of a provider request, reduced to what the invariants care about.
 *
 * The reduction is what makes the check provider-agnostic: five adapters
 * spell a row five different ways, and all five spell "a role and some
 * text" once the spelling is taken out.
 */
export interface CanonicalRequestMessage {
  /** The row's role, in the adapter's own vocabulary. */
  readonly role: string;
  /** Every text the row carries, in the order the model would read them. */
  readonly texts: readonly string[];
}

/** The ways a request can violate the boundary. */
export type ModelRequestViolationCode =
  /** The request carried no rows at all. */
  | 'REQUEST_EMPTY'
  /** The question is nowhere in the request. */
  | 'QUESTION_MISSING'
  /** The question appears more than once. */
  | 'QUESTION_DUPLICATED'
  /** The request's last row does not carry the question. */
  | 'QUESTION_NOT_LAST'
  /** The question is not a user turn. */
  | 'QUESTION_ROLE_INVALID'
  /** A row the SYSTEM attached sits behind the question. */
  | 'SYSTEM_ROW_AFTER_QUESTION';

export interface ModelRequestViolation {
  readonly code: ModelRequestViolationCode;
  /** A sentence a human can act on. */
  readonly detail: string;
}

export interface ModelRequestExpectation {
  /**
   * The question the request has to carry.
   *
   * Matched as a SUBSTRING of a row's text, because an adapter may split a
   * row's content into parts, and a part is not a row.
   */
  readonly question: string;
  /**
   * Which kind of turn this request is.
   *
   * A QUESTION TURN asks something, and its whole point is that the request
   * ENDS with the question. A CONTINUATION does not: it is the turn after a
   * tool result, where the question is history and the tool result is the
   * newest thing the model has to react to. The request contract says so in
   * rule 4 -- a later turn carries no prompt -- so a continuation that does
   * NOT end with the question is correct, and checking it as if it did would
   * report a defect that is not there.
   *
   * The two modes check DIFFERENT things, and the difference is not
   * cosmetic:
   *
   * | | question turn | continuation |
   * | --- | --- | --- |
   * | the question appears more than once | violation | violation |
   * | the question is nowhere in the request | violation | allowed (a compacted transcript may not carry it) |
   * | the request does not end with the question | violation | allowed |
   * | a system-attached row sits behind the question | violation | allowed |
   *
   * The duplicate check applies to BOTH, because a question sent twice is
   * wrong in either: it makes the model answer the same thing twice.
   */
  readonly mode?: 'question-turn' | 'continuation';
}

/**
 * Check a provider request against the boundary.
 *
 * Returns every violation found rather than the first, because a request
 * that is wrong in two ways is two bugs, and a report that names only one
 * sends the fixer back for a second round.
 */
export function checkModelRequest(
  messages: readonly CanonicalRequestMessage[],
  expectation: ModelRequestExpectation,
): readonly ModelRequestViolation[] {
  const violations: ModelRequestViolation[] = [];

  if (messages.length === 0) {
    violations.push({
      code: 'REQUEST_EMPTY',
      detail: 'the request carried no rows',
    });
    return violations;
  }

  const question = expectation.question;
  const mode = expectation.mode ?? 'question-turn';

  // OCCURRENCES, not rows.
  //
  // Anthropic merges consecutive `user` rows into ONE block, so two copies of
  // the question folded into that block are two OCCURRENCES in one row. A
  // checker that counted ROWS would see one carrier and report nothing --
  // which is how a duplicate question survives to the provider. Counting the
  // occurrences inside every text of every row is what survives the merge.
  const occurrences: { readonly messageIndex: number; readonly textIndex: number }[] = [];
  messages.forEach((message, messageIndex) => {
    message.texts.forEach((text, textIndex) => {
      const count = countOccurrences(text, question);
      for (let i = 0; i < count; i += 1) {
        occurrences.push({ messageIndex, textIndex });
      }
    });
  });

  if (occurrences.length > 1) {
    violations.push({
      code: 'QUESTION_DUPLICATED',
      detail:
        `the question appears ${occurrences.length} times in the request ` +
        `(rows ${occurrences.map((o) => o.messageIndex).join(', ')}); it must appear exactly once`,
    });
  }

  if (mode === 'continuation') {
    // A continuation turn: the duplicate check is the whole contract. The
    // question is history there, and rule 4 says the turn carries no prompt.
    return violations;
  }

  if (occurrences.length === 0) {
    violations.push({
      code: 'QUESTION_MISSING',
      detail: `the request carries no row containing the question: ${JSON.stringify(question)}`,
    });
    return violations;
  }

  // The LAST occurrence is the one the model reads as the current ask.
  const lastOccurrence = occurrences[occurrences.length - 1]!;
  const carrier = messages[lastOccurrence.messageIndex]!;
  const last = messages[messages.length - 1]!;

  // The strong form of "last": the request's last row must END with the
  // question. A row that merely CONTAINS it is not enough, because an
  // adapter that merges consecutive `user` rows puts the whole conversation
  // into one block -- and the model reads the block's TAIL.
  const lastText = last.texts.length > 0 ? last.texts[last.texts.length - 1] : undefined;
  if (lastText === undefined || !lastText.includes(question)) {
    violations.push({
      code: 'QUESTION_NOT_LAST',
      detail:
        `the request's last row (index ${messages.length - 1}, role '${last.role}') does not END with ` +
        `the question; the question sits at index ${lastOccurrence.messageIndex}`,
    });
  }

  if (last.role !== 'user') {
    violations.push({
      code: 'QUESTION_ROLE_INVALID',
      detail: `the request's last row carries role '${last.role}', not 'user'`,
    });
  }

  // A row the SYSTEM attached behind the question: either a LATER row, or a
  // later TEXT inside the question's own row. The second case is the one an
  // adapter's role-merging creates, and a row-level check cannot see it.
  const systemTextBehindInRow = carrier.texts
    .slice(lastOccurrence.textIndex + 1)
    .some((text) => text.includes(SYSTEM_ATTACHED_MARKER));
  const systemRowBehind = messages.findIndex(
    (message, index) =>
      index > lastOccurrence.messageIndex &&
      message.texts.some((text) => text.includes(SYSTEM_ATTACHED_MARKER)),
  );
  if (systemTextBehindInRow || systemRowBehind >= 0) {
    violations.push({
      code: 'SYSTEM_ROW_AFTER_QUESTION',
      detail:
        `a row the system attached sits behind the question ` +
        `(${systemTextBehindInRow ? 'inside the question\'s own row' : `at index ${systemRowBehind}`}); ` +
        `the model reads a conversation from the end and will read that row last`,
    });
  }

  return violations;
}

/** How many times `needle` occurs in `haystack`, counting overlaps once each. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Reduce a payload to the boundary's own vocabulary.
 *
 * A convenience for callers that have a payload in an unknown shape: it
 * walks the payload and takes every string it can attribute to a row. It is
 * deliberately generous -- a row's text may be split, and a payload may
 * carry parts this version does not know about -- because a checker that
 * refuses to look is not a checker.
 */
export function canonicalizeGenericPayload(payload: unknown): CanonicalRequestMessage[] {
  if (!Array.isArray(payload)) return [];
  const out: CanonicalRequestMessage[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : '';
    out.push({ role, texts: collectTexts(record.content) });
  }
  return out;
}

/**
 * Reduce an Anthropic payload (`{role, content}` rows).
 *
 * `content` is a string or a list of blocks, and a block's text may sit
 * under `text`.
 */
export function canonicalizeAnthropicPayload(payload: unknown): CanonicalRequestMessage[] {
  return canonicalizeGenericPayload(payload);
}

/**
 * Reduce an OpenAI Responses payload (`input` items).
 *
 * The items are `{role, content}` too, except that tool rows are a
 * different item type and carry no role -- those become role `''`.
 */
export function canonicalizeOpenAIResponsesPayload(payload: unknown): CanonicalRequestMessage[] {
  return canonicalizeGenericPayload(payload);
}

/**
 * Reduce an OpenAI Chat Completions payload (`{role, content}` rows).
 */
export function canonicalizeOpenAICompletionsPayload(payload: unknown): CanonicalRequestMessage[] {
  return canonicalizeGenericPayload(payload);
}

/**
 * Reduce a Gemini payload (`{role, parts}` rows).
 *
 * Gemini calls the text carrier `parts`, and its roles are `user` and
 * `model` -- the model's own turn, not `assistant`.
 */
export function canonicalizeGeminiPayload(payload: unknown): CanonicalRequestMessage[] {
  if (!Array.isArray(payload)) return [];
  const out: CanonicalRequestMessage[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : '';
    const texts: string[] = [];
    if (Array.isArray(record.parts)) {
      for (const part of record.parts) {
        if (part && typeof part === 'object' && 'text' in part) {
          texts.push(String((part as { text: unknown }).text));
        }
      }
    }
    out.push({ role, texts });
  }
  return out;
}

/**
 * Reduce a Bedrock Converse payload (`{role, content}` rows whose content
 * is a list of `{text}` blocks).
 */
export function canonicalizeBedrockPayload(payload: unknown): CanonicalRequestMessage[] {
  return canonicalizeGenericPayload(payload);
}

/** Every text a content carrier holds, in reading order. */
function collectTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (block && typeof block === 'object' && 'text' in block) {
      texts.push(String((block as { text: unknown }).text));
    }
  }
  return texts;
}
