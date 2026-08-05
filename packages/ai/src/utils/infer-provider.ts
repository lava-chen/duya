/**
 * LLM provider inference heuristic
 *
 * Moved from packages/agent/src/llm/index.ts into @duya/ai.
 */

export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

/**
 * Check if the URL is a MiniMax API endpoint
 */
export function isMiniMaxURL(baseURL: string): boolean {
  const url = baseURL.toLowerCase();
  return MINIMAX_DOMAINS.some(domain => url.includes(domain));
}

/**
 * Determine the provider based on base URL and optional providerType
 * This is a heuristic that can be overridden by explicit provider setting
 *
 * Priority:
 * 1. URL is MiniMax API -> openai (MiniMax uses OpenAI-compatible API)
 * 2. URL contains 'openrouter' -> openai (authoritative, even if providerType differs)
 * 3. URL contains '/anthropic' -> anthropic
 * 4. URL contains '/v1' -> openai (OpenAI-compatible endpoint)
 * 5. URL contains 'openai' -> openai
 * 6. URL is Ollama localhost and does NOT have /v1 -> ollama (native API)
 * 7. Fall back to providerType if set
 * 8. Default -> anthropic
 *
 * NOTE: This function is used within the agent package. For frontend code,
 * use provider-resolver.ts:getLLMProvider() which has access to DB provider_type.
 * Both implementations must be kept consistent.
 */
export function inferProvider(baseURL: string, providerType?: string): LLMProvider {
  const normalizedBaseURL = (baseURL || '').toLowerCase();
  const isOllamaLocal = normalizedBaseURL.includes('localhost:11434')
    || normalizedBaseURL.includes('127.0.0.1:11434')
    || normalizedBaseURL.includes('ollama');
  const isOpenAIStyleEndpoint = normalizedBaseURL.includes('/v1');

  // If providerType is explicitly specified, use it (unless it's ambiguous)
  // This allows users to override baseURL detection in Vision Settings
  if (providerType) {
    const pt = providerType.toLowerCase();
    if (pt === 'openrouter' || pt === 'openai-compatible' || pt === 'openai') {
      // Guard against stale/mismatched UI config:
      // `openrouter` or `openai` provider with Ollama native URL should use Ollama.
      if (isOllamaLocal && !isOpenAIStyleEndpoint) {
        return 'ollama';
      }
      return 'openai';
    }
    if (pt === 'ollama') {
      // Ollama exposes both native API and OpenAI-compatible `/v1`.
      // Respect `/v1` as OpenAI-compatible mode.
      if (isOpenAIStyleEndpoint) {
        return 'openai';
      }
      return 'ollama';
    }
    if (pt === 'anthropic') {
      return 'anthropic';
    }
  }

  if (baseURL) {
    const url = normalizedBaseURL;

    // If baseUrl clearly indicates a specific provider, use it
    if (url.includes('openrouter')) {
      return 'openai';
    }
    if (url.includes('/anthropic')) {
      return 'anthropic';
    }
    if (url.includes('/v1')) {
      return 'openai';
    }
    if (url.includes('openai')) {
      return 'openai';
    }

    // Ollama local API - use native Ollama API if no /v1 path
    // If user explicitly uses /v1, they want OpenAI-compatible mode
    if (url.includes('localhost:11434') || url.includes('127.0.0.1:11434') || url.includes('ollama')) {
      return 'ollama';
    }

    // MiniMax uses OpenAI-compatible API - check after path-based detection
    if (isMiniMaxURL(url)) {
      return 'openai';
    }
  }

  // Fall back to anthropic as default
  return 'anthropic';
}