/**
 * src/lib/providers/index.ts
 *
 * Public entry point for the new provider domain.
 *
 * Re-exports all types and services. The renderer should import from
 * `@/lib/providers` (or its sub-paths) instead of from the legacy
 * `@/lib/provider-presets`.
 */

export * from './types';
export {
  inferApiFormatFromLegacyProviderType,
  inferCategoryFromLegacyProviderType,
  migrateLegacyApiProvider,
  toLegacyApiProvider,
  maskApiProvider,
  buildLlmProviderFromPreset,
  defaultApiKeyField,
} from './legacy';

export {
  validateProvider,
  validateAuth,
  validateEndpoint,
  redactSecrets,
  redactSecret,
} from './domain/ProviderValidation';

export {
  toRuntimeConfig,
  toRuntimeConfigFromLegacy,
  buildHeaders,
  normalizeBaseUrl,
  validateRuntimeConfig,
  toLegacyLlmProviderDiscriminator,
} from './domain/ProviderRuntimeAdapter';

export { LlmProviderService, toRendererDto } from './domain/LlmProviderService';

export {
  ALL_PRESETS,
  PRESET_BY_KEY,
  findPresetByKey,
  findPresetsByCategory,
  ANTHROPIC_PRESETS,
  OPENAI_PRESETS,
  OLLAMA_PRESETS,
  GOOGLE_PRESETS,
  BEDROCK_PRESETS,
  CUSTOM_PRESETS,
} from './presets';

export { ModelCapabilityService, modelCapabilityService } from './models/ModelCapabilityService';
export { ModelSyncService, modelSyncService } from './models/ModelSyncService';
export { ProviderHealthService, providerHealthService } from './health/ProviderHealthService';
