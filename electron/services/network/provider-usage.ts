/**
 * Provider Usage / Quota Fetcher
 *
 * Fetches token/quota usage from provider APIs.
 * Inspired by 9router's open-sse/services/usage.js
 */

export interface QuotaItem {
  used: number;
  total: number;
  remaining: number;
  remainingPercentage: number;
  resetAt: string | null;
  unlimited: boolean;
}

export interface ProviderUsageResult {
  success: boolean;
  plan?: string;
  quotas?: Record<string, QuotaItem>;
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

// ── Provider detection helpers ────────────────────────────────────────────

function detectProvider(baseUrl: string): string | null {
  const url = baseUrl.toLowerCase();
  if (url.includes('minimax.io')) return 'minimax';
  if (url.includes('minimaxi.com')) return 'minimax-cn';
  if (url.includes('bigmodel.cn') || url.includes('z.ai')) return 'glm';
  return null;
}

// ── Generic fetch helper ──────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ── MiniMax helpers ───────────────────────────────────────────────────────

const MINIMAX_USAGE_URLS: Record<string, string[]> = {
  minimax: [
    'https://www.minimax.io/v1/token_plan/remains',
    'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  ],
  'minimax-cn': [
    'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  ],
};

function getMiniMaxField(model: Record<string, unknown>, snakeKey: string, camelKey: string): unknown {
  if (!model || typeof model !== 'object') return null;
  return model[snakeKey] ?? model[camelKey] ?? null;
}

function getMiniMaxModelName(model: Record<string, unknown>): string {
  return String(getMiniMaxField(model, 'model_name', 'modelName') || '').trim();
}

function formatMiniMaxQuotaName(model: Record<string, unknown>): string {
  const rawName = getMiniMaxModelName(model);
  if (!rawName) return 'MiniMax';
  return rawName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\bTo\b/g, 'to')
    .replace(/\bTts\b/g, 'TTS')
    .replace(/\bHd\b/g, 'HD');
}

function getMiniMaxSessionTotal(model: Record<string, unknown>): number {
  return Math.max(0, Number(getMiniMaxField(model, 'current_interval_total_count', 'currentIntervalTotalCount')) || 0);
}

function getMiniMaxWeeklyTotal(model: Record<string, unknown>): number {
  return Math.max(0, Number(getMiniMaxField(model, 'current_weekly_total_count', 'currentWeeklyTotalCount')) || 0);
}

function hasMiniMaxQuota(model: Record<string, unknown>): boolean {
  return getMiniMaxSessionTotal(model) > 0 || getMiniMaxWeeklyTotal(model) > 0;
}

function getMiniMaxResetAt(
  model: Record<string, unknown>,
  capturedAtMs: number,
  remainsSnake: string,
  remainsCamel: string,
  endSnake: string,
  endCamel: string
): string | null {
  const remainsMs = Number(getMiniMaxField(model, remainsSnake, remainsCamel)) || 0;
  if (remainsMs > 0) return new Date(capturedAtMs + remainsMs).toISOString();
  const endTime = getMiniMaxField(model, endSnake, endCamel);
  if (endTime) {
    try {
      return new Date(String(endTime)).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function buildMiniMaxQuota(total: number, count: number, resetAt: string | null, countMeansRemaining: boolean): QuotaItem {
  const safeTotal = Math.max(0, total);
  const used = countMeansRemaining ? Math.max(safeTotal - count, 0) : Math.min(Math.max(0, count), safeTotal);
  const remaining = Math.max(safeTotal - used, 0);
  return {
    used,
    total: safeTotal,
    remaining,
    remainingPercentage: safeTotal > 0 ? Math.max(0, Math.min(100, (remaining / safeTotal) * 100)) : 0,
    resetAt,
    unlimited: false,
  };
}

function addMiniMaxQuota(
  quotas: Record<string, QuotaItem>,
  key: string,
  model: Record<string, unknown>,
  getTotal: (m: Record<string, unknown>) => number,
  countSnake: string,
  countCamel: string,
  resetArgs: [number, string, string, string, string],
  countMeansRemaining: boolean
): void {
  const total = getTotal(model);
  if (total <= 0) return;
  const count = Math.max(0, Number(getMiniMaxField(model, countSnake, countCamel)) || 0);
  quotas[key] = buildMiniMaxQuota(total, count, getMiniMaxResetAt(model, ...resetArgs), countMeansRemaining);
}

async function getMiniMaxUsage(apiKey: string, provider: string): Promise<ProviderUsageResult> {
  if (!apiKey) {
    return { success: false, message: 'MiniMax API key not available.' };
  }

  const usageUrls = MINIMAX_USAGE_URLS[provider] || [];
  let lastErrorMessage = '';

  for (let index = 0; index < usageUrls.length; index += 1) {
    const usageUrl = usageUrls[index];
    const canFallback = index < usageUrls.length - 1;

    try {
      const response = await fetchWithTimeout(usageUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });

      const rawText = await response.text();
      let payload: Record<string, unknown> = {};
      if (rawText) {
        try {
          payload = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          payload = {};
        }
      }

      const baseResp = (payload?.base_resp ?? payload?.baseResp) as Record<string, unknown> | undefined;
      const apiStatusCode = Number(baseResp?.status_code ?? baseResp?.statusCode) || 0;
      const apiStatusMessage = String(baseResp?.status_msg ?? baseResp?.statusMsg ?? '').trim();
      const combined = `${apiStatusMessage} ${rawText}`.trim();
      const authLike = /token plan|coding plan|invalid api key|invalid key|unauthorized|inactive/i;

      if (response.status === 401 || response.status === 403 || apiStatusCode === 1004 || authLike.test(combined)) {
        return {
          success: false,
          error: { code: 'AUTH_FAILED', message: 'MiniMax API key invalid or inactive. Use an active Token/Coding Plan key.' },
        };
      }

      if (!response.ok) {
        lastErrorMessage = `MiniMax usage endpoint error (${response.status})`;
        if ((response.status === 404 || response.status === 405 || response.status >= 500) && canFallback) continue;
        return { success: false, message: `MiniMax connected. ${lastErrorMessage}` };
      }

      if (apiStatusCode !== 0) {
        return { success: false, message: `MiniMax connected. ${apiStatusMessage || 'Upstream quota API error'}` };
      }

      const modelRemains = payload?.model_remains ?? payload?.modelRemains;
      const allModels = Array.isArray(modelRemains) ? modelRemains : [];
      const quotaModels = allModels.filter(hasMiniMaxQuota);

      if (quotaModels.length === 0) {
        return { success: false, message: 'MiniMax connected. No quota data was returned.' };
      }

      const capturedAtMs = Date.now();
      const countMeansRemaining = usageUrl.includes('/coding_plan/remains');
      const quotas: Record<string, QuotaItem> = {};

      for (const model of quotaModels) {
        const displayName = formatMiniMaxQuotaName(model as Record<string, unknown>);
        addMiniMaxQuota(
          quotas,
          `${displayName} (5h)`,
          model as Record<string, unknown>,
          getMiniMaxSessionTotal,
          'current_interval_usage_count',
          'currentIntervalUsageCount',
          [capturedAtMs, 'remains_time', 'remainsTime', 'end_time', 'endTime'],
          countMeansRemaining
        );
        addMiniMaxQuota(
          quotas,
          `${displayName} (7d)`,
          model as Record<string, unknown>,
          getMiniMaxWeeklyTotal,
          'current_weekly_usage_count',
          'currentWeeklyUsageCount',
          [capturedAtMs, 'weekly_remains_time', 'weeklyRemainsTime', 'weekly_end_time', 'weeklyEndTime'],
          countMeansRemaining
        );
      }

      if (Object.keys(quotas).length === 0) {
        return { success: false, message: 'MiniMax connected. Unable to extract quota usage.' };
      }

      return { success: true, quotas };
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      if (!canFallback) break;
    }
  }

  return {
    success: false,
    message: lastErrorMessage ? `MiniMax connected. Unable to fetch usage: ${lastErrorMessage}` : 'MiniMax connected. Unable to fetch usage.',
  };
}

// ── GLM helpers ───────────────────────────────────────────────────────────

const GLM_QUOTA_URLS: Record<string, string> = {
  international: 'https://api.z.ai/api/monitor/usage/quota/limit',
  china: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
};

async function getGlmUsage(apiKey: string, baseUrl: string): Promise<ProviderUsageResult> {
  if (!apiKey) {
    return { success: false, message: 'GLM API key not available.' };
  }

  const region = baseUrl.includes('bigmodel.cn') ? 'china' : 'international';
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await fetchWithTimeout(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'GLM API key invalid or expired.' } };
      }
      return { success: false, message: `GLM quota API error (${response.status}).` };
    }

    const json = (await response.json()) as Record<string, unknown>;
    const data = (json?.data && typeof json.data === 'object') ? json.data as Record<string, unknown> : {};
    const limits = Array.isArray(data.limits) ? data.limits as Record<string, unknown>[] : [];
    const quotas: Record<string, QuotaItem> = {};

    for (const limit of limits) {
      if (!limit || limit.type !== 'TOKENS_LIMIT') continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      quotas['session'] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === 'string' ? data.level : '';
    const plan = levelRaw ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase() : 'Unknown';

    return { success: true, plan, quotas };
  } catch (error) {
    return { success: false, message: `GLM error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface ProviderUsageBody {
  provider_type?: string;
  base_url?: string;
  api_key?: string;
}

export async function getProviderUsage(body: ProviderUsageBody): Promise<ProviderUsageResult> {
  const { provider_type, base_url, api_key } = body;

  if (!api_key) {
    return {
      success: false,
      error: { code: 'NO_CREDENTIALS', message: 'API Key is required to fetch usage.' },
    };
  }

  const detected = detectProvider(base_url || '');

  if (!detected) {
    return {
      success: false,
      error: { code: 'UNSUPPORTED_PROVIDER', message: `Usage API not implemented for provider ${provider_type || base_url}.` },
    };
  }

  switch (detected) {
    case 'minimax':
    case 'minimax-cn':
      return getMiniMaxUsage(api_key, detected);
    case 'glm':
      return getGlmUsage(api_key, base_url || '');
    default:
      return {
        success: false,
        error: { code: 'UNSUPPORTED_PROVIDER', message: `Usage API not implemented for ${detected}.` },
      };
  }
}
