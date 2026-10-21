/**
 * Provider Presets
 * Single source of truth for quick-add provider configurations
 *
 * Based on hermes-agent's models_dev.py and CodePilot's provider-catalog.ts
 *
 * NOTE: Brand icons are NOT imported here to avoid SSR issues with @lobehub/icons.
 * Consumers should use the iconKey field and resolve icons themselves using
 * getPresetIcon() helper from their own components with proper icon imports.
 */

import type { ReactNode } from "react";
import { GlobeIcon } from "@/components/icons";
import { BUILTIN_CATALOG, type ProviderCatalogEntry, type AuthType } from "@duya/ai";

// ── Types ───────────────────────────────────────────────────────

export type Protocol =
  | 'anthropic'
  | 'openai-compatible'
  | 'openrouter'
  | 'bedrock'
  | 'vertex'
  | 'google'
  | 'gemini-image'
  | 'ollama';

export type AuthStyle =
  | 'api_key'
  | 'auth_token'
  | 'env_only'
  | 'custom_header';

export interface CatalogModel {
  modelId: string;
  upstreamModelId?: string;
  displayName: string;
}

export interface VendorPreset {
  key: string;
  name: string;
  description: string;
  descriptionZh: string;
  protocol: Protocol;
  authStyle: AuthStyle;
  baseUrl: string;
  defaultEnvOverrides: Record<string, string>;
  defaultModels: CatalogModel[];
  fields: ('name' | 'api_key' | 'base_url' | 'extra_env' | 'model_names' | 'model_mapping')[];
  category?: 'chat' | 'media';
  iconKey: string;
  sdkProxyOnly?: boolean;
  meta?: {
    apiKeyUrl?: string;
    docsUrl?: string;
    pricingUrl?: string;
    statusPageUrl?: string;
    billingModel?: 'pay_as_you_go' | 'coding_plan' | 'token_plan' | 'free' | 'self_hosted';
    notes?: string[];
  };
}

export interface QuickPreset extends VendorPreset {
  provider_type: string;
}

// ── Vendor presets ──────────────────────────────────────────────
//
// Derived from @duya/ai provider catalog (single source of truth).
// Keeps the VendorPreset shape for zero-regression rendering.

function mapCatalogProtocolToPresetProtocol(p: ProviderCatalogEntry['protocol']): Protocol {
  switch (p) {
    case 'openai-chat':
    case 'openai-responses':
      return 'openai-compatible';
    case 'gemini':
      return 'google';
    case 'anthropic':
      return 'anthropic';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'ollama';
    case 'bedrock':
      return 'bedrock';
    case 'vertex':
      return 'vertex';
    default:
      return 'openai-compatible';
  }
}

function mapAuthTypesToAuthStyle(authTypes: AuthType[]): AuthStyle {
  if (authTypes.includes('env_only')) return 'env_only';
  if (authTypes.includes('auth_token')) return 'auth_token';
  return 'api_key';
}

export const VENDOR_PRESETS: VendorPreset[] = BUILTIN_CATALOG.list().map(
  (e: ProviderCatalogEntry): VendorPreset => ({
    key: e.id,
    name: e.name,
    description: e.name,
    descriptionZh: e.descriptionZh,
    protocol: mapCatalogProtocolToPresetProtocol(e.protocol),
    authStyle: mapAuthTypesToAuthStyle(e.authTypes),
    baseUrl: e.baseUrl,
    defaultEnvOverrides: e.envOverrides ?? {},
    defaultModels: e.defaultModels,
    fields: (e.fields ?? ['api_key']) as VendorPreset['fields'],
    category: e.category,
    iconKey: e.iconKey,
    sdkProxyOnly: e.sdkProxyOnly,
    meta: e.meta,
  }),
);

// ── Convert to QuickPreset ──────────────────────────────────────

function toQuickPreset(vp: VendorPreset): QuickPreset {
  return {
    ...vp,
    provider_type: vp.protocol === 'openrouter' ? 'openrouter'
      : vp.protocol === 'bedrock' ? 'bedrock'
      : vp.protocol === 'vertex' ? 'vertex'
      : vp.protocol === 'gemini-image' ? 'gemini-image'
      : vp.protocol === 'ollama' ? 'ollama'
      : vp.protocol === 'openai-compatible' ? 'openai-compatible'
      : 'anthropic',
  };
}

export const QUICK_PRESETS: QuickPreset[] = VENDOR_PRESETS.map(toQuickPreset);

export function getPreset(key: string): QuickPreset | undefined {
  return QUICK_PRESETS.find((p) => p.key === key);
}

/**
 * Find a matching preset for a provider by base_url
 */
export function findPresetByBaseUrl(baseUrl: string): QuickPreset | undefined {
  if (!baseUrl) return undefined;
  const urlLower = baseUrl.toLowerCase();
  return QUICK_PRESETS.find(p => {
    if (!p.baseUrl) return false;
    return p.baseUrl.toLowerCase() === urlLower || urlLower.includes(p.baseUrl.toLowerCase());
  });
}

/**
 * Get icon component for a preset by iconKey.
 * Consumer must import this function and use their own @lobehub/icons imports.
 *
 * Example usage in a component:
 *   import Anthropic from "@lobehub/icons/es/Anthropic";
 *   import OpenRouter from "@lobehub/icons/es/OpenRouter";
 *   const icon = getPresetIcon(preset.iconKey, { anthropic: <Anthropic size={18} />, openrouter: <OpenRouter size={18} />, ... });
 */
export function getPresetIcon(iconKey: string, iconMap: Record<string, ReactNode>): ReactNode {
  return iconMap[iconKey] ?? <GlobeIcon size={18} />;
}
