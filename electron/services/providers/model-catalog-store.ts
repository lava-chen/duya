/**
 * electron/services/providers/model-catalog-store.ts
 *
 * Plan 334 Phase 4 (decision 13): the DB-backed "override" layer for the
 * model-catalog resolution. The built-in baseline (the 16 `.models.ts`
 * files + `findModelCompat`) stays in `@duya/ai` as pure, static code;
 * the SQLite `provider_model_capabilities` table only ever holds
 * user / runtime override rows.
 *
 * This class wraps a `CapabilityStore` (the row-level `CapabilityDao`) and
 * enforces the one domain rule `CapabilityDao` does not: **never write a
 * `preset` row**. A `preset` row would duplicate the built-in baseline that
 * already lives in `@duya/ai`, so it is coerced to `user` on write. The
 * resolution priority is DB(user override) > built-in(format seed).
 */

import type { ModelCapability } from '../../../src/lib/providers/types';
import type { CapabilityStore } from './provider-store';

/** Source values the DB override layer is allowed to persist. */
export type OverrideSource = 'user' | 'models-api';

/** Coerce any incoming source to a persisted override source. A `preset`
 *  (or unknown) source is treated as a user edit; `models-api` is kept
 *  as-is because it is a legitimate runtime-discovered override. */
export function normalizeOverrideSource(
  source: ModelCapability['source'],
): OverrideSource {
  return source === 'models-api' ? 'models-api' : 'user';
}

/**
 * DB-backed override layer over a `provider_model_capabilities` store.
 * Implements `CapabilityStore` so it can be wired anywhere a capability
 * store is expected, and adds override-semantic helpers whose writes
 * never persist a `preset` row.
 */
export class ModelCatalogStore implements CapabilityStore {
  private inner: CapabilityStore;

  constructor(inner: CapabilityStore) {
    this.inner = inner;
  }

  // ── CapabilityStore passthrough ──
  listByProvider(providerId: string): ModelCapability[] {
    return this.inner.listByProvider(providerId);
  }

  getOne(providerId: string, modelId: string): ModelCapability | undefined {
    return this.inner.getOne(providerId, modelId);
  }

  upsert(capability: ModelCapability): ModelCapability {
    return this.upsertOverride(capability);
  }

  delete(providerId: string, modelId: string): boolean {
    return this.inner.delete(providerId, modelId);
  }

  // ── Override semantics (never persist a preset row) ──
  getOverrides(providerId: string, modelId: string): ModelCapability | undefined {
    return this.getOne(providerId, modelId);
  }

  listOverrides(providerId: string): ModelCapability[] {
    return this.listByProvider(providerId);
  }

  upsertOverride(capability: ModelCapability): ModelCapability {
    return this.inner.upsert({
      ...capability,
      source: normalizeOverrideSource(capability.source),
    });
  }

  deleteOverride(providerId: string, modelId: string): boolean {
    return this.delete(providerId, modelId);
  }
}