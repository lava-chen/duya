/**
 * electron/config/provider-types.ts
 *
 * Pure types and helpers for the legacy `ApiProvider` DTO. Extracted from
 * `manager.ts` so the agent-server bundle (which runs in
 * `ELECTRON_RUN_AS_NODE=1` and cannot `require('electron')`) can import
 * the type and the `toLLMProvider` mapping without pulling in the
 * electron-native parts of the config manager.
 *
 * The `ApiProvider` type is the legacy on-disk shape (`isActive` boolean).
 * It is converted to the new `LlmProvider` shape by
 * `src/lib/providers/legacy.ts#toLegacyApiProvider` at the IPC boundary.
 */

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

export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

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

/**
 * Convert provider type to LLM provider for agent process.
 *
 * Pure function — no electron, no I/O. Replicated here from
 * `config/manager.ts#toLLMProvider` so the agent-server bundle can
 * import it without dragging in the electron module.
 */
export function toLLMProvider(
  providerType: ApiProvider['providerType'],
  baseUrl?: string,
): LLMProvider {
  switch (providerType) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
      return 'anthropic';
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
    case 'google':
    case 'gemini-image':
      if (baseUrl?.includes('localhost:11434') || baseUrl?.includes('127.0.0.1:11434')) {
        return 'ollama';
      }
      return 'openai';
    case 'ollama':
      return 'ollama';
    default:
      return 'anthropic';
  }
}
