/**
 * packages/ai/src/providers/wrappers/compose.ts
 *
 * Family-wrapper composition primitive (Plan 451 Phase 0).
 *
 * A wrapper is a pure function that transforms a ProviderStreams into
 * another ProviderStreams. Wrappers are composed left-to-right via `pipe()`:
 *
 *     pipe(base, w1, w2, w3)  ===  w3(w2(w1(base)))
 *
 * i.e. the LAST wrapper in the argument list sits at the OUTERMOST layer and
 * processes the request first / events last. This is the standard middleware
 * order (Koa/Express `app.use(w1); app.use(w2)` — w2 wraps w1).
 *
 * Use cases (Plan 451 Phase 1+):
 *   - anthropicFamilyThinkingReplay wraps an anthropic-messages stream to
 *     inject persisted thinking signatures into the request and accumulate
 *     them on the response.
 *   - openAIFamilyThinkingFormat('glm-style') wraps an openai-completions
 *     stream to translate duya's reasoning_effort into provider-native
 *     request fields.
 *
 * Wrappers MUST NOT mutate the inner ProviderStreams. Each layer must
 * forward events from the inner stream to the outer consumer and forward
 * the inner generator's return value (the AssistantMessage) untouched.
 * Wrappers MAY transform or augment events on the way through.
 */

import type { ProviderStreams } from '../lazy.js';

/**
 * A wrapper transforms a ProviderStreams into another ProviderStreams.
 * Wrappers are stateless and may be reused across many providers.
 */
export type Wrapper = (inner: ProviderStreams) => ProviderStreams;

/**
 * Compose `base` with one or more wrappers, left-to-right.
 *
 * `pipe(base, w1, w2)` is equivalent to `w2(w1(base))`. The last wrapper
 * is the outermost layer; on the response path, its stream() is the one
 * the caller awaits.
 *
 * Returns `base` unchanged when no wrappers are supplied — identity
 * short-circuit lets `create-provider.ts` skip allocation in the common
 * case where a provider declares no wrappers.
 */
export function pipe(
  base: ProviderStreams,
  ...wrappers: Wrapper[]
): ProviderStreams {
  if (wrappers.length === 0) return base;
  return wrappers.reduce((acc, w) => w(acc), base);
}