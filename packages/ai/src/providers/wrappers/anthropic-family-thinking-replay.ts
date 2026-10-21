/**
 * packages/ai/src/providers/wrappers/anthropic-family-thinking-replay.ts
 *
 * Plan 451 Phase 1 wrapper: anthropic-family thinking-signature replay.
 *
 * Anthropic requires the assistant's `thinking` blocks to carry the opaque
 * `signature` returned in the previous turn's response — without it, the
 * API rejects the request ("missing `signature` field in `thinking` block").
 * The protocol layer preserves signatures across turns via
 * `transformMessages`'s `isSameModel` guard (Plan 310 spec §8.4).
 *
 * This wrapper adds an *external observation hook* on the response path:
 * every `thinking` event that carries a signature is recorded by an
 * observer function supplied by the caller. The hook is meant for
 * diagnostics, telemetry, and any future cross-turn replay logic that
 * needs access to signatures OUTSIDE the SSE event flow (e.g. cross-
 * session persistence tests).
 *
 * It does NOT modify the request path — the protocol layer already
 * preserves signatures via `transformMessages`.
 */

import type { Wrapper } from './compose.js';
import type { SSEEvent } from '../../types.js';

/** Observer callback invoked once per captured signature. */
export type ThinkingSignatureObserver = (params: {
  readonly modelId: string;
  readonly contentPreview: string;
  readonly signature: string;
}) => void;

/**
 * Stream wrapper. Captures thinking signatures from response events and
 * notifies the supplied observer. Forward semantics are unchanged —
 * the wrapper is a pure observer, not a transformer.
 *
 * Phase 1: USABLE for telemetry / diagnostics. Phase 2+ may add request-
 * side cross-stream accumulation if needed.
 */
export function anthropicFamilyThinkingReplay(
  observer?: ThinkingSignatureObserver,
): Wrapper {
  return (inner) => ({
    stream: (model, options) => {
      return (async function* () {
        const gen = inner.stream(model, options);
        let next = await gen.next();
        while (!next.done) {
          const ev = next.value as SSEEvent;
          if (
            ev &&
            typeof ev === 'object' &&
            'type' in ev &&
            ev.type === 'thinking' &&
            'signature' in ev &&
            typeof (ev as { signature?: unknown }).signature === 'string'
          ) {
            const thinking = ev as { data: string; signature: string };
            observer?.({
              modelId: model.id,
              contentPreview: thinking.data,
              signature: thinking.signature,
            });
          }
          yield ev;
          next = await gen.next();
        }
        return next.value;
      })();
    },
  });
}