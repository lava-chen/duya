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
});