import type { AuthType } from '../auth/types.js';
import { BUILTIN_CATALOG_ENTRIES } from './catalog-data.js';

export type CatalogProtocol =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'openrouter'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'vertex';

export interface CatalogModel {
  modelId: string;
  displayName: string;
  /** Optional upstream model id consumed by the frontend (falls back to modelId). */
  upstreamModelId?: string;
}

export interface ProviderCatalogEntry {
  id: string;                 // Stable id, maps to frontend VendorPreset.key
  name: string;
  descriptionZh: string;
  protocol: CatalogProtocol;
  authTypes: AuthType[];
  baseUrl: string;
  iconKey: string;
  defaultModels: CatalogModel[];
  sdkProxyOnly?: boolean;
  /** Default env overrides (migrated from frontend defaultEnvOverrides). */
  envOverrides?: Record<string, string>;
  /** Form fields the frontend should show when configuring this provider. */
  fields?: string[];
  /** Provider category, used to filter media presets from chat options. */
  category?: 'chat' | 'media';
  meta?: {
    apiKeyUrl?: string;
    docsUrl?: string;
    pricingUrl?: string;
    statusPageUrl?: string;
    billingModel?: 'pay_as_you_go' | 'coding_plan' | 'token_plan' | 'free' | 'self_hosted';
    notes?: string[];
  };
  // ── Domain fields (for frontend LlmProviderService / ModelSyncService / etc.) ──
  /** Domain category for the provider entity. */
  providerCategory?: 'official' | 'aggregator' | 'custom' | 'local' | 'managed' | 'proxy';
  /** Auth form fields for the settings UI. */
  authFields?: Array<{ key: string; label: string; secret: boolean; required: boolean }>;
  /** Model source strategy for the provider. */
  modelsSource?:
    | { type: 'static' }
    | { type: 'openai-compatible-models'; path?: string }
    | { type: 'custom-url'; url: string };
  /** Display labels for defaultModels when source is 'static'. */
  defaultModelLabels?: Record<string, string>;
  /** Candidate endpoints for future speed-test / auto-select. */
  endpointCandidates?: string[];
  /** Icon color for UI rendering. */
  iconColor?: string;
  /** Provider website URL. */
  websiteUrl?: string;
  /** Legacy protocol name (e.g. 'openai-compatible', 'ollama') for migration UI. */
  legacyProtocol?: string;
}

export interface ProviderCatalog {
  list(): readonly ProviderCatalogEntry[];
  get(id: string): ProviderCatalogEntry | undefined;
  byProtocol(protocol: CatalogProtocol): readonly ProviderCatalogEntry[];
}

export function createProviderCatalog(entries: readonly ProviderCatalogEntry[]): ProviderCatalog {
  const map = new Map(entries.map((e) => [e.id, e]));
  return {
    list: () => entries,
    get: (id) => map.get(id),
    byProtocol: (protocol) => entries.filter((e) => e.protocol === protocol),
  };
}

export const BUILTIN_CATALOG = createProviderCatalog(BUILTIN_CATALOG_ENTRIES);
export { BUILTIN_CATALOG_ENTRIES };