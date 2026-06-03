/**
 * packages/agent/src/providers/providerService.ts
 *
 * Domain reader for LLM providers. Single source of truth for the
 * CLI control plane.
 *
 * Reads the provider list from the config manager and produces a
 * redacted DTO (no API keys in any output).
 *
 * Source-of-truth: `electron/config/manager.ts` `getAllProviders()`
 * + `getActiveProvider()`.
 *
 * We declare a local mirror of `ApiProvider` to avoid a hard
 * cross-package import on the electron side (the provider config
 * lives in the electron main process). The shape is verified
 * against `electron/config/manager.ts`.
 */

export type ProviderSource = 'config';

export type ApiProviderType =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'openai-compatible'
  | 'openrouter'
  | 'bedrock'
  | 'vertex'
  | 'gemini-image'
  | 'google';

export interface ApiProvider {
  id: string;
  name: string;
  providerType: ApiProviderType;
  baseUrl: string;
  apiKey: string;
  isActive: boolean;
  extraEnv?: Record<string, string>;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  notes?: string;
  sortOrder?: number;
}

export interface ProviderListItem {
  id: string;
  name: string;
  providerType: ApiProviderType;
  isActive: boolean;
  hasKey: boolean;
  model?: string;
  baseUrl?: string;
  notes?: string;
  sortOrder?: number;
}

export interface ProviderInfoItem extends ProviderListItem {
  headers: Record<string, string>;
  extraEnvKeys: string[];
}

/**
 * Try to extract the model hint from notes (format used by
 * `duya setup` is "Default model: xxx").
 */
function extractModelFromNotes(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const m = notes.match(/Default model:\s*(\S+)/);
  return m ? m[1] : undefined;
}

/**
 * Build the redacted list DTO from a list of providers.
 */
export function toProviderListDTO(providers: ApiProvider[]): ProviderListItem[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    isActive: p.isActive,
    hasKey: !!p.apiKey && p.apiKey.length > 0,
    model: extractModelFromNotes(p.notes),
    baseUrl: p.baseUrl,
    notes: p.notes,
    sortOrder: p.sortOrder,
  }));
}

/**
 * Build the redacted info DTO for a single provider.
 */
export function toProviderInfoDTO(p: ApiProvider): ProviderInfoItem {
  const list = toProviderListDTO([p])[0];
  return {
    ...list,
    headers: p.headers ?? {},
    extraEnvKeys: Object.keys(p.extraEnv ?? {}),
  };
}