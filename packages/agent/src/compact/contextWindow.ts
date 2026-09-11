/**
 * Context-window resolution for the compaction budget.
 *
 * The renderer's context ring and the compaction budget must agree on
 * "how big is this model's window?" — otherwise the ring can read
 * "1M" (17%) while auto-compaction fires at the 200K fallback.
 *
 * Precedence (mirrors the renderer, see `useContextUsage` +
 * `ProviderStore.resolveRuntimeCapability`):
 *   1. `runtimeConfig.modelCapabilities.contextWindow` — the merged
 *      config-marker > DB-override > catalog value the Electron side
 *      resolved and threaded into the runtime config.
 *   2. The `@duya/ai` model catalog (`findModelById`) — the same
 *      last-resort fallback the ring uses when no capability row is
 *      attached. This branch is what keeps a plain chat turn (which may
 *      not carry a runtime config at all) on the model's real window.
 *   3. `DEFAULT_CONTEXT_WINDOW` (200K) — legacy floor.
 */
import { findModelById } from '@duya/ai'
import { DEFAULT_CONTEXT_WINDOW } from './types.js'

export type CompactionContextWindowSource = 'capability' | 'catalog' | 'default'

export interface CompactionContextWindow {
  /** Budget in tokens. Always a positive number. */
  contextWindow: number
  /** Where the value came from — `default` means the 200K fallback fired. */
  source: CompactionContextWindowSource
}

/**
 * Resolve the context window used for the compaction budget.
 *
 * Pure: no side effects, no config/store access. Callers log the WARN
 * themselves when `source === 'default'`.
 */
export function resolveCompactionContextWindow(input: {
  /** `runtimeConfig.modelCapabilities.contextWindow`, when present. */
  capabilityContextWindow?: number
  /** Model id used for the catalog fallback lookup. */
  modelId?: string
}): CompactionContextWindow {
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
