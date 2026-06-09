/**
 * src/lib/providers/models/ModelSyncService.ts
 *
 * Synchronizes a provider's model list.
 *
 * Strategy:
 *  1. If the provider's preset `modelsSource` is `openai-compatible-models`,
 *     GET `{baseUrl}/v1/models` with the provider's bearer token.
 *  2. If the preset's `modelsSource` is `custom-url`, GET that URL.
 *  3. If both fail or the provider doesn't expose a model list, fall back
 *     to the preset's `defaultModels` (as `ModelCapability` records).
 *
 * All errors are returned as data — never thrown — so the caller can decide
 * how to surface them.
 */

import type { LlmProvider, ModelCapability, ProviderPreset } from '../types';
import { findPresetByKey, PRESET_BY_KEY } from '../presets';
import { modelCapabilityService } from './ModelCapabilityService';

export interface SyncResult {
  ok: boolean;
  source: 'models-api' | 'static' | 'error';
  models: ModelCapability[];
  message?: string;
}

const TIMEOUT_MS = 8000;

function redactUrl(url: string): string {
  // Never include any query-string api_key in logs.
  try {
    const u = new URL(url);
    u.search = '';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

export class ModelSyncService {
  async syncProviderModels(
    provider: LlmProvider,
    presetKey?: string,
  ): Promise<SyncResult> {
    const preset: ProviderPreset | undefined =
      (presetKey ? findPresetByKey(presetKey) : undefined) ||
      (() => {
        const tag = provider.meta.tags?.find((t) => PRESET_BY_KEY[t]);
        return tag ? PRESET_BY_KEY[tag] : undefined;
      })();

    const source = preset?.modelsSource ?? { type: 'static' as const };

    if (source.type === 'openai-compatible-models') {
      const result = await this.fetchOpenAICompatibleModels(provider, source.path ?? '/models');
      if (result.ok) {
        this.applyCapabilities(provider, result.models);
        return { ok: true, source: 'models-api', models: result.models };
      }
      const fallback = this.fallbackToPresetModels(provider, preset);
      return {
        ok: true,
        source: 'static',
        models: fallback,
        message: result.message,
      };
    }

    if (source.type === 'custom-url') {
      const result = await this.fetchCustomUrl(provider, source.url);
      if (result.ok) {
        this.applyCapabilities(provider, result.models);
        return { ok: true, source: 'models-api', models: result.models };
      }
      const fallback = this.fallbackToPresetModels(provider, preset);
      return {
        ok: true,
        source: 'static',
        models: fallback,
        message: result.message,
      };
    }

    // 'static' — just emit the preset's defaults as capabilities.
    const fallback = this.fallbackToPresetModels(provider, preset);
    return { ok: true, source: 'static', models: fallback };
  }

  async fetchOpenAICompatibleModels(
    provider: LlmProvider,
    path: string = '/models',
  ): Promise<{ ok: boolean; models: ModelCapability[]; message?: string }> {
    const base = provider.endpoints.baseUrl.replace(/\/+$/, '');
    if (!base) return { ok: false, models: [], message: 'no baseUrl' };
    const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (provider.auth.apiKey) {
        headers.Authorization = `Bearer ${provider.auth.apiKey}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          ok: false,
          models: [],
          message: `HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
      const ids = (json.data ?? json.models ?? [])
        .map((m) => m?.id)
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
      const models: ModelCapability[] = ids.map((id) => ({
        providerId: provider.id,
        modelId: id,
        displayName: id,
        source: 'models-api',
        updatedAt: Date.now(),
      }));
      return { ok: models.length > 0, models };
    } catch (err) {
      return {
        ok: false,
        models: [],
        message: redactUrl(url) + ' :: ' + (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private async fetchCustomUrl(
    provider: LlmProvider,
    pathOrUrl: string,
  ): Promise<{ ok: boolean; models: ModelCapability[]; message?: string }> {
    const isFullUrl = /^https?:\/\//.test(pathOrUrl);
    const base = provider.endpoints.baseUrl.replace(/\/+$/, '');
    const url = isFullUrl ? pathOrUrl : `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, models: [], message: `HTTP ${res.status}` };
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const ids = (json.models ?? [])
        .map((m) => m?.name)
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
      return {
        ok: ids.length > 0,
        models: ids.map((id) => ({
          providerId: provider.id,
          modelId: id,
          displayName: id,
          source: 'models-api' as const,
          updatedAt: Date.now(),
        })),
      };
    } catch (err) {
      return {
        ok: false,
        models: [],
        message: redactUrl(url) + ' :: ' + (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private fallbackToPresetModels(
    provider: LlmProvider,
    preset: ProviderPreset | undefined,
  ): ModelCapability[] {
    const fallback: ModelCapability[] = [];
    if (preset?.defaultModels) {
      for (const id of preset.defaultModels) {
        fallback.push({
          providerId: provider.id,
          modelId: id,
          displayName: preset.defaultModelLabels?.[id] ?? id,
          source: 'preset',
          updatedAt: Date.now(),
        });
      }
    }
    return fallback;
  }

  private applyCapabilities(
    provider: LlmProvider,
    models: ModelCapability[],
  ): void {
    for (const m of models) {
      modelCapabilityService.upsertModelCapability(m);
    }
    // Make sure the provider has the preset's static models merged in
    // for offline display.
    const preset = provider.meta.tags?.find((t) => PRESET_BY_KEY[t])
      ? PRESET_BY_KEY[provider.meta.tags.find((t) => PRESET_BY_KEY[t])!]
      : undefined;
    if (preset?.defaultModels) {
      modelCapabilityService.mergePresetModels(
        provider.id,
        preset.defaultModels,
        preset.defaultModelLabels,
      );
    }
  }
}

export const modelSyncService = new ModelSyncService();
