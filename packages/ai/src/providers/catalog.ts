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
  id: string;                 // 稳定 id，对应前端 VendorPreset.key
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
    billingModel?: 'pay_as_you_go' | 'coding_plan' | 'token_plan' | 'free' | 'self_hosted';
    notes?: string[];
  };
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