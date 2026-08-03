/**
 * Pure model resolution for the memory worker.
 *
 * The UI stores the user's explicit choice as a qualified id
 * (`providerId:modelId`) so the dropdown value survives provider
 * fallbacks. This module extracts the actual model id and applies the
 * same fallback chain used elsewhere (options.defaultModel,
 * options.model, enabled_models[0], protocol default).
 */
import type { ApiProvider } from '../../../src/lib/providers/types';

export type LlmProviderKind = 'anthropic' | 'openai' | 'ollama';

export function protocolDefaultModel(llmProvider: LlmProviderKind): string {
  switch (llmProvider) {
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'openai':
      return 'gpt-4o-mini';
    default:
      return 'llama3.2';
  }
}

/**
 * Extract the model id from a qualified memoryModelId value.
 * Returns empty string when the value is empty or malformed.
 */
export function extractModelFromQualifiedId(qualifiedId: string | null | undefined): string {
  if (!qualifiedId) return '';
  const parts = qualifiedId.split(':');
  if (parts.length < 2) return '';
  return parts.slice(1).join(':');
}

/**
 * Resolve the model to use for memory extraction.
 *
 * Priority:
 *   1. `memoryModelId` qualified override
 *   2. provider.options.defaultModel
 *   3. provider.options.model
 *   4. provider.options.enabled_models[0]
 *   5. protocol default
 */
export function resolveMemoryModel(
  provider: ApiProvider,
  memoryModelId: string | null,
  llmProvider: LlmProviderKind,
): string {
  const opts = provider.options ?? {};
  const explicitModel = extractModelFromQualifiedId(memoryModelId);

  return (
    explicitModel
    || (typeof opts.defaultModel === 'string' ? opts.defaultModel : '')
    || (typeof opts.model === 'string' ? opts.model : '')
    || (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0
        ? String(opts.enabled_models[0]) : '')
    || protocolDefaultModel(llmProvider)
  );
}
