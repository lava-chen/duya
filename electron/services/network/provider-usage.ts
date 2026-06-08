/**
 * Provider Usage / Quota Fetcher
 *
 * Fetches token/quota usage from provider APIs.
 * Inspired by 9router's open-sse/services/usage.js
 */

import { initLogger, LogComponent } from '../../logging/logger';

// INFO level so the quota path actually logs something. The default
// `level: 'WARN'` swallowed all debug traces from this module, which made
// "quota fetcher returns nothing" impossible to diagnose.
const logger = initLogger({ level: 'INFO' });

// `console.log` mirror: the file logger is async/buffered and only visible
// after a restart, but the user is staring at "No quota data returned" right
// now. Always-on console traces make the request/response visible in the
// DevTools console (main process prints land there via electron's stdio).
const trace = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.log('[provider-usage]', ...args);
};

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

/**
 * Resolve a canonical provider id from caller-supplied provider type and baseUrl.
 *
 * Preference order:
 *   1. provider_type (caller already knows the family — minimax / glm / etc.)
 *   2. baseUrl (fallback when caller only has the URL)
 *
 * Returns one of: 'minimax' | 'minimax-cn' | 'glm' | 'glm-cn' | null.
 */
function detectProvider(providerType: string, baseUrl: string): string | null {
  const t = (providerType || '').toLowerCase().trim();
  if (t === 'minimax' || t === 'minimax-cn') return t;
  if (t === 'glm-cn' || t === 'glm_cn') return 'glm-cn';
  if (t === 'glm') {
    return baseUrl.toLowerCase().includes('bigmodel.cn') ? 'glm-cn' : 'glm';
  }

  const u = (baseUrl || '').toLowerCase();
  if (u.includes('minimax.io')) return 'minimax';
  if (u.includes('minimaxi.com')) return 'minimax-cn';
  if (u.includes('bigmodel.cn')) return 'glm-cn';
  if (u.includes('z.ai')) return 'glm';
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

// ── Reset-time parsing ───────────────────────────────────────────────────

/**
 * Normalize provider-supplied reset values to an ISO string.
 *
 * Accepts:
 *   - Date instance
 *   - finite number — seconds (< 1e12) or milliseconds
 *   - numeric string — same second/ms heuristic
 *   - ISO / RFC 2822 string
 *
 * Returns null when the value cannot be parsed.
 */
function parseResetTime(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const ts = Number(trimmed);
      return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// ── MiniMax helpers ───────────────────────────────────────────────────────

/**
 * MiniMax has two distinct quota endpoints and they live on different
 * (sometimes overlapping) hosts:
 *
 *   - `token_plan/remains`     — older plan, returns *used* counts.
 *   - `coding_plan/remains`    — newer plan, returns *remaining* counts.
 *
 * The international host `minimax.io` historically only served
 * `token_plan/remains`; the China host `minimaxi.com` only serves
 * `coding_plan/remains`. Recent rollouts put both paths on both hosts.
 *
 * Order: try the more permissive endpoint first, then fall back. We dedupe
 * so duplicate URLs (minimax-cn fallback) don't waste a request.
 */
const MINIMAX_USAGE_URLS: Record<string, string[]> = {
  minimax: [
    'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
    'https://www.minimax.io/v1/token_plan/remains',
  ],
  'minimax-cn': [
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

/**
 * MiniMax /api/openplatform/coding_plan/remains does NOT return a `*_total_count`
 * for accounts on the rolling-coding-plan product — only `*_remaining_percent`
 * and `current_*_status` are populated. The earlier code gated on
 * `total > 0` and silently dropped every row, which is why quota fetches
 * appeared "empty" even when the user had an active plan.
 *
 * A row is "usable" when at least one of the *_remaining_percent fields is
 * present AND the corresponding *_status is active (status === 1). Status
 * values observed in the wild: 1 = active, 3 = inactive / not on plan.
 */
function getMiniMaxSessionPercent(model: Record<string, unknown>): number | null {
  const raw = getMiniMaxField(model, 'current_interval_remaining_percent', 'currentIntervalRemainingPercent');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getMiniMaxWeeklyPercent(model: Record<string, unknown>): number | null {
  const raw = getMiniMaxField(model, 'current_weekly_remaining_percent', 'currentWeeklyRemainingPercent');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getMiniMaxSessionStatus(model: Record<string, unknown>): number {
  return Number(getMiniMaxField(model, 'current_interval_status', 'currentIntervalStatus')) || 0;
}

function getMiniMaxWeeklyStatus(model: Record<string, unknown>): number {
  return Number(getMiniMaxField(model, 'current_weekly_status', 'currentWeeklyStatus')) || 0;
}

function hasMiniMaxQuota(model: Record<string, unknown>): boolean {
  // Active session or weekly window: status === 1 with a percent value.
  const sessionActive = getMiniMaxSessionStatus(model) === 1 && getMiniMaxSessionPercent(model) != null;
  const weeklyActive = getMiniMaxWeeklyStatus(model) === 1 && getMiniMaxWeeklyPercent(model) != null;
  return sessionActive || weeklyActive;
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
  return parseResetTime(getMiniMaxField(model, endSnake, endCamel));
}

/**
 * Build a QuotaItem from MiniMax's `*_remaining_percent` field.
 *
 * The MiniMax quota API returns remaining quota as a percentage in [0, 100].
 * We map it to the canonical QuotaItem shape (used/total/remaining/%) using
 * a fixed 100-unit denominator since the upstream only exposes the percent.
 */
function buildMiniMaxPercentQuota(remainingPercent: number, resetAt: string | null): QuotaItem {
  const remaining = Math.max(0, Math.min(100, remainingPercent));
  const used = Math.max(0, 100 - remaining);
  return {
    used,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt,
    unlimited: false,
  };
}

function addMiniMaxPercentQuota(
  quotas: Record<string, QuotaItem>,
  key: string,
  model: Record<string, unknown>,
  getPercent: (m: Record<string, unknown>) => number | null,
  getStatus: (m: Record<string, unknown>) => number,
  resetArgs: [number, string, string, string, string]
): void {
  if (getStatus(model) !== 1) return;
  const percent = getPercent(model);
  if (percent == null) return;
  quotas[key] = buildMiniMaxPercentQuota(percent, getMiniMaxResetAt(model, ...resetArgs));
}

async function getMiniMaxUsage(apiKey: string, provider: string): Promise<ProviderUsageResult> {
  if (!apiKey) {
    return { success: false, message: 'MiniMax API key not available.' };
  }

  const usageUrls = MINIMAX_USAGE_URLS[provider] || [];
  trace('getMiniMaxUsage start', { provider, urlCount: usageUrls.length, urls: usageUrls, keyLen: apiKey.length });
  if (usageUrls.length === 0) {
    return { success: false, message: `No MiniMax endpoint configured for ${provider}.` };
  }

  let lastErrorMessage = '';

  for (let index = 0; index < usageUrls.length; index += 1) {
    const usageUrl = usageUrls[index];
    const canFallback = index < usageUrls.length - 1;

    try {
      trace('fetching', { url: usageUrl, provider });
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

      logger.info('MiniMax quota response', {
        url: usageUrl,
        status: response.status,
        apiStatusCode,
        apiStatusMessage,
        rawLength: rawText.length,
      }, LogComponent.NetHandlers);
      trace('response', { url: usageUrl, status: response.status, apiStatusCode, apiStatusMessage, rawLength: rawText.length });
      if (rawText.length < 2000) {
        // Dump the full payload for small responses so we can see the actual
        // field names; large responses get a shape-only summary.
        trace('payload', payload);
      } else {
        trace('payload.keys', Object.keys(payload), 'model_remains.type', typeof payload?.model_remains);
      }

      // Auth failures usually mean key/cluster mismatch (international key vs
      // China host, or vice versa). Try the next URL in the chain when there
      // is one — the second URL is on the *other* host family and may work.
      if (response.status === 401 || response.status === 403 || apiStatusCode === 1004 || authLike.test(combined)) {
        lastErrorMessage = `MiniMax rejected this key on ${new URL(usageUrl).host} (${response.status}${apiStatusCode ? `/${apiStatusCode}` : ''})`;
        logger.warn(lastErrorMessage, undefined, LogComponent.NetHandlers);
        if (canFallback) continue;
        return {
          success: false,
          error: { code: 'AUTH_FAILED', message: 'MiniMax API key invalid or inactive. Use an active Token/Coding Plan key matching the configured region.' },
        };
      }

      if (!response.ok) {
        lastErrorMessage = `MiniMax usage endpoint error (${response.status})`;
        if ((response.status === 404 || response.status === 405 || response.status >= 500) && canFallback) {
          logger.warn(`${lastErrorMessage} — trying fallback`, undefined, LogComponent.NetHandlers);
          continue;
        }
        return { success: false, message: `MiniMax connected. ${lastErrorMessage}` };
      }

      if (apiStatusCode !== 0) {
        return { success: false, message: `MiniMax connected. ${apiStatusMessage || 'Upstream quota API error'}` };
      }

      const modelRemains = payload?.model_remains ?? payload?.modelRemains;
      const allModels = Array.isArray(modelRemains) ? modelRemains : [];
      const quotaModels = allModels.filter(hasMiniMaxQuota);

      logger.info('MiniMax quota models', {
        totalModels: allModels.length,
        quotaModels: quotaModels.length,
        modelNames: quotaModels.map((m) => getMiniMaxModelName(m as Record<string, unknown>)),
      }, LogComponent.NetHandlers);
      trace('models', {
        totalModels: allModels.length,
        quotaModels: quotaModels.length,
        allNames: allModels.map((m) => getMiniMaxModelName(m as Record<string, unknown>)),
        quotaNames: quotaModels.map((m) => getMiniMaxModelName(m as Record<string, unknown>)),
      });
      if (allModels.length > 0) {
        // Dump the first model verbatim so we can confirm the field names
        // (current_interval_total_count vs currentIntervalTotalCount, etc.).
        trace('firstModel', allModels[0]);
      }

      if (quotaModels.length === 0) {
        // API responded successfully but no models with quota were found.
        // This is normal for accounts without an active plan; surface a
        // message so the UI doesn't render an empty success state.
        return {
          success: true,
          quotas: {},
          message: 'MiniMax connected. No active Token/Coding Plan quota was returned.',
        };
      }

      const capturedAtMs = Date.now();
      const quotas: Record<string, QuotaItem> = {};

      for (const model of quotaModels) {
        const displayName = formatMiniMaxQuotaName(model as Record<string, unknown>);
        addMiniMaxPercentQuota(
          quotas,
          `${displayName} (5h)`,
          model as Record<string, unknown>,
          getMiniMaxSessionPercent,
          getMiniMaxSessionStatus,
          [capturedAtMs, 'remains_time', 'remainsTime', 'end_time', 'endTime']
        );
        addMiniMaxPercentQuota(
          quotas,
          `${displayName} (7d)`,
          model as Record<string, unknown>,
          getMiniMaxWeeklyPercent,
          getMiniMaxWeeklyStatus,
          [capturedAtMs, 'weekly_remains_time', 'weeklyRemainsTime', 'weekly_end_time', 'weeklyEndTime']
        );
      }

      if (Object.keys(quotas).length === 0) {
        return { success: false, message: 'MiniMax connected. Unable to extract quota usage.' };
      }

      return { success: true, quotas };
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      trace('fetch threw', { url: usageUrl, error: lastErrorMessage });
      logger.warn(`MiniMax quota fetch error on ${usageUrl}: ${lastErrorMessage}`, undefined, LogComponent.NetHandlers);
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

    if (Object.keys(quotas).length === 0) {
      return {
        success: true,
        plan,
        quotas: {},
        message: 'GLM connected. No TOKENS_LIMIT quota was returned.',
      };
    }

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

  const detected = detectProvider(provider_type || '', base_url || '');

  logger.info('Provider usage request', { provider_type, detected }, LogComponent.NetHandlers);

  if (!detected) {
    return {
      success: false,
      error: {
        code: 'UNSUPPORTED_PROVIDER',
        message: `Usage API not implemented for provider "${provider_type || ''}" at base URL "${base_url || ''}".`,
      },
    };
  }

  switch (detected) {
    case 'minimax':
    case 'minimax-cn':
      return getMiniMaxUsage(api_key, detected);
    case 'glm':
    case 'glm-cn':
      return getGlmUsage(api_key, base_url || '');
    default:
      return {
        success: false,
        error: { code: 'UNSUPPORTED_PROVIDER', message: `Usage API not implemented for ${detected}.` },
      };
  }
}

// ── Internals exported for unit tests ────────────────────────────────────

export const __testing = {
  detectProvider,
  parseResetTime,
  buildMiniMaxPercentQuota,
  hasMiniMaxQuota,
  formatMiniMaxQuotaName,
  getMiniMaxField,
  getMiniMaxSessionPercent,
  getMiniMaxWeeklyPercent,
  getMiniMaxSessionStatus,
  getMiniMaxWeeklyStatus,
  getMiniMaxResetAt,
  MINIMAX_USAGE_URLS,
  GLM_QUOTA_URLS,
};
