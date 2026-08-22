/**
 * electron/services/next-step/next-step-llm.ts
 *
 * Single-shot LLM call for next-step suggestions, mirroring the recap
 * path (`recap-llm.ts`): a `ProviderRuntimeConfig` in, plain text out.
 * The token budget is larger than recap's because the model must emit
 * a JSON object holding three suggestions.
 *
 * The caller (`next-step-service.ts`) builds the runtime config via
 * `provider-store.getProviderRuntimeConfig(providerId, model)`.
 * This file MUST NOT interpret `providerType` / `baseUrl` strings.
 */

import { getLogger, LogComponent } from '../../logging/logger';
import type { ProviderRuntimeConfig } from '../../../src/lib/providers/types';

const logger = getLogger();

const NEXT_STEP_TIMEOUT_MS = 12_000;

export async function callLLMForNextSteps(
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string | null> {
  try {
    switch (runtime.apiFormat) {
      case 'anthropic':
      case 'bedrock':
      case 'vertex':
        return await callAnthropic(runtime, systemPrompt, userContent);
      case 'openai-chat':
      case 'openai-responses':
      case 'gemini':
        return await callOpenAI(runtime, systemPrompt, userContent);
      case 'ollama':
        return await callOllama(runtime, systemPrompt, userContent);
      default: {
        // Exhaustiveness — let TS catch new apiFormats at compile time.
        const _exhaustive: never = runtime.apiFormat;
        logger.warn(
          'Next-step LLM call: unknown apiFormat',
          { apiFormat: _exhaustive as string },
          LogComponent.Main,
        );
        return null;
      }
    }
  } catch (error) {
    logger.warn(
      'Next-step LLM call failed',
      { error: error instanceof Error ? error.message : String(error) },
      LogComponent.Main,
    );
    return null;
  }
}

async function callAnthropic(
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string | null> {
  const baseUrl = runtime.baseUrl || 'https://api.anthropic.com';

  const body = JSON.stringify({
    model: runtime.model,
    max_tokens: 400,
    temperature: 0.6,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NEXT_STEP_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...runtime.headers,
    };
    headers['anthropic-version'] =
      headers['anthropic-version'] ?? '2023-06-01';

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('Anthropic next-step call failed', { status: response.status }, LogComponent.Main);
      return null;
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((b) => b.type === 'text');
    return textBlock?.text?.trim() || null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAI(
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string | null> {
  const baseUrl = runtime.baseUrl || 'https://api.openai.com';

  const body = JSON.stringify({
    model: runtime.model,
    max_tokens: 400,
    temperature: 0.6,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NEXT_STEP_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...runtime.headers,
    };
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('OpenAI next-step call failed', { status: response.status }, LogComponent.Main);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content?.trim() || null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOllama(
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string | null> {
  const baseUrl = runtime.baseUrl || 'http://localhost:11434';

  const body = JSON.stringify({
    model: runtime.model,
    stream: false,
    options: { temperature: 0.6, num_predict: 400 },
    system: systemPrompt,
    prompt: userContent,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NEXT_STEP_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...runtime.headers,
    };
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('Ollama next-step call failed', { status: response.status }, LogComponent.Main);
      return null;
    }

    const data = (await response.json()) as { response?: string };
    return data.response?.trim() || null;
  } finally {
    clearTimeout(timeoutId);
  }
}
