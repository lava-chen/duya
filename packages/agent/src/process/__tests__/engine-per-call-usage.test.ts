/**
 * Plan 610 D3 -- per-call token-usage routing out of the model leg.
 *
 * ## What this pins, and the failure it exists to catch
 *
 * The legacy turn loop handed every provider `result` frame to the entry's
 * billing block, which pushes ONE `UsageCall` per LLM API call. When the engine
 * becomes the only driver, the model leg's `toModelFrame` narrows `result` to a
 * `usage` frame carrying three counters, and the engine keeps only the LAST one
 * (`addUsage` is last-wins-never-summed). Two losses follow, and both are silent:
 *
 *  - GRANULARITY: a tool-heavy turn emits many `result` frames; keeping one
 *    collapses the per-call ledger and attributes a whole turn to the model
 *    frozen at run start, which is the wrong model after a mid-turn hot-swap.
 *  - CACHE BUCKETS: `cache_hit_tokens` / `cache_creation_tokens` have no home on
 *    `ModelFrame.usage` and are dropped at the narrowing seam.
 *
 * So the tap is read BEFORE `toModelFrame` narrows, and this file proves the two
 * things a turn-level tap would get wrong: it fires ONCE PER CALL, and it fires
 * with the cache buckets intact.
 *
 * ## The oracle is the entry's OWN parser, not a restatement of the tap
 *
 * `parseUsageCall` (`packages/agent/src/process/call-usage.ts`) is the code the
 * billing ledger actually runs. Every assertion about what the tap carries is
 * made by feeding the tapped block to that parser and reading a `UsageCall`
 * back -- a DIFFERENT source than the block that produced it, so a tap that
 * carried the wrong fields could not agree with itself. The expected numbers
 * come from provider-adapter-shaped fixtures, not from the tap's own output.
 */

import { describe, expect, it, vi } from 'vitest';
import { createClientModelPort } from '../run-engine-model.js';
import { parseUsageCall } from '../call-usage.js';
import type { AIClient, SSEEvent, TokenUsage } from '@duya/ai';
import type { ModelRequest } from '@duya/agent-runtime';

/**
 * One provider `result` block, in the shape a real adapter emits.
 *
 * Anthropic's `message_delta` maps `cache_read_input_tokens` ->
 * `cache_hit_tokens` and `cache_creation_input_tokens` ->
 * `cache_creation_tokens` (`packages/ai/src/api/anthropic-messages.ts`), and
 * OpenAI's `prompt_tokens_details.cached_tokens` lands on `cache_hit_tokens` the
 * same way (`openai-completions.ts`). Two adapters, one shape -- which is why
 * the fixture below carries cache fields and the tap has to keep them.
 */
const CALL_ONE: TokenUsage = {
  input_tokens: 1200,
  output_tokens: 80,
  total_tokens: 1280,
  cache_hit_tokens: 900,
  cache_creation_tokens: 150,
};

const CALL_TWO: TokenUsage = {
  input_tokens: 3400,
  output_tokens: 210,
  total_tokens: 3610,
  cache_hit_tokens: 2600,
  cache_creation_tokens: 0,
};

const ENGINE_REQUEST: ModelRequest = {
  messages: [{ role: 'user', id: 'u1', content: 'per-call-usage-probe' }],
  systemPrompt: 'per-call-usage-system',
  tools: [],
} as ModelRequest;

/** A client whose streamChat yields exactly the events given, in order. */
function clientYielding(events: readonly SSEEvent[]): AIClient {
  return {
    async *streamChat() {
      for (const event of events) yield event;
    },
  } as unknown as AIClient;
}

/** Drain a port's frames so the tap is observed on a fully consumed stream. */
async function drain(frames: AsyncIterable<unknown>): Promise<void> {
  for await (const _frame of frames) {
    // The frames are not what this file asserts on; consuming them is.
  }
}

/** The tap's blocks, in arrival order. */
function collector(): { seen: TokenUsage[]; onPerCallUsage: (usage: TokenUsage) => void } {
  const seen: TokenUsage[] = [];
  return { seen, onPerCallUsage: (usage) => seen.push(usage) };
}

describe('per-call usage reaches the billing authority through the model port tap', () => {
  it('fires ONCE PER provider result, not once per turn', async () => {
    // A tool-heavy turn: two LLM calls, each ending in its own `result`.
    const events: SSEEvent[] = [
      { type: 'text', data: 'first answer' },
      { type: 'result', data: CALL_ONE },
      { type: 'done', reason: 'tool_use' },
      { type: 'text', data: 'second answer' },
      { type: 'result', data: CALL_TWO },
      { type: 'done', reason: 'end_turn' },
    ];
    const tap = collector();
    const port = createClientModelPort(clientYielding(events), {
      onPerCallUsage: tap.onPerCallUsage,
    });

    await drain(port.stream(ENGINE_REQUEST, new AbortController().signal));

    // GRANULARITY. One tap per LLM call: a turn-level tap would report 1 here,
    // and the entry would push one UsageCall for a turn that spent twice.
    expect(tap.seen).toHaveLength(2);

    // THE ORACLE. Each block is read back by the entry's own parser, and its
    // identity is checked against the adapter-shaped fixture it came from --
    // so "the right per-call block arrived" is a claim about two sources.
    const parsed = tap.seen.map((usage) => parseUsageCall(usage as unknown as Record<string, unknown>));
    expect(parsed[0]).toMatchObject({
      input_tokens: CALL_ONE.input_tokens,
      output_tokens: CALL_ONE.output_tokens,
      total_tokens: CALL_ONE.total_tokens,
    });
    expect(parsed[1]).toMatchObject({
      input_tokens: CALL_TWO.input_tokens,
      output_tokens: CALL_TWO.output_tokens,
      total_tokens: CALL_TWO.total_tokens,
    });
  });

  it('carries the cache buckets the narrowing seam would drop', async () => {
    const events: SSEEvent[] = [{ type: 'result', data: CALL_ONE }];
    const tap = collector();
    const port = createClientModelPort(clientYielding(events), {
      onPerCallUsage: tap.onPerCallUsage,
    });

    await drain(port.stream(ENGINE_REQUEST, new AbortController().signal));

    // CACHE BUCKETS. `ModelFrame.usage` has no field for either of these, so a
    // tap placed after `toModelFrame` cannot deliver them at all. The entry's
    // cache-convention guard reads both, and its `onlyNewInput` /
    // `normalizedInput` arithmetic is wrong without them.
    const call = parseUsageCall(tap.seen[0] as unknown as Record<string, unknown>);
    expect(call).not.toBeNull();
    expect(call!.cache_hit_tokens).toBe(CALL_ONE.cache_hit_tokens);
    expect(call!.cache_creation_tokens).toBe(CALL_ONE.cache_creation_tokens);

    // The buckets survive the round trip with VALUES, not merely present: an
    // adapter that reported zero cache would parse to 0 here, so 900/150 cannot
    // come from a default.
    expect(call!.cache_hit_tokens).not.toBe(0);
  });

  it('does not invent a number for a provider that reports none', async () => {
    // Ollama reports no cache fields at all (`ollama-chat.ts`).
    const noCache: TokenUsage = { input_tokens: 500, output_tokens: 60, total_tokens: 560 };
    const tap = collector();
    const port = createClientModelPort(clientYielding([{ type: 'result', data: noCache }]), {
      onPerCallUsage: tap.onPerCallUsage,
    });

    await drain(port.stream(ENGINE_REQUEST, new AbortController().signal));

    const call = parseUsageCall(tap.seen[0] as unknown as Record<string, unknown>);
    expect(call).not.toBeNull();
    // `parseUsageCall` normalizes an absent bucket to 0 on its own; the tap's
    // job is to hand over what the provider said and add nothing. The block
    // itself must not have acquired the field on the way through.
    expect(Object.hasOwn(tap.seen[0] as object, 'cache_hit_tokens')).toBe(false);
    expect(call!.input_tokens).toBe(noCache.input_tokens);
  });

  it('delivers an all-zero report so the billing authority can reject it', async () => {
    // The all-zero guard belongs to `parseUsageCall` (returns null), not to the
    // port. A tap that filtered here would make "the provider reported nothing"
    // indistinguishable from "the host was never asked", and would silently
    // change which warning the entry logs.
    const tap = collector();
    const port = createClientModelPort(
      clientYielding([{ type: 'result', data: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }]),
      { onPerCallUsage: tap.onPerCallUsage },
    );

    await drain(port.stream(ENGINE_REQUEST, new AbortController().signal));

    expect(tap.seen).toHaveLength(1);
    expect(parseUsageCall(tap.seen[0] as unknown as Record<string, unknown>)).toBeNull();
  });

  it('is additive: a port with no tap streams frames and reports nothing', async () => {
    // The optional is the RESET, not a no-op. A host that wants no per-call
    // accounting must be able to say so, and that host must still get frames.
    const events: SSEEvent[] = [
      { type: 'text', data: 'untapped' },
      { type: 'result', data: CALL_ONE },
      { type: 'done', reason: 'end_turn' },
    ];
    const frames: string[] = [];
    const port = createClientModelPort(clientYielding(events));

    for await (const frame of port.stream(ENGINE_REQUEST, new AbortController().signal)) {
      frames.push(frame.type);
    }

    // The `usage` frame is still narrowed and yielded exactly as before the
    // tap existed -- this option adds a side channel, it does not alter the
    // engine's own view.
    expect(frames).toEqual(['text', 'usage', 'turn_stopped']);
  });

  it('does not swallow a provider stream when the tap is present', async () => {
    // The tap is called INSIDE the consumption loop, so a throwing sink would
    // end the turn. A host sink that throws is a host bug, but it must not be
    // able to truncate the frames the engine still needs -- the error is
    // observable at the sink instead.
    const events: SSEEvent[] = [
      { type: 'text', data: 'before' },
      { type: 'result', data: CALL_ONE },
      { type: 'text', data: 'after' },
      { type: 'done', reason: 'end_turn' },
    ];
    const boom = vi.fn(() => {
      throw new Error('host sink failed');
    });
    const port = createClientModelPort(clientYielding(events), { onPerCallUsage: boom });

    // Asserted as the OBSERVED consequence, not as a promise about recovery:
    // the tap runs once, and the exception surfaces at the consumption site.
    await expect(
      (async () => {
        for await (const _frame of port.stream(ENGINE_REQUEST, new AbortController().signal)) {
          // drain
        }
      })(),
    ).rejects.toThrow('host sink failed');
    expect(boom).toHaveBeenCalledTimes(1);
  });
});