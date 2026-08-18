/**
 * electron/memory/rag_embedding_client.ts — provider-framework embedding
 * client (plan 428).
 *
 * Resolves an embedding-capable client from the provider store: an
 * explicit `providerId`/`modelId` from `[memory.rag]`, falling back to the
 * memory provider/model. Credentials and endpoints are never duplicated
 * here — everything flows through `ProviderStore` + `@duya/ai` runtime
 * config, the same path `main.ts` uses for the memory LLM client.
 */

import { createAIClientWithRetry, toRuntimeConfigFromLegacy } from '@duya/ai';
import { toLegacyApiProvider } from '../../src/lib/providers/legacy';
import type { ProviderStore } from '../services/providers/provider-store';
import type { EmbeddingClient } from './rag_index';

export interface EmbeddingClientOptions {
  /** Provider id from the provider framework; empty → memory provider. */
  providerId?: string;
  /** Model id; empty → memory model override. */
  modelId?: string;
}

/**
 * Build an embedding client. Returns null when no provider/model can be
 * resolved, or when the provider family has no embeddings endpoint
 * (Anthropic). Callers then degrade to keyword-only retrieval.
 */
export function createEmbeddingClient(
  store: ProviderStore,
  opts: EmbeddingClientOptions = {},
): EmbeddingClient | null {
  const provider = opts.providerId
    ? store.getLlmProvider(opts.providerId)
    : store.getMemoryLlmProvider();
  if (!provider) return null;

  const legacy = toLegacyApiProvider(provider);
  const modelId = opts.modelId || store.getMemoryModel() || '';
  if (!modelId) return null;

  try {
    const runtime = toRuntimeConfigFromLegacy(legacy, modelId);
    // Anthropic exposes no embeddings API — signal degradation up front
    // instead of failing on every call.
    if (runtime.apiFormat === 'anthropic') return null;
    const client = createAIClientWithRetry({
      apiKey: legacy.apiKey ?? '',
      baseURL: legacy.baseUrl ?? '',
      model: modelId,
      apiFormat: runtime.apiFormat,
      providerId: runtime.providerId,
      modelCapabilities: runtime.modelCompat,
    });
    return {
      embed: (texts) => {
        if (!client.embed) {
          return Promise.reject(new Error('provider does not support embed()'));
        }
        return client.embed(texts);
      },
    };
  } catch {
    return null;
  }
}
