/**
 * Worker-side image-capability detection with Host-backed persistence.
 *
 * Model-name heuristics stay in Capabilities; this service owns the cached
 * lookup and the provider HTTP probe. A detector is scoped to the injected
 * cache port so concurrent misses share one request without crossing Host
 * sessions or test instances.
 */

import type { HostLocalModelCapabilityApiV1 } from '@duya/agent-protocol/model-capabilities';
import {
  isModelLikelyMultimodal,
  isMultimodalRejectionError,
  NON_MULTIMODAL_MODEL_PATTERNS,
} from '@duya/capabilities/utils/multimodal-detection';

const PROBE_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const PROBE_TIMEOUT_MS = 8000;

export interface ProbeConfig {
  model: string;
  provider: 'anthropic' | 'openai' | string;
  apiKey: string;
  baseURL: string;
  authStyle?: 'api_key' | 'auth_token';
}

export type ModelCapabilityCache = Pick<
  HostLocalModelCapabilityApiV1,
  'getModelCapability' | 'setModelCapability'
>;

export type ModelCapabilityProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** Create a cache- and transport-bound detector for one worker composition. */
export function createModelCapabilityDetector(
  cache: ModelCapabilityCache,
  probeFetch: ModelCapabilityProbeFetch = (input, init) => fetch(input, init),
): (config: ProbeConfig) => Promise<boolean> {
  const inflightProbes = new Map<string, Promise<boolean>>();

  return async function detectModelCapability(config: ProbeConfig): Promise<boolean> {
    const modelName = config.model.trim();

    // 1. Regex heuristics — fast path.
    if (isModelLikelyMultimodal(modelName)) {
      await cache.setModelCapability({ modelName, isMultimodal: true, method: 'regex' });
      return true;
    }

    // Known text-only families should not spend a request on an API probe.
    const isKnownNonMultimodal = NON_MULTIMODAL_MODEL_PATTERNS.some((pattern) =>
      pattern.test(modelName),
    );
    if (isKnownNonMultimodal) {
      await cache.setModelCapability({ modelName, isMultimodal: false, method: 'regex' });
      return false;
    }

    // 2. Host-backed cache.
    const cached = await cache.getModelCapability(modelName);
    if (cached !== null) return cached.is_multimodal === 1;

    // 3. API probe — detect from the API response.
    const { apiKey, baseURL } = config;
    if (!apiKey || !baseURL) {
      await cache.setModelCapability({ modelName, isMultimodal: false, method: 'default' });
      return false;
    }

    // Deduplicate concurrent cache misses for this model within this detector.
    const inflight = inflightProbes.get(modelName);
    if (inflight !== undefined) return inflight;

    const probePromise = (async (): Promise<boolean> => {
      try {
        const isMultimodal = await probeMultimodalSupport(config, probeFetch);
        await cache.setModelCapability({ modelName, isMultimodal, method: 'probe' });
        return isMultimodal;
      } catch {
        // A transient network/cache failure must not be persisted as text-only.
        return false;
      }
    })();

    inflightProbes.set(modelName, probePromise);
    try {
      return await probePromise;
    } finally {
      inflightProbes.delete(modelName);
    }
  };
}

async function probeMultimodalSupport(
  config: ProbeConfig,
  probeFetch: ModelCapabilityProbeFetch,
): Promise<boolean> {
  if (config.provider.toLowerCase() === 'anthropic') {
    return probeAnthropicStyle(config, probeFetch);
  }
  return probeOpenAIStyle(config, probeFetch);
}

async function probeAnthropicStyle(
  config: ProbeConfig,
  probeFetch: ModelCapabilityProbeFetch,
): Promise<boolean> {
  const url = `${config.baseURL.replace(/\/+$/, '')}/messages`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.authStyle === 'auth_token') {
    headers.Authorization = `Bearer ${config.apiKey}`;
  } else {
    headers['x-api-key'] = config.apiKey;
  }

  const body = JSON.stringify({
    model: config.model,
    max_tokens: 5,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply "OK"' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: PROBE_1X1_PNG_BASE64,
            },
          },
        ],
      },
    ],
  });

  return requestProbe(url, headers, body, probeFetch);
}

async function probeOpenAIStyle(
  config: ProbeConfig,
  probeFetch: ModelCapabilityProbeFetch,
): Promise<boolean> {
  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  const body = JSON.stringify({
    model: config.model,
    max_tokens: 5,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply "OK"' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PROBE_1X1_PNG_BASE64}` },
          },
        ],
      },
    ],
  });

  return requestProbe(url, headers, body, probeFetch);
}

async function requestProbe(
  url: string,
  headers: Record<string, string>,
  body: string,
  probeFetch: ModelCapabilityProbeFetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await probeFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (response.ok) return true;

    const errorText = await response.text().catch(() => '');
    if (isMultimodalRejectionError(errorText)) return false;
    return false;
  } catch (error) {
    if (isAbortError(error)) return false;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}
