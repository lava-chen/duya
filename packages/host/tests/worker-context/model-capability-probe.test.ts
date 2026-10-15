import { describe, expect, it, vi } from 'vitest';
import type { ModelCapabilityRecord } from '@duya/agent-protocol/model-capabilities';
import {
  createModelCapabilityDetector,
  type ModelCapabilityCache,
  type ModelCapabilityProbeFetch,
  type ProbeConfig,
} from '../../src/worker-context/model-capability-probe.js';

function makeCache(initial?: ModelCapabilityRecord): {
  cache: ModelCapabilityCache;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const records = new Map<string, ModelCapabilityRecord>();
  if (initial !== undefined) records.set(initial.id, initial);

  const get = vi.fn(async (modelName: string) => records.get(modelName.trim().toLowerCase()) ?? null);
  const set = vi.fn(async (input: { modelName: string; isMultimodal: boolean; method?: string }) => {
    const id = input.modelName.trim().toLowerCase();
    records.set(id, {
      id,
      is_multimodal: input.isMultimodal ? 1 : 0,
      detected_at: 1,
      detection_method: input.method ?? 'unknown',
    });
    return { success: true as const };
  });
  return { cache: { getModelCapability: get, setModelCapability: set }, get, set };
}

const probeConfig: ProbeConfig = {
  model: 'custom-deployment',
  provider: 'openai',
  apiKey: 'test-key',
  baseURL: 'https://models.example/v1/',
};

describe('Host model capability probe', () => {
  it('uses known model-name patterns before cache or HTTP', async () => {
    const { cache, get, set } = makeCache();
    const fetcher = vi.fn<ModelCapabilityProbeFetch>();
    const detect = createModelCapabilityDetector(cache, fetcher);

    await expect(detect({ ...probeConfig, model: 'claude-sonnet-4' })).resolves.toBe(true);

    expect(get).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({
      modelName: 'claude-sonnet-4',
      isMultimodal: true,
      method: 'regex',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a cached result for an unknown model without probing', async () => {
    const { cache, get, set } = makeCache({
      id: 'custom-deployment',
      is_multimodal: 0,
      detected_at: 1,
      detection_method: 'probe',
    });
    const fetcher = vi.fn<ModelCapabilityProbeFetch>();
    const detect = createModelCapabilityDetector(cache, fetcher);

    await expect(detect(probeConfig)).resolves.toBe(false);

    expect(get).toHaveBeenCalledWith('custom-deployment');
    expect(set).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the OpenAI-compatible image probe and caches a successful response', async () => {
    const { cache, set } = makeCache();
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetcher: ModelCapabilityProbeFetch = async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response('{}', { status: 200 });
    };
    const detect = createModelCapabilityDetector(cache, fetcher);

    await expect(detect(probeConfig)).resolves.toBe(true);

    expect(requestedUrl).toBe('https://models.example/v1/chat/completions');
    expect(requestedInit?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(requestedInit?.body))).toMatchObject({
      model: 'custom-deployment',
      messages: [{ content: [{ type: 'text' }, { type: 'image_url' }] }],
    });
    expect(set).toHaveBeenCalledWith({
      modelName: 'custom-deployment',
      isMultimodal: true,
      method: 'probe',
    });
  });

  it('uses Anthropic auth-token headers and does not cache transient probe failures', async () => {
    const { cache, set } = makeCache();
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetcher: ModelCapabilityProbeFetch = async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      throw new Error('temporary network failure');
    };
    const detect = createModelCapabilityDetector(cache, fetcher);

    await expect(detect({
      ...probeConfig,
      provider: 'anthropic',
      authStyle: 'auth_token',
    })).resolves.toBe(false);

    expect(requestedUrl).toBe('https://models.example/v1/messages');
    expect(requestedInit?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(set).not.toHaveBeenCalled();
  });

  it('shares an in-flight probe for concurrent cache misses', async () => {
    const { cache, set } = makeCache();
    let finish!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { finish = resolve; });
    let requests = 0;
    const fetcher: ModelCapabilityProbeFetch = async () => {
      requests += 1;
      return pendingResponse;
    };
    const detect = createModelCapabilityDetector(cache, fetcher);

    const first = detect(probeConfig);
    const second = detect(probeConfig);
    await vi.waitFor(() => expect(requests).toBe(1));
    finish(new Response('{}', { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
