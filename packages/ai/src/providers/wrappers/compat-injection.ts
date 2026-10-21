/**
 * packages/ai/src/providers/wrappers/compat-injection.ts
 *
 * Plan 451 Phase 2: automatic wrapper injection based on `ModelCompat`
 * flags declared in the model catalog.
 *
 * The mapping is fixed (see plan 451 Phase 2 / "Compat 字段 → Wrapper 名字"):
 *
 *   forceAdaptiveThinking  → anthropicFamilyThinkingReplay observer
 *   toolResultTransport ≠ 'tool-result-block'
 *                          → anthropicFamilyToolPayloadCompat
 *
 * Wrappers NOT yet mapped (require onPayload hook — Phase 3+):
 *   supportsToolReferences          → anthropicFamilyToolReferences
 *   supportsThinkingTokenBudget     → anthropicFamilyThinkingBudget
 *   openaiThinkingFormat ('qwen-style' / 'glm-style' / 'reasoning-content' / 'think-tag-fallback')
 *                                   → openaiFamilyThinkingFormat
 *
 * Injection order: auto-injected wrappers run AFTER (outermost of) the
 * provider's explicit wrappers. Provider author can ALWAYS opt out of
 * auto-injection by declaring the wrapper themselves and passing a
 * sentinel; Phase 3 may add an explicit "skip auto-inject" mechanism
 * if multiple providers need it.
 */

import type { Wrapper } from './compose.js';
import type { Model } from '../../types.js';
import { anthropicFamilyToolPayloadCompat } from './anthropic-family-tool-payload-compat.js';
import { anthropicFamilyThinkingReplay } from './anthropic-family-thinking-replay.js';

/**
 * Compute the auto-injection wrapper chain for a given model based on its
 * `compat` flags. Returns an empty array when no compat flags are set or
 * none of them map to a registered wrapper.
 *
 * Pure function — easy to test in isolation.
 */
export function autoWrappersForCompat(model: Model): Wrapper[] {
  const compat = model.compat;
  if (!compat) return [];

  const wrappers: Wrapper[] = [];

  // 1. toolResultTransport ≠ 'tool-result-block' (or DeepSeek auto-detect,
  //    which applyToolResultTransport handles internally when no compat
  //    override is present).
  if (compat.toolResultTransport && compat.toolResultTransport !== 'tool-result-block') {
    wrappers.push(anthropicFamilyToolPayloadCompat());
  }

  // 2. forceAdaptiveThinking — wire up the response-side observer. The
  //    actual `{type: 'adaptive'}` thinking block format is set by the
  //    protocol layer (wire-payload level); the wrapper is purely
  //    observational.
  if (compat.forceAdaptiveThinking) {
    wrappers.push(anthropicFamilyThinkingReplay());
  }

  return wrappers;
}