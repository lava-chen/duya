/**
 * Shared context-window resolution (plan 552).
 *
 * The renderer's context ring and the agent's compaction budget must agree
 * on "how big is this model's window?" — otherwise the ring can read "1M"
 * while auto-compaction fires at the 200K fallback (plan 517 R1 root cause).
 * This module is the single implementation; the agent package re-exports it
 * and the renderer imports it directly.
 *
 * Precedence:
 *   1. `runtimeConfig.modelCapabilities.contextWindow` — the merged
 *      config-marker > DB-override > catalog value the Electron side
 *      resolved and threaded into the runtime config (what the user pinned
 *      via the 200K/1M buttons in the provider edit view, or what model
 *      sync populated when the gateway reported it).
 *   2. The built-in model catalog (`findModelById`) — the last-resort
 *      fallback that keeps a plain chat turn (which may not carry a runtime
 *      config at all) on the model's real window.
 *   3. {@link DEFAULT_CONTEXT_WINDOW} (200K) — legacy floor.
 */

import { findModelById } from '../models.js';

/** Legacy floor when neither a capability row nor the catalog knows better. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type ContextWindowSource = 'capability' | 'catalog' | 'default';

export interface ResolvedContextWindow {
  /** Budget in tokens. Always a positive number. */
  contextWindow: number
  /** Where the value came from — `default` means the 200K fallback fired. */
  source: ContextWindowSource
}

/**
 * Resolve the context window for a model.
 *
 * Pure: no side effects, no config/store access. Callers log the WARN
 * themselves when `source === 'default'`.
 */
export function resolveContextWindow(input: {
  /** `runtimeConfig.modelCapabilities.contextWindow`, when present. */
  capabilityContextWindow?: number
  /** Model id used for the catalog fallback lookup. */
  modelId?: string
}): ResolvedContextWindow {
  const { capabilityContextWindow, modelId } = input

  if (
    typeof capabilityContextWindow === 'number' &&
    capabilityContextWindow > 0
  ) {
    return { contextWindow: capabilityContextWindow, source: 'capability' }
  }

  const fromCatalog = modelId
    ? findModelById(modelId)?.contextWindow
    : undefined
  if (typeof fromCatalog === 'number' && fromCatalog > 0) {
    return { contextWindow: fromCatalog, source: 'catalog' }
  }

  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: 'default' }
}
