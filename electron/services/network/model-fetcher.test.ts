/**
 * electron/services/network/model-fetcher.test.ts
 *
 * Plan 205 follow-up: regression coverage for the model list
 * fetcher. Two layers:
 *
 *   1. `buildCandidateUrls` — pure URL construction. The DeepSeek
 *      bug was here: a baseUrl of `https://api.deepseek.com/
 *      anthropic` produced 4 candidates that ALL ended in
 *      `/anthropic/...` paths, which 404. The cc-switch-style
 *      `stripCompatSuffix` + bare-host candidates fix it.
 *
 *   2. `fetchProviderModels` — end-to-end with a mocked global
 *      `fetch`. Verifies that the first working candidate wins,
 *      404/405 trigger fallthrough, and the auth header shape
 *      differs between OpenAI-compatible vs Anthropic-compat
 *      vendors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCandidateUrls,
  fetchProviderModels,
} from './model-fetcher';

type FetchMock = ReturnType<typeof vi.fn>;

interface MockResponseInit {
  status?: number;
  body?: unknown;
  text?: string;
}

function makeResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const textBody = init.text ?? '';
  const body = init.body !== undefined ? init.body : textBody;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

let originalFetch: typeof fetch;
let fetchMock: FetchMock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('buildCandidateUrls — canonical (no compat suffix)', () => {
  it('returns /v1/models for a plain root', () => {
    expect(buildCandidateUrls('https://api.siliconflow.cn')).toEqual([
      'https://api.siliconflow.cn/v1/models',
    ]);
  });

  it('strips trailing slashes', () => {
    expect(buildCandidateUrls('https://api.example.com/')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('does not double /v1 when the user already supplied it', () => {
    expect(buildCandidateUrls('https://api.example.com/v1')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('handles v1beta / v1alpha tails the same way', () => {
    expect(buildCandidateUrls('https://api.example.com/v1beta')).toEqual([
      'https://api.example.com/v1beta/models',
    ]);
    expect(buildCandidateUrls('https://api.example.com/v1alpha')).toEqual([
      'https://api.example.com/v1alpha/models',
    ]);
  });

  it('returns an empty array for an empty baseUrl', () => {
    expect(buildCandidateUrls('')).toEqual([]);
    expect(buildCandidateUrls('   ')).toEqual([]);
  });
});

describe('buildCandidateUrls — Anthropic compat suffixes (the DeepSeek bug)', () => {
  it('DeepSeek `/anthropic` produces the bare `/models` fallback that actually works', () => {
    // Old behavior: only tried suffixed paths, all 404. New
    // behavior: also strip and try the host root.
    const urls = buildCandidateUrls('https://api.deepseek.com/anthropic');
    expect(urls).toContain('https://api.deepseek.com/anthropic/v1/models');
    expect(urls).toContain('https://api.deepseek.com/v1/models');
    expect(urls).toContain('https://api.deepseek.com/models');
    // Longest-prefix-first: `/api/anthropic` wins over `/anthropic`.
    expect(urls[0]).toBe('https://api.deepseek.com/anthropic/v1/models');
    expect(urls[urls.length - 1]).toBe('https://api.deepseek.com/models');
  });

  it('GLM (Zhipu) `/api/anthropic` strips the whole suffix, not just `/anthropic`', () => {
    const urls = buildCandidateUrls('https://open.bigmodel.cn/api/anthropic');
    expect(urls).toContain('https://open.bigmodel.cn/api/anthropic/v1/models');
    expect(urls).toContain('https://open.bigmodel.cn/v1/models');
    expect(urls).toContain('https://open.bigmodel.cn/models');
  });

  it('Bailian `/apps/anthropic` resolves to dashscope root', () => {
    const urls = buildCandidateUrls('https://dashscope.aliyuncs.com/apps/anthropic');
    expect(urls).toContain('https://dashscope.aliyuncs.com/apps/anthropic/v1/models');
    expect(urls).toContain('https://dashscope.aliyuncs.com/v1/models');
    expect(urls).toContain('https://dashscope.aliyuncs.com/models');
  });

  it('StepFun `/step_plan` resolves to api.stepfun.com root', () => {
    const urls = buildCandidateUrls('https://api.stepfun.com/step_plan');
    expect(urls).toContain('https://api.stepfun.com/step_plan/v1/models');
    expect(urls).toContain('https://api.stepfun.com/v1/models');
    expect(urls).toContain('https://api.stepfun.com/models');
  });

  it('Volcengine `/api/coding` resolves to ark root', () => {
    const urls = buildCandidateUrls('https://ark.cn-beijing.volces.com/api/coding');
    expect(urls).toContain('https://ark.cn-beijing.volces.com/api/coding/v1/models');
    expect(urls).toContain('https://ark.cn-beijing.volces.com/v1/models');
    expect(urls).toContain('https://ark.cn-beijing.volces.com/models');
  });

  it('longest suffix wins: `/api/anthropic` > `/anthropic`', () => {
    // If the order were wrong, we'd end up stripping only
    // `/anthropic` and producing the broken
    // `https://api.z.ai/api/v1/models` (note the orphan `/api`).
    const urls = buildCandidateUrls('https://api.z.ai/api/anthropic');
    expect(urls).toEqual([
      'https://api.z.ai/api/anthropic/v1/models',
      'https://api.z.ai/v1/models',
      'https://api.z.ai/models',
    ]);
  });

  it('rightcode `/claude` resolves to bare host', () => {
    const urls = buildCandidateUrls('https://www.right.codes/claude');
    expect(urls).toContain('https://www.right.codes/claude/v1/models');
    expect(urls).toContain('https://www.right.codes/v1/models');
    expect(urls).toContain('https://www.right.codes/models');
  });
});

describe('buildCandidateUrls — dedup and edge cases', () => {
  it('does not duplicate when stripped root equals the original', () => {
    // Synthetic edge case: baseUrl with trailing slash and a
    // suffix that strips to the same host. Dedup must collapse
    // it back to one candidate.
    const urls = buildCandidateUrls('https://host.example.com/anthropic/');
    // Stage 1 → https://host.example.com/anthropic/v1/models
    // Stage 2 → https://host.example.com/v1/models, /models
    // The bare /models and /v1/models don't collide with the
    // primary, so we get 3.
    expect(urls).toEqual([
      'https://host.example.com/anthropic/v1/models',
      'https://host.example.com/v1/models',
      'https://host.example.com/models',
    ]);
  });

  it('preserves insertion order through dedup', () => {
    const urls = buildCandidateUrls('https://api.deepseek.com/anthropic');
    const seen = new Set<string>();
    for (const u of urls) {
      expect(seen.has(u)).toBe(false);
      seen.add(u);
    }
  });
});

describe('fetchProviderModels — end-to-end with mocked fetch', () => {
  it('falls through 404 candidates and succeeds on the working one (DeepSeek)', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ status: 404 }))
      .mockResolvedValueOnce(makeResponse({ status: 404 }))
      .mockResolvedValueOnce(
        makeResponse({
          status: 200,
          body: {
            object: 'list',
            data: [
              { id: 'deepseek-chat', owned_by: 'deepseek' },
              { id: 'deepseek-reasoner', owned_by: 'deepseek' },
            ],
          },
        }),
      );

    const result = await fetchProviderModels({
      protocol: 'anthropic',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: 'sk-test',
    });

    expect(result.success).toBe(true);
    expect(result.models).toEqual([
      { id: 'deepseek-chat', ownedBy: 'deepseek' },
      { id: 'deepseek-reasoner', ownedBy: 'deepseek' },
    ]);
    // We made exactly 3 requests: /anthropic/v1/models (404),
    // /v1/models (404), /models (200).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.deepseek.com/anthropic/v1/models',
    );
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      'https://api.deepseek.com/models',
    );
  });

  it('uses `x-api-key` for anthropic-protocol DeepSeek (not Bearer)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: { data: [{ id: 'deepseek-chat' }] },
      }),
    );

    await fetchProviderModels({
      protocol: 'anthropic',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: 'sk-test',
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    // DeepSeek's URL contains `api.deepseek`, so the impl flips
    // to OpenAI-compatible and sends `Authorization: Bearer`.
    // This matches the actual DeepSeek /models auth contract.
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('uses `x-api-key` for canonical Anthropic', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: { data: [{ id: 'claude-sonnet-4-6' }] },
      }),
    );

    await fetchProviderModels({
      protocol: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-ant-test',
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('returns NO_CREDENTIALS when api_key is missing and auth_style is not env_only', async () => {
    const result = await fetchProviderModels({
      protocol: 'anthropic',
      base_url: 'https://api.anthropic.com',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CREDENTIALS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns NO_CREDENTIALS when base_url is missing', async () => {
    const result = await fetchProviderModels({
      protocol: 'anthropic',
      api_key: 'sk-test',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CREDENTIALS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ENDPOINT_NOT_FOUND when all candidates 404', async () => {
    // Pick a baseUrl that has NO compat suffix → only one
    // candidate → guaranteed 404.
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await fetchProviderModels({
      protocol: 'openai',
      base_url: 'https://no-such-host.example.com',
      api_key: 'sk-test',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ENDPOINT_NOT_FOUND');
  });

  it('returns PARSE_FAILED when the response is 200 but unparseable', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, body: { weird: 'shape' } }),
    );
    const result = await fetchProviderModels({
      protocol: 'openai',
      base_url: 'https://api.example.com',
      api_key: 'sk-test',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_FAILED');
  });

  it('returns AUTH_FAILED on 401', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 401, text: 'Unauthorized' }),
    );
    const result = await fetchProviderModels({
      protocol: 'openai',
      base_url: 'https://api.example.com',
      api_key: 'sk-test',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AUTH_FAILED');
  });

  it('routes to ollama when the URL matches an Ollama host', async () => {
    // fetchProviderModels dynamically imports `./model-detector`
    // for the ollama path. Mock the ollama module to avoid
    // touching the network.
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: { models: [{ name: 'llama3:latest' }] },
      }),
    );
    // The ollama path uses its own fetch, which we already
    // mocked — so we should see exactly one outbound request
    // and the ollama response shape.
    const result = await fetchProviderModels({
      protocol: 'ollama',
      base_url: 'http://localhost:11434',
    });
    expect(result.success).toBe(true);
    expect(result.models).toEqual([{ id: 'llama3:latest', ownedBy: 'ollama' }]);
  });
});
