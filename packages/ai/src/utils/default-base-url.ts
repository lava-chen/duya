/**
 * Default baseURL resolution per provider.
 *
 * The @duya/ai clients require a non-empty baseURL at construction time
 * (AIClientOptions.baseURL is mandatory). They do not fall back to a
 * provider default at runtime, so callers must supply one when the user
 * has not configured an endpoint. This helper centralizes that mapping.
 */
import type { LLMProvider } from './infer-provider.js';

export function resolveDefaultBaseURL(provider: LLMProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'ollama':
      return 'http://localhost:11434';
    default:
      return 'https://api.openai.com/v1';
  }
}