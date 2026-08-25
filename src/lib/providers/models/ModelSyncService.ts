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
import { findPresetByKey, PRESET_BY_KEY } from '../catalog';
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

/**
 * Recognize an LM Studio base URL by port (`1234`) or by an explicit
 * `/lm-studio` marker in the host (uncommon but harmless to handle).
 * Matches both `http://localhost:1234/v1` and `http://127.0.0.1:1234/v1`.
 * Mirrors `electron/services/network/provider-tester.ts#isLocalRuntimeEndpoint`
 * so the IPC `fetchOpenAICompatibleModels` and the renderer `fetchProviderModels`
 * agree on what counts as LM Studio.
 */
function isLmStudioBaseUrl(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase();
  return /[:.]1234(\/|$)/.test(lower) || lower.includes('lm-studio');
}

/**
 * Strip the OpenAI-style inference suffix (`/v1`, `/v1beta`, `/v1alpha`)
 * from a base URL so LM Studio's native endpoints can be addressed at
 * the server root. Mirrors the same stripping rule in
 * `electron/services/network/model-fetcher.ts#buildCandidateUrls`.
 */
function stripV1Suffix(baseUrl: string): string {
  return baseUrl.replace(/\/(v1|v1beta|v1alpha)\/?$/i, '');
}

function pickId(raw: Record<string, unknown>): string | undefined {
  const id = raw.id ?? raw.key ?? raw.name;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function pickDisplayName(raw: Record<string, unknown>): string | undefined {
  const n = raw.display_name ?? raw.displayName;
  return typeof n === 'string' && n.length > 0 ? n : undefined;
}

/**
 * Resolve the rich context-window payload exposed by LM Studio's
 * `/api/v1/models`. Mirrors the canonical logic in
 * `electron/services/network/model-fetcher.ts#extractModels` so the
 * settings-side fetch and the chat-side sync produce identical
 * per-model context windows (without the user needing to refetch).
 */
function pickContextWindow(raw: Record<string, unknown>): {
  contextLength?: number;
  contextWindowMax?: number;
  isLoaded: boolean;
} {
  let loadedCtx: number | undefined;
  if (Array.isArray(raw.loaded_instances) && raw.loaded_instances.length > 0) {
    const inst = raw.loaded_instances[0] as { config?: { context_length?: unknown } } | null;
    const v = inst?.config?.context_length;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      loadedCtx = Math.floor(v);
    }
  }
  const maxRaw =
    raw.max_context_length ?? raw.maxContextLength ?? raw.context_length ?? raw.contextLength;
  const maxCtx =
    typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.floor(maxRaw)
      : undefined;
  const ctxLength = loadedCtx ?? maxCtx;
  const contextWindowMax = maxCtx ?? ctxLength;
  return {
    ...(ctxLength !== undefined ? { contextLength: ctxLength } : {}),
    ...(contextWindowMax !== undefined ? { contextWindowMax } : {}),
    // isLoaded uses the same validity check as contextLength so
    // malformed entries like `[null, {}]` don't produce a false
    // "loaded" tag.
    isLoaded: loadedCtx !== undefined,
  };
}

/**
 * Normalize LM Studio's `capabilities.reasoning.allowed_options` into
 * the canonical `reasoningEffortOptions` array. Mirrors the equivalent
 * helper in `electron/services/network/model-fetcher.ts` so the two
 * fetch paths produce identical lists.
 */
function normalizeReasoningEffortOptions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    const lower = trimmed.toLowerCase();
    if (lower === 'off' || lower === 'on') continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve the capabilities block from a raw LM Studio entry. Mirrors
 * `electron/services/network/model-fetcher.ts#extractCapabilities` so
 * the two fetch paths report the same flags.
 */
function pickCapabilities(raw: Record<string, unknown>): {
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  supportsReasoning?: boolean;
  reasoningEffortOptions?: string[];
} {
  const caps = raw.capabilities;
  if (!caps || typeof caps !== 'object') return pickAggregatorCapabilities(raw);
  const c = caps as Record<string, unknown>;
  const out: {
    supportsVision?: boolean;
    supportsToolUse?: boolean;
    supportsReasoning?: boolean;
    reasoningEffortOptions?: string[];
  } = {};
  if (typeof c.vision === 'boolean') out.supportsVision = c.vision;
  if (typeof c.trained_for_tool_use === 'boolean') {
    out.supportsToolUse = c.trained_for_tool_use;
  }
  if (c.reasoning && typeof c.reasoning === 'object') {
    const r = c.reasoning as Record<string, unknown>;
    const normalized = normalizeReasoningEffortOptions(r.allowed_options);
    if (normalized && normalized.length > 0) {
      out.supportsReasoning = true;
      out.reasoningEffortOptions = normalized;
    } else if (typeof r.default === 'string') {
      out.supportsReasoning = r.default.trim().toLowerCase() !== 'off';
    } else if (Array.isArray(r.allowed_options) && r.allowed_options.length > 0) {
      out.supportsReasoning = false;
    }
  }
  // Merge aggregator-style flags (OpenRouter) when the LM Studio block
  // didn't already report them. Non-aggregator entries have neither.
  const agg = pickAggregatorCapabilities(raw);
  if (out.supportsVision === undefined) out.supportsVision = agg.supportsVision;
  if (out.supportsToolUse === undefined) out.supportsToolUse = agg.supportsToolUse;
  if (out.supportsReasoning === undefined) out.supportsReasoning = agg.supportsReasoning;
  return out;
}

/**
 * Extract capability flags from OpenRouter-style `/models` entries:
 * - `architecture.input_modalities` containing `'image'` → supportsVision
 * - `supported_parameters` containing `'tools'` → supportsToolUse
 * - `supported_parameters` containing `'reasoning'` → supportsReasoning
 *
 * Mirrors `extractAggregatorCapabilities` in
 * `electron/services/network/model-fetcher.ts` so both fetch paths agree.
 * Returns empty for non-OpenRouter-shaped entries (LM Studio, plain OpenAI).
 */
function pickAggregatorCapabilities(raw: Record<string, unknown>): {
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  supportsReasoning?: boolean;
} {
  const out: {
    supportsVision?: boolean;
    supportsToolUse?: boolean;
    supportsReasoning?: boolean;
  } = {};

  const architecture = raw.architecture;
  if (
    architecture && typeof architecture === 'object' &&
    Array.isArray((architecture as Record<string, unknown>).input_modalities)
  ) {
    const modalities = (architecture as Record<string, unknown>).input_modalities as unknown[];
    out.supportsVision = modalities.some(
      (m) => typeof m === 'string' && m.toLowerCase() === 'image',
    );
  }

  if (Array.isArray(raw.supported_parameters)) {
    const params = raw.supported_parameters as unknown[];
    const has = (name: string) =>
      params.some((p) => typeof p === 'string' && p.toLowerCase() === name);
    if (has('tools')) out.supportsToolUse = true;
    if (has('reasoning')) out.supportsReasoning = true;
  }

  return out;
}

/**
 * Extract the per-request output ceiling from an OpenRouter-style
 * `top_provider.max_completion_tokens`. Returns `undefined` when the field is
 * absent so callers can distinguish "not reported" from a real value.
 */
function pickMaxOutputTokens(raw: Record<string, unknown>): number | undefined {
  const top = raw.top_provider;
  if (!top || typeof top !== 'object') return undefined;
  const value = (top as Record<string, unknown>).max_completion_tokens;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
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
    // LM Studio exposes a richer catalog at `/api/v1/models` (per-model
    // `capabilities.{vision,trained_for_tool_use,reasoning}`, `format`,
    // `max_context_length`, and per-loaded-instance `context_length`).
    // The plain OpenAI `/v1/models` only gives us `id`. Hit the rich
    // endpoint first when we recognize an LM Studio host; fall back to
    // the OpenAI-compat path for everyone else (and for LM Studio when
    // the rich endpoint is unreachable, e.g. older versions).
    const isLmStudio = isLmStudioBaseUrl(base);
    // LM Studio's native endpoints (`/api/v1/models`) live on the
    // SERVER ROOT, not the inference base `/v1` used by the OpenAI
    // compat surface. Stripping the trailing `/v1[beta]?` keeps the
    // hit landing on the LM Studio server root, not `/v1/api/v1/models`.
    const lmStudioRoot = isLmStudio ? stripV1Suffix(base) : base;
    const paths = isLmStudio ? ['/api/v1/models', path] : [path];
    let lastMessage: string | undefined;
    for (const p of paths) {
      const url = `${(isLmStudio ? lmStudioRoot : base)}${p.startsWith('/') ? '' : '/'}${p}`;
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
          lastMessage = `HTTP ${res.status}`;
          continue;
        }
        const json = (await res.json()) as {
          data?: Array<Record<string, unknown>>;
          models?: Array<Record<string, unknown>>;
        };
        const list = (json.data ?? json.models ?? []) as Array<Record<string, unknown>>;
        if (list.length === 0) {
          lastMessage = `empty list at ${p}`;
          continue;
        }
        const models: ModelCapability[] = [];
        for (const raw of list) {
          // Drop embedding models — they share `/v1/models` with chat
          // models on LM Studio but are not valid chat endpoints. We
          // accept `type === 'llm'` or missing/empty `type` (OpenAI-compat
          // vendors don't set the field). Anything else is skipped.
          const t = raw.type;
          if (
            typeof t === 'string' &&
            t.length > 0 &&
            t !== 'llm'
          ) continue;
          const id = pickId(raw);
          if (!id) continue;
          const caps = pickCapabilities(raw);
          const ctx = pickContextWindow(raw);
          const maxOutputTokens = pickMaxOutputTokens(raw);
          models.push({
            providerId: provider.id,
            modelId: id,
            displayName: pickDisplayName(raw) ?? id,
            source: 'models-api',
            updatedAt: Date.now(),
            ...(ctx.contextLength !== undefined ? { contextWindow: ctx.contextLength } : {}),
            ...(ctx.contextWindowMax !== undefined
              ? { contextWindow: ctx.contextWindowMax }
              : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(caps.supportsVision !== undefined ? { supportsVision: caps.supportsVision } : {}),
            ...(caps.supportsToolUse !== undefined ? { supportsToolUse: caps.supportsToolUse } : {}),
            ...(caps.supportsReasoning !== undefined
              ? { supportsReasoning: caps.supportsReasoning }
              : {}),
            ...(caps.reasoningEffortOptions !== undefined
              ? { reasoningEffortOptions: caps.reasoningEffortOptions }
              : {}),
            isLoaded: ctx.isLoaded,
          });
        }
        if (models.length > 0) return { ok: true, models };
      } catch (err) {
        lastMessage = redactUrl(url) + ' :: ' + (err instanceof Error ? err.message : String(err));
      }
    }
    return { ok: false, models: [], message: lastMessage ?? 'no models-api response' };
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

/** Process-wide singleton used by the renderer. */
export const modelSyncService = new ModelSyncService();