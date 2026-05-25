/**
 * Model capability detection with DB-backed caching.
 *
 * On first use of an unknown model, probes the API with a tiny 1x1 PNG
 * to determine if the model supports image/multimodal inputs. Results are
 * cached in the model_capabilities table so subsequent uses skip the probe.
 */

import { getModelCapability, setModelCapability } from '../session/db.js';
import {
  isModelLikelyMultimodal,
  isMultimodalRejectionError,
  NON_MULTIMODAL_MODEL_PATTERNS,
} from './multimodal-detection.js';

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

/**
 * Detects whether a model supports multimodal (image) inputs.
 *
 * Resolution order:
 * 1. Regex heuristics (fast, covers well-known models)
 * 2. DB cache (from previous API probes)
 * 3. API probe (slow, one-time, result cached)
 */
export async function detectModelCapability(config: ProbeConfig): Promise<boolean> {
  const modelName = config.model.trim();

  // 1. Regex heuristics — fast path
  const regexResult = isModelLikelyMultimodal(modelName);
  if (regexResult) {
    setModelCapability(modelName, true, 'regex');
    return true;
  }

  // Check NON_MULTIMODAL pattern match — also cache negative regex results
  // isModelLikelyMultimodal returns false for non-multimodal and unknown.
  // We only want to probe truly unknown models, not known non-multimodal ones.
  const isKnownNonMultimodal = NON_MULTIMODAL_MODEL_PATTERNS.some(
    (p: RegExp) => p.test(modelName),
  );
  if (isKnownNonMultimodal) {
    setModelCapability(modelName, false, 'regex');
    return false;
  }

  // 2. DB cache
  const cached = getModelCapability(modelName);
  if (cached) {
    return cached.is_multimodal === 1;
  }

  // 3. API probe — detect from API response
  const { apiKey, baseURL, provider } = config;

  if (!apiKey || !baseURL) {
    setModelCapability(modelName, false, 'default');
    return false;
  }

  try {
    const isMultimodal = await probeMultimodalSupport(config);
    setModelCapability(modelName, isMultimodal, 'probe');
    return isMultimodal;
  } catch {
    setModelCapability(modelName, false, 'default');
    return false;
  }
}

async function probeMultimodalSupport(config: ProbeConfig): Promise<boolean> {
  const { model, provider, apiKey, baseURL, authStyle } = config;
  const normalizedProvider = provider.toLowerCase();

  if (normalizedProvider === 'anthropic') {
    return probeAnthropicStyle(model, apiKey, baseURL, authStyle);
  }
  return probeOpenAIStyle(model, apiKey, baseURL);
}

async function probeAnthropicStyle(
  model: string,
  apiKey: string,
  baseURL: string,
  authStyle?: string,
): Promise<boolean> {
  const url = baseURL.replace(/\/+$/, '') + '/messages';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (authStyle === 'auth_token') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  const body = JSON.stringify({
    model,
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (response.ok) return true;

    const errorText = await response.text().catch(() => '');
    if (isMultimodalRejectionError(errorText)) return false;

    return false;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return false;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeOpenAIStyle(
  model: string,
  apiKey: string,
  baseURL: string,
): Promise<boolean> {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const body = JSON.stringify({
    model,
    max_tokens: 5,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply "OK"' },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${PROBE_1X1_PNG_BASE64}`,
            },
          },
        ],
      },
    ],
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (response.ok) return true;

    const errorText = await response.text().catch(() => '');
    if (isMultimodalRejectionError(errorText)) return false;

    return false;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return false;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}