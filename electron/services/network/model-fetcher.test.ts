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

  it('adds a 127.0.0.1 alias for localhost hosts (IPv6 ::1 is refused)', () => {
    // `localhost` resolves to ::1 and 127.0.0.1; Electron's Node may try ::1
    // first and fail with ECONNREFUSED (LM Studio binds IPv4 only), so we must
    // also try the 127.0.0.1 variant.
    expect(buildCandidateUrls('http://localhost:1234/v1')).toEqual([
      'http://localhost:1234/v1/models',
      'http://127.0.0.1:1234/v1/models',
    ]);
    expect(buildCandidateUrls('http://localhost:11434')).toEqual([
      'http://localhost:11434/v1/models',
      'http://127.0.0.1:11434/v1/models',
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

  it('fetches from a localhost OpenAI-compatible server without an API key (LM Studio)', async () => {
    // LM Studio exposes `/api/v1/models` on the host root and needs no key.
    // Previously the `!api_key` guard returned NO_CREDENTIALS before any
    // network call; now the local rich path returns models (with context).
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: {
          models: [
            {
              type: 'llm',
              key: 'qwen3.8-27b',
              loaded_instances: [{ id: 'qwen3.8-27b', config: { context_length: 2048 } }],
              max_context_length: 262144,
            },
            {
              type: 'llm',
              key: 'openai/gpt-oss-20b',
              loaded_instances: [],
              max_context_length: 131072,
            },
          ],
        },
      }),
    );

    const result = await fetchProviderModels({
      protocol: 'openai-compatible',
      base_url: 'http://localhost:1234/v1',
      auth_style: 'auth_token', // no api_key provided
    });

    expect(result.success).toBe(true);
    // Loaded model → its ACTIVE context_length (2048); not-loaded → max.
    // `contextWindowMax` mirrors the model's absolute cap so the
    // renderer can show both "32K / 256K" values.
    expect(result.models).toEqual([
      {
        id: 'qwen3.8-27b',
        ownedBy: null,
        contextLength: 2048,
        contextWindowMax: 262144,
      },
      {
        id: 'openai/gpt-oss-20b',
        ownedBy: null,
        contextLength: 131072,
        contextWindowMax: 131072,
      },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:1234/api/v1/models',
    );
    // No Authorization header is sent because no key exists.
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('falls back from refused localhost to the 127.0.0.1 alias', async () => {
    // Simulate Electron's Node: `localhost` resolves to ::1 which is refused,
    // so the localhost rich endpoint throws; we must hit the 127.0.0.1 alias.
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        makeResponse({
          status: 200,
          body: {
            models: [
              { key: 'qwen3.8-27b', loaded_instances: [{ config: { context_length: 8192 } }] },
            ],
          },
        }),
      );

    const result = await fetchProviderModels({
      protocol: 'openai-compatible',
      base_url: 'http://localhost:1234/v1',
    });

    expect(result.success).toBe(true);
    // `contextWindowMax` was added alongside `contextLength` to expose
    // the model's absolute ceiling when LM Studio reports it via
    // `max_context_length` (here the raw payload omits the max so
    // `contextWindowMax` falls back to the loaded context length).
    expect(result.models).toEqual([
      { id: 'qwen3.8-27b', ownedBy: null, contextLength: 8192, contextWindowMax: 8192 },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:1234/api/v1/models',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'http://127.0.0.1:1234/api/v1/models',
    );
  });

  it('still requires a key for a non-local endpoint', async () => {
    const result = await fetchProviderModels({
      protocol: 'openai-compatible',
      base_url: 'https://api.remote.example.com/v1',
      auth_style: 'auth_token',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CREDENTIALS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractModels — LM Studio rich capabilities', () => {
  // Regression coverage for the wasted-metadata gap: LM Studio's
  // `/api/v1/models` payload reports capabilities (vision /
  // trained_for_tool_use / reasoning) and a quantization format.
  // Previously `extractModels` threw these away. These tests pin the
  // new behavior so future changes don't regress it.

  function fetchLmStudio(body: unknown) {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body }));
    return fetchProviderModels({
      protocol: 'openai-compatible',
      base_url: 'http://localhost:1234/v1',
      auth_style: 'auth_token',
    });
  }

  it('extracts supportsVision / supportsToolUse from capabilities.vision / .trained_for_tool_use', async () => {
    const result = await fetchLmStudio({
      models: [
        {
          type: 'llm',
          key: 'llava-1.5-7b',
          display_name: 'LLaVA 1.5 7B',
          max_context_length: 4096,
          format: 'gguf',
          capabilities: { vision: true, trained_for_tool_use: false },
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.models?.[0]).toMatchObject({
      id: 'llava-1.5-7b',
      supportsVision: true,
      supportsToolUse: false,
      format: 'gguf',
      contextLength: 4096,
      contextWindowMax: 4096,
    });
  });

  it('sets supportsReasoning=true when capabilities.reasoning.allowed_options has at least one non-off entry', async () => {
    const result = await fetchLmStudio({
      models: [
        {
          type: 'llm',
          key: 'deepseek-r1-distill',
          max_context_length: 8192,
          capabilities: {
            reasoning: { allowed_options: ['low', 'medium', 'high', 'off'] },
          },
        },
      ],
    });
    expect(result.models?.[0]?.supportsReasoning).toBe(true);
  });

  it('sets supportsReasoning=false when allowed_options contains only "off"', async () => {
    const result = await fetchLmStudio({
      models: [
        {
          type: 'llm',
          key: 'qwen2.5-7b-instruct',
          max_context_length: 32768,
          capabilities: { reasoning: { allowed_options: ['off'] } },
        },
      ],
    });
    expect(result.models?.[0]?.supportsReasoning).toBe(false);
  });

  it('falls back to capabilities.reasoning.default when allowed_options is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 200,
        body: {
          models: [
            {
              type: 'llm',
              key: 'qwq-32b',
              max_context_length: 32768,
              capabilities: { reasoning: { default: 'low' } },
            },
          ],
        },
      }),
    );
    const result = await fetchProviderModels({
      protocol: 'openai-compatible',
      base_url: 'http://localhost:1234/v1',
    });
    expect(result.models?.[0]?.supportsReasoning).toBe(true);
  });

  it('omits capability flags (undefined) when the source did not report capabilities', async () => {
    // Plain OpenAI `/v1/models` style payload: only `id`.
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, body: { data: [{ id: 'gpt-4o' }] } }),
    );
    const result = await fetchProviderModels({
      protocol: 'openai-compatible',
      base_url: 'https://api.openai.com/v1',
      auth_style: 'api_key',
      api_key: 'sk-test',
    });
    expect(result.models?.[0]).toEqual({
      id: 'gpt-4o',
      ownedBy: null,
    });
    expect(result.models?.[0]?.supportsVision).toBeUndefined();
    expect(result.models?.[0]?.supportsToolUse).toBeUndefined();
    expect(result.models?.[0]?.supportsReasoning).toBeUndefined();
    expect(result.models?.[0]?.format).toBeUndefined();
  });

  it('prefers loaded_instances context_length over max_context_length for contextLength, but keeps max in contextWindowMax', async () => {
    const result = await fetchLmStudio({
      models: [
        {
          type: 'llm',
          key: 'qwen3.5-9b',
          max_context_length: 32768,
          loaded_instances: [
            { id: 'qwen3.5-9b', config: { context_length: 4096 } },
          ],
          capabilities: { trained_for_tool_use: true },
        },
      ],
    });
    expect(result.models?.[0]).toMatchObject({
      contextLength: 4096,
      contextWindowMax: 32768,
      supportsToolUse: true,
    });
  });

  it('extracts MLX format for Apple-Silicon-hosted models', async () => {
    const result = await fetchLmStudio({
      models: [
        {
          type: 'llm',
          key: 'mlx-community/Llama-3-8B-Instruct',
          max_context_length: 8192,
          format: 'mlx',
          capabilities: { vision: false, trained_for_tool_use: true },
        },
      ],
    });
    expect(result.models?.[0]?.format).toBe('mlx');
    expect(result.models?.[0]?.supportsVision).toBe(false);
  });
});
