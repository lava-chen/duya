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

function isOllama(protocol: string | undefined, baseUrl: string | undefined): boolean {
  if (protocol === 'ollama') return true;
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return OLLAMA_KEYWORDS.some((k) => lower.includes(k));
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
 * The function strips a trailing `/v1` and `/v1/...` segment from
 * the base URL so we can build the candidates from the bare host.
 */
function buildCandidateUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, '');
  // Strip common path prefixes to derive the host root.
  const hostRoot = trimmed.replace(
    /\/(v1|v1beta|v1alpha)(\/.*)?$/i,
    '',
  );
  return [
    `${trimmed}/models`,         // already-prefixed
    `${hostRoot}/v1/models`,     // OpenAI / Anthropic canonical
    `${hostRoot}/api/v1/models`, // OpenRouter
    `${hostRoot}/api/models`,    // z.ai / GLM
  ];
}

interface RawModelEntry {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  ownedBy?: unknown;
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
      const idRaw = entry.id ?? entry.name;
      if (typeof idRaw !== 'string' || idRaw.length === 0) continue;
      const ownedRaw = entry.owned_by ?? entry.ownedBy ?? null;
      out.push({
        id: idRaw,
        ownedBy: typeof ownedRaw === 'string' && ownedRaw.length > 0
          ? ownedRaw
          : null,
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
  if (!api_key && auth_style !== 'env_only') {
    return {
      success: false,
      error: {
        code: 'NO_CREDENTIALS',
        message: 'API Key is required',
        suggestion: '请先填写 API Key',
      },
    };
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
