/**
 * services/voice/cloud-endpoint.ts — shared cloud STT endpoint resolution.
 *
 * Pure module (no Electron imports) so both the VoiceService and the CLI
 * voice doctor can resolve the effective cloud endpoint through the same
 * fallback chain: explicit `voice.stt.cloud.provider` → default provider →
 * first configured provider (mirrors agent-communicator's
 * getDefaultOrFirstLlmProvider) so voice works out of the box whenever any
 * provider exists.
 */
import type { ResolvedVoiceConfig } from '@duya/voice';

/** Structural subset of ProviderStore's LlmProvider we depend on. */
export interface CloudProviderLike {
  endpoints?: { baseUrl?: string };
  auth?: { apiKey?: string };
}

/** Structural subset of ProviderStore used for endpoint resolution. */
export interface CloudEndpointSource {
  getLlmProvider(id: string): CloudProviderLike | undefined;
  getDefaultLlmProvider(): CloudProviderLike | undefined;
  listLlmProviders(): CloudProviderLike[];
}

export interface CloudEndpoint {
  baseUrl: string;
  apiKey: string;
}

/**
 * Resolve the effective cloud STT endpoint (explicit config base_url wins
 * over the provider's, mirroring VoiceService.startCloud).
 */
export function resolveCloudEndpoint(
  cfg: ResolvedVoiceConfig,
  source: CloudEndpointSource,
): CloudEndpoint {
  const explicit = cfg.cloud.provider ? source.getLlmProvider(cfg.cloud.provider) : undefined;
  const provider =
    explicit ?? source.getDefaultLlmProvider() ?? source.listLlmProviders()[0];
  const baseUrl = (cfg.cloud.baseUrl || provider?.endpoints?.baseUrl || '').replace(/\/+$/, '');
  const apiKey = provider?.auth?.apiKey || '';
  return { baseUrl, apiKey };
}

/** True when the resolved endpoint has both a base URL and an API key. */
export function cloudEndpointReady(endpoint: CloudEndpoint): boolean {
  return endpoint.baseUrl.length > 0 && endpoint.apiKey.length > 0;
}
