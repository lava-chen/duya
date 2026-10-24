/**
 * The Model Request boundary, over EVERY provider.
 *
 * ## What this file is for
 *
 * `request-assembly.ts` (agent-runtime) owns the order of the rows the
 * ENGINE hands over. That is not what the model reads: each adapter
 * converts the rows to its own wire shape, and the conversions are not
 * neutral. Anthropic merges consecutive `user` rows into one block, so the
 * question and the rail behind it become ONE message whose TAIL is the rail.
 *
 * A test that asserts on the engine's array therefore proves nothing about
 * what the model receives. This file asserts on the FINAL payload, once per
 * provider, and it does it for the providers the product actually ships:
 * Anthropic, OpenAI Responses, OpenAI Chat Completions, Gemini and Bedrock.
 *
 * ## What each arm claims
 *
 *  - **Well formed**: the rows arrive with the question last, and EVERY
 *    adapter's payload ends with the question. An adapter that reorders
 *    would fail here.
 *  - **Regressed**: the rows arrive with the question NOT last -- the shape
 *    the defect took -- and EVERY adapter's payload is REPORTED as
 *    violating the boundary. This is the counter-example arm: it is what
 *    proves the check can fail, so a green well-formed arm means something.
 *
 * ## Why the counter-example arm is not redundant
 *
 * A checker that always returns "no violations" would pass the well-formed
 * arm of every provider and catch nothing. The regressed arm is the only
 * thing that distinguishes a real check from a rubber stamp.
 */

import { describe, expect, it } from 'vitest';

import { toAnthropicMessages } from '../src/api/anthropic-messages.js';
import { toResponsesInput } from '../src/api/openai-responses.js';
import { toOpenAIMessages } from '../src/api/openai-completions.js';
import { toGeminiContents } from '../src/api/google-generative-ai.js';
import { toBedrockMessages } from '../src/api/bedrock-converse.js';
import {
  SYSTEM_ATTACHED_MARKER,
  canonicalizeAnthropicPayload,
  canonicalizeBedrockPayload,
  canonicalizeGeminiPayload,
  canonicalizeOpenAICompletionsPayload,
  canonicalizeOpenAIResponsesPayload,
  checkModelRequest,
  type CanonicalRequestMessage,
} from '../src/model-request-invariants.js';
import type { Message } from '../src/types.js';

/** The user's question. */
const QUESTION = 'BOUNDARY-QUESTION-MARKER';
/** A row the person said earlier. */
const PRIOR = 'earlier thing the person said';

/**
 * A row the SYSTEM attached: the volatile-context rail.
 *
 * It is a `user` row, and it says in so many words that it is not part of
 * the user's message -- which is exactly why it must not close the request.
 */
const RAIL = `${SYSTEM_ATTACHED_MARKER}\n<system-reminder>the environment</system-reminder>`;

const ANTHROPIC_MODEL = {
  id: 'claude-test',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  supportsReasoning: false,
  supportsPromptCaching: true,
  inputPricePerMillion: 3,
  outputPricePerMillion: 15,
  supportedApiFormats: ['anthropic'],
} as never;

/** The rows as the host projects them when the order is right. */
const WELL_FORMED: Message[] = [
  { role: 'user', content: PRIOR, timestamp: 1 },
  { role: 'user', content: RAIL, timestamp: 2 },
  { role: 'user', content: QUESTION, timestamp: 3 },
];

/** The rows as they were when the defect was live: the rail closes the request. */
const REGRESSED: Message[] = [
  { role: 'user', content: PRIOR, timestamp: 1 },
  { role: 'user', content: QUESTION, timestamp: 2 },
  { role: 'user', content: RAIL, timestamp: 3 },
];

interface Adapter {
  readonly name: string;
  /** The adapter's final payload for the given rows. */
  readonly payload: (messages: Message[]) => unknown;
  /** The reducer for that payload shape. */
  readonly canonicalize: (payload: unknown) => CanonicalRequestMessage[];
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: 'anthropic',
    payload: (messages) => toAnthropicMessages(messages, ANTHROPIC_MODEL),
    canonicalize: canonicalizeAnthropicPayload,
  },
  {
    name: 'openai-responses',
    payload: (messages) => toResponsesInput(messages),
    canonicalize: canonicalizeOpenAIResponsesPayload,
  },
  {
    name: 'openai-completions',
    payload: (messages) => toOpenAIMessages(messages),
    canonicalize: canonicalizeOpenAICompletionsPayload,
  },
  {
    name: 'gemini',
    payload: (messages) => toGeminiContents(messages),
    canonicalize: canonicalizeGeminiPayload,
  },
  {
    name: 'bedrock',
    payload: (messages) => toBedrockMessages(messages),
    canonicalize: canonicalizeBedrockPayload,
  },
];

describe.each(ADAPTERS)('the $name payload', (adapter) => {
  it('ends with the question when the rows arrive in order', () => {
    const violations = checkModelRequest(
      adapter.canonicalize(adapter.payload(WELL_FORMED)),
      { question: QUESTION },
    );

    expect(violations).toEqual([]);
  });

  it('is REPORTED when the question is not the last row', () => {
    // The counter-example. Without this arm, a checker that never fails
    // would pass the arm above and catch nothing.
    const violations = checkModelRequest(
      adapter.canonicalize(adapter.payload(REGRESSED)),
      { question: QUESTION },
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.code)).toContain('QUESTION_NOT_LAST');
  });

  it('keeps the question exactly once', () => {
    const canonical = adapter.canonicalize(adapter.payload(WELL_FORMED));
    const occurrences = canonical.reduce(
      (total, message) =>
        total +
        message.texts.filter((text) => text.includes(QUESTION)).length,
      0,
    );

    expect(occurrences).toBe(1);
  });
});

describe('the boundary checker itself', () => {
  it('reports an empty request', () => {
    const violations = checkModelRequest([], { question: QUESTION });

    expect(violations.map((v) => v.code)).toEqual(['REQUEST_EMPTY']);
  });

  it('reports a request that carries no question at all', () => {
    const violations = checkModelRequest(
      [{ role: 'user', texts: ['something else entirely'] }],
      { question: QUESTION },
    );

    expect(violations.map((v) => v.code)).toEqual(['QUESTION_MISSING']);
  });

  it('reports a question that was sent twice', () => {
    const violations = checkModelRequest(
      [
        { role: 'user', texts: [QUESTION] },
        { role: 'user', texts: [QUESTION] },
      ],
      { question: QUESTION },
    );

    expect(violations.map((v) => v.code)).toContain('QUESTION_DUPLICATED');
  });

  it('reports a question that is not a user turn', () => {
    const violations = checkModelRequest(
      [{ role: 'assistant', texts: [QUESTION] }],
      { question: QUESTION },
    );

    expect(violations.map((v) => v.code)).toContain('QUESTION_ROLE_INVALID');
  });

  it('reports a system-attached row behind the question', () => {
    const violations = checkModelRequest(
      [
        { role: 'user', texts: [QUESTION] },
        { role: 'user', texts: [RAIL] },
      ],
      { question: QUESTION },
    );

    expect(violations.map((v) => v.code)).toContain('SYSTEM_ROW_AFTER_QUESTION');
  });

  it('reports a system-attached row behind the question INSIDE one merged row', () => {
    // The shape Anthropic's role-merging produces: the question and the rail
    // arrive as ONE row, so a row-level check alone cannot see the order.
    const violations = checkModelRequest(
      [{ role: 'user', texts: [QUESTION, RAIL] }],
      { question: QUESTION },
    );

    expect(violations.map((v) => v.code)).toContain('SYSTEM_ROW_AFTER_QUESTION');
  });
});
