/**
 * src/lib/providers/catalog.ts
 *
 * Adapter that derives `ProviderPreset` instances from the @duya/ai
 * `BUILTIN_CATALOG`. This is the single source of truth — the old
 * hand-written `src/lib/providers/presets/` directory has been removed.
 *
 * The adapter maps `ProviderCatalogEntry` (from @duya/ai) to the
 * `ProviderPreset` shape consumed by the domain services
 * (LlmProviderService, ModelSyncService, ProviderHealthService, etc.).
 *
 * Key aliases (e.g. `aws-bedrock` -> `bedrock`) are handled so
 * providers created before the migration still resolve correctly.
 */

import { BUILTIN_CATALOG, type ProviderCatalogEntry, type CatalogProtocol } from '@duya/ai';
import type { ApiFormat } from '@duya/ai';
import type { ProviderPreset, ProviderCategory } from './types';

/** Map a CatalogProtocol to the runtime ApiFormat. */
function catalogProtocolToApiFormat(protocol: CatalogProtocol): ApiFormat {
  switch (protocol) {
    case 'anthropic':
      return 'anthropic';
    case 'openai-chat':
      return 'openai-chat';
    case 'openai-responses':
      return 'openai-responses';
    case 'openrouter':
      return 'openai-chat';
    case 'gemini':
      return 'gemini';
    case 'ollama':
      return 'ollama';
    case 'bedrock':
      return 'bedrock';
    case 'vertex':
      return 'vertex';
    default:
      return 'openai-chat';
  }
}

/** Map a ProviderCatalogEntry to a ProviderPreset. */
function catalogToPreset(entry: ProviderCatalogEntry): ProviderPreset {
  const defaultModels = entry.defaultModels.map((m) => m.modelId);
  const defaultModelLabels =
    entry.defaultModelLabels ??
    Object.fromEntries(entry.defaultModels.map((m) => [m.modelId, m.displayName]));

  return {
    key: entry.id,
    name: entry.name,
    description: entry.name,
    descriptionZh: entry.descriptionZh,
    category: (entry.providerCategory ?? 'custom') as ProviderCategory,
    apiFormat: catalogProtocolToApiFormat(entry.protocol),
    authFields: entry.authFields ?? [
      { key: 'api_key', label: 'API Key', secret: true, required: true },
    ],
    defaultEndpoint: entry.baseUrl,
    endpointCandidates: entry.endpointCandidates,
    modelsSource: entry.modelsSource ?? { type: 'static' },
    defaultModels,
    defaultModelLabels,
    templateValues: entry.envOverrides,
    ui: {
      icon: entry.iconKey,
      iconColor: entry.iconColor,
      websiteUrl: entry.websiteUrl,
      docsUrl: entry.meta?.docsUrl,
      apiKeyUrl: entry.meta?.apiKeyUrl,
      pricingUrl: entry.meta?.pricingUrl,
      statusPageUrl: entry.meta?.statusPageUrl,
    },
    legacyProtocol: entry.legacyProtocol,
  };
}

// ── Derived collections ────────────────────────────────────────

const _presetList: ProviderPreset[] = BUILTIN_CATALOG.list().map(catalogToPreset);
const _presetMap: Map<string, ProviderPreset> = new Map(_presetList.map((p) => [p.key, p]));

/**
 * Key aliases for backward compatibility. Providers created before
 * the migration may have tags referencing old preset keys.
 */
const KEY_ALIASES: Record<string, string> = {
  'aws-bedrock': 'bedrock',
  'google-vertex': 'vertex',
};

/** All presets, derived from BUILTIN_CATALOG. */
export const ALL_PRESETS: ProviderPreset[] = _presetList;

/**
 * Preset lookup by key, with alias resolution.
 * Includes both canonical keys and backward-compat aliases.
 */
export const PRESET_BY_KEY: Record<string, ProviderPreset> = Object.fromEntries(
  [
    ..._presetList.map((p) => [p.key, p] as const),
    ...Object.entries(KEY_ALIASES).flatMap(([alias, canonical]) => {
      const preset = _presetMap.get(canonical);
      return preset ? [[alias, preset] as const] : [];
    }),
  ],
);

/** Find a preset by its key, resolving aliases. */
export function findPresetByKey(key: string): ProviderPreset | undefined {
  return _presetMap.get(key) ?? _presetMap.get(KEY_ALIASES[key] ?? '');
}

/** Find presets by domain category. */
export function findPresetsByCategory(
  category: ProviderCategory,
): ProviderPreset[] {
  return _presetList.filter((p) => p.category === category);
}
