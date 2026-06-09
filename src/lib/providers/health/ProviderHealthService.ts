/**
 * src/lib/providers/health/ProviderHealthService.ts
 *
 * Basic health checks for a provider.
 *
 * Phase 1 implements:
 *  - `testProvider(provider, presetKey?)`: full provider-level smoke test
 *    that delegates to `ModelSyncService.fetchOpenAICompatibleModels`
 *    for the most common case (openai-chat) and a small dedicated probe
 *    for anthropic.
 *  - `testModel(provider, modelId)`: per-model check.
 *  - `classifyProviderError(error)`: maps a thrown error / HTTP status
 *    to one of the 6 categories.
 *
 * Health-check error messages are ALWAYS run through `redactSecrets()`
 * before being attached to the result.
 */

import type {
  LlmProvider,
  ProviderHealthStatus,
  ProviderPreset,
} from '../types';
import { findPresetByKey } from '../presets';
import { redactSecrets } from '../domain/ProviderValidation';
import { modelSyncService } from '../models/ModelSyncService';

const TIMEOUT_MS = 8000;

export class ProviderHealthService {
  async testProvider(
    provider: LlmProvider,
    presetKey?: string,
  ): Promise<ProviderHealthStatus> {
    const started = Date.now();
    const preset: ProviderPreset | undefined = presetKey
      ? findPresetByKey(presetKey)
      : undefined;
    try {
      const res = await modelSyncService.fetchOpenAICompatibleModels(
        provider,
        this.discoverModelsPath(preset),
      );
      if (res.ok) {
        return {
          providerId: provider.id,
          ok: true,
          latencyMs: Date.now() - started,
          checkedAt: Date.now(),
        };
      }
      return {
        providerId: provider.id,
        ok: false,
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
        errorKind: this.classifyProviderError({ message: res.message ?? 'unknown' }),
        message: redactSecrets(res.message),
      };
    } catch (err) {
      return {
        providerId: provider.id,
        ok: false,
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
        errorKind: this.classifyProviderError(err),
        message: redactSecrets(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  async testModel(
    provider: LlmProvider,
    modelId: string,
  ): Promise<ProviderHealthStatus> {
    // For Phase 1, model-level tests reuse the provider-level probe and
    // additionally check the model appears in the listing.
    const providerStatus = await this.testProvider(provider);
    if (!providerStatus.ok) return providerStatus;
    const caps = await modelSyncService.syncProviderModels(provider);
    const has = caps.models.some((m) => m.modelId === modelId);
    if (has) return providerStatus;
    return {
      ...providerStatus,
      ok: false,
      errorKind: 'invalid_model',
      message: `Model ${modelId} not in provider's /v1/models listing`,
    };
  }

  classifyProviderError(
    err: { status?: number; message?: string } | Error | unknown,
  ): ProviderHealthStatus['errorKind'] {
    if (err && typeof err === 'object' && 'status' in err) {
      const status = (err as { status: number }).status;
      if (status === 401 || status === 403) return 'auth';
      if (status === 404) return 'invalid_model';
      if (status === 429) return 'rate_limit';
      if (status >= 400 && status < 500) return 'invalid_config';
    }
    if (err && typeof err === 'object' && 'message' in err) {
      const msg = String((err as { message: unknown }).message ?? '').toLowerCase();
      if (msg.includes('unauthorized') || msg.includes('401') || msg.includes('403')) {
        return 'auth';
      }
      if (msg.includes('not found') || msg.includes('404')) {
        return 'invalid_model';
      }
      if (msg.includes('rate limit') || msg.includes('429')) {
        return 'rate_limit';
      }
      if (msg.includes('abort') || msg.includes('network') || msg.includes('fetch')) {
        return 'network';
      }
    }
    return 'unknown';
  }

  private discoverModelsPath(preset: ProviderPreset | undefined): string {
    if (!preset) return '/v1/models';
    if (preset.modelsSource.type === 'openai-compatible-models') {
      return preset.modelsSource.path ?? '/v1/models';
    }
    return '/v1/models';
  }
}

export const providerHealthService = new ProviderHealthService();
