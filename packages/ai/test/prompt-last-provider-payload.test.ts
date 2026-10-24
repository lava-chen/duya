/**
 * The question reaches the PROVIDER's payload last.
 *
 * ## Why this file exists
 *
 * `request-assembly.ts` fixes the order of the rows the ENGINE hands over,
 * and `engine-prompt-order-proof.test.ts` proves the order survives the real
 * Host -> Runtime -> provider boundary. Both stop one step short: the
 * provider ADAPTERS have their own transforms.
 *
 * Anthropic's is the sharp one. `mergeConsecutiveRoles` merges consecutive
 * same-role messages -- and the rows the system attached are `user` rows, so
 * the question and the rail behind it become ONE `user` message. If the
 * adapter's merge put the question first, the model would read the merged
 * block's tail and find the rail again: the defect, wearing a new hat.
 *
 * So the claim is checked on the FINAL payload each adapter produces, not on
 * the rows the engine assembled.
 *
 * ## What each adapter does with the question
 *
 * - **Anthropic** merges the question with the rail rows behind it into one
 *   `user` block. The block's LAST content part must still be the question.
 * - **OpenAI Responses** keeps the rows as separate `input` items. The last
 *   item must be the question.
 */

import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../src/api/anthropic-messages.js';
import { toResponsesInput } from '../src/api/openai-responses.js';
import type { Message } from '../src/types.js';

/** The user's question. */
const QUESTION = 'PROVIDER-QUESTION-MARKER';
/** The rail's envelope: the product's own reminder wrapper. */
const RAIL_ENVELOPE = 'This context was attached automatically by the system';

/** A row the person said earlier. */
const PRIOR: Message = { role: 'user', content: 'hello', timestamp: 1 };
/** A row the system attached: the volatile context rail. */
const RAIL: Message = {
  role: 'user',
  content: `${RAIL_ENVELOPE}\n<system-reminder>the environment</system-reminder>`,
  timestamp: 2,
};
/** Another row the system attached: a hook's block. */
const HOOK: Message = {
  role: 'user',
  content: `${RAIL_ENVELOPE}\n<system-reminder>a hook said this</system-reminder>`,
  timestamp: 3,
};
/** The question, as the host commits it. */
const ASK: Message = { role: 'user', content: QUESTION, timestamp: 4 };

/**
 * The rows the ENGINE hands over after the contract ran: the conversation,
 * then the system-attached rows, then the question.
 */
const ASSEMBLED: Message[] = [PRIOR, RAIL, HOOK, ASK];

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

/** Every text in a content block, however the block is shaped. */
function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      out.push(block);
      continue;
    }
    if (block && typeof block === 'object' && 'text' in block) {
      out.push(String((block as { text: unknown }).text));
    }
  }
  return out;
}

describe('the Anthropic payload ends with the question', () => {
  it('puts the question last in the merged user block', () => {
    // Anthropic merges the question with the rail rows behind it, so the
    // claim is about the merged block's LAST part -- the merged block's
    // order is the order the model reads.
    const payload = toAnthropicMessages(ASSEMBLED, ANTHROPIC_MODEL);

    const userBlocks = payload.filter((m) => m.role === 'user');
    expect(userBlocks.length).toBeGreaterThan(0);

    const lastUser = userBlocks[userBlocks.length - 1]!;
    const texts = textsOf(lastUser.content);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[texts.length - 1]).toContain(QUESTION);
  });

  it('keeps the question in the LAST message of the payload', () => {
    // The stronger claim: the payload's last message is the one that carries
    // the question. A payload whose last message is an assistant turn or a
    // tool result is a different conversation.
    const payload = toAnthropicMessages(ASSEMBLED, ANTHROPIC_MODEL);
    const last = payload[payload.length - 1]!;

    expect(last.role).toBe('user');
    expect(textsOf(last.content).join('\n')).toContain(QUESTION);
  });

  it('carries the question exactly once', () => {
    const payload = toAnthropicMessages(ASSEMBLED, ANTHROPIC_MODEL);
    const all = payload.flatMap((m) => textsOf(m.content)).join('\n');
    const occurrences = all.split(QUESTION).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('the OpenAI Responses payload ends with the question', () => {
  it('puts the question in the last input item', () => {
    const input = toResponsesInput(ASSEMBLED);

    expect(input.length).toBeGreaterThan(0);
    const last = input[input.length - 1]!;
    const content = (last as { content?: unknown }).content;
    expect(textsOf(content).join('\n')).toContain(QUESTION);
  });

  it('carries the question exactly once', () => {
    const input = toResponsesInput(ASSEMBLED);
    const all = input
      .map((item) => textsOf((item as { content?: unknown }).content).join('\n'))
      .join('\n');
    const occurrences = all.split(QUESTION).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('the payload would still end with the question if the order regressed', () => {
  it('fails when the question sits BEHIND the system-attached rows', () => {
    // The regression this file guards: the engine's contract moves the
    // system-attached rows in front of the question, and if that ever stops
    // happening, the question rides behind the rail and the model reads the
    // rail last. The merged Anthropic block would then END with the rail.
    const regressed: Message[] = [PRIOR, ASK, RAIL, HOOK];

    const payload = toAnthropicMessages(regressed, ANTHROPIC_MODEL);
    const lastUser = payload.filter((m) => m.role === 'user').at(-1)!;
    const texts = textsOf(lastUser.content);

    // The merged block still CONTAINS the question...
    expect(texts.join('\n')).toContain(QUESTION);
    // ...but its LAST part is the rail, which is the defect.
    expect(texts[texts.length - 1]).not.toContain(QUESTION);
  });
});
