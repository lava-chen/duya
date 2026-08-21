/**
 * electron/services/network/model-fetcher.ts
 *
 * Plan 205 Phase H1: fetch the available model list from a
 * provider. Used by the renderer (ProviderEditView) so the user
 * can pick a model from a dropdown instead of typing a raw id.
 *
 * Two protocol paths:
 *   1. `protocol === 'ollama'` → reuse the existing
 *      `fetchOllamaModels` (which hits `GET /api/tags`).
 *   2. Anything else → probe OpenAI-compatible `GET /v1/models`
 *      with a small set of candidate paths. Anthropic's
 *      `GET /v1/models` is also OpenAI-shaped in this respect.
 *
 * Errors are normalized to a `FetchProviderModelsError` shape that
 * the renderer can render as inline feedback (e.g. 401 → "API Key
 * 无效", 404 → "不支持的端点"). Mirrors the error classification
 * pattern in `provider-tester.ts#classifyError`.
 */

export interface FetchedModel {
  id: string;
  ownedBy: string | null;
  /**
   * Known context window (tokens) for the model, when the source API exposes
   * it (e.g. LM Studio `/api/v0/models` reports `max_context_length`). Lets the
   * renderer seed the per-model context window instead of assuming 200K/1M.
   */
  contextLength?: number;
}

export interface FetchProviderModelsBody {
  protocol?: string;
  base_url?: string;
  api_key?: string;
  auth_style?: 'api_key' | 'auth_token' | 'env_only' | 'custom_header';
}

export interface FetchProviderModelsResult {
  success: boolean;
  models?: FetchedModel[];
  error?: {
    code:
      | 'NO_CREDENTIALS'
      | 'AUTH_FAILED'
      | 'ACCESS_DENIED'
      | 'RATE_LIMITED'
      | 'ENDPOINT_NOT_FOUND'
      | 'TIMEOUT'
      | 'CONNECTION_FAILED'
      | 'PARSE_FAILED'
      | 'EMPTY'
      | 'UNKNOWN_ERROR';
    message: string;
    suggestion?: string;
  };
}

const OLLAMA_KEYWORDS = ['localhost:11434', '127.0.0.1:11434', 'ollama'];

/**
 * A local / loopback endpoint (LM Studio at `http://localhost:1234/v1`,
 * Ollama, a LAN-hosted OpenAI-compatible server, etc.) does not require
 * an API key. Used to relax the credential guard below so the user can
 * fetch a model list from a self-hosted runtime that has no auth.
 */
function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('0.0.0.0') ||
    lower.includes('::1')
  );
}

/**
 * LM Studio exposes its own richer model list at `GET /api/v1/models` on the
 * host root. Unlike the OpenAI-compatible `/v1/models`, each entry carries
 * `key`, `loaded_instances[].config.context_length` (the real *active* context
 * for loaded models) and `max_context_length`. We prefer it for local
 * endpoints so the renderer can seed a correct per-model context window
 * instead of assuming 200K/1M. Returns `null` when the host isn't LM Studio
 * (endpoint 404s) so the caller falls back to the standard candidates.
 */
async function fetchLocalRichModels(
  baseUrl: string,
  controllerTimeoutMs: number,
): Promise<FetchedModel[] | null> {
  const root = (baseUrl.trim().replace(/\/+$/, '') || '').replace(
    /\/(v1|v1beta|v1alpha)$/i,
    '',
  );
  if (!root || !root.includes('://')) return null;

  const hosts = new Set<string>();
  hosts.add(root);
  hosts.add(root.replace(/(:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1'));

  for (const host of hosts) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), controllerTimeoutMs);
    try {
      const response = await fetch(`${host}/api/v1/models`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) continue;
      const json = (await response.json().catch(() => null)) as unknown;
      const models = extractModels(json);
      if (models && models.length > 0) return models;
    } catch {
      clearTimeout(timeoutId);
      // Not reachable / not LM Studio → try the next host variant.
    }
  }
  return null;
}

function isOllama(protocol: string | undefined, baseUrl: string | undefined): boolean {
  if (protocol === 'ollama') return true;
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return OLLAMA_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * A local / loopback endpoint (LM Studio at `http://localhost:1234/v1`,
 * Ollama, a LAN-hosted OpenAI-compatible server, etc.) does not require
 * an API key. Used to relax the credential guard below so users can
 * fetch a model list from a self-hosted runtime that has no auth.
 */
function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('0.0.0.0') ||
    lower.includes('::1')
  );
}

/**
 * Known Anthropic-compat trailing path segments. When the
 * baseUrl ends with one of these, the user is hitting an
 * Anthropic-shaped sub-endpoint (DeepSeek, GLM, Bailian,
 * StepFun, etc.) but the OpenAI-style `GET /v1/models` (or
 * bare `GET /models`) lives on the *host root*, not the
 * sub-path. We try the original first, then a stripped host
 * version.
 *
 * Order matters: longest prefix first, so `/api/anthropic`
 * wins over `/anthropic`. Mirrors `cc-switch/src-tauri/src/
 * services/model_fetch.rs::KNOWN_COMPAT_SUFFIXES`.
 */
const KNOWN_COMPAT_SUFFIXES: readonly string[] = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
];

/**
 * Strip a known Anthropic-compat suffix from a baseUrl.
 * Returns the remaining prefix, or `null` if no suffix
 * matches. Longest-prefix-first so `/api/anthropic` wins
 * over `/anthropic`.
 */
function stripCompatSuffix(baseUrl: string): string | null {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) {
      return baseUrl.slice(0, baseUrl.length - suffix.length);
    }
  }
  return null;
}

/**
 * Build the candidate URL list to probe. We try the most likely
 * paths first, then fall back to less common ones. The first one
 * that returns a successful JSON `{ data: [...] }` or `{ models:
 * [...] }` wins.
 *
 * Why multiple candidates:
 *   - OpenAI:  `GET {base}/v1/models` → `{ data: [{id,...}] }`
 *   - Anthropic: `GET {base}/v1/models` → `{ data: [{id,...}] }`
 *   - DeepSeek: `GET {base}/models` → `{ data: [...] }`
 *   - OpenRouter: `GET {base}/api/v1/models` → `{ data: [...] }`
 *   - z.ai / GLM: `GET {base}/api/models` → `{ data: [...] }`
 *
 * Two-stage strategy (matches cc-switch):
 *   1. Build the primary candidate from the original baseUrl
 *      (`${trimmed}/v1/models`, or `${trimmed}/models` if the
 *      user already includes `/v1`).
 *   2. If the baseUrl ends with a known compat suffix (e.g.
 *      `https://api.deepseek.com/anthropic`), strip it and
 *      retry against the host root. This catches vendors
 *      (DeepSeek, GLM, Bailian, StepFun, etc.) that expose
 *      OpenAI-style `/v1/models` or `/models` on the host
 *      root, not on the anthropic sub-path.
 *
 * Deduplicates while preserving insertion order — linear scan
 * is fine because we cap at ~3-4 candidates.
 */
export function buildCandidateUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return [];

  // Local-server alias: `localhost` can resolve to `::1` (IPv6) first, which
  // LM Studio / Ollama do not listen on → ECONNREFUSED in Electron's bundled
  // Node (which, unlike a modern standalone Node, does not fall back to IPv4).
  // Always also produce a `127.0.0.1` variant so local runtimes stay reachable.
  const variants = new Set<string>();
  variants.add(trimmed);
  variants.add(trimmed.replace(/(:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1'));

  // Stage 1: primary candidates on each host variant. If the user already
  // supplied a `/v1` tail, don't double it.
  const primary: string[] = [];
  for (const base of variants) {
    if (/\/(v1|v1beta|v1alpha)$/i.test(base)) {
      primary.push(`${base}/models`);
    } else {
      primary.push(`${base}/v1/models`);
    }
  }

  // Stage 2: strip known compat suffixes and try the host root.
  // Only relevant for remote anthropic-compat vendors (DeepSeek, GLM, etc.).
  const candidates: string[] = [];
  const stripped = stripCompatSuffix(trimmed);
  if (stripped) {
    const root = stripped.replace(/\/+$/, '');
    if (root && root.includes('://')) {
      candidates.push(`${root}/v1/models`);
      candidates.push(`${root}/models`);
    }
  }

  // Dedup, preserve first occurrence (original host first).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...primary, ...candidates]) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

interface RawModelEntry {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  type?: unknown;
  owned_by?: unknown;
  ownedBy?: unknown;
  max_context_length?: unknown;
  maxContextLength?: unknown;
  context_length?: unknown;
  contextLength?: unknown;
  loaded_instances?: unknown;
  format?: unknown;
  capabilities?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  created?: unknown;
}

function asInt(value: unknown): number | undefined {
  // Accept floats (LM Studio sometimes reports e.g. 32768.0) and
  // round them. Context-length is the only caller; decimals are
  // spurious.
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Normalize LM Studio's `capabilities.reasoning.allowed_options` array
 * into the canonical `reasoningEffortOptions` we store on the
 * capability record.
 *
 * Rules:
 *   - Keep only string values that look like effort levels
 *     (lowercase / trimmed / non-empty)
 *   - Exclude binary toggles (`'off'`, `'on'`) — those are not effort
 *     levels, they're presence flags
 *   - Dedupe (case-insensitive: `'Low'` and `'low'` collapse)
 *   - Preserve insertion order so the chat dropdown renders in the
 *     order the model author specified
 *
 * Returns `undefined` when the source is empty / absent so callers
 * can distinguish "no per-model options" from "explicitly empty".
 */
function normalizeReasoningOptions(raw: unknown): string[] | undefined {
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
 * Extract the rich capabilities payload exposed by LM Studio's
 * `/api/v1/models`. Returns `undefined` for every field the source API
 * doesn't report, so callers downstream can distinguish "known false"
 * (e.g. `vision: false` for a text-only LM Studio model) from "unknown".
 *
 * LM Studio shape (relevant subset):
 *   capabilities.vision                     -> supportsVision
 *   capabilities.trained_for_tool_use        -> supportsToolUse
 *   capabilities.reasoning.allowed_options (any non-`off` entry)
 *                                            -> supportsReasoning=true
 *                                            + reasoningEffortOptions
 *   capabilities.reasoning.default          -> supportsReasoning=true when
 *     the default is non-`off` AND no `allowed_options` were listed
 *
 * Anything that doesn't match the LM Studio shape (plain OpenAI
 * `/v1/models`, Anthropic `/v1/models`) returns `undefined` for all
 * fields — the renderer treats `undefined` as "not reported by source"
 * and falls back to the preset's defaults where available.
 */
function extractCapabilities(raw: unknown): {
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  supportsReasoning?: boolean;
  reasoningEffortOptions?: string[];
} {
  if (!raw || typeof raw !== 'object') return {};
  const caps = raw as Record<string, unknown>;
  const out: {
    supportsVision?: boolean;
    supportsToolUse?: boolean;
    supportsReasoning?: boolean;
    reasoningEffortOptions?: string[];
  } = {};
  const vision = asBoolean(caps.vision);
  if (vision !== undefined) out.supportsVision = vision;
  const toolUse = asBoolean(caps.trained_for_tool_use);
  if (toolUse !== undefined) out.supportsToolUse = toolUse;
  const reasoning = caps.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const allowed = (reasoning as Record<string, unknown>).allowed_options;
    const defaultV = (reasoning as Record<string, unknown>).default;
    const normalized = normalizeReasoningOptions(allowed);
    if (normalized && normalized.length > 0) {
      // The model advertises at least one real effort level — it can
      // reason, and the chat dropdown should expose exactly that set.
      out.supportsReasoning = true;
      out.reasoningEffortOptions = normalized;
    } else if (typeof defaultV === 'string') {
      // No allow-list but a non-`off` default — reasoning is possible
      // but the user can't pick an intensity. Surface only the boolean.
      out.supportsReasoning = defaultV.trim().toLowerCase() !== 'off';
    } else if (Array.isArray(allowed) && allowed.length > 0) {
      // Allow-list contained only `'off'` / `'on'` toggles. Reasoning
      // is reported as a binary on/off, not a graded effort.
      out.supportsReasoning = false;
    }
  }
  return out;
}

function extractModels(json: unknown): FetchedModel[] | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(obj.data)) candidates.push(obj.data);
  if (Array.isArray(obj.models)) candidates.push(obj.models);
  if (Array.isArray(obj)) candidates.push(obj);

  for (const list of candidates) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const out: FetchedModel[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as RawModelEntry;
      const idRaw = entry.id ?? entry.key ?? entry.name;
      if (typeof idRaw !== 'string' || idRaw.length === 0) continue;
      // Filter out embedding models — they share `/v1/models` with
      // chat models on LM Studio but are not valid chat endpoints.
      // Accept `type === 'llm'` or missing/empty `type` (legacy
      // OpenAI vendors don't set the field, and a malformed payload
      // shouldn't drop every entry). Anything else (e.g. `'embedding'`)
      // is skipped.
      const typeRaw = entry.type;
      if (
        typeof typeRaw === 'string' &&
        typeRaw.length > 0 &&
        typeRaw !== 'llm'
      ) continue;
      const ownedRaw = entry.owned_by ?? entry.ownedBy ?? null;
      // LM Studio `/api/v1/models`: the *loaded* runtime context lives at
      // loaded_instances[0].config.context_length (smaller than the
      // model's max). Prefer it so duya seeds the real active context.
      const loadedCtx = (() => {
        if (!Array.isArray(entry.loaded_instances) || entry.loaded_instances.length === 0) {
          return undefined;
        }
        const inst = entry.loaded_instances[0] as {
          config?: { context_length?: unknown };
        };
        return asInt(inst?.config?.context_length);
      })();
      // The absolute model cap, kept distinct from `contextLength` so
      // the renderer can show both ("32K loaded, 256K max").
      const maxCtx = asInt(
        entry.max_context_length ??
          entry.maxContextLength ??
          entry.context_length ??
          entry.contextLength,
      );
      const ctxRaw = loadedCtx ?? maxCtx;
      const capabilities = extractCapabilities(entry.capabilities);
      const formatRaw = entry.format;
      const format =
        typeof formatRaw === 'string' && formatRaw.length > 0 ? formatRaw : null;
      // `isLoaded` is true when LM Studio / Ollama has at least one
      // loaded instance with a parseable context_length (the same
      // validity check used for `contextLength` so malformed entries
      // like `[null, {}]` don't produce a false "loaded" tag).
      const isLoaded = loadedCtx !== undefined;
      out.push({
        id: idRaw,
        ownedBy: typeof ownedRaw === 'string' && ownedRaw.length > 0
          ? ownedRaw
          : null,
        ...(ctxRaw !== undefined ? { contextLength: ctxRaw } : {}),
        // Surface the model-cap separately from the loaded value, so the
        // renderer can render "32K / 256K" and the user can re-load
        // with a larger context. Falls back to `contextLength` so old
        // callers that only read one field keep working.
        ...(maxCtx !== undefined
          ? { contextWindowMax: maxCtx }
          : ctxRaw !== undefined
            ? { contextWindowMax: ctxRaw }
            : {}),
        ...(capabilities.supportsVision !== undefined
          ? { supportsVision: capabilities.supportsVision }
          : {}),
        ...(capabilities.supportsToolUse !== undefined
          ? { supportsToolUse: capabilities.supportsToolUse }
          : {}),
        ...(capabilities.supportsReasoning !== undefined
          ? { supportsReasoning: capabilities.supportsReasoning }
          : {}),
        ...(capabilities.reasoningEffortOptions !== undefined
          ? { reasoningEffortOptions: capabilities.reasoningEffortOptions }
          : {}),
        // `format: null` is the LM Studio convention for "unknown / not
        // applicable" (e.g. embedding models). We forward null so the
        // renderer can distinguish "not reported" from "reported gguf".
        ...(format !== null ? { format } : {}),
        isLoaded,
      });
    }
    if (out.length > 0) return out;
  }
  return null;
}

function classifyError(
  message: string,
  baseUrl?: string,
): FetchProviderModelsResult['error'] {
  const m = message;
  if (m.includes('ECONNREFUSED') || m.includes('ENOTFOUND') || m.includes('fetch failed')) {
    return {
      code: 'CONNECTION_FAILED',
      message: '无法连接到服务器',
      suggestion: '请检查 Base URL 是否正确，以及网络连接是否正常',
    };
  }
  if (m.includes('401') || m.includes('Unauthorized')) {
    return {
      code: 'AUTH_FAILED',
      message: '认证失败',
      suggestion: '请检查 API Key 是否正确',
    };
  }
  if (m.includes('403') || m.includes('Forbidden')) {
    return {
      code: 'ACCESS_DENIED',
      message: '访问被拒绝',
      suggestion: '您的 API Key 可能没有权限访问此资源',
    };
  }
  if (m.includes('429') || m.includes('Rate limit')) {
    return {
      code: 'RATE_LIMITED',
      message: '请求过于频繁',
      suggestion: '请稍后再试',
    };
  }
  if (m.includes('404') || m.includes('Not Found')) {
    return {
      code: 'ENDPOINT_NOT_FOUND',
      message: 'API 端点未找到 (404)',
      suggestion: `供应商未在已知路径暴露模型列表。请检查 Base URL 是否正确。当前 URL: ${baseUrl || '未设置'}`,
    };
  }
  if (m.includes('timeout') || m.includes('aborted') || m.includes('AbortError')) {
    return {
      code: 'TIMEOUT',
      message: '连接超时',
      suggestion: '服务器响应时间过长，请检查网络或稍后重试',
    };
  }
  return {
    code: 'UNKNOWN_ERROR',
    message: m.slice(0, 200),
    suggestion: `请检查配置是否正确。当前 URL: ${baseUrl || '未设置'}`,
  };
}

/**
 * LM Studio exposes its own richer model list at `GET /api/v1/models` on the
 * host root. Unlike the OpenAI-compatible `/v1/models`, each entry carries
 * `key`, `loaded_instances[].config.context_length` (the real *active* context
 * for loaded models) and `max_context_length`. We prefer it for local
 * endpoints so the renderer can seed a correct per-model context window
 * instead of assuming 200K/1M. Returns `null` when the host isn't LM Studio
 * (endpoint 404s) so the caller falls back to the standard candidates.
 */
async function fetchLocalRichModels(
  baseUrl: string,
  controllerTimeoutMs: number,
): Promise<FetchedModel[] | null> {
  const root = (baseUrl.trim().replace(/\/+$/, '') || '').replace(
    /\/(v1|v1beta|v1alpha)$/i,
    '',
  );
  if (!root || !root.includes('://')) return null;

  const hosts = new Set<string>();
  hosts.add(root);
  hosts.add(root.replace(/(:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1'));

  for (const host of hosts) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), controllerTimeoutMs);
    try {
      const response = await fetch(`${host}/api/v1/models`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) continue;
      const json = (await response.json().catch(() => null)) as unknown;
      const models = extractModels(json);
      if (models && models.length > 0) return models;
    } catch {
      clearTimeout(timeoutId);
      // Not reachable / not LM Studio → try the next host variant.
    }
  }
  return null;
}

export async function fetchProviderModels(
  body: FetchProviderModelsBody,
): Promise<FetchProviderModelsResult> {
  const { protocol, base_url, api_key, auth_style } = body;

  if (isOllama(protocol, base_url)) {
    const { fetchOllamaModels } = await import('./model-detector');
    const ollama = await fetchOllamaModels(base_url || 'http://localhost:11434');
    if (ollama.success && ollama.models) {
      return {
        success: true,
        models: ollama.models.map((m) => ({ id: m.id, ownedBy: 'ollama' })),
      };
    }
    return {
      success: false,
      error: classifyError(ollama.error || 'failed to fetch', base_url),
    };
  }

  if (!base_url) {
    return {
      success: false,
      error: {
        code: 'NO_CREDENTIALS',
        message: 'Base URL is required',
        suggestion: '请先填写 Base URL',
      },
    };
  }
  // Local OpenAI-compatible runtimes (Ollama at :11434, LM Studio
  // at :1234) don't require auth, so an empty API key is fine for
  // them. Mirrors the same exemption applied later when building
  // the auth headers — without it the user would see "API Key is
  // required" before the local rich probe even has a chance to
  // run. `env_only` covers AWS Bedrock / Vertex, which are also
  // exempt.
  if (!api_key && auth_style !== 'env_only' && !isLocalEndpoint(base_url)) {
    return {
      success: false,
      error: {
        code: 'NO_CREDENTIALS',
        message: 'API Key is required',
        suggestion: '请先填写 API Key',
      },
    };
  }

  // Prefer LM Studio's rich `/api/v1/models` (per-model
  // `capabilities.{vision,trained_for_tool_use,reasoning}` +
  // `loaded_instances[].config.context_length` + `max_context_length` +
  // `format`) for local endpoints. Ignore failures silently — LM
  // Studio may not be the target (the user might be configuring a
  // local OpenAI-compatible proxy), and the standard OpenAI-compatible
  // candidates below still apply.
  if (isLocalEndpoint(base_url)) {
    const rich = await fetchLocalRichModels(base_url, 5_000);
    if (rich && rich.length > 0) {
      return { success: true, models: rich };
    }
  }

  // Build the auth headers based on protocol + baseUrl, mirroring
  // `provider-tester.ts#testProviderConnection` (line 162-171).
  // The key insight: minimax / anthropic-family vendors use
  // `x-api-key` + `anthropic-version`, NOT `Authorization: Bearer`.
  // Sending Bearer to them returns 401 even with a valid key.
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const lowerBase = (base_url || '').toLowerCase();
  const isOpenAICompatible =
    protocol === 'openai' ||
    protocol === 'openai-compatible' ||
    lowerBase.includes('openrouter') ||
    lowerBase.includes('api.openai') ||
    lowerBase.includes('api.deepseek') ||
    lowerBase.includes('api.moonshot') ||
    lowerBase.includes('api.groq') ||
    lowerBase.includes('api.together') ||
    lowerBase.includes('api.perplexity');

  if (isOpenAICompatible) {
    if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
  } else {
    // Anthropic-compatible (minimax / anthropic / 3rd-party
    // anthropic-style). Both the canonical Anthropic API and
    // minimax.cn's anthropic-compatible endpoint expect:
    //   x-api-key: <key>
    //   anthropic-version: 2023-06-01
    headers['anthropic-version'] = '2023-06-01';
    if (auth_style === 'auth_token') {
      if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
    } else {
      // Default: x-api-key (Anthropic's convention).
      if (api_key) headers['x-api-key'] = api_key;
    }
  }

  let lastError: string = 'Unknown error';
  const candidates = buildCandidateUrls(base_url);
  for (const url of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.status === 404 || response.status === 405) {
        // Try the next candidate.
        lastError = `HTTP ${response.status}`;
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          success: false,
          error: classifyError(`HTTP ${response.status}: ${text.slice(0, 200)}`, base_url),
        };
      }
      const json = (await response.json().catch(() => null)) as unknown;
      const models = extractModels(json);
      if (models) {
        return { success: true, models };
      }
      // 200 OK but no recognized list shape.
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message: '无法解析模型列表',
          suggestion: '供应商的 API 响应格式与预期不符',
        },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err.message : String(err);
      // Continue to the next candidate (timeout, ECONNREFUSED, etc.)
    }
  }

  return {
    success: false,
    error: classifyError(
      `All candidates failed: ${lastError}`,
      base_url,
    ),
  };
}
