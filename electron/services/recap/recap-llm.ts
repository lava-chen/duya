import type { ApiProvider } from '../../config/manager';
import { getLogger, LogComponent } from '../../logging/logger';

const logger = getLogger();

const RECAP_TIMEOUT_MS = 15_000;

export async function callLLMForRecap(
  provider: ApiProvider,
  systemPrompt: string,
  userContent: string,
): Promise<string | null> {
  const model =
    (provider.options?.model as string) ||
    (provider.options?.defaultModel as string) ||
    '';

  try {
    switch (provider.providerType) {
      case 'anthropic':
      case 'bedrock':
      case 'vertex':
        return await callAnthropic(provider, systemPrompt, userContent, model);
      case 'openai':
      case 'openai-compatible':
      case 'openrouter':
      case 'google':
      case 'gemini-image':
        return await callOpenAI(provider, systemPrompt, userContent, model);
      case 'ollama':
        return await callOllama(provider, systemPrompt, userContent, model);
      default:
        logger.warn('Unknown provider type for recap', { providerType: provider.providerType }, LogComponent.Main);
        return null;
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
  provider: ApiProvider,
  systemPrompt: string,
  userContent: string,
  model: string,
): Promise<string | null> {
  const baseUrl = provider.baseUrl || 'https://api.anthropic.com';

  const body = JSON.stringify({
    model,
    max_tokens: 120,
    temperature: 0.3,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
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
  provider: ApiProvider,
  systemPrompt: string,
  userContent: string,
  model: string,
): Promise<string | null> {
  const baseUrl = provider.baseUrl || 'https://api.openai.com';

  const body = JSON.stringify({
    model,
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
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
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
  provider: ApiProvider,
  systemPrompt: string,
  userContent: string,
  model: string,
): Promise<string | null> {
  const baseUrl = provider.baseUrl || 'http://localhost:11434';

  const body = JSON.stringify({
    model,
    stream: false,
    options: { temperature: 0.3, num_predict: 120 },
    system: systemPrompt,
    prompt: userContent,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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