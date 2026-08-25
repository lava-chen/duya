/**
 * src/lib/providers/models/__tests__/ModelSyncService.test.ts
 *
 * Unit tests for the LM Studio-aware model sync.
 *
 * Background: `ModelSyncService.fetchOpenAICompatibleModels` is the
 * capability-table seeder. Before this change it only hit the plain
 * OpenAI `/v1/models` endpoint, which on LM Studio returns just `id`
 * (no capabilities, no context length). The fix detects LM Studio
 * by baseUrl port (`:1234`) and hits the richer `/api/v1/models`
 * endpoint first, falling back to the OpenAI-compat path if the
 * rich endpoint 404s (older LM Studio versions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ModelSyncService } from '../ModelSyncService';
import type { LlmProvider } from '../../types';

type FetchMock = ReturnType<typeof vi.fn>;

function lmStudioProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'lmstudio-local',
    name: 'LM Studio',
    category: 'local',
    apiFormat: 'openai-chat',
    auth: { type: 'none' },
    endpoints: { baseUrl: 'http://localhost:1234/v1', isFullUrl: false },
    ui: {},
    meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    headers: undefined,
    extraEnv: undefined,
    ...overrides,
  };
}

function openAiProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'openai-remote',
    name: 'OpenAI',
    category: 'official',
    apiFormat: 'openai-chat',
    auth: { type: 'api-key', apiKey: 'sk-test' },
    endpoints: { baseUrl: 'https://api.openai.com/v1', isFullUrl: false },
    ui: {},
    meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    headers: undefined,
    extraEnv: undefined,
    ...overrides,
  };
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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('ModelSyncService.fetchOpenAICompatibleModels \u2014 LM Studio rich endpoint', () => {
  it('hits /api/v1/models first for an LM Studio host (port 1234)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            type: 'llm',
            key: 'qwen3.5-9b',
            max_context_length: 32768,
            loaded_instances: [{ config: { context_length: 4096 } }],
            format: 'gguf',
            capabilities: { vision: false, trained_for_tool_use: true },
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      modelId: 'qwen3.5-9b',
      contextWindow: 32768,
      supportsVision: false,
      supportsToolUse: true,
      isLoaded: true,
      source: 'models-api',
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:1234/api/v1/models',
    );
  });

  it('falls back to /v1/models when /api/v1/models returns 404 (older LM Studio)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'qwen3.5-9b' },
          ],
        }),
      );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.ok).toBe(true);
    expect(result.models[0].modelId).toBe('qwen3.5-9b');
    // No capability flags from the OpenAI-compat fallback.
    expect(result.models[0].supportsVision).toBeUndefined();
    expect(result.models[0].isLoaded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://localhost:1234/api/v1/models',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'http://localhost:1234/models',
    );
  });

  it('routes non-LM-Studio providers straight to /v1/models (no LM Studio probe)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(openAiProvider());

    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.modelId)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.openai.com/v1/models',
    );
  });

  it('returns ok=false with message when both endpoints fail', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 500));

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.message).toBeDefined();
  });

  it('attaches Authorization header when auth.apiKey is set (LM Studio with explicit key)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ models: [{ key: 'qwen3.5-9b' }] }),
    );

    const svc = new ModelSyncService();
    await svc.fetchOpenAICompatibleModels(
      lmStudioProvider({
        auth: { type: 'api-key', apiKey: 'lm-studio-token' },
      }),
    );

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lm-studio-token');
  });

  it('skips embedding models (LM Studio `type === "embedding"`)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [
          { type: 'llm', key: 'qwen3.5-9b', max_context_length: 32768 },
          {
            type: 'embedding',
            key: 'text-embedding-nomic-embed-text-v1.5',
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.modelId)).toEqual(['qwen3.5-9b']);
  });

  it('normalizes reasoning allowed_options into reasoningEffortOptions', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            type: 'llm',
            key: 'qwq-32b',
            max_context_length: 32768,
            capabilities: {
              reasoning: { allowed_options: ['low', 'medium', 'high', 'off'] },
            },
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.models[0]).toMatchObject({
      modelId: 'qwq-32b',
      supportsReasoning: true,
      reasoningEffortOptions: ['low', 'medium', 'high'],
    });
  });

  it('exposes isLoaded=true when loaded_instances has a valid context_length', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            type: 'llm',
            key: 'qwen3.5-9b',
            max_context_length: 32768,
            loaded_instances: [{ config: { context_length: 8192 } }],
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.models[0].isLoaded).toBe(true);
    expect(result.models[0].contextWindow).toBe(32768);
  });

  it('exposes isLoaded=false when loaded_instances is empty', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            type: 'llm',
            key: 'qwen3.5-9b',
            max_context_length: 32768,
            loaded_instances: [],
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.models[0].isLoaded).toBe(false);
  });
});
describe('ModelSyncService.fetchOpenAICompatibleModels — OpenRouter-style entries', () => {
  function openRouterProvider(): LlmProvider {
    return openAiProvider({
      id: 'openrouter',
      name: 'OpenRouter',
      endpoints: { baseUrl: 'https://openrouter.ai/api/v1', isFullUrl: false },
      auth: { type: 'api-key', apiKey: 'sk-or-test' },
    });
  }

  it('extracts maxOutputTokens from top_provider.max_completion_tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'vendor/ox-alpha',
            context_length: 200000,
            top_provider: { context_length: 200000, max_completion_tokens: 16384 },
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(openRouterProvider());

    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      modelId: 'vendor/ox-alpha',
      contextWindow: 200000,
      maxOutputTokens: 16384,
    });
  });

  it('maps architecture.input_modalities and supported_parameters to capability flags', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'vendor/ox-alpha',
            context_length: 200000,
            architecture: {
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
            },
            supported_parameters: ['tools', 'reasoning', 'max_tokens'],
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(openRouterProvider());

    expect(result.models[0]).toMatchObject({
      modelId: 'vendor/ox-alpha',
      supportsVision: true,
      supportsToolUse: true,
      supportsReasoning: true,
    });
  });

  it('leaves capability flags undefined for plain OpenAI-shaped entries (unknown ≠ false)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'gpt-x' }],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(openRouterProvider());

    expect(result.ok).toBe(true);
    const m = result.models[0];
    expect(m.supportsVision).toBeUndefined();
    expect(m.supportsToolUse).toBeUndefined();
    expect(m.supportsReasoning).toBeUndefined();
    expect(m.maxOutputTokens).toBeUndefined();
  });

  it('LM Studio capabilities win over aggregator fields when both are present', async () => {
    // Hybrid entry: LM Studio `capabilities` block + aggregator fields.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            type: 'llm',
            key: 'hybrid',
            capabilities: { vision: false, trained_for_tool_use: false, reasoning: { default: 'off' } },
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'reasoning'],
          },
        ],
      }),
    );

    const svc = new ModelSyncService();
    const result = await svc.fetchOpenAICompatibleModels(lmStudioProvider());

    expect(result.models[0]).toMatchObject({
      modelId: 'hybrid',
      supportsVision: false,
      supportsToolUse: false,
      supportsReasoning: false,
    });
  });
});
