/**
 * src/lib/providers/domain/LlmProviderService.ts
 *
 * Business-logic service for LlmProvider CRUD. This module is the
 * authoritative entry point for renderer-side provider management.
 *
 * Responsibilities:
 *  - normalize / validate / persist LlmProvider records
 *  - maintain the active-provider invariant (exactly one active, or zero)
 *  - migrate legacy `ApiProvider[]` payloads to `LlmProvider[]` on first read
 *  - expose a thin facade that talks to the IPC layer (`apiProviders`)
 *    and to the underlying config.json store through the same shape
 *
 * Non-goals (Phase 1):
 *  - secret encryption (still handled by Electron safeStorage in
 *    electron/config/manager.ts)
 *  - cross-device sync (WebDAV, etc.)
 *  - automatic failover (only the inFailoverQueue field is exposed)
 *
 * The store is a simple in-memory cache backed by the IPC layer. The actual
 * persistence is still done by `electron/config/manager.ts`. The service
 * here is what the UI calls; it converts between legacy ApiProvider and
 * LlmProvider on the fly.
 */

import type {
  ApiProvider,
  LlmProvider,
  ValidationResult,
} from '../types';
import {
  buildLlmProviderFromPreset,
  maskApiProvider,
  migrateLegacyApiProvider,
  toLegacyApiProvider,
} from '../legacy';
import type { ProviderPreset } from '../types';
import { validateProvider } from './ProviderValidation';

export interface LlmProviderStore {
  /** Read the full provider map from the IPC layer. */
  readAll(): Promise<Record<string, ApiProvider>>;
  /** Persist the full map back. */
  writeAll(map: Record<string, ApiProvider>): Promise<boolean>;
  /** Subscribe to changes (optional). */
  onChange?(cb: () => void): () => void;
}

/** In-memory LlmProviderService. */
export class LlmProviderService {
  private providers: Map<string, LlmProvider> = new Map();
  private activeId: string | undefined;
  private initialized = false;
  private store: LlmProviderStore;
  private configUnsubscribe: (() => void) | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: LlmProviderStore) {
    this.store = store;
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /** Load legacy ApiProvider records, migrate to LlmProvider. Idempotent. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const legacy = await this.store.readAll();
    this.providers.clear();
    this.activeId = undefined;
    for (const p of Object.values(legacy)) {
      const migrated = migrateLegacyApiProvider(p);
      this.providers.set(migrated.id, migrated);
      if (p.isActive) this.activeId = p.id;
    }
    this.initialized = true;
  }

  /**
   * Phase 3: subscribe to the store's change events. The store's
   * `onChange` callback signature is `() => void` (no args), but
   * we wrap it to support an optional `(config: unknown) => void`
   * user callback (the renderer-side `onConfigUpdate(config)`
   * takes the full config payload).
   */
  subscribeToConfigUpdates(
    onConfigUpdate?: (config: unknown) => void,
  ): () => void {
    if (this.configUnsubscribe) {
      return this.configUnsubscribe;
    }
    const wrapped = (config: unknown) => {
      onConfigUpdate?.(config);
      this.scheduleResync();
    };
    const onChange = this.store.onChange;
    if (onChange) {
      // The store's onChange is `() => void`; we discard the
      // wrapped signature by casting through unknown once. The
      // wrapped fn never reads the parameter on its own.
      this.configUnsubscribe = onChange(() => wrapped(undefined)) ?? null;
    } else {
      this.configUnsubscribe = () => {};
    }
    return this.configUnsubscribe;
  }

  /** Debounced re-initialization. Avoids thrashing on a burst of
   *  config updates (e.g. user dragging a slider). */
  private scheduleResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.initialized = false;
      void this.initialize();
    }, 50);
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  listProviders(): LlmProvider[] {
    return Array.from(this.providers.values()).sort(
      (a, b) => a.meta.sortIndex - b.meta.sortIndex,
    );
  }

  getProvider(id: string): LlmProvider | undefined {
    return this.providers.get(id);
  }

  getActiveProvider(): LlmProvider | undefined {
    return this.activeId ? this.providers.get(this.activeId) : undefined;
  }

  // ===========================================================================
  // Write
  // ===========================================================================

  /** Validate, then upsert. Returns validation result on failure. */
  async upsertProvider(provider: LlmProvider): Promise<ValidationResult> {
    const result = validateProvider(provider);
    if (!result.ok) return result;
    provider.meta.updatedAt = Date.now();
    this.providers.set(provider.id, provider);
    await this.persist();
    return { ok: true };
  }

  /** Create a new provider from a preset + user values. */
  async createProviderFromPreset(
    preset: ProviderPreset,
    values: {
      id: string;
      name: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
    },
  ): Promise<{ ok: true; provider: LlmProvider } | { ok: false; error: string }> {
    const draft = buildLlmProviderFromPreset(preset, values);
    const result = await this.upsertProvider(draft);
    if (!result.ok) {
      return { ok: false, error: result.message ?? 'validation failed' };
    }
    return { ok: true, provider: draft };
  }

  async deleteProvider(id: string): Promise<boolean> {
    if (!this.providers.has(id)) return false;
    this.providers.delete(id);
    if (this.activeId === id) this.activeId = undefined;
    await this.persist();
    return true;
  }

  /** Set the active provider. At most one is active at a time. */
  async setActiveProvider(id: string): Promise<ValidationResult> {
    if (!this.providers.has(id)) {
      return { ok: false, code: 'provider.notFound', message: `provider ${id} not found` };
    }
    this.activeId = id;
    for (const [pid, p] of this.providers) {
      const tags = new Set(p.meta.tags ?? []);
      if (pid === id) tags.add('active');
      else tags.delete('active');
      p.meta.tags = Array.from(tags);
    }
    await this.persist();
    return { ok: true };
  }

  /** Reorder providers. The new order is the array of ids. */
  async reorderProviders(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      const p = this.providers.get(ids[i]);
      if (p) {
        p.meta.sortIndex = i;
        p.meta.updatedAt = Date.now();
      }
    }
    await this.persist();
  }

  // ===========================================================================
  // Internal: persist the migrated state back to the legacy store
  // ===========================================================================

  private async persist(): Promise<void> {
    const legacy: Record<string, ApiProvider> = {};
    for (const p of this.providers.values()) {
      const lp = toLegacyApiProvider(p);
      // Re-apply active flag.
      lp.isActive = p.id === this.activeId;
      legacy[p.id] = lp;
    }
    await this.store.writeAll(legacy);
  }
}

/** Convenience: produce a masked DTO for the renderer, suitable for the
 *  existing listProvidersIPC / getProviderIPC contract. */
export function toRendererDto(llm: LlmProvider): {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  /** @deprecated Use isDefault. Transitional alias. */
  isActive: boolean;
  /** Soft default — implicit fallback for chat/vision/etc. */
  isDefault: boolean;
  hasApiKey: boolean;
  sortOrder: number;
  extraEnv: string;
  protocol: string;
  headers: string;
  options: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
} {
  // Re-derive a legacy ApiProvider and mask it. This keeps the renderer
  // contract stable while we move internal code to LlmProvider.
  // We derive `isDefault` from the cache (AppConfig.defaultProviderId)
  // so the legacy `isActive` boolean on the masked DTO stays
  // consistent with the new "soft default" model.
  const legacy = toLegacyApiProvider(llm);
  const masked = maskApiProvider(legacy);
  const isDefault =
    Boolean(llm.meta?.tags?.includes('active')) || legacy.isActive === true;
  return { ...masked, isActive: isDefault, isDefault };
}
