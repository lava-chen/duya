/**
 * electron/services/recap/recap-llm.ts
 *
 * Recap (session summary) LLM call. Phase 3: switched from a legacy
 * `ApiProvider` to a `ProviderRuntimeConfig` so the recap path
 * uses the same auth / header semantics as Chat.
 *
 * The caller (`recap-service.ts`) builds the runtime config via
 * `provider-store.getProviderRuntimeConfig(providerId, model)`.
 * This file MUST NOT interpret `providerType` / `baseUrl` strings.
 */

import { getLogger, LogComponent } from '../../logging/logger';
import type { ProviderRuntimeConfig } from '../../../src/lib/providers/types';

const logger = getLogger();

const RECAP_TIMEOUT_MS = 15_000;

export async function callLLMForRecap(
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string | null> {
  try {
    // Route by apiFormat, not by baseUrl string. This is the
    // single source of truth — if a new apiFormat is added, the
    // compiler will flag this switch (via the exhaustive check in
    // resolveLlmClientDiscriminator).
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
          'Recap LLM call: unknown apiFormat',
          { apiFormat: _exhaustive as string },
          LogComponent.Main,
        );
        return null;
      }
    }
  } catch (error) {
    logger.warn(
      'Recap LLM call failed',
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
    max_tokens: 120,
    temperature: 0.3,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);

  try {
    // Reuse the headers from the runtime config so the recap
    // follows the same auth style as Chat (Bearer vs x-api-key).
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...runtime.headers,
    };
    // Always pin the anthropic-version for the wire protocol.
    headers['anthropic-version'] =
      headers['anthropic-version'] ?? '2023-06-01';

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('Anthropic recap call failed', { status: response.status }, LogComponent.Main);
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
    max_tokens: 120,
    temperature: 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);

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
      logger.warn('OpenAI recap call failed', { status: response.status }, LogComponent.Main);
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
    options: { temperature: 0.3, num_predict: 120 },
    system: systemPrompt,
    prompt: userContent,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);

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
      logger.warn('Ollama recap call failed', { status: response.status }, LogComponent.Main);
      return null;
    }

    const data = (await response.json()) as { response?: string };
    return data.response?.trim() || null;
  } finally {
    clearTimeout(timeoutId);
  }
}
