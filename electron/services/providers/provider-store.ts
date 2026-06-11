/**
 * electron/services/providers/provider-store.ts
 *
 * Electron main-side provider store. The single facade through which
 * all NEW provider code reads / writes providers. Internally backed by
 * `electron/config/manager.ts` `apiProviders` (legacy schema) so the
 * on-disk format is unchanged.
 *
 * - All NEW code that needs a provider MUST go through this module.
 * - It is the ONLY place in the new path that touches `ApiProvider`.
 * - `migrateLegacyApiProvider` and `toLegacyApiProvider` are used to
 *   translate at the boundary.
 *
 * Round-trip note (per Phase 1 doc-block):
 *   ApiProvider -> LlmProvider -> ApiProvider is lossy on
 *   unknown / forward-compat fields ONLY when those fields are placed
 *   in `options` / `extraEnv` (which we preserve). The reverse path
 *   (LlmProvider -> ApiProvider) maps apiFormat/category back to a
 *   best-effort legacy `providerType`. UI code that needs to display
 *   `providerType` after LlmProvider should call
 *   `toLegacyApiProvider(p).providerType` rather than re-deriving it.
 */

// Logger is required lazily so this file can be unit-tested without
// the electron runtime.
function logInfo(message: string, meta?: unknown) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLogger } = require('../../logging/logger.js') as { getLogger: () => { info: (m: string, meta?: unknown, component?: string) => void } };
    getLogger().info(message, meta, 'ConfigManager');
  } catch {
    // logger not available in non-electron test env
  }
}
function logError(message: string, err: unknown) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLogger } = require('../../logging/logger.js') as { getLogger: () => { error: (m: string, err?: Error, meta?: unknown, component?: string) => void } };
    getLogger().error(message, err instanceof Error ? err : new Error(String(err)), undefined, 'ConfigManager');
  } catch {
    // logger not available
  }
}
import {
  inferApiFormatFromLegacyProviderType,
  migrateLegacyApiProvider,
  toLegacyApiProvider,
} from '../../../src/lib/providers/legacy';
import type { ApiProvider, LlmProvider, ModelCapability, ProviderRuntimeConfig, ProviderHealthStatus } from '../../../src/lib/providers/types';
import {
  toRuntimeConfig,
  validateRuntimeConfig,
} from '../../../src/lib/providers/domain/ProviderRuntimeAdapter';
import { modelSyncService } from '../../../src/lib/providers/models/ModelSyncService';
import { providerHealthService } from '../../../src/lib/providers/health/ProviderHealthService';
import { findPresetByKey } from '../../../src/lib/providers/presets';
import { validateProvider } from '../../../src/lib/providers/domain/ProviderValidation';
import { redactSecrets } from '../../../src/lib/providers/domain/ProviderValidation';
import { isMaskedKey } from '../../../src/lib/providers/secret';

/** Read interface — implemented by the live store. Tests can substitute. */
export interface ProviderStoreReader {
  readAll(): Record<string, ApiProvider>;
  readOne(id: string): ApiProvider | undefined;
  /** @deprecated Use readDefault. The single-active concept is gone. */
  readActive(): ApiProvider | undefined;
  /** Soft default — the implicit fallback for chat/vision/etc. */
  readDefault(): ApiProvider | undefined;
  writeAll(map: Record<string, ApiProvider>): boolean;
  onChange(cb: () => void): () => void;
}

/**
 * Minimal capability-store interface. The Electron bridge supplies
 * a SQLite-backed implementation (`CapabilityDao`); tests can
 * substitute a no-op fake.
 */
export interface CapabilityStore {
  listByProvider(providerId: string): ModelCapability[];
  getOne(providerId: string, modelId: string): ModelCapability | undefined;
  upsert(capability: ModelCapability): ModelCapability;
  delete(providerId: string, modelId: string): boolean;
}

/** A `CapabilityStore` that does nothing. Useful as the test default
 *  when capability persistence is not under test. */
export class NoopCapabilityStore implements CapabilityStore {
  listByProvider(): ModelCapability[] {
    return [];
  }
  getOne(): undefined {
    return undefined;
  }
  upsert(c: ModelCapability): ModelCapability {
    return { ...c, updatedAt: Date.now() };
  }
  delete(): boolean {
    return false;
  }
}

/** Default reader backed by the existing ConfigManager. */
export class ProviderStore {
  private reader: ProviderStoreReader;
  private capabilityStore: CapabilityStore;
  private cache: Map<string, LlmProvider> = new Map();
  /**
   * @deprecated The single-active concept is gone. Use `defaultId` instead.
   * Retained so callers compiled against the old API still type-check
   * during the migration window.
   */
  private activeId: string | undefined;
  /**
   * Soft default provider id. The chat, agent process, vision, gateway,
   * wiki-agent, title generation, embedding, and automation subsystems
   * fall back to this id when no explicit per-thread or per-task
   * provider is set. Multiple providers can be configured and used;
   * this is only the implicit fallback. May be undefined.
   */
  private defaultId: string | undefined;
  private initialized = false;

  /**
   * @param reader Optional pre-built reader. If omitted, the store
   * uses a lazy default that requires the electron-bound
   * `provider-store-electron` module. Production code paths should
   * inject the reader explicitly via `provider-store-electron.ts`;
   * tests should pass a fake.
   * @param capabilityStore Optional capability persistence. Defaults
   * to a `NoopCapabilityStore` so tests that don't exercise the
   * capability surface still work.
   */
  constructor(reader?: ProviderStoreReader, capabilityStore?: CapabilityStore) {
    if (reader) {
      this.reader = reader;
    } else {
      // Defer require to keep this file free of static electron
      // imports for non-electron test environments.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createDefaultReader } = require('./provider-store-electron.js') as {
        createDefaultReader: () => ProviderStoreReader;
      };
      this.reader = createDefaultReader();
    }
    if (capabilityStore) {
      this.capabilityStore = capabilityStore;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('./provider-store-electron.js') as {
          createDefaultDao?: () => CapabilityStore;
        };
        this.capabilityStore = mod.createDefaultDao
          ? mod.createDefaultDao()
          : new NoopCapabilityStore();
      } catch {
        this.capabilityStore = new NoopCapabilityStore();
      }
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /** Load the legacy apiProviders, migrate to LlmProvider, cache. Idempotent. */
  migrateAllLegacyProviders(): { count: number; activeId?: string; defaultId?: string } {
    const legacy = this.reader.readAll();
    this.cache.clear();
    this.activeId = undefined;
    this.defaultId = this.reader.readDefault()?.id;
    for (const legacyProvider of Object.values(legacy)) {
      const llm = migrateLegacyApiProvider(legacyProvider);
      this.cache.set(llm.id, llm);
      if (legacyProvider.isActive) this.activeId = legacyProvider.id;
    }
    // Fallback for direct callers (e.g. unit tests) that populate
    // `isActive: true` but never went through the boot-time
    // `migrateMultiProviderV1`. If the reader has no default set,
    // inherit from the legacy `isActive` flag. Production code paths
    // always run the boot migration first, so this branch is a no-op
    // outside of tests.
    if (!this.defaultId && this.activeId && this.cache.has(this.activeId)) {
      this.defaultId = this.activeId;
    }
    // If the configured default was deleted, drop it.
    if (this.defaultId && !this.cache.has(this.defaultId)) {
      this.defaultId = undefined;
    }
    this.initialized = true;
    return {
      count: this.cache.size,
      activeId: this.activeId,
      defaultId: this.defaultId,
    };
  }

  /** Returns the cached migrated providers, lazily migrating. */
  private ensureInitialized(): void {
    if (!this.initialized) this.migrateAllLegacyProviders();
  }

  // ===========================================================================
  // Read (LlmProvider)
  // ===========================================================================

  listLlmProviders(): LlmProvider[] {
    this.ensureInitialized();
    return Array.from(this.cache.values()).sort(
      (a, b) => a.meta.sortIndex - b.meta.sortIndex,
    );
  }

  getLlmProvider(id: string): LlmProvider | undefined {
    this.ensureInitialized();
    return this.cache.get(id);
  }

  /**
   * @deprecated Use getDefaultLlmProvider. The single-active concept is gone;
   * this returns the soft default for backward compatibility.
   */
  getActiveLlmProvider(): LlmProvider | undefined {
    return this.getDefaultLlmProvider();
  }

  getDefaultLlmProvider(): LlmProvider | undefined {
    this.ensureInitialized();
    if (!this.defaultId) return undefined;
    return this.cache.get(this.defaultId);
  }

  // ===========================================================================
  // Write (LlmProvider)
  // ===========================================================================

  upsertLlmProvider(provider: LlmProvider): { ok: true } | { ok: false; code: string; message: string } {
    this.ensureInitialized();
    // Plan 209: defense in depth. Even though the renderer is
    // supposed to never send a masked value as `auth.apiKey`, the
    // earlier version of the code (pre-Plan 209) would happily
    // persist it. We reject it here so a renderer bug cannot
    // silently destroy a user's credential. The error code is
    // stable: `'masked_key'`.
    if (provider.auth?.apiKey !== undefined && isMaskedKey(provider.auth.apiKey)) {
      const msg = 'apiKey looks like a masked placeholder; refusing to persist';
      logError('ProviderStore.upsertLlmProvider rejected masked apiKey', { id: provider.id });
      return { ok: false, code: 'masked_key', message: msg };
    }
    // Plan 209 / Fix-up: when the caller sends an `auth` whose
    // `apiKey` is undefined (i.e. the user did not retype the key
    // on edit), preserve the existing on-disk apiKey. Otherwise
    // the renderer-side `sharedMeta.auth = { type: 'api-key' }`
    // would have an empty `apiKey` field, `validateAuth` would
    // fail with `auth.missingApiKey`, and the entire upsert —
    // including `enabled_models` — would be silently dropped.
    //
    // We only merge the existing apiKey when the auth type
    // still expects one (api-key / bearer). A caller setting
    // `auth.type = 'none'` is explicitly clearing the credential
    // and we must honor that.
    if (
      provider.auth &&
      provider.auth.apiKey === undefined &&
      (provider.auth.type === 'api-key' || provider.auth.type === 'bearer')
    ) {
      const existing = this.cache.get(provider.id);
      if (existing && existing.auth?.apiKey) {
        provider = {
          ...provider,
          auth: { ...provider.auth, apiKey: existing.auth.apiKey },
        };
      }
    }
    const result = validateProvider(provider);
    if (!result.ok) {
      return { ok: false, code: result.code ?? 'invalid', message: result.message ?? 'invalid' };
    }
    provider.meta.updatedAt = Date.now();
    this.cache.set(provider.id, provider);
    this.persist();
    return { ok: true };
  }

  deleteLlmProvider(id: string): boolean {
    this.ensureInitialized();
    if (!this.cache.has(id)) return false;
    this.cache.delete(id);
    if (this.activeId === id) this.activeId = undefined;
    if (this.defaultId === id) this.defaultId = undefined;
    this.persist();
    return true;
  }

  /**
   * @deprecated Use setDefaultLlmProvider. Retained for one release so
   * existing callers keep compiling.
   */
  setActiveLlmProvider(id: string): boolean {
    return this.setDefaultLlmProvider(id);
  }

  /**
   * Set (or clear) the soft default provider. The default is the
   * implicit fallback used by chat/vision/gateway/etc when no explicit
   * per-thread or per-task provider is set. Multiple providers remain
   * usable in parallel — setting the default does NOT lock the others.
   *
   * Pass `null` to clear the default.
   */
  setDefaultLlmProvider(id: string | null): boolean {
    this.ensureInitialized();
    if (id !== null && !this.cache.has(id)) return false;
    this.defaultId = id ?? undefined;
    // Keep `activeId` in sync so the legacy bridge still has a single
    // owner for the `ApiProvider.isActive` round-trip. After the legacy
    // `isActive` is removed (Task 15) this assignment is harmless.
    this.activeId = this.defaultId;
    // Reflect on the cached providers so the renderer DTO mapper can
    // still surface the `'active'` tag during the migration window.
    for (const [pid, p] of this.cache) {
      const tags = new Set(p.meta.tags ?? []);
      if (pid === this.defaultId) tags.add('active');
      else tags.delete('active');
      p.meta.tags = Array.from(tags);
    }
    this.persist();
    return true;
  }

  // ===========================================================================
  // Runtime config (used by agent runtime)
  // ===========================================================================

  /**
   * Build the `ProviderRuntimeConfig` for the active provider, given a
   * `modelId`. This is the single source of truth for "what config does
   * the agent runtime receive?".
   *
   * Returns null if there is no active provider, OR if validation fails.
   * Caller is responsible for surfacing a clear error.
   *
   * Secret redaction: secrets are NEVER written to logs. Validation
   * errors are run through `redactSecrets()` before being returned.
   */
  getActiveProviderRuntimeConfig(
    modelId: string,
    capabilities?: ModelCapability,
  ): ProviderRuntimeConfig | { error: string; code: string } {
    this.ensureInitialized();
    const active = this.getActiveLlmProvider();
    if (!active) {
      return { error: 'no active provider', code: 'runtime.noActiveProvider' };
    }
    if (!modelId) {
      return { error: 'modelId required', code: 'runtime.missingModel' };
    }
    const cfg = toRuntimeConfig(active, { modelId, capabilities });
    const v = validateRuntimeConfig(cfg);
    if (!v.ok) {
      return {
        error: redactSecrets(v.message ?? 'invalid runtime config'),
        code: v.code ?? 'runtime.invalid',
      };
    }
    return cfg;
  }

  /**
   * Get a runtime config for a specific (providerId, modelId) pair.
   * Used for title-generation / gateway / wiki-agent sub-models.
   */
  getProviderRuntimeConfig(
    providerId: string,
    modelId: string,
    capabilities?: ModelCapability,
  ): ProviderRuntimeConfig | { error: string; code: string } {
    this.ensureInitialized();
    const p = this.getLlmProvider(providerId);
    if (!p) return { error: `provider ${providerId} not found`, code: 'provider.notFound' };
    if (!modelId) return { error: 'modelId required', code: 'runtime.missingModel' };
    const cfg = toRuntimeConfig(p, { modelId, capabilities });
    const v = validateRuntimeConfig(cfg);
    if (!v.ok) {
      return {
        error: redactSecrets(v.message ?? 'invalid runtime config'),
        code: v.code ?? 'runtime.invalid',
      };
    }
    return cfg;
  }

  // ===========================================================================
  // Health & model sync (Electron side)
  // ===========================================================================

  /**
   * Run a smoke test against the provider. Returns a sanitized
   * `ProviderHealthStatus`. Never writes the apiKey to logs.
   *
   * `presetKey` is best-effort; if not given, we discover from the
   * provider's `meta.tags` (any tag that matches a preset key) or fall
   * back to the openai-compatible probe.
   */
  async testProvider(
    providerId: string,
    presetKey?: string,
  ): Promise<ProviderHealthStatus> {
    this.ensureInitialized();
    const provider = this.getLlmProvider(providerId);
    if (!provider) {
      return {
        providerId,
        ok: false,
        checkedAt: Date.now(),
        errorKind: 'invalid_config',
        message: 'provider not found',
      };
    }
    // Discover the preset: explicit > meta.tags[0] matching > undefined.
    let discoveredKey = presetKey;
    if (!discoveredKey) {
      const tag = provider.meta.tags?.find((t) => Boolean(findPresetByKey(t)));
      if (tag) discoveredKey = tag;
    }
    return providerHealthService.testProvider(provider, discoveredKey);
  }

  async testModel(
    providerId: string,
    modelId: string,
  ): Promise<ProviderHealthStatus> {
    this.ensureInitialized();
    const provider = this.getLlmProvider(providerId);
    if (!provider) {
      return {
        providerId,
        ok: false,
        checkedAt: Date.now(),
        errorKind: 'invalid_config',
        message: 'provider not found',
      };
    }
    return providerHealthService.testModel(provider, modelId);
  }

  /** Sync a provider's model list. The result is also written to the
   *  model_capability service (renderer) and returned to the caller.
   */
  async syncProviderModels(
    providerId: string,
    presetKey?: string,
  ): Promise<{ ok: boolean; models: ModelCapability[]; source: string; message?: string }> {
    this.ensureInitialized();
    const provider = this.getLlmProvider(providerId);
    if (!provider) {
      return { ok: false, models: [], source: 'error', message: 'provider not found' };
    }
    const result = await modelSyncService.syncProviderModels(provider, presetKey);
    return {
      ok: result.ok,
      models: result.models,
      source: result.source,
      message: result.message ? redactSecrets(result.message) : undefined,
    };
  }

  // ===========================================================================
  // ModelCapability helpers
  // ===========================================================================

  /**
   * Phase 3: persist a `ModelCapability` record. The capability is
   * stored in the SQLite `provider_model_capabilities` table
   * (Phase 3 schema migration in `electron/db/schema.ts`).
   *
   * The record is keyed on `(provider_id, model_id)`. The user's
   * `source = 'user'` always wins over `preset` / `models-api`.
   */
  upsertModelCapability(
    capability: ModelCapability,
  ): { ok: true; capability: ModelCapability } {
    const stored = this.capabilityStore.upsert(capability);
    return { ok: true, capability: stored };
  }

  listModelCapabilities(providerId: string): ModelCapability[] {
    return this.capabilityStore.listByProvider(providerId);
  }

  getModelCapability(
    providerId: string,
    modelId: string,
  ): ModelCapability | undefined {
    return this.capabilityStore.getOne(providerId, modelId);
  }

  deleteModelCapability(providerId: string, modelId: string): boolean {
    return this.capabilityStore.delete(providerId, modelId);
  }

  // ===========================================================================
  // Internal: persist migrated state back to legacy store
  // ===========================================================================

  private persist(): void {
    const map: Record<string, ApiProvider> = {};
    for (const p of this.cache.values()) {
      const legacy = toLegacyApiProvider(p);
      // Keep `isActive` derived from `defaultId` so the legacy on-disk
      // format stays consistent. The renderer DTO mapper reads `isDefault`
      // from the new code path; the legacy `isActive` field is only used
      // by the migration (multi-provider-v1) and any pre-existing readers.
      legacy.isActive = p.id === this.defaultId;
      map[p.id] = legacy;
    }
    try {
      this.reader.writeAll(map);
      logInfo('ProviderStore.persist', {
        count: Object.keys(map).length,
        default: this.defaultId,
      });
    } catch (err) {
      logError('ProviderStore.persist failed', err);
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

// =============================================================================
// Singleton — moved to `provider-store-electron.ts` to keep this file
// free of `electron` imports (for testing).
// =============================================================================
