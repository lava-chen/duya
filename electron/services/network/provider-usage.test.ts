/**
 * Provider Usage / Quota Fetcher — unit tests
 *
 * Covers parity with 9router's open-sse/services/usage.js:
 *  - detectProvider (provider_type priority, baseUrl fallback, GLM region split)
 *  - parseResetTime (Date, sec, ms, numeric string, ISO string, null/garbage)
 *  - MiniMax field mapping (token_plan "used" vs coding_plan "remaining")
 *  - MiniMax 401 fallback — previously hard-returned, now continues to next URL
 *  - MiniMax empty model_remains surfaces a "connected" message instead of silent success
 *  - GLM region split (z.ai → international, bigmodel.cn → china)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks must be registered before importing the SUT ──────────────────────

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getLogger: vi.fn(),
  LogComponent: {
    NetHandlers: 'NetHandlers',
  },
}));

import {
  getProviderUsage,
  __testing,
} from './provider-usage';

const {
  detectProvider,
  parseResetTime,
  buildMiniMaxPercentQuota,
  hasMiniMaxQuota,
  formatMiniMaxQuotaName,
  MINIMAX_USAGE_URLS,
  GLM_QUOTA_URLS,
} = __testing;

// ── fetch mock helpers ────────────────────────────────────────────────────

const fetchMock = vi.fn();

function mockJsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function mockTextResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── detectProvider ────────────────────────────────────────────────────────

describe('detectProvider', () => {
  it('prefers provider_type over baseUrl', () => {
    expect(detectProvider('minimax', 'https://api.minimaxi.com/v1')).toBe('minimax');
    expect(detectProvider('minimax-cn', 'https://api.minimax.io/v1')).toBe('minimax-cn');
  });

  it('splits GLM into china/international by baseUrl', () => {
    expect(detectProvider('glm', 'https://open.bigmodel.cn/api/paas/v4')).toBe('glm-cn');
    expect(detectProvider('glm', 'https://api.z.ai/api/paas/v4')).toBe('glm');
    expect(detectProvider('glm-cn', 'https://api.z.ai/whatever')).toBe('glm-cn');
  });

  it('falls back to baseUrl when provider_type is missing', () => {
    expect(detectProvider('', 'https://api.minimax.io/v1')).toBe('minimax');
    expect(detectProvider('', 'https://api.minimaxi.com/v1')).toBe('minimax-cn');
    expect(detectProvider('', 'https://open.bigmodel.cn/api/paas/v4')).toBe('glm-cn');
    expect(detectProvider('', 'https://api.z.ai/api/paas/v4')).toBe('glm');
  });

  it('returns null for unknown providers', () => {
    expect(detectProvider('', 'https://api.openai.com/v1')).toBeNull();
    expect(detectProvider('openai', 'https://api.openai.com/v1')).toBeNull();
    expect(detectProvider('', '')).toBeNull();
  });

  it('handles provider_type aliases', () => {
    expect(detectProvider('glm_cn', '')).toBe('glm-cn');
    expect(detectProvider('GLM-CN', 'https://api.z.ai/x')).toBe('glm-cn');
  });
});

// ── parseResetTime ────────────────────────────────────────────────────────

describe('parseResetTime', () => {
  it('returns null for empty input', () => {
    expect(parseResetTime(null)).toBeNull();
    expect(parseResetTime(undefined)).toBeNull();
    expect(parseResetTime('')).toBeNull();
    // parseResetTime(0) is technically 1970-01-01, not null — leave that to
    // the caller, which uses it as "no reset info" via the || 0 short-circuit.
  });

  it('parses Date instances', () => {
    const d = new Date('2026-05-12T10:00:00.000Z');
    expect(parseResetTime(d)).toBe('2026-05-12T10:00:00.000Z');
  });

  it('parses millisecond timestamps', () => {
    // 1747056000000 ms = 2025-05-12T13:20:00.000Z
    expect(parseResetTime(1747056000000)).toBe('2025-05-12T13:20:00.000Z');
  });

  it('parses second timestamps and converts to ms', () => {
    // 1747056000 s = 2025-05-12T13:20:00.000Z
    expect(parseResetTime(1747056000)).toBe('2025-05-12T13:20:00.000Z');
  });

  it('parses numeric strings (sec + ms)', () => {
    expect(parseResetTime('1747056000')).toBe('2025-05-12T13:20:00.000Z');
    expect(parseResetTime('1747056000000')).toBe('2025-05-12T13:20:00.000Z');
  });

  it('parses ISO strings', () => {
    expect(parseResetTime('2026-05-12T10:00:00.000Z')).toBe('2026-05-12T10:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseResetTime('not-a-date')).toBeNull();
    expect(parseResetTime(NaN)).toBeNull();
  });
});

// ── MiniMax pure helpers ──────────────────────────────────────────────────

describe('buildMiniMaxPercentQuota', () => {
  it('maps a 99% remaining into used=1 / remaining=99 / total=100', () => {
    const q = buildMiniMaxPercentQuota(99, null);
    expect(q.used).toBe(1);
    expect(q.total).toBe(100);
    expect(q.remaining).toBe(99);
    expect(q.remainingPercentage).toBe(99);
  });

  it('clamps values into [0, 100]', () => {
    expect(buildMiniMaxPercentQuota(-5, null).remaining).toBe(0);
    expect(buildMiniMaxPercentQuota(150, null).remaining).toBe(100);
  });

  it('preserves resetAt when provided', () => {
    const q = buildMiniMaxPercentQuota(64, '2026-06-10T00:00:00.000Z');
    expect(q.resetAt).toBe('2026-06-10T00:00:00.000Z');
  });
});

describe('hasMiniMaxQuota', () => {
  it('accepts session rows with status=1 and a remaining_percent', () => {
    expect(hasMiniMaxQuota({
      current_interval_status: 1,
      current_interval_remaining_percent: 99,
    })).toBe(true);
  });

  it('accepts weekly rows with status=1 and a remaining_percent', () => {
    expect(hasMiniMaxQuota({
      current_weekly_status: 1,
      current_weekly_remaining_percent: 64,
    })).toBe(true);
  });

  it('rejects rows where status !== 1 (status=3 means inactive)', () => {
    expect(hasMiniMaxQuota({
      current_interval_status: 3,
      current_interval_remaining_percent: 100,
      current_weekly_status: 3,
      current_weekly_remaining_percent: 100,
    })).toBe(false);
  });

  it('accepts mixed: only weekly is active', () => {
    expect(hasMiniMaxQuota({
      current_interval_status: 3,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 50,
    })).toBe(true);
  });

  it('returns false when neither status nor percent is present', () => {
    expect(hasMiniMaxQuota({})).toBe(false);
    expect(hasMiniMaxQuota({ current_interval_total_count: 4000 })).toBe(false);
  });
});

describe('formatMiniMaxQuotaName', () => {
  it('title-cases snake_case and lowercases "to"', () => {
    expect(formatMiniMaxQuotaName({ model_name: 'text_to_speech_hd' })).toBe('Text to Speech HD');
  });
  it('handles TTS / HD acronyms', () => {
    expect(formatMiniMaxQuotaName({ model_name: 'speech-2.8-tts-hd' })).toBe('Speech 2.8 TTS HD');
  });
  it('falls back to "MiniMax" when no model name', () => {
    expect(formatMiniMaxQuotaName({})).toBe('MiniMax');
  });
});

// ── getProviderUsage entrypoint ───────────────────────────────────────────

describe('getProviderUsage', () => {
  it('returns NO_CREDENTIALS when api_key missing', async () => {
    const r = await getProviderUsage({ provider_type: 'minimax', base_url: 'https://api.minimax.io/v1' });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('NO_CREDENTIALS');
  });

  it('returns UNSUPPORTED_PROVIDER for unknown baseUrl + provider_type', async () => {
    const r = await getProviderUsage({
      provider_type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
    });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('UNSUPPORTED_PROVIDER');
  });
});

// ── MiniMax HTTP integration ──────────────────────────────────────────────

describe('getProviderUsage — MiniMax', () => {
  it('parses a coding_plan payload using remaining_percent + status=1', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        base_resp: { status_code: 0, status_msg: 'success' },
        model_remains: [
          {
            model_name: 'general',
            current_interval_status: 1,
            current_interval_remaining_percent: 99,
            current_weekly_status: 1,
            current_weekly_remaining_percent: 64,
            end_time: '2026-06-06T10:00:00.000Z',
            weekly_end_time: '2026-06-10T10:00:00.000Z',
            // total/used are 0 in the real response — they should be ignored.
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            current_weekly_total_count: 0,
            current_weekly_usage_count: 0,
          },
        ],
      })
    );

    const r = await getProviderUsage({
      provider_type: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: 'test-key',
    });

    expect(r.success).toBe(true);
    expect(r.quotas?.['General (5h)']).toMatchObject({
      used: 1,
      total: 100,
      remaining: 99,
      remainingPercentage: 99,
    });
    expect(r.quotas?.['General (7d)']).toMatchObject({
      used: 36,
      total: 100,
      remaining: 64,
      remainingPercentage: 64,
    });
  });

  it('skips models with status=3 (inactive / no plan)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        base_resp: { status_code: 0, status_msg: 'success' },
        model_remains: [
          { model_name: 'video', current_interval_status: 3, current_interval_remaining_percent: 100 },
          { model_name: 'general', current_interval_status: 1, current_interval_remaining_percent: 80 },
        ],
      })
    );

    const r = await getProviderUsage({
      provider_type: 'minimax-cn',
      base_url: 'https://api.minimaxi.com/v1',
      api_key: 'test-key',
    });

    expect(r.success).toBe(true);
    expect(Object.keys(r.quotas ?? {})).toEqual(['General (5h)']);
    expect(r.quotas?.['General (5h)']?.remaining).toBe(80);
  });

  it('falls back to second URL on 401 (cluster-mismatch scenario)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTextResponse('unauthorized', 401))
      .mockResolvedValueOnce(
        mockJsonResponse({
          base_resp: { status_code: 0, status_msg: 'success' },
          model_remains: [
            { model_name: 'general', current_interval_status: 1, current_interval_remaining_percent: 70 },
          ],
        })
      );

    const r = await getProviderUsage({
      provider_type: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: 'test-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.success).toBe(true);
    expect(r.quotas?.['General (5h)']?.remaining).toBe(70);
  });

  it('returns AUTH_FAILED only when ALL URLs in chain return 401', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTextResponse('unauthorized', 401))
      .mockResolvedValueOnce(mockTextResponse('unauthorized', 401));

    const r = await getProviderUsage({
      provider_type: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: 'bad-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('AUTH_FAILED');
  });

  it('returns a connected-but-empty message when no rows have status=1', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        base_resp: { status_code: 0, status_msg: 'success' },
        model_remains: [
          { model_name: 'video', current_interval_status: 3, current_interval_remaining_percent: 100 },
        ],
      })
    );

    const r = await getProviderUsage({
      provider_type: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: 'test-key',
    });

    expect(r.success).toBe(true);
    expect(r.quotas).toEqual({});
    expect(r.message).toMatch(/No active.*quota/i);
  });

  it('returns a connected-but-empty message when model_remains is empty', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        base_resp: { status_code: 0, status_msg: 'success' },
        model_remains: [],
      })
    );

    const r = await getProviderUsage({
      provider_type: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: 'test-key',
    });

    expect(r.success).toBe(true);
    expect(r.quotas).toEqual({});
    expect(r.message).toMatch(/No active.*quota/i);
  });

  it('surfaces upstream base_resp status_code=1004 as AUTH_FAILED (single URL chain)', async () => {
    // Single-URL chain (minimax-cn) means no fallback, so 1004 should resolve
    // to AUTH_FAILED with the upstream status message.
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        base_resp: { status_code: 1004, status_msg: 'invalid api key' },
        model_remains: [],
      })
    );

    const r = await getProviderUsage({
      provider_type: 'minimax-cn',
      base_url: 'https://api.minimaxi.com/v1',
      api_key: 'bad-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('AUTH_FAILED');
  });

  it('falls back on 5xx to the next URL', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTextResponse('boom', 502))
      .mockResolvedValueOnce(
        mockJsonResponse({
          base_resp: { status_code: 0, status_msg: 'success' },
          model_remains: [
            { model_name: 'general', current_interval_status: 1, current_interval_remaining_percent: 50 },
          ],
        })
      );

    const r = await getProviderUsage({
      provider_type: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: 'test-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.success).toBe(true);
    expect(r.quotas?.['General (5h)']?.remaining).toBe(50);
  });
});

// ── GLM HTTP integration ──────────────────────────────────────────────────

describe('getProviderUsage — GLM', () => {
  it('hits international endpoint for z.ai baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        data: {
          level: 'pro',
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 23, nextResetTime: 1747056000000 },
          ],
        },
      })
    );

    const r = await getProviderUsage({
      provider_type: 'glm',
      base_url: 'https://api.z.ai/api/paas/v4',
      api_key: 'glm-test',
    });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe(GLM_QUOTA_URLS.international);
    expect(r.success).toBe(true);
    expect(r.plan).toBe('Pro');
    expect(r.quotas?.['session']).toMatchObject({
      used: 23,
      total: 100,
      remaining: 77,
      remainingPercentage: 77,
    });
  });

  it('hits china endpoint for bigmodel.cn baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        data: {
          level: 'pro',
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 50, nextResetTime: 1747056000000 },
          ],
        },
      })
    );

    const r = await getProviderUsage({
      provider_type: 'glm',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key: 'glm-test',
    });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe(GLM_QUOTA_URLS.china);
    expect(r.success).toBe(true);
    expect(r.quotas?.['session']?.used).toBe(50);
  });

  it('returns AUTH_FAILED on 401', async () => {
    fetchMock.mockResolvedValueOnce(mockTextResponse('unauthorized', 401));

    const r = await getProviderUsage({
      provider_type: 'glm',
      base_url: 'https://api.z.ai/api/paas/v4',
      api_key: 'bad-key',
    });

    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('AUTH_FAILED');
  });

  it('returns connected-but-empty message when limits is empty', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ data: { level: 'free', limits: [] } })
    );

    const r = await getProviderUsage({
      provider_type: 'glm',
      base_url: 'https://api.z.ai/api/paas/v4',
      api_key: 'glm-test',
    });

    expect(r.success).toBe(true);
    expect(r.quotas).toEqual({});
    expect(r.message).toMatch(/No TOKENS_LIMIT/i);
  });
});

// ── URL catalog sanity checks ─────────────────────────────────────────────

describe('URL catalogs', () => {
  it('minimax URL list is non-empty and de-duplicated', () => {
    for (const list of Object.values(MINIMAX_USAGE_URLS)) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('GLM URL list contains both regions', () => {
    expect(GLM_QUOTA_URLS.international).toContain('z.ai');
    expect(GLM_QUOTA_URLS.china).toContain('bigmodel.cn');
  });
});
